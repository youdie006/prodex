#!/usr/bin/env node
// Notice when ChatGPT's UI stops working for prodex, without waiting for a
// person to hit it.
//
// This cannot live in GitHub Actions: it needs the logged-in browser, which only
// exists on a machine where someone signed in. It is meant to be run on a
// schedule there.
//
// It probes with `pro browser smoke`, which sends a token and checks the reply,
// rather than inspecting the picker's shape. Shape is a proxy; a round trip is
// the thing we actually care about, and this project has already been bitten by
// a picker that looked right and could not be driven.

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const cli = process.env.PRODEX_CLI ?? "prodex";
const cwd = process.env.PRODEX_WATCHDOG_CWD ?? process.cwd();
const shouldFile = process.argv.includes("--file-issue");
// --canary: run the read-only page canary first and do the round trip only
// when the page changed or broke, so the check can run hourly without sending
// a prompt every hour.
const canaryFirst = process.argv.includes("--canary");
const canaryScript = fileURLToPath(new URL("./page-canary.mjs", import.meta.url));
// --revive: when the canary finds the dedicated browser gone, start it once on
// the virtual display. On 2026-10-10 the machine's earlyoom ended it twice and
// the hourly run could only log "skipped" until someone restarted it by hand.
const revive = process.argv.includes("--revive");
const reviveStatePath = process.env.PRODEX_WATCHDOG_REVIVE_STATE ?? path.join(os.homedir(), ".local", "state", "prodex-maint", "revive.json");

// A browser that keeps dying is started again at most this often, so a machine
// short of memory does not get a fresh Chrome every hour.
export const REVIVE_INTERVAL_MS = 6 * 60 * 60_000;

/**
 * Only a browser that is gone, or has no ChatGPT tab, is started. A consult
 * holding the lock, or a tab that stopped answering, may be mid-send.
 */
export function shouldReviveBrowser(canarySummary, lastReviveAt, now) {
  if (!/skipped - (the browser is not available|no ChatGPT tab is open)/.test(canarySummary)) return false;
  return lastReviveAt === undefined || now - lastReviveAt >= REVIVE_INTERVAL_MS;
}

async function runCanary() {
  try {
    const { stdout } = await run(process.execPath, [canaryScript], { timeout: 2 * 60_000 });
    return { exitCode: 0, summary: stdout.trim().split(/\r?\n/).join(" | ") };
  } catch (error) {
    return {
      exitCode: typeof error?.code === "number" ? error.code : 1,
      summary: typeof error?.stdout === "string" ? error.stdout.trim().split(/\r?\n/).join(" | ") : firstLine(error)
    };
  }
}

async function lastBrowserRevive() {
  try {
    const at = JSON.parse(await readFile(reviveStatePath, "utf8")).lastReviveAt;
    return typeof at === "number" ? at : undefined;
  } catch {
    return undefined; // Never revived, or an unreadable state file.
  }
}

async function reviveBrowser() {
  await mkdir(path.dirname(reviveStatePath), { recursive: true });
  await writeFile(reviveStatePath, `${JSON.stringify({ lastReviveAt: Date.now() })}\n`, { mode: 0o600 });
  try {
    await run(cli, ["pro", "browser", "login", "--virtual-display", "--wait", "--wait-timeout-ms", "120000"], { timeout: 4 * 60_000 });
    console.log("ui_watchdog_revive=started");
    return true;
  } catch (error) {
    console.log(`ui_watchdog_revive=failed detail=${firstLine(error)}`);
    return false;
  }
}

async function main() {
  if (canaryFirst) {
    let { exitCode, summary } = await runCanary();
    console.log(`ui_watchdog_canary exit=${exitCode} ${summary}`);
    if (revive) {
      const lastReviveAt = await lastBrowserRevive();
      if (shouldReviveBrowser(summary, lastReviveAt, Date.now())) {
        if (await reviveBrowser()) {
          ({ exitCode, summary } = await runCanary());
          console.log(`ui_watchdog_canary exit=${exitCode} ${summary}`);
        }
      } else if (shouldReviveBrowser(summary, undefined, Date.now())) {
        console.log(`ui_watchdog_revive=held last=${new Date(lastReviveAt).toISOString()}`);
      }
    }
    // 0 is ok or skipped; 3 changed and 2 broken go on to the round trip,
    // which decides whether prodex still works on this page.
    if (exitCode === 0) return 0;
  }
  const started = Date.now();
  try {
    await run(cli, ["pro", "browser", "smoke", "--cwd", cwd], { timeout: 15 * 60_000, maxBuffer: 20 * 1024 * 1024 });
    console.log(`ui_watchdog=ok round_trip_ms=${Date.now() - started}`);
    return 0;
  } catch (error) {
    const detail = firstLine(error);
    // Another session holding the browser is not a broken UI; it filed
    // issue #20 as one. Try again next run.
    if (/Another prodex browser send is in progress/.test(detail)) {
      console.log(`ui_watchdog=skipped detail=${detail}`);
      return 0;
    }
    console.log(`ui_watchdog=broken detail=${detail}`);
    if (!shouldFile) {
      console.log("Nothing was filed. Pass --file-issue to open (or add to) an issue about it.");
      return 1;
    }
    // The report is built from the receipt the failed smoke just wrote, which
    // carries the blocker without carrying any prompt or answer. Filing is
    // deduplicated by blocker code, so a UI that stays broken keeps adding to
    // one issue instead of opening a new one every run.
    try {
      const { stdout } = await run(cli, ["pro", "report-issue", "--cwd", cwd, "--confirm"], { timeout: 2 * 60_000 });
      console.log(stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? "(filed)");
    } catch (fileError) {
      console.log(`ui_watchdog=file_failed detail=${firstLine(fileError)}`);
      return 2;
    }
    return 1;
  }
}

function firstLine(error) {
  // Skip the progress chatter: "connecting to browser" is what the run was
  // doing, not why it failed, and it is the first line every time.
  const isNoise = (line) => /^progress:/.test(line) || /^blocked consult recorded/.test(line);
  for (const part of [error?.stderr, error?.stdout, error?.message]) {
    if (typeof part !== "string") continue;
    const lines = part.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const real = lines.find((line) => !isNoise(line));
    if (real) return real.slice(0, 200);
  }
  return "unknown failure";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
