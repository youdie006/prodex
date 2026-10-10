#!/usr/bin/env node
// Maintainer tool, not part of the published package: notice when ChatGPT's
// page changes under prodex before a consult trips over it.
//
// ChatGPT ships builds without notice (two on 2026-10-08), and so far a
// redesign only showed up as failed consults. This reads the ChatGPT page that
// is already open in the dedicated browser - it never navigates, types or
// sends - records the build id and whether each control prodex relies on is
// there, and compares with the previous run. It writes counts and booleans
// only (never prompts, answers, titles or project names) to
// ~/.local/share/prodex/page-canary.json.
//
// Exit codes for a scheduler: 0 ok or skipped, 3 changed, 2 broken. A browser
// that is busy with a consult, closed, or not on ChatGPT is a skip.
//
//   node scripts/page-canary.mjs [--port 9333] [--state-file path] [--json]

import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PAGE_CANARY_EXPRESSION = `(() => {
  const visible = (el) => !!el && el.getClientRects().length > 0;
  const all = (selector) => [...document.querySelectorAll(selector)];
  const editor = all('#prompt-textarea,[contenteditable="true"]').find((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  const form = editor ? editor.closest("form") : null;
  const units = all("[data-chatgpt-search-unit-key]").filter(visible);
  const keyOf = (unit) => unit.getAttribute("data-chatgpt-search-unit-key") || "";
  const rows = all("[data-app-action-sidebar-project-row]");
  const path = location.pathname;
  return {
    build: document.documentElement.getAttribute("data-build"),
    pageKind: path === "/" ? "root" : /^\\/g\\/g-p-[^/]+\\/c\\//.test(path) || /^\\/c\\//.test(path) ? "conversation" : /^\\/g\\/g-p-/.test(path) ? "project" : "other",
    composer: { editor: !!editor, inForm: !!form },
    modelButton: !!(form && form.querySelector('button[aria-label="Select ChatGPT model"]')),
    toolsButton: !!(form && form.querySelector('button[data-composer-navigation-target="add-context"],button[aria-label="Add files and more"]')),
    generalFileInput: !!(form && form.querySelector('input[type="file"]:not([accept*="image"])')),
    sidebar: {
      projectRows: rows.length,
      rowsWithLabelAndId: rows.filter((row) => row.hasAttribute("data-app-action-sidebar-project-label") && row.hasAttribute("data-app-action-sidebar-project-id")).length,
      createProject: !!document.querySelector("[data-app-action-sidebar-project-create]"),
      newChatInButtons: all('button[aria-label^="New chat in "]').length,
      projectActions: all('button[aria-label^="Project actions for "]').length
    },
    messages: {
      user: units.filter((unit) => /:user$/.test(keyOf(unit))).length,
      assistant: units.filter((unit) => /:assistant$/.test(keyOf(unit))).length,
      selectionIds: all("[data-chatgpt-selection-message-id]").filter(visible).length,
      userBubbles: all("[data-user-message-bubble]").filter(visible).length
    },
    // Markers plus the renderer families seen: web-search answers moved to a
    // data-d-component renderer on 2026-10-10 with the same copy markers, and
    // only this told the two apart.
    markdown: { copyKinds: [...new Set([
      ...all("[data-markdown-copy]").map((el) => el.getAttribute("data-markdown-copy") || ""),
      ...(document.querySelector("[data-d-component]") ? ["renderer:data-d-component"] : []),
      ...(document.querySelector(".cm-content") ? ["renderer:codemirror"] : [])
    ])].sort() }
  };
})()`;

/**
 * Judge one run against what prodex needs, and against the previous run.
 *
 * A check that can only be judged on some pages (messages on a conversation,
 * project controls when the account has projects) is skipped elsewhere rather
 * than failed, and a sidebar that HAD project rows and now has none counts as
 * broken, since the account did not lose its projects.
 */
export function judgePageCanary(facts, previous, knownMarkers) {
  const failures = [];
  const fail = (check, detail) => {
    failures.push({ check, detail });
  };
  if (!facts.composer.editor) fail("composer", "no visible prompt editor");
  else if (!facts.composer.inForm) fail("composer", "the prompt editor is not inside a form");
  if (facts.composer.inForm) {
    if (!facts.modelButton) fail("model selector", 'no "Select ChatGPT model" button in the composer');
    if (!facts.toolsButton) fail("tools button", 'no "Add files and more" control in the composer');
    if (!facts.generalFileInput) fail("file input", "no general file input in the composer form");
  }
  const rows = facts.sidebar.projectRows;
  if (rows > 0) {
    if (facts.sidebar.rowsWithLabelAndId !== rows) fail("project rows", `${rows - facts.sidebar.rowsWithLabelAndId} of ${rows} project rows lack their label or id attribute`);
    if (facts.sidebar.newChatInButtons !== rows) fail("project entry", `${facts.sidebar.newChatInButtons} "New chat in" controls for ${rows} project rows`);
    if (facts.sidebar.projectActions !== rows) fail("project actions", `${facts.sidebar.projectActions} "Project actions for" controls for ${rows} project rows`);
  } else if (previous && previous.sidebar.projectRows > 0) {
    fail("project rows", `the sidebar showed ${previous.sidebar.projectRows} project rows last time and none now`);
  }
  if (!facts.sidebar.createProject) fail("project create", "no add-project control in the sidebar");
  if (facts.pageKind === "conversation") {
    if (facts.messages.user + facts.messages.assistant === 0) fail("message units", "a conversation page with no visible message units");
    if (facts.messages.user > 0 && facts.messages.userBubbles === 0) fail("user turns", "user turns without a user message bubble");
    if (facts.messages.assistant > 0 && facts.messages.selectionIds === 0) fail("assistant turns", "assistant turns without a selection message id");
  }
  const changes = [];
  // An idle tab keeps the build it loaded, so the build ChatGPT serves now
  // (liveBuild, read from the homepage) decides; the tab's is the fallback.
  const buildOf = (run) => (run ? run.liveBuild ?? run.build : undefined);
  const buildChanged = Boolean(previous && buildOf(previous) !== buildOf(facts));
  if (buildChanged) changes.push({ check: "build", detail: `${buildOf(previous) ?? "unknown"} -> ${buildOf(facts) ?? "unknown"}` });
  if (facts.liveBuild && facts.build && facts.liveBuild !== facts.build) {
    changes.push({ check: "stale tab", detail: `the tab still runs ${facts.build}; ChatGPT now serves ${facts.liveBuild}, so the controls above were read from the older build` });
  }
  // Which markers a page carries depends on the answer on screen (a short
  // reply has no code block), so a marker counts as new only against every
  // marker seen before, not against the previous page.
  if (knownMarkers && knownMarkers.length > 0) {
    const added = facts.markdown.copyKinds.filter((kind) => !knownMarkers.includes(kind));
    if (added.length > 0) changes.push({ check: "markdown markers", detail: `new: ${added.join(", ")}` });
  }
  return { status: failures.length > 0 ? "broken" : changes.length > 0 ? "changed" : "ok", buildChanged, failures, changes };
}


const EXIT = { ok: 0, skipped: 0, changed: 3, broken: 2 };

/** Whether a consult holds the browser: the send lock exists and its holder is alive. */
async function sendLockHeld(lockFile) {
  let raw;
  try {
    raw = await readFile(lockFile, "utf8");
  } catch {
    return false;
  }
  try {
    const pid = JSON.parse(raw)?.pid;
    if (!Number.isInteger(pid)) return true;
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // A lock we cannot parse is treated as held; a dead holder is not.
    return error?.code === "EPERM" || !(error instanceof Error && "code" in error);
  }
}

// The build ChatGPT serves now, from its homepage HTML fetched inside the tab
// (same request as opening the page; nothing is navigated). Measured
// 2026-10-10: an idle tab still showed build 4c511f80 for hours after
// 314720d0 was being served, so the hourly canary never saw the change.
const LIVE_BUILD_EXPRESSION = `fetch("/", { credentials: "include", cache: "no-store" })
  .then((response) => response.text())
  .then((html) => (html.match(/data-build="([0-9a-f]+)"/) || [])[1] || null)
  .catch(() => null)`;

function readLiveBuild(ws, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== 2) return;
      clearTimeout(timer);
      const value = message.result?.result?.value;
      resolve(typeof value === "string" ? value : null);
    });
    ws.send(JSON.stringify({ id: 2, method: "Runtime.evaluate", params: { expression: LIVE_BUILD_EXPRESSION, returnByValue: true, awaitPromise: true } }));
  });
}

/**
 * A page that just loaded can be judged before its composer renders: right
 * after a browser restart on 2026-10-10 the first run reported "broken: model
 * selector" and the next was ok. A broken read is read again after a pause and
 * counts only if it stays broken.
 */
export async function settledPageFacts(read, isBroken, { attempts = 3, waitMs = 10_000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  let facts = await read();
  for (let attempt = 1; attempt < attempts && isBroken(facts); attempt += 1) {
    await sleep(waitMs);
    facts = await read();
  }
  return facts;
}

async function readPageFacts(port, timeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal })).json();
  const page = pages.find((p) => p.type === "page" && /^https:\/\/chatgpt\.com\//.test(p.url));
  if (!page) throw Object.assign(new Error("no ChatGPT tab"), { skip: "no ChatGPT tab is open" });
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  try {
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("could not connect to the tab")), { once: true });
      setTimeout(() => reject(new Error("the tab did not accept a connection")), timeoutMs);
    });
    return await new Promise((resolve, reject) => {
      ws.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        if (message.id !== 1) return;
        const value = message.result?.result?.value;
        if (value && typeof value === "object") resolve(value);
        else reject(new Error(message.result?.exceptionDetails?.text ?? "the page returned nothing"));
      });
      ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: PAGE_CANARY_EXPRESSION, returnByValue: true } }));
      setTimeout(() => reject(Object.assign(new Error("the tab did not answer"), { skip: "the tab did not answer (busy or crashed)" })), timeoutMs);
    }).then(async (facts) => ({ ...facts, liveBuild: await readLiveBuild(ws, timeoutMs) }));
  } finally {
    ws.close();
  }
}

function flag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const port = Number(flag("--port") ?? 9333);
  const timeoutMs = Number(flag("--timeout-ms") ?? 10_000);
  const json = process.argv.includes("--json");
  const prodexDir = path.join(os.homedir(), ".local", "share", "prodex");
  const statePath = flag("--state-file") ?? path.join(prodexDir, "page-canary.json");
  const lockFile = process.env.PRODEX_SEND_LOCK_FILE ?? path.join(prodexDir, "browser-send.lock");
  let state = { history: [] };
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8"));
    if (parsed && Array.isArray(parsed.history)) state = parsed;
  } catch {
    // First run, or an unreadable state file: start over.
  }
  const at = new Date().toISOString();
  const save = async () => {
    state.history = state.history.slice(-19);
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  };
  const skip = async (reason) => {
    state.history.push({ at, build: state.last?.facts.build ?? null, status: "skipped", detail: reason });
    await save();
    console.log(json ? JSON.stringify({ status: "skipped", reason }, null, 2) : `canary: skipped - ${reason}; nothing was judged.`);
    return EXIT.skipped;
  };
  let facts;
  try {
    facts = await settledPageFacts(
      async () => {
        // A consult that starts between reads changes the page; leave it alone.
        if (await sendLockHeld(lockFile)) throw Object.assign(new Error("busy"), { skip: "a consult is using the browser" });
        return readPageFacts(port, timeoutMs);
      },
      (read) => judgePageCanary(read, state.last?.facts, state.knownMarkers).status === "broken"
    );
  } catch (error) {
    return skip(error?.skip ?? `the browser is not available (${error instanceof Error ? error.message : String(error)})`);
  }
  const verdict = judgePageCanary(facts, state.last?.facts, state.knownMarkers);
  state.knownMarkers = [...new Set([...(state.knownMarkers ?? []), ...facts.markdown.copyKinds])].sort();
  state.last = { at, facts, verdict };
  state.history.push({ at, build: facts.liveBuild ?? facts.build, status: verdict.status, ...(verdict.failures.length > 0 ? { detail: verdict.failures.map((f) => f.check).join(", ") } : {}) });
  await save();
  if (json) {
    console.log(JSON.stringify({ status: verdict.status, build: facts.liveBuild ?? facts.build, tabBuild: facts.build, page: facts.pageKind, failures: verdict.failures, changes: verdict.changes }, null, 2));
  } else {
    console.log(`canary: ${verdict.status} build=${facts.liveBuild ?? facts.build ?? "unknown"} page=${facts.pageKind}`);
    for (const change of verdict.changes) console.log(`changed: ${change.check} - ${change.detail}`);
    for (const failure of verdict.failures) console.log(`broken: ${failure.check} - ${failure.detail}`);
  }
  return EXIT[verdict.status];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
