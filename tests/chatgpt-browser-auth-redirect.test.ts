import { afterEach, describe, expect, it, vi } from "vitest";

import {
  chatGptPageSelectionBlocker,
  type DevtoolsPage,
  getChatGptBrowserStatus,
  selectChatGptPage
} from "../src/chatgpt-browser.js";
import { waitForChatGptLoginReady } from "../src/cli-pro.js";

const AUTH_REDIRECT_URLS = [
  "https://auth.openai.com/authorize?state=private-state",
  "https://accounts.google.com/o/oauth2/v2/auth?state=private-state"
] as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ChatGPT authentication redirects", () => {
  it.each(AUTH_REDIRECT_URLS)("treats an exact HTTPS auth page as pending manual login: %s", (url) => {
    const blocker = chatGptPageSelectionBlocker([devtoolsTarget(url)]);

    expect(blocker).toMatchObject({ code: "login_required", retryable: true });
    expect(blocker?.message).toBe("An authentication page is already open in the dedicated browser.");
    expect(blocker?.next_step).toContain("keep using the current dedicated profile");
    expect(`${blocker?.message} ${blocker?.next_step}`).not.toMatch(/session (?:expired|lost)|lost session/i);
    expect(blocker?.message).not.toContain("private-state");
    expect(blocker?.next_step).not.toContain("private-state");
  });

  it.each([
    "http://auth.openai.com/",
    "https://auth.openai.com.example.test/",
    "https://example.test/?next=https://auth.openai.com/",
    "ftp://accounts.google.com/",
    "https://accounts.google.com.example.test/",
    "https://user@auth.openai.com/",
    "https://auth.openai.com:444/"
  ])("does not classify a lookalike or nonstandard auth URL: %s", (url) => {
    expect(chatGptPageSelectionBlocker([devtoolsTarget(url)])).toBeUndefined();
  });

  it.each(["iframe", "service_worker"])("ignores an auth host exposed as a %s target", (type) => {
    expect(
      chatGptPageSelectionBlocker([devtoolsTarget("https://auth.openai.com/authorize", type)])
    ).toBeUndefined();
  });

  it("does not alter selection when a real ChatGPT page exists", () => {
    const chatGpt = devtoolsTarget("https://chatgpt.com/c/current");
    const auth = devtoolsTarget(AUTH_REDIRECT_URLS[0]);

    expect(chatGptPageSelectionBlocker([auth, chatGpt])).toBeUndefined();
    expect(selectChatGptPage([auth, chatGpt])).toBe(chatGpt);
  });

  it("does not override explicit target selection rules", () => {
    const auth = devtoolsTarget(AUTH_REDIRECT_URLS[0]);

    expect(chatGptPageSelectionBlocker([auth], "https://chatgpt.com/c/confirmed")).toBeUndefined();
    expect(selectChatGptPage([auth], "https://chatgpt.com/c/confirmed")).toBeUndefined();
  });

  it.each(AUTH_REDIRECT_URLS)("reports pending login from status without evaluating provider content: %s", async (url) => {
    const evaluatedTargets: string[] = [];
    class UnexpectedProviderWebSocket {
      static readonly OPEN = 1;
      constructor(socketUrl: string) {
        evaluatedTargets.push(socketUrl);
        throw new Error("Authentication provider content must not be evaluated");
      }
    }
    vi.stubGlobal("WebSocket", UnexpectedProviderWebSocket);
    stubDevtoolsTargets([devtoolsTarget(url)]);

    await expect(getChatGptBrowserStatus({ port: 19333, timeoutMs: 100 })).resolves.toMatchObject({
      reachable: true,
      loggedInLikely: false,
      hasComposer: false,
      blocker: { code: "login_required", retryable: true }
    });
    expect(evaluatedTargets).toEqual([]);
  });

  it("keeps a generic empty page list classified as missing", async () => {
    stubDevtoolsTargets([]);

    await expect(getChatGptBrowserStatus({ port: 19333, timeoutMs: 100 })).resolves.toMatchObject({
      reachable: true,
      blocker: { code: "chatgpt_page_missing" }
    });
  });

  it("keeps the login wait on the existing auth redirect without opening another tab", async () => {
    const evaluatedTargets: string[] = [];
    class UnexpectedProviderWebSocket {
      static readonly OPEN = 1;
      constructor(socketUrl: string) {
        evaluatedTargets.push(socketUrl);
        throw new Error("Authentication provider content must not be evaluated");
      }
    }
    vi.stubGlobal("WebSocket", UnexpectedProviderWebSocket);
    stubDevtoolsTargets([devtoolsTarget(AUTH_REDIRECT_URLS[1])]);
    const openTabFn = vi.fn(async () => true);
    const lines: string[] = [];
    let now = 0;

    const ready = await waitForChatGptLoginReady((line) => lines.push(line), {
      port: 19333,
      timeoutMs: 60_000,
      pollMs: 1,
      windowMode: { headless: true, virtualDisplay: false, minimized: false }
    }, {
      statusFn: getChatGptBrowserStatus,
      sleepFn: async () => {},
      openTabFn,
      now: () => (now += 1_000)
    });

    expect(ready).toBe(false);
    expect(openTabFn).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("login_required");
    expect(evaluatedTargets).toEqual([]);
  });

  it("keeps a headed wait on successive auth redirects until ChatGPT becomes ready", async () => {
    const evaluatedTargets: string[] = [];
    class UnexpectedProviderWebSocket {
      static readonly OPEN = 1;
      constructor(socketUrl: string) {
        evaluatedTargets.push(socketUrl);
        throw new Error("Authentication provider content must not be evaluated");
      }
    }
    vi.stubGlobal("WebSocket", UnexpectedProviderWebSocket);
    const authTargets = [AUTH_REDIRECT_URLS[1], AUTH_REDIRECT_URLS[0]];
    let probe = 0;
    const statusFn = vi.fn(async (options: { port?: number; timeoutMs?: number }) => {
      if (probe < authTargets.length) {
        stubDevtoolsTargets([devtoolsTarget(authTargets[probe++])]);
        return getChatGptBrowserStatus(options);
      }
      probe += 1;
      return {
        reachable: true,
        loggedInLikely: true,
        hasComposer: true,
        modelHints: []
      };
    });
    const openTabFn = vi.fn(async () => true);
    const sleepFn = vi.fn(async () => {});
    let now = 0;

    const ready = await waitForChatGptLoginReady(() => {}, {
      port: 19333,
      timeoutMs: 60_000,
      pollMs: 1,
      windowMode: { headless: false, virtualDisplay: false, minimized: false }
    }, {
      statusFn,
      sleepFn,
      openTabFn,
      now: () => (now += 1_000)
    });

    expect(ready).toBe(true);
    expect(statusFn).toHaveBeenCalledTimes(3);
    expect(sleepFn).toHaveBeenCalledTimes(2);
    expect(openTabFn).not.toHaveBeenCalled();
    expect(evaluatedTargets).toEqual([]);
  });
});

function devtoolsTarget(url: string, type = "page"): DevtoolsPage {
  return {
    id: encodeURIComponent(url),
    type,
    url,
    title: "",
    webSocketDebuggerUrl: `ws://provider.invalid/devtools/page/${encodeURIComponent(url)}`
  };
}

function stubDevtoolsTargets(targets: DevtoolsPage[]): void {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => targets
  })));
}
