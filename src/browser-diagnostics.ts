/**
 * Capture what the page looked like when a send failed.
 *
 * Every UI break in this project has cost a live debugging session: opening the
 * picker by hand, reading rects, asking elementFromPoint what was on top. A
 * report from another machine cannot carry any of that, so the same archaeology
 * gets repeated by whoever can reproduce it.
 *
 * These stay LOCAL and are never attached to anything. A screenshot of ChatGPT
 * shows the conversation, so the capture is a debugging aid for the person who
 * hit the failure, not something to hand out - the same line `pro report-issue`
 * already draws.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface DiagnosticsTarget {
  /** Runtime.evaluate against the page, returning a value. */
  evaluate: <T>(expression: string) => Promise<T>;
  /** Raw CDP command, used for Page.captureScreenshot. */
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
}

/** Whether the caller asked for captures. Off unless explicitly turned on. */
export function diagnosticsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.PRODEX_BROWSER_DIAGNOSTICS;
  return raw !== undefined && raw !== "" && raw !== "0" && raw.toLowerCase() !== "false";
}

/** Where a capture for this failure belongs. */
export function diagnosticsDir(cwd: string, label: string): string {
  const safe = label.replace(/[^A-Za-z0-9_.-]+/g, "-").slice(0, 80) || "capture";
  return path.join(cwd, ".bridge", "diagnostics", safe);
}

/**
 * What the picker and composer looked like: the shape prodex needs in order to
 * drive them, read the way the failing code reads it.
 */
export function pageShapeExpression(): string {
  return `(() => {
    const vis = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const box = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
    const menu = document.querySelector('[data-testid="composer-intelligence-picker-content"]');
    const describe = (el) => ({
      role: el.getAttribute("role"),
      testid: el.getAttribute("data-testid"),
      label: (el.innerText || "").replace(/\\n+/g, " / ").trim().slice(0, 60),
      checked: el.getAttribute("aria-checked"),
      haspopup: el.getAttribute("aria-haspopup"),
      valuenow: el.getAttribute("aria-valuenow"),
      valuemax: el.getAttribute("aria-valuemax"),
      valuetext: el.getAttribute("aria-valuetext"),
      // The reason a click can be refused at every coordinate on a row.
      pointerEvents: getComputedStyle(el).pointerEvents,
      ...box(el)
    });
    return {
      url: location.href,
      title: document.title,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      pickerOpen: Boolean(menu),
      picker: menu ? { ...box(menu), items: [...menu.querySelectorAll('[role],button')].filter(vis).map(describe) } : null,
      composerButtons: [...document.querySelectorAll('form button,form [role="button"]')].filter(vis).map(describe)
    };
  })()`;
}

export interface CaptureResult {
  dir: string;
  files: string[];
}

/**
 * Write a screenshot and a shape snapshot next to each other. Failing to
 * capture must never replace the failure being captured, so every step here is
 * best effort and the caller gets back only what actually landed.
 */
export async function captureBrowserDiagnostics(
  target: DiagnosticsTarget,
  input: { cwd: string; label: string }
): Promise<CaptureResult | undefined> {
  const dir = diagnosticsDir(input.cwd, input.label);
  const files: string[] = [];
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  } catch {
    return undefined;
  }
  try {
    const shape = await target.evaluate<unknown>(pageShapeExpression());
    const file = path.join(dir, "page-shape.json");
    await writeFile(file, `${JSON.stringify(shape, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    files.push(file);
  } catch {
    // A page that cannot answer is itself worth knowing, but not worth failing over.
  }
  try {
    // Some targets refuse captureScreenshot until the Page domain is on, and the
    // failure is silent - the first capture written here came back with the
    // shape and no image.
    await target.send("Page.enable").catch(() => undefined);
    const shot = (await target.send("Page.captureScreenshot", { format: "png" })) as { data?: string };
    if (typeof shot?.data === "string" && shot.data.length > 0) {
      const file = path.join(dir, "screen.png");
      await writeFile(file, Buffer.from(shot.data, "base64"), { mode: 0o600 });
      files.push(file);
    }
  } catch {
    // Screenshots are unavailable on some targets; the shape snapshot still helps.
  }
  return files.length > 0 ? { dir, files } : undefined;
}

/** One line telling the user where the capture went, and that it stays put. */
export function diagnosticsNote(capture: CaptureResult | undefined): string | undefined {
  if (!capture) return undefined;
  return (
    `browser_diagnostics: wrote ${capture.files.length} file(s) to ${capture.dir}. ` +
    "They stay on this machine - a screenshot of ChatGPT shows the conversation, so nothing attaches them to a report."
  );
}
