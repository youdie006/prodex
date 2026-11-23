import { afterEach, describe, expect, it, vi } from "vitest";
import * as browser from "../src/chatgpt-browser.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type FixtureOptions = {
  busy?: boolean;
  draft?: boolean;
  missingProject?: boolean;
  menuFails?: boolean;
  firstPressIgnored?: boolean;
  strictTriggerFailsOn?: number;
  restoreFails?: boolean;
  closeFails?: boolean;
  pageChanges?: boolean;
  buttonLabel?: string;
  submenuValue?: string;
  sliderModel?: string;
  hiddenProjectControlHasGeometry?: boolean;
  topModel?: string | null;
  dialog?: "connect" | "picker";
};

function install(options: FixtureOptions = {}) {
  vi.useFakeTimers();
  const state = {
    position: 3,
    open: false,
    reachedTop: false,
    projectHovered: false,
    projectReads: 0,
    releases: 0,
    strictHits: 0,
    pointer: { x: 0, y: 0 },
    methods: [] as string[],
    expressions: [] as string[],
    keys: [] as string[]
  };
  const url = "https://chatgpt.com/c/test-thread";
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => [{ type: "page", id: "test", url, title: "ChatGPT", webSocketDebuggerUrl: "ws://fake/test" }]
    }))
  );

  class Socket extends EventTarget {
    static OPEN = 1;
    readyState = 0;

    constructor() {
      super();
      queueMicrotask(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
      });
    }

    send(raw: string) {
      const { id, method, params } = JSON.parse(raw) as { id: number; method: string; params: Record<string, unknown> };
      state.methods.push(method);
      queueMicrotask(() => {
        if ((options.dialog === "connect" && method === "Page.enable") ||
            (options.dialog === "picker" && method === "Input.dispatchMouseEvent" && params.type === "mouseReleased")) {
          this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
            method: "Page.javascriptDialogOpening", params: { type: "beforeunload" }
          }) }));
        }
        let value: unknown;
        if (method === "Input.dispatchMouseEvent") {
          if (params.type === "mouseMoved") state.pointer = { x: params.x as number, y: params.y as number };
          if (params.type === "mouseMoved" && params.x === 10 && params.y === 10) state.projectHovered = true;
          if (params.type === "mouseReleased") {
            state.releases += 1;
            state.open = !options.menuFails && !(options.firstPressIgnored && state.releases === 1);
          }
        }
        if (method === "Input.dispatchKeyEvent" && ["keyDown", "rawKeyDown"].includes(params.type as string)) {
          const key = params.key as string;
          state.keys.push(key);
          if (key === "Escape" && !options.closeFails) state.open = false;
          if (key === "ArrowLeft" && !(options.restoreFails && state.reachedTop)) state.position = Math.max(0, state.position - 1);
          if (key === "ArrowRight") state.position = Math.min(4, state.position + 1);
          if (state.position === 4) state.reachedTop = true;
        }
        if (method === "Runtime.evaluate") {
          const expression = params.expression as string;
          state.expressions.push(expression);
          if (expression === "document.visibilityState") value = "visible";
          else if (expression === "location.href") {
            value = options.pageChanges && state.reachedTop ? "https://chatgpt.com/c/other-thread" : url;
          } else if (expression === browser.statusExpression()) {
            value = {
              title: "ChatGPT",
              url,
              visibilityState: "visible",
              textSample: "New chat\nProjects\nGPT-6\nPro",
              hasComposer: true,
              generating: !!options.busy,
              visibleButtonLabels: [],
              modelHints: ["GPT-6", "Pro"]
            };
          } else if (expression.includes("selectorProbeSnapshot")) {
            value = { url, composerEmpty: !options.draft, menuClosed: !state.open, overlayOpen: state.open };
          } else if (expression === browser.sidebarProjectRowPointExpression("Codex")) {
            value = options.missingProject ? { ok: false } : { ok: true, x: 10, y: 10 };
          } else if (expression === browser.projectItemRectExpression("Codex")) {
            state.projectReads += 1;
            value = options.missingProject
              ? { ok: false, reason: "project not found in sidebar (1 projects visible)" }
              : state.projectHovered || options.hiddenProjectControlHasGeometry
                ? { ok: true, x: 12, y: 12 }
                : { ok: false, reason: "project row found but it has no new-chat control to open the project" };
          } else if (expression === browser.modelButtonRectExpression()) {
            value = { ok: true, x: 20, y: 20, label: options.buttonLabel ?? "GPT-6, Pro" };
          } else if (expression === browser.menuOpenExpression()) value = state.open;
          else if (expression === browser.menuClosedExpression()) value = !state.open;
          else if (expression === browser.modelSelectorReadsClosedExpression()) value = !state.open;
          else if (expression === browser.modelMenuOptionsExpression()) {
            value = [{ label: "Model", value: options.submenuValue ?? "GPT-6", kind: "submenu", checked: false }];
          } else if (expression.startsWith("(() => {") && expression.includes("menu item not found")) value = { ok: false, reason: "menu item not found" };
          else if (expression === browser.focusPowerSliderExpression()) value = { ok: true };
          else if (expression === browser.powerSliderStateExpression()) {
            value = {
              ok: true,
              position: state.position,
              min: 0,
              max: 4,
              model: state.position === 4 && options.topModel !== undefined ? options.topModel : options.sliderModel ?? "GPT-6",
              effort: ["Instant", "Medium", "High", "Extra High", "Pro"][state.position]
            };
          } else if (expression.includes("selectorProbeStrictHit")) {
            state.strictHits += 1;
            value = options.strictTriggerFailsOn !== state.strictHits &&
              !(options.hiddenProjectControlHasGeometry && state.pointer.x === 12 && !state.projectHovered);
          } else if (expression.includes("document.elementFromPoint")) value = true;
          else if (expression.includes('removeAttribute("data-prodex-click")')) value = true;
          else throw new Error(`Unhandled fixture expression: ${expression.slice(0, 120)}`);
        }
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id, result: { result: { value } } }) }));
      });
    }

    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
    }
  }

  vi.stubGlobal("WebSocket", Socket);
  return state;
}

async function check(
  selection: { model?: string; effort?: string; project?: string } = { model: "GPT-6", effort: "Pro", project: "Codex" },
  timeoutMs = 15_000
) {
  const done = browser.inspectConfiguredBrowserSelectors({ port: 19333, timeoutMs, selection });
  await vi.advanceTimersByTimeAsync(120_000);
  return done;
}

describe("configured selector readiness without sending", () => {
  it("checks current picker and visible project controls, then restores the original idle UI", async () => {
    const state = install();

    expect(await check()).toMatchObject({
      modelMenu: "OPENED",
      model: { state: "VERIFIED" },
      effort: { state: "VERIFIED" },
      project: { state: "VERIFIED" }
    });
    expect(state.position).toBe(3);
    expect(state.open).toBe(false);
    expect(state.keys).not.toContain("Enter");
    expect(state.methods.some((method) => /insertText|navigate|reload|activateTarget|createTarget/.test(method))).toBe(false);
    expect(state.expressions).not.toContain(browser.expandSidebarProjectsExpression());
    expect(state.projectReads).toBeGreaterThanOrEqual(2);
  });

  it.each([{ busy: true }, { draft: true }])("refuses inspection while the page is occupied: %j", async (options) => {
    const state = install(options);
    expect(await check()).toMatchObject({ model: { state: "UNVERIFIED" }, project: { state: "UNVERIFIED" } });
    expect(state.methods.some((method) => method.startsWith("Input."))).toBe(false);
  });

  it("reports a configured project missing from visible sidebar controls", async () => {
    install({ missingProject: true });
    expect(await check({ project: "Codex" })).toMatchObject({ project: { state: "MISSING" } });
  });

  it("reveals a hover-only project control even when its hidden button already has geometry", async () => {
    const state = install({ hiddenProjectControlHasGeometry: true });
    expect(await check({ project: "Codex" })).toMatchObject({ project: { state: "VERIFIED" } });
    expect(state.projectHovered).toBe(true);
    expect(state.releases).toBe(0);
  });

  it("does not verify a configured selector when the model menu never opens", async () => {
    install({ menuFails: true });
    expect(await check({ model: "Pro" })).toMatchObject({ modelMenu: "UNVERIFIED", model: { state: "UNVERIFIED" } });
  });

  it.each([
    { strictTriggerFailsOn: 1 },
    { firstPressIgnored: true, strictTriggerFailsOn: 2 }
  ])("requires a strict native hit for every model-trigger press: %j", async (options) => {
    const state = install(options);
    expect(await check({ model: "Pro" })).toMatchObject({ modelMenu: "UNVERIFIED", model: { state: "UNVERIFIED" } });
    expect(state.releases).toBe(options.firstPressIgnored ? 1 : 0);
  });

  it("does not treat an unchecked submenu value as the selected model", async () => {
    install({ buttonLabel: "GPT-6", submenuValue: "GPT-5", sliderModel: "GPT-6" });
    expect(await check({ model: "GPT-5" })).toMatchObject({ model: { state: "UNVERIFIED" } });
  });

  it("does not infer an exact model selection from a version-prefix button label", async () => {
    install({ buttonLabel: "GPT-5.6 Pro, 5 of 5", sliderModel: "GPT-5.6", submenuValue: "GPT-5.6" });
    expect(await check({ model: "GPT-5" })).toMatchObject({ model: { state: "UNVERIFIED" } });
  });

  it.each([
    { topModel: "GPT-5", expected: "MISSING" },
    { topModel: null, expected: "UNVERIFIED" }
  ])("verifies the configured model and effort on the same rung: %j", async ({ topModel, expected }) => {
    const state = install({ topModel });
    expect(await check({ model: "GPT-6", effort: "Pro" })).toMatchObject({ effort: { state: expected } });
    expect(state.position).toBe(3);
  });

  it("does not answer a JavaScript confirmation during selector inspection", async () => {
    const state = install({ dialog: "picker" });
    expect(await check({ model: "Pro" })).toMatchObject({ model: { state: "UNVERIFIED" } });
    expect(state.methods).not.toContain("Page.handleJavaScriptDialog");
    expect(state.keys).toEqual([]);
  });

  it("does not answer a JavaScript confirmation during the base status read", async () => {
    const state = install({ dialog: "connect" });
    const done = browser.getChatGptBrowserStatus({ port: 19333, timeoutMs: 1000 }).then(
      () => undefined,
      (error: unknown) => error
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(await done).toBeInstanceOf(Error);
    expect(state.methods).not.toContain("Page.handleJavaScriptDialog");
  });

  it.each([{ restoreFails: true }, { closeFails: true }])("fails closed when cleanup is incomplete: %j", async (options) => {
    install(options);
    expect(await check()).toMatchObject({ model: { state: "UNVERIFIED" }, effort: { state: "UNVERIFIED" } });
  });

  it("does not restore controls after the conversation changes externally", async () => {
    const state = install({ pageChanges: true });
    expect(await check()).toMatchObject({ model: { state: "UNVERIFIED" } });
    expect(state.position).toBe(4);
    expect(state.keys).not.toContain("Escape");
  });
});
