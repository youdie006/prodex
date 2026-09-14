import { describe, expect, it } from "vitest";

import { chatSurfaceProbeExpression } from "../src/chatgpt-browser.js";

// Reading which surface is live happens on every send, and used to go through
// the click-point helper - which scrolls the element into view and tags the
// DOM. A read that scrolls the page is a side effect nobody asked for, and the
// confirmation loop repeated it up to fourteen times per send.
describe("reading which ChatGPT surface is live", () => {
  const build = (labels: [string, boolean][] = []) => {
    let scrolled = false;
    const buttons = labels.map(([text, checked]) => ({
      innerText: text,
      textContent: text,
      getAttribute: (name: string) => (name === "aria-checked" ? String(checked) : null),
      scrollIntoView() {
        scrolled = true;
      },
      setAttribute() {
        scrolled = true;
      }
    }));
    const doc = {
      querySelectorAll: () => buttons,
      querySelectorAllCalled: true,
      get scrolled() {
        return scrolled;
      }
    };
    const result = new Function("document", `return ${chatSurfaceProbeExpression()}`)(doc);
    return { result, scrolled: doc.scrolled };
  };

  it("does not touch the page to answer the question", () => {
    const { result, scrolled } = build([
      ["Chat", false],
      ["Work", true]
    ]);
    expect(scrolled).toBe(false);
    expect(result.surfaces).toEqual([
      { label: "Chat", checked: false },
      { label: "Work", checked: true }
    ]);
  });

  it("does not inspect persisted browser state when the toggle is absent", () => {
    expect(build().result).toEqual({ surfaces: [] });
    expect(chatSurfaceProbeExpression()).not.toContain("localStorage");
    expect(chatSurfaceProbeExpression()).not.toContain("cookie");
  });
});
