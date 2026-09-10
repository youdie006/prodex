import { describe, expect, it } from "vitest";

import { composerProjectBindingExpression } from "../src/chatgpt-browser.js";

// Measured live on a project home, after a --project-new send refused with "the
// placeholder could not be read" on a page that was perfectly fine:
//
//   TEXTAREA  0x0      placeholder="New chat in <name>"  aria-label="New chat in <name>"
//   DIV       531x42   #prompt-textarea  data-placeholder=null  aria-label="New chat in <name>"
//
// The editor prodex types into is the div, and it keeps the label ONLY in
// aria-label. The textarea that does carry `placeholder` is the hidden 0x0
// fallback the composer finder rejects on size - correctly. Reading one
// attribute meant the label was on the page and prodex could not see it, so
// the fail-closed branch refused every project send.
function readLabel(attributes: Record<string, string | null>): string | undefined {
  const composerRoot = { tagName: "FORM", querySelectorAll: () => [] };
  const composer = {
    getAttribute: (name: string) => attributes[name] ?? null,
    getBoundingClientRect: () => ({ width: 531, height: 42 }),
    parentElement: { closest: () => null },
    closest: (selector: string) => (selector === "form" ? composerRoot : null),
    setAttribute: () => undefined
  };
  const document = {
    querySelector: () => null,
    querySelectorAll: (selector: string) => (selector.includes("contenteditable") ? [composer] : [])
  };
  const read = new Function("document", `return ${composerProjectBindingExpression()};`)(document) as {
    found: boolean;
    placeholder?: string;
  };
  return read.found ? read.placeholder : undefined;
}

describe("finding the label the composer names its project with", () => {
  it("reads it from aria-label, which is where the live editor keeps it", () => {
    expect(readLabel({ "data-placeholder": null, placeholder: null, "aria-label": "New chat in Notes" })).toBe(
      "New chat in Notes"
    );
  });

  it("still reads data-placeholder, which is where it was first measured", () => {
    expect(readLabel({ "data-placeholder": "New chat in Notes", "aria-label": null })).toBe("New chat in Notes");
  });

  // Whatever the page names it, the project has to survive the read intact:
  // the caller compares it by equality and refuses on anything else.
  it("prefers the placeholder when both are there and they agree", () => {
    expect(readLabel({ "data-placeholder": "New chat in Notes", "aria-label": "New chat in Notes" })).toBe(
      "New chat in Notes"
    );
  });

  it("reports an empty label rather than inventing one", () => {
    expect(readLabel({ "data-placeholder": null, placeholder: null, "aria-label": null })).toBe("");
  });
});
