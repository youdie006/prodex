import { describe, expect, it } from "vitest";

import { projectItemRectExpression, sidebarProjectNamesExpression } from "../src/chatgpt-browser.js";
import { browserSendBlockerFromError } from "../src/cli-pro.js";
import { projectsWithIdsExpression } from "../src/tui.js";

// Measured 2026-09-29 on the live sidebar. ChatGPT replaced the per-row "Open
// project options for <name>" button - the key every project lookup in prodex
// used - with "Project actions for <name>", made the row a disclosure that
// expands in place (clicking it no longer navigates), and put the project's
// name and id on the row as attributes. Every --project send reported
// "project not found in sidebar (0 projects visible)" with nine projects on
// screen, and that was classified as a missing name that must not be retried.
interface Row {
  label: string;
  id: string;
  newChatX?: number;
}

function fakeSidebar(rows: Row[]) {
  const buttons: unknown[] = [];
  const rowEls = rows.map((row) => {
    const rowEl: Record<string, unknown> = {
      getAttribute: (name: string) =>
        name === "data-app-action-sidebar-project-label" ? row.label : name === "data-app-action-sidebar-project-id" ? row.id : null
    };
    if (row.newChatX !== undefined) {
      const button = {
        getAttribute: (name: string) => (name === "aria-label" ? `New chat in ${row.label}` : null),
        getBoundingClientRect: () => ({ x: row.newChatX, y: 500, width: 20, height: 20 }),
        scrollIntoView: () => undefined,
        setAttribute: () => undefined,
        removeAttribute: () => undefined
      };
      buttons.push(button);
      rowEl.contains = (el: unknown) => el === button;
    } else {
      rowEl.contains = () => false;
    }
    return rowEl;
  });
  return {
    querySelectorAll: (selector: string) => {
      if (selector === "[data-app-action-sidebar-project-row]") return rowEls;
      if (selector === "button[aria-label]") return buttons;
      return [];
    }
  };
}

const run = <T>(expression: string, document: unknown): T =>
  new Function("document", "getComputedStyle", `return ${expression};`)(document, () => ({ pointerEvents: "auto" })) as T;

describe("finding a project in the current sidebar", () => {
  it("opens the project through its New chat control, not the row that only expands", () => {
    const doc = fakeSidebar([
      { label: "Codex Review", id: "g-p-aaaa", newChatX: 100 },
      { label: "Codex", id: "g-p-bbbb", newChatX: 300 }
    ]);
    const hit = run<{ ok: boolean; x?: number }>(projectItemRectExpression("Codex"), doc);
    expect(hit.ok).toBe(true);
    expect(hit.x).toBe(310);
  });

  it("matches the exact name through the attribute, Korean names included", () => {
    const doc = fakeSidebar([{ label: "[회사] 온디바이스", id: "g-p-cccc", newChatX: 50 }]);
    expect(run<{ ok: boolean }>(projectItemRectExpression("[회사] 온디바이스"), doc).ok).toBe(true);
  });

  it("refuses to guess between two rows with the same name", () => {
    const doc = fakeSidebar([
      { label: "Notes", id: "g-p-1", newChatX: 10 },
      { label: "Notes", id: "g-p-2", newChatX: 20 }
    ]);
    expect(run<{ reason?: string }>(projectItemRectExpression("Notes"), doc).reason).toMatch(/multiple sidebar projects/);
  });

  it("says a name is missing only when there were projects to look through", () => {
    const doc = fakeSidebar([{ label: "Codex", id: "g-p-1", newChatX: 10 }]);
    expect(run<{ reason?: string }>(projectItemRectExpression("Ledger"), doc).reason).toMatch(/not found in sidebar \(1 projects visible/);
  });

  it("calls an empty sidebar unreadable rather than a missing name", () => {
    expect(run<{ reason?: string }>(projectItemRectExpression("Codex"), fakeSidebar([])).reason).toMatch(/no sidebar projects could be read/);
  });

  it("lists names and ids from the rows, where only the open project still has a link", () => {
    const doc = fakeSidebar([
      { label: "Codex", id: "g-p-6a3b24056f9c8191ac8282efd2e0b3c3" },
      { label: "Ledger", id: "g-p-6a34afd5e1d08191bb45a1ec54e45957" }
    ]);
    expect(run<string[]>(sidebarProjectNamesExpression(), doc)).toEqual(["Codex", "Ledger"]);
    const withIds = new Function("document", `return ${projectsWithIdsExpression()};`)({
      querySelectorAll: (selector: string) =>
        selector === "[data-app-action-sidebar-project-row]" ? (doc.querySelectorAll(selector) as unknown[]) : []
    });
    expect(withIds).toEqual([
      { id: "g-p-6a3b24056f9c8191ac8282efd2e0b3c3", name: "Codex" },
      { id: "g-p-6a34afd5e1d08191bb45a1ec54e45957", name: "Ledger" }
    ]);
  });
});

describe("what an unreadable sidebar tells the caller", () => {
  it("is worth retrying, and is not reported as a missing project", () => {
    const blocker = browserSendBlockerFromError(
      new Error(
        "ChatGPT project not found in sidebar: <project> (no sidebar projects could be read (0 projects visible) - the sidebar is not rendered or ChatGPT changed how it lists projects) List the visible names with `prodex pro browser projects`."
      )
    );
    expect(blocker.code).toBe("sidebar_projects_unreadable");
    expect(blocker.retryable).toBe(true);
    expect(blocker.next_step).toMatch(/nothing was sent/i);
  });

  // The ledger's own wording from before this change must land here too.
  it("reads the old '0 projects visible' wording the same way", () => {
    const blocker = browserSendBlockerFromError(
      new Error("ChatGPT project not found in sidebar: <project> (project not found in sidebar (0 projects visible; names are matched exactly first, then case-insensitively - check the exact sidebar spelling))")
    );
    expect(blocker.code).toBe("sidebar_projects_unreadable");
  });

  it("still calls a name missing from a readable sidebar not found", () => {
    const blocker = browserSendBlockerFromError(
      new Error("ChatGPT project not found in sidebar: <project> (project not found in sidebar (9 projects visible; names are matched exactly first))")
    );
    expect(blocker.code).toBe("project_not_found");
    expect(blocker.retryable).toBe(false);
  });
});

// The row's "New chat in <name>" control is revealed only while the row is
// hovered: measured, the button reports opacity 1 inside a container at
// opacity 0, and the click point resolved to the section behind it. A manual
// probe passed only because the pointer was already on the row; a real send
// reported "did not navigate the visible tab". prodex now rests the pointer on
// the row first, and needs a point on the row to do that.
describe("revealing a row's hover-only controls", () => {
  it("finds a point on the row itself, by exact name", async () => {
    const { sidebarProjectRowPointExpression } = await import("../src/chatgpt-browser.js");
    const row = {
      getAttribute: (name: string) =>
        name === "data-app-action-sidebar-project-label" ? "Codex" : name === "data-app-action-sidebar-project-id" ? "g-p-1" : null,
      getBoundingClientRect: () => ({ x: 10, y: 400, width: 240, height: 36 })
    };
    const doc = { querySelectorAll: (s: string) => (s === "[data-app-action-sidebar-project-row]" ? [row] : []) };
    const point = new Function("document", `return ${sidebarProjectRowPointExpression("Codex")};`)(doc) as { ok: boolean; x: number; y: number };
    expect(point).toEqual({ ok: true, x: 70, y: 418 });
    const none = new Function("document", `return ${sidebarProjectRowPointExpression("Ledger")};`)(doc) as { ok: boolean };
    expect(none.ok).toBe(false);
  });
});
