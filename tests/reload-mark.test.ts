import { describe, expect, it } from "vitest";

import { markDocumentForReloadExpression, reloadedDocumentReadyExpression } from "../src/chatgpt-browser.js";

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
