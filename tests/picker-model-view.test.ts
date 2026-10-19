import { describe, expect, it } from "vitest";

import { pickerModelViewToggleExpression } from "../src/chatgpt-browser.js";

// Measured 2026-10-19 on ChatGPT build bfc3a09a: the composer picker opens on
// its effort view - a "Pro ›" label over the slider - and the model rows
// (GPT-6, GPT-5.6 Sol) sit underneath it, so every point on "GPT-5.6 Sol" hit
// the slider and `--model "GPT-5.6 Sol"` was refused with "another element
// covers its click point". Clicking the label swaps in the model list.
type Box = { x: number; y: number; w: number; h: number };
class El {
  attrs = new Map<string, string>();
  children: El[] = [];
  constructor(readonly role: string | null, readonly innerText: string, readonly box: Box, readonly hasSlider = false) {
    if (role) this.attrs.set("role", role);
  }
  getAttribute(name: string) { return this.attrs.get(name) ?? null; }
  setAttribute(name: string, value: string) { this.attrs.set(name, value); }
  removeAttribute(name: string) { this.attrs.delete(name); }
  getBoundingClientRect() { const { x, y, w, h } = this.box; return { x, y, width: w, height: h, top: y, left: x, right: x + w, bottom: y + h }; }
  getClientRects() { return this.box.w > 0 ? [this.box] : []; }
  scrollIntoView() {}
  contains(other: unknown) { return other === this; }
  querySelector(selector: string) { return selector === '[role="slider"]' && this.hasSlider ? {} : null; }
}

function picker(modelView: boolean) {
  const label = new El("menuitem", "Pro", { x: 1083, y: 652, w: 55, h: 35 });
  const slider = new El("menuitem", "", { x: 980, y: 691, w: 246, h: 32 }, true);
  const gpt6 = new El("menuitemradio", "GPT-6", { x: 980, y: 661, w: 246, h: 36 });
  const sol = new El("menuitemradio", "GPT-5.6 Sol", { x: 980, y: 697, w: 246, h: 36 });
  const items = [label, slider, gpt6, sol];
  const menu = { querySelectorAll: () => items };
  const front = modelView ? [gpt6, sol] : [label, slider];
  const document = {
    querySelector: () => menu,
    querySelectorAll: () => items,
    elementFromPoint: (x: number, y: number) =>
      front.find((el) => { const r = el.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; }) ?? null
  };
  return { document, label };
}

const run = (document: unknown, requested: string) =>
  new Function("document", "getComputedStyle", `return ${pickerModelViewToggleExpression(requested)};`)(
    document,
    () => ({ pointerEvents: "auto" })
  ) as { needed: boolean; ok?: boolean; x?: number; y?: number };

describe("the picker's model view", () => {
  it("is opened through the effort label when the requested model row is covered", () => {
    const { document, label } = picker(false);
    const result = run(document, "GPT-5.6 Sol");
    expect(result.needed).toBe(true);
    expect(result.ok).toBe(true);
    expect([result.x, result.y]).toEqual([Math.round(1083 + 55 / 2), Math.round(652 + 35 / 2)]);
    expect(label.getAttribute("data-prodex-click")).toBe("1");
  });

  it("is left alone when the model row can already be clicked", () => {
    expect(run(picker(true).document, "GPT-5.6 Sol").needed).toBe(false);
  });

  it("is left alone for a model the picker does not list", () => {
    expect(run(picker(false).document, "GPT-9").needed).toBe(false);
  });
});
