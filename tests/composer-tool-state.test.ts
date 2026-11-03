import { describe, expect, it } from "vitest";

import { activeComposerToolsExpression, composerToolsButtonRectExpression } from "../src/chatgpt-browser.js";

interface FakeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

class FakeElement {
  readonly children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  disabled = false;
  innerText = "";

  constructor(
    readonly tagName: string,
    private readonly attributes: Record<string, string> = {},
    private readonly rect: FakeRect = { x: 0, y: 0, width: 36, height: 36 }
  ) {}

  get textContent(): string {
    return this.innerText;
  }

  append(...nodes: FakeElement[]): this {
    for (const node of nodes) {
      node.parentElement = this;
      this.children.push(node);
    }
    return this;
  }

  getClientRects(): FakeRect[] {
    return this.rect.width > 0 && this.rect.height > 0 ? [this.rect] : [];
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  removeAttribute(name: string): void {
    delete this.attributes[name];
  }

  getBoundingClientRect(): FakeRect {
    return this.rect;
  }

  scrollIntoView(): void {}

  matches(selector: string): boolean {
    return selector.split(",").some((part) => this.matchesOne(part.trim()));
  }

  closest(selector: string): FakeElement | null {
    for (let node: FakeElement | null = this; node; node = node.parentElement) {
      if (node.matches(selector)) return node;
    }
    return null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const descendants = this.children.flatMap((child) => [child, ...child.querySelectorAll("*")]);
    return descendants.filter((node) => node.matches(selector));
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  private matchesOne(selector: string): boolean {
    if (selector === "*") return true;
    if (selector === "form") return this.tagName === "FORM";
    if (selector === "button") return this.tagName === "BUTTON";
    if (selector === "textarea") return this.tagName === "TEXTAREA";
    if (selector === '[contenteditable="true"]') return this.getAttribute("contenteditable") === "true";
    if (selector === 'div[role="textbox"]') return this.tagName === "DIV" && this.getAttribute("role") === "textbox";
    if (selector === '[aria-hidden="true"]') return this.getAttribute("aria-hidden") === "true";
    if (selector === 'button[aria-label="Add files and more"]') {
      return this.tagName === "BUTTON" && this.getAttribute("aria-label") === "Add files and more";
    }
    const presence = /^\[([\w-]+)\]$/.exec(selector);
    if (presence) return this.getAttribute(presence[1]!) !== null;
    return false;
  }
}

class FakeDocument {
  constructor(readonly roots: FakeElement[]) {}

  querySelectorAll(selector: string): FakeElement[] {
    const nodes = this.roots.flatMap((root) => [root, ...root.querySelectorAll("*")]);
    return nodes.filter((node) => node.matches(selector));
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

function composer(options: { rect?: FakeRect; editorText?: string; formText?: string; toolsButton?: boolean } = {}): FakeElement {
  const rect = options.rect ?? { x: 220, y: 700, width: 768, height: 52 };
  const editor = new FakeElement("DIV", { role: "textbox", contenteditable: "true" }, rect);
  editor.innerText = options.editorText ?? "";
  const form = new FakeElement("FORM", {}, rect).append(editor);
  if (options.toolsButton !== false) {
    form.append(new FakeElement("BUTTON", { "aria-label": "Add files and more", type: "button", "aria-expanded": "false", "data-state": "closed" }, { ...rect, width: rect.width && 36, height: rect.height && 36 }));
  }
  form.innerText = options.formText ?? `${editor.innerText} Thinking effort Pro`;
  return form;
}

const evaluate = <T>(expression: string, document: FakeDocument): T =>
  new Function("document", "getComputedStyle", `return ${expression};`)(document, () => ({ pointerEvents: "auto" })) as T;

// Measured 2026-11-03 in the browser container: a new chat leaves the home
// page's composer mounted in a workspace with display: none, ahead of the
// conversation's composer in the document. A follow-up with --tool "Web search"
// turned the tool on in the visible composer, but the check read the hidden
// one ("Thinking effortPro"), so the send was refused with "Selected "Web
// search" but the composer never showed it as active." and the token was left
// in the composer.
describe("reading which composer tools are on", () => {
  it("reads the visible composer, not a hidden workspace's", () => {
    const hidden = composer({ rect: { x: 0, y: 0, width: 0, height: 0 }, formText: "Thinking effortPro" });
    const visible = composer({ editorText: "Web search ", formText: "Web search Thinking effort Pro" });

    const state = evaluate<{ active: string[] }>(activeComposerToolsExpression(["Web search"]), new FakeDocument([hidden, visible]));

    expect(state.active).toEqual(["Web search"]);
  });

  it("does not report a tool that only a hidden workspace's composer shows", () => {
    const hidden = composer({ rect: { x: 0, y: 0, width: 0, height: 0 }, editorText: "Web search ", formText: "Web search" });
    const visible = composer();

    const state = evaluate<{ active: string[] }>(activeComposerToolsExpression(["Web search"]), new FakeDocument([hidden, visible]));

    expect(state.active).toEqual([]);
  });
});

// "Edit message" on a user turn opens a form with its own editor inside the
// transcript, ahead of the composer, and with no tools button.
describe("finding the composer tools button", () => {
  it("skips an open message editor in the transcript", () => {
    const editing = composer({ rect: { x: 220, y: 300, width: 766, height: 133 }, toolsButton: false });
    const turn = new FakeElement("DIV", { "data-chatgpt-search-unit-key": "fallback-turn-1:0:user" }).append(editing);

    const hit = evaluate<{ ok: boolean; reason?: string; y?: number }>(
      composerToolsButtonRectExpression(),
      new FakeDocument([turn, composer()])
    );

    expect(hit).toMatchObject({ ok: true, y: 718 });
  });
});
