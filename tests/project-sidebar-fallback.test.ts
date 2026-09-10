import { describe, expect, it } from "vitest";

import { projectItemRectExpression } from "../src/chatgpt-browser.js";

// The sidebar row is normally found by its "Open project options for <name>"
// button, compared by equality - a bare .includes() there once let "Codex"
// select "Codex Review" and sent the prompt into a project nobody named. The
// FALLBACK for a sidebar whose option buttons cannot be read kept that exact
// substring match, so the bug survived wherever the primary path did not apply.
interface FakeRow {
  name: string;
  rect?: { x: number; y: number; width: number; height: number };
}

function findRow(rows: FakeRow[], wanted: string): { ok: boolean; x?: number; y?: number; reason?: string } {
  const elements = rows.map((row) => {
    const element = {
      innerText: `${row.name}\n3 chats`,
      textContent: `${row.name} 3 chats`,
      getBoundingClientRect: () => row.rect ?? { x: 0, y: 100, width: 220, height: 40 },
      scrollIntoView: () => undefined,
      setAttribute: () => undefined,
      removeAttribute: () => undefined,
      // No "open project home" button: this is the older row the fallback is for.
      querySelector: () => null
    };
    return { element, icon: { closest: () => element } };
  });
  const document = {
    querySelectorAll: (selector: string) =>
      selector === '[data-testid="project-folder-icon"]' ? elements.map((entry) => entry.icon) : []
  };
  return new Function(
    "document",
    "getComputedStyle",
    `return ${projectItemRectExpression(wanted)};`
  )(document, () => ({ pointerEvents: "auto" }));
}

describe("finding a project row without its options button", () => {
  it("refuses a project whose name merely starts the same way", () => {
    const hit = findRow([{ name: "Codex Review" }], "Codex");
    expect(hit.ok).toBe(false);
    expect(hit.reason).toMatch(/not found in sidebar/i);
  });

  it("takes the row whose name is the one that was asked for", () => {
    const hit = findRow([{ name: "Codex Review" }, { name: "Codex" }], "Codex");
    expect(hit.ok).toBe(true);
    expect(hit.y).toBe(118);
  });

  // The caller types the name, so case is theirs to get wrong; which of two
  // identically named projects they meant is not something prodex can know.
  it("still resolves a name typed in another case", () => {
    expect(findRow([{ name: "Codex" }], "codex").ok).toBe(true);
  });

  it("refuses when two rows carry the same name", () => {
    const hit = findRow([{ name: "Codex" }, { name: "Codex" }], "Codex");
    expect(hit.ok).toBe(false);
    expect(hit.reason).toMatch(/multiple sidebar projects/i);
  });
});
