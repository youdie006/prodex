import { describe, expect, it } from "vitest";

import { composerInsertBudgetMs } from "../src/chatgpt-browser.js";

// Measured 2026-10-13 on the live composer: one in-page insert took 10 s for
// 15 KB, 34 s for 30 KB, and 63 s then 126 s for the same 57 KB (it was ~20 s for 67 KB when the
// budget was set), so a 57 KB prompt hit the old 60 s budget and failed with
// "Chrome DevTools command timed out: Runtime.evaluate".
describe("the budget for one large composer insert", () => {
  it("covers the measured insert times with room to spare", () => {
    expect(composerInsertBudgetMs(15_000)).toBeGreaterThanOrEqual(2 * 10_000);
    expect(composerInsertBudgetMs(30_000)).toBeGreaterThanOrEqual(2 * 34_000);
    expect(composerInsertBudgetMs(57_000)).toBeGreaterThanOrEqual(2 * 126_000);
  });

  it("keeps a one-minute floor for anything that takes this path", () => {
    expect(composerInsertBudgetMs(4_001)).toBe(60_000);
  });
});
