import { describe, expect, it } from "vitest";

import { focusPowerSliderExpression, powerSliderStateExpression } from "../src/chatgpt-browser.js";

// Whether the power slider is THERE was asked inside the picker, but which
// slider to read and to drive was asked of the whole document. Any other
// slider on the page - and ChatGPT has them elsewhere - therefore became the
// one prodex focused and sent arrow keys to, in someone's real session, while
// the presence check happily reported the picker's.
describe("finding the power slider", () => {
  const fakeSlider = (attrs: Record<string, string | null>) => ({
    getAttribute: (name: string) => attrs[name] ?? null,
    focus() {
      focused = attrs.id ?? null;
    }
  });
  let focused: string | null = null;

  const buildDocument = () => {
    const strayFirst = fakeSlider({ id: "stray", "aria-valuenow": "9", "aria-valuemin": "0", "aria-valuemax": "9" });
    const pickerSlider = fakeSlider({ id: "picker", "aria-valuenow": "2", "aria-valuemin": "0", "aria-valuemax": "4" });
    const menu = {
      innerText: "Latest\nHigh",
      contains: (node: unknown) => node === pickerSlider,
      querySelector: (selector: string) => (selector.includes("slider") ? pickerSlider : null),
      querySelectorAll: () => [
        {
          innerText: "Latest\nHigh",
          textContent: "Latest\nHigh",
          getAttribute: (name: string) => (name === "role" ? "menuitem" : null),
          contains: () => false
        }
      ]
    };
    return {
      querySelector(selector: string) {
        // The stray slider comes first in document order, which is exactly the
        // case a document-wide lookup gets wrong.
        if (selector === '[role="slider"]') return strayFirst;
        if (selector.includes("composer-intelligence-picker-content")) {
          return selector.includes("slider") ? pickerSlider : menu;
        }
        return null;
      },
      get activeElement() {
        return focused === "picker" ? pickerSlider : null;
      }
    };
  };

  it("reads the picker's slider, not whichever one comes first in the document", () => {
    const state = new Function("document", `return ${powerSliderStateExpression()}`)(buildDocument());
    expect(state).toMatchObject({ ok: true, position: 2, max: 4 });
  });

  it("focuses the picker's slider, so arrow keys cannot land on another control", () => {
    focused = null;
    const result = new Function("document", `return ${focusPowerSliderExpression()}`)(buildDocument());
    expect(focused).toBe("picker");
    expect(result).toMatchObject({ ok: true });
  });
});
