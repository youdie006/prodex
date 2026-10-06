import { afterEach, describe, expect, it } from "vitest";
import { attachmentPresenceExpression, attachmentStateExpression } from "../src/chatgpt-browser.js";

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

  it("recognizes the timestamp ChatGPT puts on a repeated upload since 2026-10", () => {
    // Measured 2026-10-06: "cont-att(20261006-012426).txt" instead of "(3)".
    const state = evaluateWithComposerText(attachmentStateExpression(["cont-att.txt"]), "cont-att(20261006-012426).txt");
    expect(state.present).toEqual(["cont-att.txt"]);
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

describe("leftover attachments in the composer", () => {
  afterEach(() => {
    delete (globalThis as { document?: unknown }).document;
  });

  function countRemovable(buttons: Array<{ label: string; rendered?: boolean }>): number {
    (globalThis as { document?: unknown }).document = {
      querySelectorAll: () =>
        buttons.map((button) => ({
          getAttribute: () => button.label,
          getClientRects: () => (button.rendered === false ? [] : [{}])
        }))
    };
    return ((0, eval)(attachmentPresenceExpression()) as { removed: number }).removed;
  }

  it("counts a chip whose remove button names the file", () => {
    // Measured 2026-10-06: the label is "Remove <file name>", no longer "Remove file 1: ...".
    expect(countRemovable([{ label: "Remove cont-att(20261006-012426).txt" }])).toBe(1);
    expect(countRemovable([{ label: "Remove file 1: deck.pptx" }])).toBe(1);
  });

  it("ignores remove controls that are not files and chips on a hidden page", () => {
    expect(countRemovable([{ label: "Remove Search" }, { label: "Remove" }])).toBe(0);
    expect(countRemovable([{ label: "Remove notes.pdf", rendered: false }])).toBe(0);
  });
});
