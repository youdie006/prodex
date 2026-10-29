import { afterEach, describe, expect, it, vi } from "vitest";

import {
  menuOpenExpression,
  modelButtonRectExpression,
  modelSelectorReadsClosedExpression,
  waitForModelMenu
} from "../src/chatgpt-browser.js";

// Measured 2026-10-29 with the host under load: a send that started from a
// conversation reached the new chat, pressed the model selector, and nothing
// happened - a trusted pointerdown and pointerup reached the selector while it
// read closed, aria-expanded stayed false and no menu was added. Two of every
// four such sends failed with "model menu did not open", alternating with the
// sends that started from the home page.
function fakeCdp(options: { opensOnPress: number; readsClosed?: () => boolean }) {
  let presses = 0;
  const cdp = {
    send: async (method: string, params: { type?: string } = {}) => {
      if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed") presses += 1;
      return { result: {} };
    },
    evaluate: async (expression: string) => {
      if (expression === menuOpenExpression()) return presses >= options.opensOnPress;
      if (expression === modelSelectorReadsClosedExpression()) return options.readsClosed ? options.readsClosed() : presses < options.opensOnPress;
      if (expression === modelButtonRectExpression()) return { ok: true, x: 40, y: 600, label: "Thinking effort" };
      // The hover check before each press.
      if (expression.includes("data-prodex-click")) return true;
      return undefined;
    }
  };
  return { cdp, presses: () => presses };
}

describe("a model selector press the page ignored", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("presses the selector again while it still reads closed", async () => {
    vi.useFakeTimers();
    // The first press (made by the caller) was ignored; one more opens it.
    const { cdp, presses } = fakeCdp({ opensOnPress: 1 });
    const opened = waitForModelMenu(cdp as never);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(opened).resolves.toBe(true);
    expect(presses()).toBe(1);
  });

  it("leaves a selector alone once it reads open, even before its menu paints", async () => {
    vi.useFakeTimers();
    let painted = false;
    setTimeout(() => {
      painted = true;
    }, 2_500);
    const { cdp, presses } = fakeCdp({ opensOnPress: 0, readsClosed: () => false });
    const base = cdp.evaluate;
    cdp.evaluate = async (expression: string) => (expression === menuOpenExpression() ? painted : base(expression));
    const opened = waitForModelMenu(cdp as never);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(opened).resolves.toBe(true);
    expect(presses()).toBe(0);
  });

  it("presses only once more before reporting the menu did not open", async () => {
    vi.useFakeTimers();
    const { cdp, presses } = fakeCdp({ opensOnPress: Number.POSITIVE_INFINITY });
    const opened = waitForModelMenu(cdp as never);
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(opened).resolves.toBe(false);
    expect(presses()).toBe(1);
  });
});

describe("whether the model selector reads closed", () => {
  const run = (triggers: Array<{ expanded: string | null; visible?: boolean }>, menuOpen = false) =>
    new Function(
      "document",
      `return ${modelSelectorReadsClosedExpression()};`
    )({
      querySelectorAll: () =>
        triggers.map((trigger) => ({
          getAttribute: (name: string) => (name === "aria-expanded" ? trigger.expanded : null),
          getClientRects: () => (trigger.visible === false ? [] : [{}])
        })),
      querySelector: () => (menuOpen ? {} : null)
    }) as boolean;

  it("is true for one visible selector marked aria-expanded=false with no menu", () => {
    expect(run([{ expanded: "false" }])).toBe(true);
  });

  it("is false when the selector is open, unmarked, or its menu is on the page", () => {
    expect(run([{ expanded: "true" }])).toBe(false);
    expect(run([{ expanded: null }])).toBe(false);
    expect(run([{ expanded: "false" }], true)).toBe(false);
  });

  it("is false when there is no single visible selector to press", () => {
    expect(run([])).toBe(false);
    expect(run([{ expanded: "false" }, { expanded: "false" }])).toBe(false);
    expect(run([{ expanded: "false", visible: false }])).toBe(false);
  });
});
