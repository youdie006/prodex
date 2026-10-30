import { afterEach, describe, expect, it, vi } from "vitest";

import { expandSidebarProjectsExpression, findSidebarProjectRow, projectItemRectExpression } from "../src/chatgpt-browser.js";

// Measured 2026-10-30 on WSL: the sidebar showed 9 project rows (4 pinned, 5
// under Projects) with a "Show more" button under the Projects section, and
// pressing it added 16 more rows that were not in the page before. A --project
// send for any of those 16 failed as "project not found in sidebar (9 projects
// visible)", and `pro browser projects` listed 9 of 25.
interface FakeNode {
  tagName: string;
  attributes: Record<string, string>;
  innerText?: string;
  children: FakeNode[];
  parent?: FakeNode;
  clicked?: number;
  onClick?: () => void;
}

function node(tagName: string, attributes: Record<string, string> = {}, children: FakeNode[] = [], innerText = ""): FakeNode {
  const created: FakeNode = { tagName, attributes, children, innerText };
  for (const child of children) child.parent = created;
  return created;
}

const matches = (element: FakeNode, selector: string): boolean =>
  selector.split(",").some((part) => {
    const trimmed = part.trim();
    if (trimmed === "button") return element.tagName === "button";
    if (trimmed === "section[data-app-action-sidebar-section]") return element.tagName === "section" && "data-app-action-sidebar-section" in element.attributes;
    const attribute = /^\[([\w-]+)(?:\^=["']([^"']*)["'])?\]$/.exec(trimmed);
    if (!attribute) return false;
    const value = element.attributes[attribute[1]];
    return value !== undefined && (attribute[2] === undefined || value.startsWith(attribute[2]));
  });

function descendants(root: FakeNode): FakeNode[] {
  return root.children.flatMap((child) => [child, ...descendants(child)]);
}

function element(fake: FakeNode): unknown {
  return {
    getAttribute: (name: string) => fake.attributes[name] ?? null,
    hasAttribute: (name: string) => name in fake.attributes,
    get innerText() {
      return fake.innerText ?? "";
    },
    getClientRects: () => [{}],
    closest: (selector: string) => {
      for (let current: FakeNode | undefined = fake; current; current = current.parent) {
        if (matches(current, selector)) return element(current);
      }
      return null;
    },
    querySelectorAll: (selector: string) => descendants(fake).filter((child) => matches(child, selector)).map(element),
    click: () => {
      fake.clicked = (fake.clicked ?? 0) + 1;
      fake.onClick?.();
    }
  };
}

const row = (name: string): FakeNode =>
  node("div", { "data-sidebar-project-container-id": `project:g-p-${name}` }, [
    node("div", { "data-app-action-sidebar-project-row": "", "data-app-action-sidebar-project-label": name, "data-app-action-sidebar-project-id": `g-p-${name}` }, [
      node("button", { "aria-label": `Project actions for ${name}`, "data-variant": "ghost" })
    ])
  ]);

function fakeSidebar(options: { hidden: string[]; withShowMore?: boolean }) {
  const list = node("div", { role: "list" }, [row("aaaa"), row("bbbb")]);
  const toggle = node("button", { "data-app-action-sidebar-section-toggle": "", "data-variant": "ghost" }, [], "Projects");
  const create = node("button", { "aria-label": "Add new project", "data-app-action-sidebar-project-create": "" });
  const more = node("button", { type: "button", "data-variant": "ghost" }, [], "Show more");
  more.onClick = () => {
    for (const name of options.hidden) {
      const added = row(name);
      added.parent = list;
      list.children.push(added);
    }
    const listItem = more.parent!;
    listItem.children = listItem.children.filter((child) => child !== more);
  };
  const section = node("section", { "data-app-action-sidebar-section": "", "data-app-action-sidebar-section-heading": "Projects" }, [
    toggle,
    create,
    list,
    node("div", { role: "listitem" }, options.withShowMore === false ? [] : [more])
  ]);
  const recents = node("section", { "data-app-action-sidebar-section": "" }, [node("button", { "data-variant": "ghost" }, [], "Show more")]);
  const root = node("div", {}, [section, recents]);
  const document = element(root) as { querySelectorAll: (selector: string) => unknown[] };
  return { document, toggle, create, more, recentsMore: recents.children[0], rowCount: () => descendants(root).filter((child) => "data-app-action-sidebar-project-row" in child.attributes).length };
}

const run = async <T>(expression: string, document: unknown): Promise<T> =>
  (await new Function("document", `return ${expression};`)(document)) as T;

describe("projects kept behind the sidebar's Show more", () => {
  it("presses the Projects section's Show more and waits for the rows it adds", async () => {
    const sidebar = fakeSidebar({ hidden: ["cccc", "dddd"] });
    const result = await run<{ clicked: boolean; before: number; after: number }>(expandSidebarProjectsExpression(), sidebar.document);
    expect(result).toEqual({ clicked: true, before: 2, after: 4 });
    expect(sidebar.more.clicked).toBe(1);
    // Nothing else in the sidebar is pressed: not the section toggle, not
    // "Add new project", not a row's own controls, not another section's list.
    expect(sidebar.toggle.clicked).toBeUndefined();
    expect(sidebar.create.clicked).toBeUndefined();
    expect(sidebar.recentsMore.clicked).toBeUndefined();
  });

  it("presses nothing when every project is already listed", async () => {
    const sidebar = fakeSidebar({ hidden: [], withShowMore: false });
    const result = await run<{ clicked: boolean }>(expandSidebarProjectsExpression(), sidebar.document);
    expect(result.clicked).toBe(false);
    expect(sidebar.toggle.clicked).toBeUndefined();
    expect(sidebar.recentsMore.clicked).toBeUndefined();
  });
});

describe("finding a project row for a send", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const notFound = { ok: false, reason: "project not found in sidebar (9 projects visible; names are matched exactly first, then case-insensitively - check the exact sidebar spelling)" };

  function fakeCdp(options: { foundAfterExpand: boolean; foundAtOnce?: boolean }) {
    let expanded = false;
    let expandCalls = 0;
    // This branch hovers the target and hit-tests it before trusting it.
    const cdp = {
      send: async () => ({}),
      evaluate: async (expression: string) => {
        if (expression.includes("elementFromPoint")) return true;
        if (expression === expandSidebarProjectsExpression()) {
          expandCalls += 1;
          expanded = true;
          return { clicked: true, before: 9, after: 25 };
        }
        if (expression === projectItemRectExpression("Hidden")) {
          if (options.foundAtOnce || (expanded && options.foundAfterExpand)) return { ok: true, x: 40, y: 300 };
          return notFound;
        }
        return undefined;
      }
    };
    return { cdp, expandCalls: () => expandCalls };
  }

  it("shows the rest of the projects once when the name is not among those listed", async () => {
    const { cdp, expandCalls } = fakeCdp({ foundAfterExpand: true });
    await expect(findSidebarProjectRow(cdp as never, "Hidden")).resolves.toMatchObject({ ok: true, x: 40, y: 300 });
    expect(expandCalls()).toBe(1);
  });

  it("leaves the sidebar alone for a project already listed", async () => {
    const { cdp, expandCalls } = fakeCdp({ foundAfterExpand: true, foundAtOnce: true });
    await expect(findSidebarProjectRow(cdp as never, "Hidden")).resolves.toMatchObject({ ok: true });
    expect(expandCalls()).toBe(0);
  });

  it("still reports a name that is in no list, after showing the rest once", async () => {
    vi.useFakeTimers();
    const { cdp, expandCalls } = fakeCdp({ foundAfterExpand: false });
    const found = findSidebarProjectRow(cdp as never, "Hidden");
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(found).resolves.toMatchObject({ ok: false, reason: expect.stringMatching(/not found in sidebar/) });
    expect(expandCalls()).toBe(1);
  });
});
