import { describe, expect, it } from "vitest";

import { modelButtonRectExpression } from "../src/chatgpt-browser.js";

// Measured 2026-09-29 on the installed 0.40.20: every send that started on a
// fresh chat failed with "model menu did not open". The composer had not
// rendered yet, the lookup fell back to the whole document, and the first menu
// button with text in it was the sidebar's "Pinned" (or "Explore"). prodex
// clicked a sidebar menu in the user's session. A project send passed only
// because its page had already rendered the composer.
type Fake = Record<string, unknown>;

function el(opts: { aria?: string; text?: string; width?: number; form?: Fake | null; haspopup?: boolean }): Fake {
  const node: Fake = {
    textContent: opts.text ?? "",
    getAttribute: (n: string) => (n === "aria-label" ? opts.aria ?? null : n === "aria-haspopup" ? (opts.haspopup ? "menu" : null) : null),
    getBoundingClientRect: () => ({ x: 100, y: 300, width: opts.width ?? 40, height: 30 }),
    closest: (s: string) => (s === "form" ? opts.form ?? null : null),
    scrollIntoView: () => undefined,
    setAttribute: () => undefined,
    removeAttribute: () => undefined
  };
  return node;
}

function page(opts: { composer: boolean; triggerInForm: boolean }) {
  const sidebarPinned = el({ text: "Pinned", haspopup: true });
  const trigger = el({ aria: "Select ChatGPT model", text: "Pro", haspopup: true });
  const form: Fake = {
    querySelectorAll: (s: string) => {
      if (!opts.triggerInForm) return [];
      return s.includes("Select ChatGPT model") || s.includes("aria-haspopup") ? [trigger] : [];
    }
  };
  const composer = el({ width: opts.composer ? 540 : 0, form });
  return {
    trigger,
    document: {
      querySelectorAll: (s: string) => (s.includes("prompt-textarea") ? [composer] : s.includes("aria-haspopup") ? [sidebarPinned, trigger] : []),
      querySelector: () => null
    }
  };
}

const run = (document: unknown) =>
  new Function("document", "getComputedStyle", `return ${modelButtonRectExpression()};`)(document, () => ({ pointerEvents: "auto" })) as {
    ok: boolean;
    reason?: string;
    label?: string;
  };

describe("finding the model trigger", () => {
  it("never reaches for a sidebar menu while the composer is still rendering", () => {
    const result = run(page({ composer: false, triggerInForm: true }).document);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/composer has not rendered/);
  });

  it("takes the exact trigger inside the rendered composer", () => {
    const result = run(page({ composer: true, triggerInForm: true }).document);
    expect(result.ok).toBe(true);
    expect(result.label).toBe("Select ChatGPT model");
  });

  it("reports not found rather than falling back to the document", () => {
    const result = run(page({ composer: true, triggerInForm: false }).document);
    expect(result.ok).toBe(false);
  });
});
