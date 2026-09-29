import { describe, expect, it } from "vitest";

import {
  freshChatGptHomeReadyExpression,
  markDocumentForReloadExpression,
  modelButtonRectExpression
} from "../src/chatgpt-browser.js";

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
  textContent = "";
  innerText = "";
  readonly style = { display: "block", visibility: "visible", pointerEvents: "auto", opacity: "1" };

  constructor(
    readonly tagName: string,
    private readonly attributes: Record<string, string> = {},
    private readonly rect: FakeRect = { x: 0, y: 0, width: 36, height: 36 }
  ) {}

  append(...nodes: FakeElement[]): this {
    for (const node of nodes) {
      node.parentElement = this;
      this.children.push(node);
    }
    return this;
  }

  get offsetWidth(): number {
    return this.rect.width;
  }

  get offsetHeight(): number {
    return this.rect.height;
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

  contains(node: FakeElement): boolean {
    return node === this || this.children.some((child) => child.contains(node));
  }

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
    if (selector === "textarea") return this.tagName === "TEXTAREA";
    if (selector === '[contenteditable="true"]') return this.getAttribute("contenteditable") === "true";
    if (selector === 'div[role="textbox"]') return this.tagName === "DIV" && this.getAttribute("role") === "textbox";
    if (selector === 'textarea[data-testid="prompt-textarea"]') {
      return this.tagName === "TEXTAREA" && this.getAttribute("data-testid") === "prompt-textarea";
    }
    if (selector === '[aria-haspopup="menu"]') return this.getAttribute("aria-haspopup") === "menu";
    if (selector === '[data-codex-intelligence-trigger="true"][aria-haspopup="menu"]') {
      return this.getAttribute("data-codex-intelligence-trigger") === "true" && this.getAttribute("aria-haspopup") === "menu";
    }
    if (selector === 'button[aria-label="Select ChatGPT model"][aria-haspopup="menu"]') {
      return this.tagName === "BUTTON" && this.getAttribute("aria-label") === "Select ChatGPT model" && this.getAttribute("aria-haspopup") === "menu";
    }
    if (selector === "[data-prodex-click]") return this.getAttribute("data-prodex-click") !== null;
    if (selector === "[inert]") return this.getAttribute("inert") !== null;
    if (selector === '[aria-hidden="true"]') return this.getAttribute("aria-hidden") === "true";
    if (selector.startsWith('[data-testid*="composer"]')) {
      return (this.getAttribute("data-testid") || "").includes("composer");
    }
    if (selector.startsWith('[data-testid*="prompt"]')) {
      return (this.getAttribute("data-testid") || "").includes("prompt");
    }
    if (selector.startsWith('[class*="composer"]')) {
      return (this.getAttribute("class") || "").includes("composer");
    }
    return false;
  }
}

class FakeDocument {
  constructor(readonly roots: FakeElement[], readonly readyState = "complete") {}

  querySelectorAll(selector: string): FakeElement[] {
    const nodes = this.roots.flatMap((root) => [root, ...root.querySelectorAll("*")]);
    return nodes.filter((node) => node.matches(selector));
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

function editor(rect: FakeRect = { x: 220, y: 700, width: 500, height: 52 }): FakeElement {
  return new FakeElement("DIV", { role: "textbox", contenteditable: "true" }, rect);
}

function trigger(
  attributes: Record<string, string> = {
    "aria-label": "Select ChatGPT model",
    "aria-haspopup": "menu",
    "aria-expanded": "false"
  },
  rect: FakeRect = { x: 720, y: 708, width: 42, height: 36 }
): FakeElement {
  const node = new FakeElement("BUTTON", attributes, rect);
  node.textContent = "Pro";
  node.innerText = "Pro";
  return node;
}

function composer(modelTrigger?: FakeElement): FakeElement {
  const form = new FakeElement("FORM", {}, { x: 120, y: 680, width: 700, height: 90 }).append(editor());
  if (modelTrigger) form.append(modelTrigger);
  return form;
}

function locate(document: FakeDocument): { ok: boolean; reason?: string; x?: number; y?: number; label?: string; strict?: boolean } {
  return new Function("document", "getComputedStyle", `return ${modelButtonRectExpression()};`)(
    document,
    (node: FakeElement) => node.style
  );
}

describe("locating the model trigger in one rendered composer", () => {
  it("uses the exact current model trigger and marks its click for strict hit-testing", () => {
    expect(locate(new FakeDocument([composer(trigger())]))).toMatchObject({
      ok: true,
      x: 741,
      y: 726,
      label: "Select ChatGPT model",
      strict: true
    });
  });

  it("keeps the measured legacy intelligence trigger", () => {
    const legacy = trigger({
      "data-codex-intelligence-trigger": "true",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      "aria-label": "Pro"
    });

    expect(locate(new FakeDocument([composer(legacy)]))).toMatchObject({ ok: true, label: "Pro", strict: true });
  });

  it("does not let a hidden fallback editable redirect lookup to the global Explore menu", () => {
    const fallback = new FakeElement("TEXTAREA", {}, { x: 0, y: 0, width: 0, height: 0 });
    const explore = trigger({ "aria-haspopup": "menu", "aria-label": "Explore" }, { x: 150, y: 170, width: 40, height: 38 });
    explore.textContent = "Explore";

    expect(locate(new FakeDocument([fallback, new FakeElement("NAV").append(explore), composer(trigger())]))).toMatchObject({
      ok: true,
      x: 741,
      y: 726,
      label: "Select ChatGPT model"
    });
  });

  it("fails closed when no exact model trigger exists", () => {
    const explore = trigger({ "aria-haspopup": "menu", "aria-label": "Explore" });
    explore.textContent = "Explore";

    expect(locate(new FakeDocument([new FakeElement("NAV").append(explore), composer()]))).toMatchObject({ ok: false });
  });

  it("fails closed when more than one rendered composer root exists", () => {
    const hit = locate(new FakeDocument([composer(trigger()), composer(trigger())]));

    expect(hit.ok).toBe(false);
    expect(hit.reason).toMatch(/multiple|ambiguous/i);
  });

  it.each([
    ["disabled", (modelTrigger: FakeElement) => { modelTrigger.disabled = true; }],
    ["aria-disabled", (modelTrigger: FakeElement) => { modelTrigger.setAttribute("aria-disabled", "true"); }],
    ["hidden", (modelTrigger: FakeElement) => { modelTrigger.style.visibility = "hidden"; }],
    ["pointer-inert", (modelTrigger: FakeElement) => { modelTrigger.style.pointerEvents = "none"; }],
    ["inert ancestor", (modelTrigger: FakeElement) => { modelTrigger.setAttribute("inert", ""); }]
  ])("rejects a %s model trigger", (_name, makeUnsafe) => {
    const modelTrigger = trigger();
    makeUnsafe(modelTrigger);

    expect(locate(new FakeDocument([composer(modelTrigger)]))).toMatchObject({ ok: false });
  });
});

function freshReady(document: FakeDocument, window: Record<string, unknown> = {}): boolean {
  return new Function("window", "document", "location", "getComputedStyle", `return ${freshChatGptHomeReadyExpression()};`)(
    window,
    document,
    { href: "https://chatgpt.com/" },
    (node: FakeElement) => node.style
  ) as boolean;
}

describe("new-chat document readiness", () => {
  it("rejects the stamped old root document even when its counters are empty", () => {
    const document = new FakeDocument([composer()]);
    const window: Record<string, unknown> = {};
    new Function("window", `return ${markDocumentForReloadExpression()};`)(window);

    expect(freshReady(document, window)).toBe(false);
  });

  it("rejects a new document while it is loading without a usable composer", () => {
    expect(freshReady(new FakeDocument([], "loading"))).toBe(false);
  });

  it("accepts only a complete new root document with a usable composer", () => {
    expect(freshReady(new FakeDocument([composer()]))).toBe(true);
  });
});
