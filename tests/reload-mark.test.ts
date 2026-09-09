import { describe, expect, it } from "vitest";

import {
  freshChatGptHomeReadyExpression,
  markDocumentForReloadExpression,
  reloadedDocumentReadyExpression
} from "../src/chatgpt-browser.js";

// Polling readyState and the composer after asking for a reload confirmed the
// document being LEFT: both are already "complete" and present there, for as
// long as the reload takes to commit. The stamp put on the old document cannot
// survive the navigation, so only a document without it can be the new one.
function run(expression: string, window: Record<string, unknown>, document: Record<string, unknown>): unknown {
  return new Function("window", "document", `return ${expression};`)(window, document);
}

const composerPresent = { readyState: "complete", querySelector: () => ({}) };
const noComposer = { readyState: "complete", querySelector: () => null };

describe("telling the reloaded document from the one it replaced", () => {
  it("stamps the document that is about to be reloaded", () => {
    const window: Record<string, unknown> = {};
    expect(run(markDocumentForReloadExpression(), window, composerPresent)).toBe(true);
    expect(Object.keys(window)).toHaveLength(1);
  });

  it("refuses the stamped document even though it is complete and has a composer", () => {
    const window: Record<string, unknown> = {};
    run(markDocumentForReloadExpression(), window, composerPresent);
    expect(run(reloadedDocumentReadyExpression(), window, composerPresent)).toBe(false);
  });

  it("waits for the new document to finish loading and render its composer", () => {
    expect(run(reloadedDocumentReadyExpression(), {}, { ...composerPresent, readyState: "loading" })).toBe(false);
    expect(run(reloadedDocumentReadyExpression(), {}, noComposer)).toBe(false);
    expect(run(reloadedDocumentReadyExpression(), {}, composerPresent)).toBe(true);
  });

  it("applies the caller's extra condition on top", () => {
    expect(run(reloadedDocumentReadyExpression("1 === 2"), {}, composerPresent)).toBe(false);
    expect(run(reloadedDocumentReadyExpression("1 === 1"), {}, composerPresent)).toBe(true);
  });
});

// The recovery for a composer bound to the wrong project opens a fresh root,
// then clicks a sidebar row on whatever page it left behind. A false "fresh"
// therefore clicks on the OLD document and walks straight back into the
// binding it exists to shed, so every clause is worth an assertion.
describe("proving the tab reached a fresh chatgpt.com root", () => {
  const composerRoot = { tagName: "FORM", querySelectorAll: () => [] };
  const composer = {
    getBoundingClientRect: () => ({ width: 420, height: 48 }),
    parentElement: { closest: () => null },
    closest: (selector: string) => (selector === "form" ? composerRoot : null)
  };
  // The 0x0 fallback textarea ChatGPT ships ahead of the real editor: the
  // broad selector finds it, the composer finder rejects it on size.
  const hiddenFallback = { ...composer, getBoundingClientRect: () => ({ width: 0, height: 0 }) };

  function onPage(options: { href: string; composers: unknown[]; stamped?: boolean }): boolean {
    const window: Record<string, unknown> = {};
    const document = {
      readyState: "complete",
      querySelector: () => (options.composers.length > 0 ? {} : null),
      querySelectorAll: () => options.composers
    };
    if (options.stamped) run(markDocumentForReloadExpression(), window, document);
    return new Function("window", "document", "location", `return ${freshChatGptHomeReadyExpression()};`)(
      window,
      document,
      { href: options.href }
    ) as boolean;
  }

  it("accepts a new root document that rendered a real composer", () => {
    expect(onPage({ href: "https://chatgpt.com/", composers: [composer] })).toBe(true);
    expect(onPage({ href: "https://chatgpt.com/?model=auto", composers: [composer] })).toBe(true);
  });

  it("refuses the document that asked for the navigation, however complete it looks", () => {
    expect(onPage({ href: "https://chatgpt.com/", composers: [composer], stamped: true })).toBe(false);
  });

  it("refuses a document that never left the project home", () => {
    expect(onPage({ href: "https://chatgpt.com/g/g-p-000000/project", composers: [composer] })).toBe(false);
  });

  it("refuses a root whose only editable is the hidden fallback", () => {
    expect(onPage({ href: "https://chatgpt.com/", composers: [hiddenFallback] })).toBe(false);
  });
});
