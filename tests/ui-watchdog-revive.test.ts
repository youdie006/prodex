import { describe, expect, it } from "vitest";

import { REVIVE_INTERVAL_MS, shouldReviveBrowser } from "../scripts/ui-watchdog.mjs";

// Measured 2026-10-10: the machine's earlyoom ended the dedicated browser twice
// (about 11:49 and 17:45 KST) and the hourly canary could only log "skipped"
// until someone restarted it by hand. The watchdog may now start it once, but
// never more often than every few hours, and never over a consult.
const now = Date.parse("2026-10-10T10:17:00Z");
const gone = "canary: skipped - the browser is not available (The operation was aborted due to timeout); nothing was judged.";

describe("reviving the dedicated browser", () => {
  it("revives a browser that is gone", () => {
    expect(shouldReviveBrowser(gone, undefined, now)).toBe(true);
  });

  it("reopens a missing ChatGPT tab", () => {
    expect(shouldReviveBrowser("canary: skipped - no ChatGPT tab is open; nothing was judged.", undefined, now)).toBe(true);
  });

  it("leaves a browser that a consult is using alone", () => {
    expect(shouldReviveBrowser("canary: skipped - a consult is using the browser; nothing was judged.", undefined, now)).toBe(false);
    expect(shouldReviveBrowser("canary: skipped - the tab did not answer (busy or crashed); nothing was judged.", undefined, now)).toBe(false);
  });

  it("does nothing when the page was judged", () => {
    expect(shouldReviveBrowser("canary: ok build=314720d0 page=root", undefined, now)).toBe(false);
  });

  it("starts it at most once per interval, so a browser that keeps dying is not relaunched every hour", () => {
    expect(shouldReviveBrowser(gone, now - 60 * 60_000, now)).toBe(false);
    expect(shouldReviveBrowser(gone, now - REVIVE_INTERVAL_MS, now)).toBe(true);
  });
});
