import { describe, expect, it } from "vitest";

import { chatSurfaceProbeExpression } from "../src/chatgpt-browser.js";

// Reading which surface is live happens on every send, and used to go through
// the click-point helper - which scrolls the element into view and tags the
// DOM. A read that scrolls the page is a side effect nobody asked for, and the
// confirmation loop repeated it up to fourteen times per send.
describe("reading which ChatGPT surface is live", () => {
  const build = (cookie: string, stored: string | null, labels: [string, boolean][] = []) => {
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
      cookie,
      get scrolled() {
        return scrolled;
      }
    };
    const localStorage = { getItem: () => stored };
    const result = new Function("document", "localStorage", `return ${chatSurfaceProbeExpression()}`)(doc, localStorage);
    return { result, scrolled: doc.scrolled };
  };

  it("does not touch the page to answer the question", () => {
    const { result, scrolled } = build("oai-chat-surface-mode=work", null, [
      ["Chat", false],
      ["Work", true]
    ]);
    expect(scrolled).toBe(false);
    expect(result.storedMode).toBe("work");
    expect(result.surfaces).toEqual([
      { label: "Chat", checked: false },
      { label: "Work", checked: true }
    ]);
  });

  it("prefers the stored value and reads the cookie only as a fallback", () => {
    expect(build("oai-chat-surface-mode=work", '"chat"').result.storedMode).toBe('"chat"');
  });

  it("matches the cookie by name rather than by suffix", () => {
    // A cookie whose name merely ends with the one being looked for must not
    // answer for it.
    expect(build("x-oai-chat-surface-mode=work; other=1", null).result.storedMode).toBe("");
    expect(build("other=1; oai-chat-surface-mode=chat", null).result.storedMode).toBe("chat");
  });
});
