import { afterEach, describe, expect, it, vi } from "vitest";

import { browserLostMidWaitBlocker, getChatGptBrowserStatus, sendChatGptPrompt } from "../src/chatgpt-browser.js";

const original = "https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const accepted = "https://chatgpt.com/c/11111111-2222-3333-4444-555555555555";
type Page = { id: string; url: string; visible: boolean; crashed: boolean; stalled?: boolean };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("unconfirmed submission authentication", () => {
  it("does not make a dispatch failure retryable when Enter may already have submitted", async () => {
    const fixture = install([{ id: "a", url: original, visible: true, crashed: false }], { dispatchFailure: true });
    const result = await settle(sendChatGptPrompt({ port: 19333, prompt: "uncertain question", targetUrl: original, timeoutMs: 4_000 }));
    expect(result).toMatchObject({ error: { blocker: { code: "prompt_acceptance_unconfirmed", retryable: false } } });
    expect(result.error?.blocker.next_step).toMatch(/do not.*resend/i);
    expect(result.error?.blocker.next_step).toMatch(/\[prodex-request:[a-f0-9]{32}\]/);
    expect(fixture.submissions).toBe(1);
    expect(fixture.reloads).toEqual([]);
  });

  it("does not infer session expiry from missing logged-in signals", async () => {
    const fixture = install([{ id: "a", url: original, visible: true, crashed: false }], { postSubmitStatus: "unknown" });
    const result = await settle(sendChatGptPrompt({ port: 19333, prompt: "uncertain question", targetUrl: original, timeoutMs: 4_000 }));
    expect(result.error).toBeDefined();
    expect(result.error?.blocker?.code).not.toBe("session_expired");
    expect(result.error?.message).not.toMatch(/log in|session.*expired/i);
    expect(result.error?.blocker?.retryable).toBe(false);
    expect(result.error?.message).toMatch(/do not.*resend/i);
    expect(fixture.submissions).toBe(1);
    expect(fixture.reloads).toEqual([]);
  });

  it.each(["login", "cloudflare"] as const)("preserves explicit %s evidence without making an uncertain submit retryable", async (postSubmitStatus) => {
    const fixture = install([{ id: "a", url: original, visible: true, crashed: false }], { postSubmitStatus });
    const result = await settle(sendChatGptPrompt({ port: 19333, prompt: "uncertain question", targetUrl: original, timeoutMs: 4_000 }));
    expect(result.error?.blocker).toMatchObject({ code: postSubmitStatus === "login" ? "login_required" : "cloudflare_check", retryable: false });
    expect(result.error?.blocker.next_step).toMatch(/do not.*resend/i);
    expect(result.error?.blocker.next_step).not.toMatch(/then retry/i);
    expect(fixture.submissions).toBe(1);
    expect(fixture.reloads).toEqual([]);
  });

  it("does not recommend resending when the first acceptance poll reports login", async () => {
    const fixture = install([{ id: "a", url: original, visible: true, crashed: false }], { postSubmitStatus: "login", runtimeLoginBlocker: true });
    const result = await settle(sendChatGptPrompt({ port: 19333, prompt: "uncertain question", targetUrl: original, timeoutMs: 4_000 }));
    expect(result.error?.blocker).toMatchObject({ code: "login_required", retryable: false });
    expect(result.error?.blocker.next_step).toMatch(/do not.*resend/i);
    expect(result.error?.blocker.next_step).toMatch(/\[prodex-request:[a-f0-9]{32}\]/);
    expect(fixture.submissions).toBe(1);
    expect(fixture.reloads).toEqual([]);
  });

  it("preserves the accepted thread when login appears while waiting for the answer", async () => {
    const fixture = install([{ id: "a", url: original, visible: true, crashed: false }], { loginAfterAcceptance: true });
    const result = await settle(sendChatGptPrompt({ port: 19333, prompt: "accepted question", targetUrl: original, timeoutMs: 4_000 }));
    expect(result.error?.blocker).toMatchObject({ code: "login_required", retryable: false, thread: original });
    expect(result.error?.blocker.next_step).toContain(`--target-url ${original}`);
    expect(result.error?.blocker.next_step).toMatch(/--request-id [a-f0-9]{32}/);
    expect(result.error?.blocker.next_step).toMatch(/do not.*resend/i);
    expect(fixture.submissions).toBe(1);
    expect(fixture.reloads).toEqual([]);
  });
});

describe("confirmed renderer crashes", () => {
  it("preserves the request marker when a lost connection has no captured thread", () => {
    const requestId = "0123456789abcdef0123456789abcdef";
    const blocker = browserLostMidWaitBlocker(undefined, requestId);
    expect(blocker.retryable).toBe(false);
    expect(blocker.next_step).toContain(`[prodex-request:${requestId}]`);
    expect(blocker.next_step).not.toContain("--target-url");
  });

  it("reports an already crashed tab as reachable, without reloading during status", async () => {
    const fixture = install([{ id: "a", url: original, visible: true, crashed: true }]);
    const result = await settle(getChatGptBrowserStatus({ port: 19333, timeoutMs: 500 }));
    expect(result).toMatchObject({ value: { reachable: true, blocker: { code: "browser_tab_crashed", thread: original } } });
    expect(fixture.reloads).toEqual([]);
  });

  it("does not count a confirmed crashed background tab as an unknown visible competitor", async () => {
    install([
      { id: "a", url: original, visible: true, crashed: false },
      { id: "b", url: accepted, visible: false, crashed: true }
    ]);
    const result = await settle(getChatGptBrowserStatus({ port: 19333, timeoutMs: 500 }));
    expect(result).toMatchObject({ value: { reachable: true, hasComposer: true, url: original } });
  });

  it("reloads the same crashed target once before input and records the repair", async () => {
    const fixture = install([{ id: "a", url: original, visible: true, crashed: true }]);
    const result = await settle(sendChatGptPrompt({ port: 19333, prompt: "test question", targetUrl: original, timeoutMs: 4_000 }));
    expect(result).toMatchObject({ value: { answer: "test answer", requestVerified: true, url: original } });
    expect(result.value?.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/^browser_tab_recovered:/)]));
    expect(fixture.reloads).toEqual([{ id: "a", url: original, submissions: 0 }]);
    expect(fixture.submissions).toBe(1);
  });

  it("never falls back from a pinned crashed target to a healthy other conversation", async () => {
    const fixture = install([
      { id: "other", url: accepted, visible: true, crashed: false },
      { id: "target", url: original, visible: false, crashed: true }
    ]);
    const result = await settle(sendChatGptPrompt({ port: 19333, prompt: "test question", targetUrl: original, timeoutMs: 4_000 }));
    expect(result).toMatchObject({ error: { blocker: { code: "tab_not_visible" } } });
    expect(fixture.reloads.map((r) => r.id)).toEqual(["target"]);
    expect(fixture.submissions).toBe(0);
  });

  it("does not reload a slow tab without crash evidence", async () => {
    const fixture = install([{ id: "a", url: original, visible: true, crashed: false, stalled: true }]);
    const result = await settle(sendChatGptPrompt({ port: 19333, prompt: "test question", targetUrl: original, timeoutMs: 4_000 }));
    expect(result.error?.message).toMatch(/command timed out/);
    expect(fixture.reloads).toEqual([]);
    expect(fixture.submissions).toBe(0);
  });

  it("stops after one reload if the renderer crashes again", async () => {
    const fixture = install([{ id: "a", url: original, visible: true, crashed: true }], { crashesAgain: true });
    const result = await settle(sendChatGptPrompt({ port: 19333, prompt: "test question", targetUrl: original, timeoutMs: 4_000 }));
    expect(result).toMatchObject({ error: { blocker: { code: "browser_tab_crashed" } } });
    expect(fixture.reloads).toHaveLength(1);
    expect(fixture.submissions).toBe(0);
  });

  it("refuses a target whose URL changed before recovery", async () => {
    const fixture = install([{ id: "a", url: original, visible: true, crashed: true }], { changesBeforeReload: true });
    const result = await settle(sendChatGptPrompt({ port: 19333, prompt: "test question", targetUrl: original, timeoutMs: 4_000 }));
    expect(result.error).toBeDefined();
    expect(fixture.reloads).toEqual([]);
    expect(fixture.submissions).toBe(0);
  });

  it("does not reload a tab that another client already recovered", async () => {
    const fixture = install([{ id: "a", url: original, visible: true, crashed: true }], { recoversBeforeReload: true });
    const result = await settle(sendChatGptPrompt({ port: 19333, prompt: "test question", targetUrl: original, timeoutMs: 4_000 }));
    expect(result).toMatchObject({ value: { answer: "test answer", requestVerified: true } });
    expect(fixture.reloads).toEqual([]);
    expect(fixture.submissions).toBe(1);
  });

  it("preserves the accepted request identity after a crash without reload or resend", async () => {
    const fixture = install([{ id: "a", url: original, visible: true, crashed: false }], { crashAfterAcceptance: true });
    const result = await settle(sendChatGptPrompt({ port: 19333, prompt: "test question", timeoutMs: 4_000 }));
    expect(result).toMatchObject({ error: { blocker: { code: "browser_tab_crashed", retryable: false, thread: accepted } } });
    const requestId = /\[prodex-request:([a-f0-9]{32})\]/.exec(fixture.prompt)?.[1];
    expect(requestId).toBeDefined();
    expect(result.error?.blocker.next_step).toContain(`--target-url ${accepted}`);
    expect(result.error?.blocker.next_step).toContain(`--request-id ${requestId}`);
    expect(result.error?.blocker.next_step).not.toContain(original);
    expect(fixture.reloads).toEqual([]);
    expect(fixture.submissions).toBe(1);
  });
});

async function settle<T>(promise: Promise<T>): Promise<{ value?: T; error?: any }> {
  const settled = promise.then((value) => ({ value }), (error) => ({ error }));
  await vi.advanceTimersByTimeAsync(60_000);
  return settled;
}

function install(pages: Page[], options: { crashesAgain?: boolean; changesBeforeReload?: boolean; crashAfterAcceptance?: boolean; recoversBeforeReload?: boolean; postSubmitStatus?: "unknown" | "login" | "cloudflare"; runtimeLoginBlocker?: boolean; loginAfterAcceptance?: boolean; dispatchFailure?: boolean } = {}) {
  vi.useFakeTimers();
  const fixture = { reloads: [] as { id: string; url: string; submissions: number }[], submissions: 0, prompt: "", acceptedReads: 0 };
  const sockets: Socket[] = [];
  let discovery = 0;
  vi.stubGlobal("fetch", vi.fn(async () => {
    discovery += 1;
    if (options.changesBeforeReload && discovery > 1) pages[0].url = accepted;
    if (options.recoversBeforeReload && discovery > 1) {
      pages[0].crashed = false;
      for (const socket of sockets) {
        if (socket.readyState === Socket.OPEN) socket.emit({ method: "Inspector.targetReloadedAfterCrash", params: {} });
      }
    }
    return { ok: true, json: async () => pages.map((p) => ({ ...p, type: "page", title: "ChatGPT", webSocketDebuggerUrl: `ws://fake/${p.id}` })) };
  }));
  class Socket extends EventTarget {
    static OPEN = 1;
    readyState = 0;
    private page: Page;
    constructor(url: string) {
      super();
      this.page = pages.find((p) => url.endsWith(`/${p.id}`))!;
      sockets.push(this);
      queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); });
    }
    emit(data: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) })); }
    send(raw: string) {
      const request = JSON.parse(raw);
      queueMicrotask(() => {
        const page = this.page;
        if (request.method === "Inspector.enable" && page.crashed) this.emit({ method: "Inspector.targetCrashed", params: {} });
        if (request.method === "Page.reload") {
          fixture.reloads.push({ id: page.id, url: page.url, submissions: fixture.submissions });
          page.crashed = options.crashesAgain === true;
          this.emit({ method: page.crashed ? "Inspector.targetCrashed" : "Inspector.targetReloadedAfterCrash", params: {} });
        }
        if (request.method.startsWith("Runtime.") && (page.crashed || page.stalled)) return;
        if (request.method === "Input.dispatchKeyEvent" && request.params?.key === "Enter" && request.params?.type === "keyDown") fixture.submissions += 1;
        if (options.dispatchFailure && fixture.submissions && request.method === "Input.dispatchKeyEvent") {
          this.close();
          return;
        }
        let value: unknown;
        if (request.method === "Runtime.evaluate") {
          const expression = request.params.expression as string;
          if (expression === "document.visibilityState") value = page.visible ? "visible" : "hidden";
          else if (expression.includes("visibilityState: document.visibilityState")) value = {
            title: "ChatGPT", url: page.url, visibilityState: page.visible ? "visible" : "hidden",
            textSample: "New chat\nProjects\nPro", blockerTextSample: "", blockerScanTextSample: "",
            visibleButtonLabels: [], hasComposer: true, generating: false, modelHints: ["Pro"],
            ...(fixture.submissions && options.postSubmitStatus ? { hasComposer: false, textSample: "", blockerTextSample: "", blockerScanTextSample: "",
              title: options.postSubmitStatus === "cloudflare" ? "Just a moment..." : "ChatGPT",
              visibleButtonLabels: options.postSubmitStatus === "login" ? ["Log in", "Sign up"] : [] } : {})
          };
          else if (expression.includes("const surfaces = buttons.map")) value = { surfaces: [{ label: "Chat", checked: true }] };
          else if (expression.includes("assistantMessageCount")) {
            if (fixture.submissions) {
              fixture.acceptedReads += 1;
              if (options.crashAfterAcceptance) page.url = accepted;
              if (options.crashAfterAcceptance && fixture.acceptedReads > 1) {
                page.crashed = true;
                this.emit({ method: "Inspector.targetCrashed", params: {} });
                return;
              }
            }
            const reported = options.postSubmitStatus ? 0 : fixture.submissions;
            value = { title: "ChatGPT", url: page.url, answer: reported ? "test answer" : "",
              assistantMessageCount: reported ? 1 : 0, userMessageCount: reported,
              lastUserText: reported ? fixture.prompt : "", generating: options.crashAfterAcceptance === true,
              modelHints: ["Pro"], modelSlug: "gpt-6-pro", textSample: "", blockerTextSample: "",
              visibleButtonLabels: (fixture.submissions && options.runtimeLoginBlocker) || (options.loginAfterAcceptance && fixture.acceptedReads > 1) ? ["Log in", "Sign up"] : [] };
          }
          else if (expression.includes("actualText: raw.slice")) {
            const expected = /const expected = (.+);/.exec(expression)?.[1];
            if (expected && expected !== "null") fixture.prompt = JSON.parse(expected);
            value = { ok: true, actualText: fixture.prompt };
          }
          else if (expression.includes("return { ok: true, hasText }")) value = { ok: true, hasText: false };
          else if (expression.includes(").ok === true")) value = true;
          else if (expression.includes("return Boolean(last && last.text.includes(")) value = fixture.submissions > 0;
        }
        this.emit({ id: request.id, result: { result: { value } } });
      });
    }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event("close")); }
  }
  vi.stubGlobal("WebSocket", Socket);
  return fixture;
}
