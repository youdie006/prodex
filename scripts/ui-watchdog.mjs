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
import { promisify } from "node:util";

const run = promisify(execFile);
const cli = process.env.PRODEX_CLI ?? "prodex";
const cwd = process.env.PRODEX_WATCHDOG_CWD ?? process.cwd();
const shouldFile = process.argv.includes("--file-issue");
// --canary: run the read-only page canary first and do the round trip only
// when the page changed or broke, so the check can run hourly without sending
// a prompt every hour.
const canaryFirst = process.argv.includes("--canary");

async function main() {
  if (canaryFirst) {
    let exitCode = 0;
    let summary = "";
    try {
      const { stdout } = await run(cli, ["pro", "browser", "canary"], { timeout: 2 * 60_000 });
      summary = stdout.trim().split(/\r?\n/).join(" | ");
    } catch (error) {
      exitCode = typeof error?.code === "number" ? error.code : 1;
      summary = typeof error?.stdout === "string" ? error.stdout.trim().split(/\r?\n/).join(" | ") : firstLine(error);
    }
    console.log(`ui_watchdog_canary exit=${exitCode} ${summary}`);
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

process.exit(await main());
