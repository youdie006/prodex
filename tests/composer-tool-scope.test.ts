import { describe, expect, it } from "vitest";

import { composerToolEntryRectExpression } from "../src/chatgpt-browser.js";

// Measured live: the FIRST `--tool create-image` send of an account works and
// leaves a conversation titled "Create Image" in the sidebar. Every send after
// it failed with "Selected \"Create image\" but the composer never showed it as
// active" - because the lookup searched the document for the tool's name,
// matched that CHAT ROW, clicked it, and navigated to the old conversation.
// Stepping through prodex's own expressions showed the hit at a coordinate on
// the sidebar while the menu was closed.
//
// Scoping the search to an open menu was tried and broke every tool, including
// web-search which had just been measured working: this build's menu carries no
// menu role, no aria-controls and no floating popover node, so nothing matched.
// Excluding where a tool name can only be a coincidence keeps the search that
// works and removes the match that lies.
interface Leaf {
  text: string;
  x: number;
  inSidebar?: boolean;
}

function findEntry(leaves: Leaf[]): { ok: boolean; reason?: string; x?: number; available?: string[] } {
  const build = (leaf: Leaf) => ({
    children: [] as unknown[],
    textContent: leaf.text,
    closest: (selector: string) => (leaf.inSidebar && /sidebar|nav|aside/.test(selector) ? { tag: "NAV" } : null),
    parentElement: null,
    scrollIntoView: () => undefined,
    setAttribute: () => undefined,
    removeAttribute: () => undefined,
    getBoundingClientRect: () => ({ x: leaf.x, y: 300, width: 180, height: 30 })
  });
  const document = { querySelectorAll: () => leaves.map(build) };
  return new Function("document", "getComputedStyle", `return ${composerToolEntryRectExpression("Create image")};`)(
    document,
    () => ({ pointerEvents: "auto" })
  );
}

describe("finding a composer tool to enable", () => {
  it("ignores a chat titled like the tool", () => {
    const hit = findEntry([{ text: "Create Image", x: 100, inSidebar: true }]);
    expect(hit.ok).toBe(false);
    expect(hit.reason).toMatch(/not found in the composer tools menu/i);
  });

  it("takes the menu entry when both are on the page", () => {
    const hit = findEntry([
      { text: "Create Image", x: 100, inSidebar: true },
      { text: "Create image", x: 620 }
    ]);
    expect(hit.ok).toBe(true);
    expect(hit.x).toBeGreaterThan(500);
  });

  it("still finds the entry with no sidebar noise at all", () => {
    expect(findEntry([{ text: "Create image", x: 620 }]).ok).toBe(true);
  });

  // The menu's own contents are what a caller needs to see when the tool is not
  // there - a sidebar full of chat titles would bury them.
  it("lists only candidates from outside the sidebar when it cannot find the tool", () => {
    const hit = findEntry([
      { text: "Heap vs Stack Difference", x: 100, inSidebar: true },
      { text: "Web search", x: 620 }
    ]);
    expect(hit.ok).toBe(false);
    expect(hit.available).toEqual(["Web search"]);
  });
});
