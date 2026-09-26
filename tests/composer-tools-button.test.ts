import { describe, expect, it, vi } from "vitest";

import { composerToolsButtonRectExpression, enableComposerTools } from "../src/chatgpt-browser.js";

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
    if (selector === "button") return this.tagName === "BUTTON";
    if (selector === "textarea") return this.tagName === "TEXTAREA";
    if (selector === 'textarea[data-testid="prompt-textarea"]') {
      return this.tagName === "TEXTAREA" && this.getAttribute("data-testid") === "prompt-textarea";
    }
    if (selector === 'div[role="textbox"]') return this.tagName === "DIV" && this.getAttribute("role") === "textbox";
    if (selector === '[contenteditable="true"]') return this.getAttribute("contenteditable") === "true";
    if (selector === '[data-testid="composer-plus-btn"]') {
      return this.getAttribute("data-testid") === "composer-plus-btn";
    }
    if (selector === 'button[aria-label="Add files and more"]') {
      return this.tagName === "BUTTON" && this.getAttribute("aria-label") === "Add files and more";
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
  constructor(readonly roots: FakeElement[]) {}

  querySelectorAll(selector: string): FakeElement[] {
    const nodes = this.roots.flatMap((root) => [root, ...root.querySelectorAll("*")]);
    return nodes.filter((node) => node.matches(selector));
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

function editor(): FakeElement {
  return new FakeElement(
    "DIV",
    { role: "textbox", contenteditable: "true" },
    { x: 200, y: 700, width: 500, height: 52 }
  );
}

function currentToolsButton(attributes: Record<string, string> = {}): FakeElement {
  return new FakeElement(
    "BUTTON",
    {
      type: "button",
      "aria-label": "Add files and more",
      "aria-expanded": "false",
      "data-state": "closed",
      ...attributes
    },
    { x: 150, y: 708, width: 36, height: 36 }
  );
}

function legacyToolsButton(): FakeElement {
  return new FakeElement("BUTTON", { type: "button", "data-testid": "composer-plus-btn" });
}

function composer(...buttons: FakeElement[]): FakeElement {
  return new FakeElement("FORM", {}, { x: 120, y: 680, width: 700, height: 90 }).append(editor(), ...buttons);
}

function locate(document: FakeDocument): { ok: boolean; reason?: string; x?: number; y?: number; strict?: boolean } {
  return new Function("document", "getComputedStyle", `return ${composerToolsButtonRectExpression()};`)(
    document,
    (node: FakeElement) => node.style
  );
}

describe("locating the composer tools trigger", () => {
  it("uses the measured current button inside the actual composer form", () => {
    const hit = locate(new FakeDocument([composer(currentToolsButton())]));

    expect(hit).toMatchObject({ ok: true, x: 168, y: 726 });
  });

  it("preserves support for the legacy composer test id", () => {
    expect(locate(new FakeDocument([composer(legacyToolsButton())])).ok).toBe(true);
  });

  it("rejects a legacy match outside the composer", () => {
    const outside = new FakeElement("ASIDE").append(legacyToolsButton());

    expect(locate(new FakeDocument([composer(), outside]))).toMatchObject({ ok: false });
  });

  it("rejects a current match outside the composer", () => {
    const outside = new FakeElement("ASIDE").append(currentToolsButton());

    expect(locate(new FakeDocument([composer(), outside]))).toMatchObject({ ok: false });
  });

  it("rejects a matching button when there is no visible composer", () => {
    expect(locate(new FakeDocument([new FakeElement("MAIN").append(currentToolsButton())]))).toMatchObject({ ok: false });
  });

  it("rejects multiple matching buttons in the composer", () => {
    const hit = locate(new FakeDocument([composer(currentToolsButton(), currentToolsButton())]));

    expect(hit.ok).toBe(false);
    expect(hit.reason).toMatch(/ambiguous|multiple/i);
  });

  it("rejects distinct legacy and current buttons in the same composer", () => {
    const hit = locate(new FakeDocument([composer(legacyToolsButton(), currentToolsButton())]));

    expect(hit.ok).toBe(false);
    expect(hit.reason).toMatch(/ambiguous|multiple/i);
  });

  it("deduplicates one button carrying both legacy and current identifiers", () => {
    const hit = locate(new FakeDocument([composer(currentToolsButton({ "data-testid": "composer-plus-btn" }))]));

    expect(hit).toMatchObject({ ok: true, x: 168, y: 726 });
  });

  it("rejects multiple visible composer roots", () => {
    const hit = locate(new FakeDocument([composer(currentToolsButton()), composer(currentToolsButton())]));

    expect(hit.ok).toBe(false);
    expect(hit.reason).toMatch(/ambiguous|multiple/i);
  });

  it.each([
    ["visibility", "hidden"],
    ["visibility", "collapse"],
    ["display", "none"],
    ["opacity", "0"]
  ] as const)("ignores an alternate composer with %s=%s and nonzero geometry", (property, value) => {
    const hidden = composer(currentToolsButton());
    hidden.style[property] = value;

    expect(locate(new FakeDocument([hidden, composer(currentToolsButton())]))).toMatchObject({ ok: true });
  });

  it("does not confuse the separate model selector with the tools trigger", () => {
    const modelSelector = new FakeElement("BUTTON", {
      type: "button",
      "aria-label": "Select ChatGPT model",
      "aria-haspopup": "menu"
    });

    expect(locate(new FakeDocument([composer(modelSelector)]))).toMatchObject({ ok: false });
  });

  it.each([
    ["disabled", (button: FakeElement) => { button.disabled = true; }],
    ["aria-disabled", (button: FakeElement) => { button.setAttribute("aria-disabled", "true"); }],
    ["hidden", (button: FakeElement) => { button.style.visibility = "hidden"; }],
    ["pointer-inert", (button: FakeElement) => { button.style.pointerEvents = "none"; }],
    ["inert ancestor", (button: FakeElement) => { button.setAttribute("inert", ""); }]
  ])("rejects a %s tools trigger", (_name, makeUnsafe) => {
    const button = currentToolsButton();
    makeUnsafe(button);

    expect(locate(new FakeDocument([composer(button)]))).toMatchObject({ ok: false });
  });
});

interface MockCdp {
  evaluate<T>(expression: string): Promise<T>;
  send(method: string, params: Record<string, unknown>): Promise<unknown>;
}

describe("clicking the composer tools trigger", () => {
  it("fails closed before pressing a covered or parent hit target", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const hoverExpressions: string[] = [];
    const cdp: MockCdp = {
      async evaluate<T>(expression: string): Promise<T> {
        if (expression.includes("return { ok: true, active:")) return { active: [] } as T;
        if (expression.includes("composer tools button not found")) return { ok: true, x: 168, y: 726 } as T;
        if (expression.includes("document.elementFromPoint")) {
          hoverExpressions.push(expression);
          return false as T;
        }
        throw new Error(`Unexpected evaluation: ${expression.slice(0, 80)}`);
      },
      async send(method: string, params: Record<string, unknown>): Promise<unknown> {
        expect(method).toBe("Input.dispatchMouseEvent");
        sent.push(params);
        return {};
      }
    };

    await expect(enableComposerTools(cdp as never, ["Web search"])).rejects.toThrow(/Refusing to click/);
    expect(sent.map((event) => event.type)).toEqual(["mouseMoved"]);
    expect(hoverExpressions).toHaveLength(1);
    expect(hoverExpressions[0]).not.toContain("hit.contains(el)");
  });

  it("strictly verifies the retry trigger and never presses it when covered", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const hoverExpressions: string[] = [];
    let now = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => (now += 10_000));
    const cdp: MockCdp = {
      async evaluate<T>(expression: string): Promise<T> {
        if (expression.includes("return { ok: true, active:")) return { active: [] } as T;
        if (expression.includes("composer tools button not found")) return { ok: true, x: 168, y: 726 } as T;
        if (expression.includes("document.elementFromPoint")) {
          hoverExpressions.push(expression);
          return (hoverExpressions.length === 1) as T;
        }
        if (expression.includes("tool not found in the composer tools menu")) return { ok: true, x: 500, y: 400 } as T;
        throw new Error(`Unexpected evaluation: ${expression.slice(0, 80)}`);
      },
      async send(method: string, params: Record<string, unknown>): Promise<unknown> {
        expect(method).toBe("Input.dispatchMouseEvent");
        sent.push(params);
        return {};
      }
    };

    try {
      await expect(enableComposerTools(cdp as never, ["Web search"])).rejects.toThrow(/Refusing to click/);
    } finally {
      nowSpy.mockRestore();
    }

    const triggerPresses = sent.filter((event) => event.type === "mousePressed" && event.x === 168 && event.y === 726);
    expect(triggerPresses).toHaveLength(1);
    expect(hoverExpressions).toHaveLength(2);
    expect(hoverExpressions.every((expression) => !expression.includes("hit.contains(el)"))).toBe(true);
  });
});
