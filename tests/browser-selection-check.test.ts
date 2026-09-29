import { afterEach, describe, expect, it, vi } from "vitest";
import * as browser from "../src/chatgpt-browser.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function install(options: { busy?: boolean; draft?: boolean; missingProject?: boolean; menuFails?: boolean; restoreFails?: boolean; closeFails?: boolean; noPro?: boolean; cleanupReadFails?: boolean; pageChanges?: boolean; coveredModel?: boolean; submenuModel?: boolean; checkedModel?: boolean } = {}) {
  vi.useFakeTimers();
  const state = { position: 3, open: false, reachedTop: false, methods: [] as string[], keys: [] as string[] };
  const url = "https://chatgpt.com/c/test-thread";
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => [{ type: "page", id: "test", url, title: "ChatGPT", webSocketDebuggerUrl: "ws://fake/test" }] })));
  class Socket extends EventTarget {
    static OPEN = 1;
    readyState = 0;
    constructor() { super(); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); }); }
    send(raw: string) {
      const { id, method, params } = JSON.parse(raw);
      state.methods.push(method);
      queueMicrotask(() => {
        let value: unknown;
        if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") state.open = !options.menuFails;
        if (method === "Input.dispatchKeyEvent" && ["keyDown", "rawKeyDown"].includes(params.type)) {
          state.keys.push(params.key);
          if (params.key === "Escape" && !options.closeFails) state.open = false;
          if (params.key === "ArrowLeft" && !(options.restoreFails && state.reachedTop)) state.position = Math.max(0, state.position - 1);
          if (params.key === "ArrowRight") state.position = Math.min(4, state.position + 1);
          if (state.position === 4) state.reachedTop = true;
        }
        if (method === "Runtime.evaluate") {
          const e = params.expression;
          if (e === "document.visibilityState") value = "visible";
          else if (e === "location.href") value = options.pageChanges && state.reachedTop ? "https://chatgpt.com/c/other-thread" : url;
          else if (e === browser.statusExpression()) value = { title: "ChatGPT", url, visibilityState: "visible", textSample: "New chat\nProjects\nPro", hasComposer: true, generating: !!options.busy, visibleButtonLabels: [], modelHints: ["Pro"] };
          else if (e.includes("selectorProbeSnapshot")) value = { url, composerEmpty: !options.draft, menuClosed: !state.open, overlayOpen: state.open };
          else if (e === browser.projectItemRectExpression("Codex")) value = options.missingProject ? { ok: false, reason: "project not found in sidebar" } : { ok: true, x: 10, y: 10 };
          else if (e === browser.modelButtonRectExpression()) value = { ok: true, x: 20, y: 20 };
          else if (e === browser.menuItemRectExpression("Other model")) value = { ok: true, x: 30, y: 30, role: "menuitemradio", haspopup: options.submenuModel ? "menu" : null };
          else if (e.includes("document.elementFromPoint")) value = !(options.coveredModel && e.includes("(30, 30)"));
          else if (e === browser.menuOpenExpression()) value = state.open;
          else if (e === browser.modelMenuOptionsExpression()) value = options.checkedModel ? [{ label: "Other model", kind: "submenu", checked: true }] : [{ label: "Latest", kind: "radio", checked: true }];
          else if (e === browser.focusPowerSliderExpression()) value = { ok: true };
          else if (e === browser.powerSliderStateExpression()) {
            if (options.cleanupReadFails && state.reachedTop && state.position === 3) {
              this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id, error: { message: "Fixture cleanup read failed" } }) }));
              return;
            }
            value = { ok: true, position: state.position, min: 0, max: 4, model: "Latest", effort: ["Instant", "Medium", "High", "Extra High", options.noPro ? "Max" : "Pro"][state.position] };
          }
          else if (e.includes('removeAttribute("data-prodex-click")')) value = true;
          else throw new Error(`Unhandled fixture expression: ${e.slice(0, 100)}`);
        }
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id, result: { result: { value } } }) }));
      });
    }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event("close")); }
  }
  vi.stubGlobal("WebSocket", Socket);
  return state;
}

async function check(timeoutMs = 15_000, model = "Pro") {
  const done = browser.inspectConfiguredBrowserSelectors({ port: 19333, timeoutMs, selection: { model, project: "Codex" } });
  await vi.advanceTimersByTimeAsync(120_000);
  return done;
}

describe("configured selector readiness without sending", () => {
  it("verifies the Pro step and project target, restoring the original picker", async () => {
    const state = install();
    expect(await check()).toMatchObject({ modelMenu: "OPENED", model: { state: "VERIFIED" }, project: { state: "VERIFIED" } });
    expect(state.position).toBe(3);
    expect(state.open).toBe(false);
    expect(state.keys).not.toContain("Enter");
    expect(state.methods.some((m) => /insertText|navigate|reload|activateTarget|createTarget/.test(m))).toBe(false);
  });
  it.each([{ busy: true }, { draft: true }])("refuses input when page is occupied: %j", async (options) => {
    const state = install(options);
    expect(await check()).toMatchObject({ model: { state: "UNVERIFIED" }, project: { state: "UNVERIFIED" } });
    expect(state.methods.some((m) => m.startsWith("Input."))).toBe(false);
  });
  it("reports missing project without claiming readiness", async () => {
    install({ missingProject: true });
    expect(await check()).toMatchObject({ project: { state: "MISSING" } });
  });
  it("does not verify a selector that never opens", async () => {
    install({ menuFails: true });
    expect(await check()).toMatchObject({ modelMenu: "UNVERIFIED", model: { state: "UNVERIFIED" } });
  });
  it.each([{ restoreFails: true }, { closeFails: true }])("does not verify a probe with failed cleanup: %j", async (options) => {
    install(options);
    expect(await check()).toMatchObject({ model: { state: "UNVERIFIED" } });
  });
  it("never infers Pro from the slider's maximum position", async () => {
    install({ noPro: true });
    expect(await check()).toMatchObject({ model: { state: "MISSING" } });
  });
  it("does not turn a deadline into readiness", async () => {
    install();
    expect(await check(100)).toMatchObject({ model: { state: "UNVERIFIED" } });
  });
  it("still attempts menu closure when a cleanup read throws", async () => {
    const state = install({ cleanupReadFails: true });
    expect(await check()).toMatchObject({ model: { state: "UNVERIFIED" } });
    expect(state.open).toBe(false);
  });
  it("does not restore a slider in a different conversation after external navigation", async () => {
    const state = install({ pageChanges: true });
    expect(await check()).toMatchObject({ model: { state: "UNVERIFIED" } });
    expect(state.position).toBe(4);
    expect(state.keys).not.toContain("Escape");
  });
  it.each([{ coveredModel: true }, { submenuModel: true }, { submenuModel: true, checkedModel: true }])("does not verify unusable named-model controls: %j", async (options) => {
    install(options);
    expect(await check(15_000, "Other model")).toMatchObject({ model: { state: "UNVERIFIED" } });
  });
});
