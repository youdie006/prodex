import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composerTextStateExpression } from "../src/chatgpt-browser.js";

const ps = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), spawnSync: ps }));
const sockets = vi.hoisted(() => ({ create: undefined as undefined | ((url: string) => unknown) }));
vi.mock("ws", () => ({ default: class { constructor(url: string) { return sockets.create!(url); } } }));

let profile: string;
beforeEach(async () => { profile = await mkdtemp(path.join(tmpdir(), "prodex-handoff-")); });
afterEach(async () => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); await rm(profile, { recursive: true, force: true }); });

const url = "https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
type Options = { extraPage?: string; profileMismatch?: boolean; ephemeralFlag?: string; draft?: boolean; generating?: boolean; dialog?: boolean; attachments?: boolean; temporary?: boolean; targetChanged?: boolean; closeError?: boolean; lingering?: boolean; foreignSocket?: boolean };

function fixture(options: Options = {}) {
  vi.useFakeTimers();
  const data = { closed: false, closeCalls: 0, socketCount: 0, lists: 0, expressions: [] as string[] };
  const processLine = `tester 123456789 /usr/bin/google-chrome --remote-debugging-port=19333 --user-data-dir=${options.profileMismatch ? "/wrong/profile" : profile} --no-first-run ${options.ephemeralFlag ?? ""}`;
  ps.mockImplementation(() => ({ status: 0, stdout: data.closed && !options.lingering ? "" : processLine }));
  vi.spyOn(process, "kill").mockImplementation(((_pid: number, signal: unknown) => {
    expect(signal).toBe(0);
    if (data.closed && !options.lingering) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    return true;
  }) as typeof process.kill);
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    if (data.closed && !options.lingering) throw new TypeError("fetch failed", { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) });
    if (input.endsWith("/json/version")) return { ok: true, json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:19333/devtools/browser/one" }) };
    data.lists++;
    const currentUrl = options.temporary ? "https://chatgpt.com/?temporary-chat=true" : options.targetChanged && data.lists > 1 ? "https://chatgpt.com/" : url;
    return { ok: true, json: async () => [
      { id: "one", type: "page", title: "ChatGPT", url: currentUrl, webSocketDebuggerUrl: options.foreignSocket ? "ws://remote.invalid:19333/devtools/page/one" : "ws://127.0.0.1:19333/devtools/page/one" },
      ...(options.extraPage ? [{ id: "two", type: "page", title: "Other", url: options.extraPage, webSocketDebuggerUrl: "ws://127.0.0.1:19333/devtools/page/two" }] : [])
    ] };
  }));
  sockets.create = () => {
    data.socketCount++;
    class Socket extends EventEmitter {
      done = false;
      send(raw: string) {
        const request = JSON.parse(raw);
        if (request.method === "Runtime.evaluate") data.expressions.push(request.params.expression);
        queueMicrotask(() => {
          if (request.method === "Browser.close") {
            data.closeCalls++;
            if (options.closeError) { this.emit("message", JSON.stringify({ id: request.id, error: { message: "refused" } })); return; }
            data.closed = true;
          }
          this.emit("message", JSON.stringify({ id: request.id, result: request.method === "Runtime.evaluate" ? { result: { value: {
            status: { url, title: "ChatGPT", textSample: "New chat Projects Pro", visibleButtonLabels: [], hasComposer: true,
              generating: options.generating === true, modelHints: ["Pro"], visibilityState: "visible", openDialogText: "" },
            draft: options.draft === true, dialog: options.dialog === true, attachments: options.attachments === true, unpersisted: false
          } } } : {} }));
        });
      }
      close() { if (!this.done) { this.done = true; data.socketCount--; this.emit("close"); } }
      terminate() { this.close(); }
    }
    const socket = new Socket();
    queueMicrotask(() => socket.emit("open"));
    return socket;
  };
  return data;
}

async function run(options: Options = {}) {
  const data = fixture(options);
  const { closeIdleChatGptBrowserForHandoff } = await import("../src/browser-handoff.js");
  const promise = closeIdleChatGptBrowserForHandoff({ port: 19333, profileDir: profile })
    .then((value) => ({ value, error: undefined }), (error: Error) => ({ value: undefined, error }));
  await vi.advanceTimersByTimeAsync(20_000);
  const result = await promise;
  expect(data.socketCount).toBe(0);
  return { ...data, ...result };
}

describe("graceful dedicated-browser handoff", () => {
  it("closes only a verified idle browser and preserves its conversation", async () => {
    const result = await run();
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({ url });
    expect(result.closeCalls).toBe(1);
    // The proven composer probe excludes Chrome's hidden fallback textarea.
    expect(result.expressions).toHaveLength(2);
    expect(result.expressions.every((expression) => expression.includes(composerTextStateExpression()))).toBe(true);
  });
  it.each([
    { extraPage: "https://chatgpt.com/" }, { extraPage: "chrome://signin-dice-web-intercept.top-chrome/chrome-signin" },
    { profileMismatch: true }, { draft: true }, { generating: true }, { dialog: true }, { attachments: true },
    { temporary: true }, { targetChanged: true }, { foreignSocket: true }, { ephemeralFlag: "--incognito" }, { ephemeralFlag: "--guest" }, { ephemeralFlag: "--profile-directory=Profile 1" }
  ])("refuses unsafe handoff before closing %j", async (options) => {
    const result = await run(options);
    expect(result.error).toBeDefined();
    expect(result.closeCalls).toBe(0);
  });
  it("does not pretend a refused Browser.close succeeded", async () => {
    const result = await run({ closeError: true });
    expect(result.error).toBeDefined();
    expect(result.closeCalls).toBe(1);
  });
  it("does not force kill a browser that stays alive", async () => {
    const result = await run({ lingering: true });
    expect(result.error).toBeDefined();
    expect(result.closeCalls).toBe(1);
  });
});
