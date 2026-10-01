import { afterEach, describe, expect, it } from "vitest";
import { attachmentStateExpression } from "../src/chatgpt-browser.js";

function evaluateWithComposerText(expression: string, text: string): { present: string[] } {
  const globals = globalThis as { document?: unknown };
  globals.document = { body: { innerText: text }, querySelectorAll: () => [] };
  return (0, eval)(expression) as { present: string[] };
}

describe("attachment state", () => {
  afterEach(() => {
    delete (globalThis as { document?: unknown }).document;
  });

  it("recognizes an upload that ChatGPT renamed because the name was used before", () => {
    // Uploading the same file name again makes ChatGPT show "name(3).txt";
    // matching only the original name waited out the whole upload budget.
    const state = evaluateWithComposerText(attachmentStateExpression(["probe.txt"]), "probe(3).txt");
    expect(state.present).toEqual(["probe.txt"]);
  });

  it("renames without an extension too", () => {
    const state = evaluateWithComposerText(attachmentStateExpression(["Makefile"]), "Makefile(2)");
    expect(state.present).toEqual(["Makefile"]);
  });

  it("does not count a different file that only shares the stem", () => {
    const state = evaluateWithComposerText(attachmentStateExpression(["probe.txt"]), "probe-old.txt probe.md");
    expect(state.present).toEqual([]);
  });
});
