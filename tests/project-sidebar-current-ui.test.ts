import { describe, expect, it } from "vitest";

import {
  locateProjectNavigationTarget,
  projectItemRectExpression,
  projectOptionButtonName,
  sidebarProjectNamesExpression
} from "../src/chatgpt-browser.js";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly innerText: string;
  readonly textContent: string;

  constructor(
    text: string,
    private readonly rect: Rect = { x: 0, y: 0, width: 120, height: 32 }
  ) {
    this.innerText = text;
    this.textContent = text;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  getBoundingClientRect(): Rect {
    return this.rect;
  }

  scrollIntoView(): void {}

  closest(): null {
    return null;
  }

  querySelector(): null {
    return null;
  }
}

class FakeButton extends FakeElement {
  constructor(label: string, rect?: Rect) {
    super(label, rect);
    this.setAttribute("aria-label", label);
  }
}

class FakeProjectRow extends FakeElement {
  constructor(
    readonly name: string,
    readonly buttons: FakeButton[]
  ) {
    super(name, { x: 20, y: 100, width: 240, height: 40 });
    this.setAttribute("role", "button");
    this.setAttribute("data-app-action-sidebar-project-row", "");
    this.setAttribute("data-app-action-sidebar-project-id", `g-p-${name}`);
    this.setAttribute("data-app-action-sidebar-project-label", name);
  }

  querySelectorAll(selector: string): FakeButton[] {
    return selector.includes("button") || selector.includes("aria-label") ? this.buttons : [];
  }
}

class FakeDocument {
  constructor(
    readonly rows: FakeProjectRow[],
    readonly legacyButtons: FakeButton[] = []
  ) {}

  querySelectorAll(selector: string): FakeElement[] {
    if (selector === "[data-prodex-click]") {
      return [...this.rows, ...this.rows.flatMap((row) => row.buttons), ...this.legacyButtons].filter(
        (element) => element.getAttribute("data-prodex-click") !== null
      );
    }
    if (selector.includes("data-app-action-sidebar-project-row")) return this.rows;
    if (selector === '[data-testid="project-folder-icon"]') return [];
    if (!selector.includes("aria-label")) return [];

    return this.legacyButtons.filter((button) => {
      const label = button.getAttribute("aria-label") || "";
      if (selector.includes('aria-label^="Open project options for " i') && /^open project options for /i.test(label)) return true;
      if (selector.includes('aria-label$=" 프로젝트 옵션 열기"') && / 프로젝트 옵션 열기$/.test(label)) return true;
      if (selector.includes('aria-label*="project options" i') && /project options/i.test(label)) return true;
      if (selector.includes('aria-label*="프로젝트 옵션"') && /프로젝트 옵션/.test(label)) return true;
      return false;
    });
  }
}

function actionButton(name: string, x = 10): FakeButton {
  return new FakeButton(`Project actions for ${name}`, { x, y: 200, width: 40, height: 24 });
}

function newChatButton(name: string, x = 300): FakeButton {
  return new FakeButton(`New chat in ${name}`, { x, y: 200, width: 50, height: 24 });
}

function evaluateProjectHit(
  rows: FakeProjectRow[],
  wanted: string
): { ok: boolean; x?: number; y?: number; reason?: string } {
  const document = new FakeDocument(rows);
  return new Function(
    "document",
    "getComputedStyle",
    `return ${projectItemRectExpression(wanted)};`
  )(document, () => ({ pointerEvents: "auto" }));
}

function evaluateProjectNames(document: FakeDocument): string[] {
  return new Function("document", `return ${sidebarProjectNamesExpression()};`)(document);
}

describe("current ChatGPT sidebar project rows", () => {
  it("targets the exact new-chat control instead of the actions control or collapsed row", () => {
    const row = new FakeProjectRow("Codex", [actionButton("Codex"), newChatButton("Codex")]);

    const hit = evaluateProjectHit([row], "Codex");

    expect(hit).toMatchObject({ ok: true, x: 325, y: 212 });
    expect(hit).toMatchObject({ hover: { x: 140, y: 120 } });
    expect(row.getAttribute("data-prodex-click")).toBeNull();
    expect(row.buttons[0].getAttribute("data-prodex-click")).toBeNull();
    expect(row.buttons[1].getAttribute("data-prodex-click")).toBe("1");
  });

  it("matches names exactly rather than selecting a substring superset", () => {
    const review = new FakeProjectRow("Codex Review", [actionButton("Codex Review"), newChatButton("Codex Review", 500)]);
    const codex = new FakeProjectRow("Codex", [actionButton("Codex"), newChatButton("Codex", 300)]);

    expect(evaluateProjectHit([review, codex], "Codex")).toMatchObject({ ok: true, x: 325 });
  });

  it("supports escaped project names and an unambiguous case-insensitive lookup", () => {
    const name = 'Codex "Quoted" \\ Work';
    const row = new FakeProjectRow(name, [actionButton(name), newChatButton(name)]);

    expect(evaluateProjectHit([row], name.toLowerCase()).ok).toBe(true);
  });

  it("fails closed for duplicate project names", () => {
    const first = new FakeProjectRow("Codex", [actionButton("Codex"), newChatButton("Codex")]);
    const second = new FakeProjectRow("Codex", [actionButton("Codex"), newChatButton("Codex")]);

    const hit = evaluateProjectHit([first, second], "Codex");

    expect(hit.ok).toBe(false);
    expect(hit.reason).toMatch(/multiple sidebar projects/i);
  });

  it("fails closed when case-insensitive lookup is ambiguous", () => {
    const titleCase = new FakeProjectRow("Codex", [actionButton("Codex"), newChatButton("Codex")]);
    const upperCase = new FakeProjectRow("CODEX", [actionButton("CODEX"), newChatButton("CODEX")]);

    const hit = evaluateProjectHit([titleCase, upperCase], "codex");

    expect(hit.ok).toBe(false);
    expect(hit.reason).toMatch(/multiple sidebar projects/i);
  });

  it("fails closed when the matched row has no unique new-chat control", () => {
    const missing = new FakeProjectRow("Missing", [actionButton("Missing")]);
    const duplicate = new FakeProjectRow("Duplicate", [
      actionButton("Duplicate"),
      newChatButton("Duplicate"),
      newChatButton("Duplicate", 400)
    ]);

    expect(evaluateProjectHit([missing], "Missing")).toMatchObject({ ok: false });
    expect(evaluateProjectHit([missing], "Missing").reason).toMatch(/new chat/i);
    expect(evaluateProjectHit([duplicate], "Duplicate")).toMatchObject({ ok: false });
    expect(evaluateProjectHit([duplicate], "Duplicate").reason).toMatch(/multiple/i);
  });

  it("lists structural row labels without unrelated project sidebar controls", () => {
    const rows = [
      new FakeProjectRow("Codex", [actionButton("Codex"), newChatButton("Codex")]),
      new FakeProjectRow("Codex Review", [actionButton("Codex Review"), newChatButton("Codex Review")])
    ];
    const oldProject = new FakeButton("Open project options for Legacy");
    const unrelated = new FakeButton("Project sidebar options");

    expect(evaluateProjectNames(new FakeDocument(rows, [oldProject, unrelated]))).toEqual([
      "Codex",
      "Codex Review",
      "Legacy"
    ]);
  });

  it("extracts names from current action labels while retaining old labels", () => {
    expect(projectOptionButtonName("Project actions for Codex")).toBe("Codex");
    expect(projectOptionButtonName("Open project options for Legacy")).toBe("Legacy");
  });
});

interface MockProjectCdp {
  evaluate<T>(expression: string): Promise<T>;
  send(method: string, params: Record<string, unknown>): Promise<unknown>;
}

function projectLocatorCdp(options: { covered?: boolean; legacy?: boolean } = {}): {
  cdp: MockProjectCdp;
  projectEvaluations: () => number;
  strictExpressions: string[];
  mouseMoves: Array<{ x: number; y: number }>;
} {
  let projectEvaluations = 0;
  const strictExpressions: string[] = [];
  const mouseMoves: Array<{ x: number; y: number }> = [];
  const cdp: MockProjectCdp = {
    async evaluate<T>(expression: string): Promise<T> {
      if (expression.includes("document.elementFromPoint")) {
        strictExpressions.push(expression);
        return (!options.covered) as T;
      }
      projectEvaluations += 1;
      if (options.legacy) return { ok: true, x: 80, y: 90 } as T;
      return (projectEvaluations % 2 === 1
        ? { ok: true, x: 326, y: 317, hover: { x: 165, y: 317 } }
        : { ok: true, x: 306, y: 317, hover: { x: 165, y: 317 } }) as T;
    },
    async send(method: string, params: Record<string, unknown>): Promise<unknown> {
      expect(method).toBe("Input.dispatchMouseEvent");
      expect(params.type).toBe("mouseMoved");
      mouseMoves.push({ x: params.x as number, y: params.y as number });
      return {};
    }
  };
  return { cdp, projectEvaluations: () => projectEvaluations, strictExpressions, mouseMoves };
}

describe("locating a hover-revealed project navigation target", () => {
  it("hovers the row, resolves the button again, then strictly verifies its fresh point", async () => {
    const mock = projectLocatorCdp();

    const hit = await locateProjectNavigationTarget(mock.cdp as never, "Codex");

    expect(hit).toMatchObject({ ok: true, x: 306, y: 317, strict: true });
    expect(mock.projectEvaluations()).toBe(2);
    expect(mock.mouseMoves).toEqual([
      { x: 165, y: 317 },
      { x: 306, y: 317 }
    ]);
    expect(mock.strictExpressions).toHaveLength(1);
    expect(mock.strictExpressions[0]).toContain("target === hit || target.contains(hit)");
    expect(mock.strictExpressions[0]).not.toContain("hit.contains(target)");
  });

  it("retries a covered target three times, then fails closed", async () => {
    const mock = projectLocatorCdp({ covered: true });

    const hit = await locateProjectNavigationTarget(mock.cdp as never, "Codex");

    expect(hit.ok).toBe(false);
    expect(hit.reason).toMatch(/covered|hit-testable/i);
    expect(mock.projectEvaluations()).toBe(6);
    expect(mock.strictExpressions).toHaveLength(3);
    expect(mock.mouseMoves).toHaveLength(6);
  });

  it("keeps a legacy target single-pass while strictly checking its point", async () => {
    const mock = projectLocatorCdp({ legacy: true });

    const hit = await locateProjectNavigationTarget(mock.cdp as never, "Legacy");

    expect(hit).toMatchObject({ ok: true, x: 80, y: 90 });
    expect(mock.projectEvaluations()).toBe(1);
    expect(mock.mouseMoves).toEqual([{ x: 80, y: 90 }]);
    expect(mock.strictExpressions).toHaveLength(1);
  });
});
