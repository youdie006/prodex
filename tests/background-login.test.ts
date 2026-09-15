import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const status = vi.hoisted(() => vi.fn());
const open = vi.hoisted(() => vi.fn());
const readLaunch = vi.hoisted(() => vi.fn());
const record = vi.hoisted(() => vi.fn());
const close = vi.hoisted(() => vi.fn());
const actualHeadless = vi.hoisted(() => vi.fn());

vi.mock("../src/chatgpt-browser.js", async (original) => ({
  ...await original<typeof import("../src/chatgpt-browser.js")>(),
  getChatGptBrowserStatus: status,
  openChatGptBrowser: open,
  readLastBrowserLoginLaunch: readLaunch,
  recordBrowserLoginLaunch: record,
  findWedgedBrowser: () => []
}));
vi.mock("../src/browser-handoff.js", () => ({ closeIdleChatGptBrowserForHandoff: close, getDedicatedBrowserHeadlessMode: actualHeadless }));

import { runCli } from "../src/cli.js";

const ready = { reachable: true, loggedInLikely: true, hasComposer: true, modelHints: [] };
const saved = { port: 9333, profile_dir: "/saved/profile", headless: false, minimized: false };
const thread = "https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
let out: string[];
let errors: string[];
const run = (args: string[]) => runCli(["pro", "browser", "login", "--port", "9333", ...args], {
  cwd: "/tmp/background-login-test", stdout: (line) => out.push(line), stderr: (line) => errors.push(line), isInteractive: false
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("PRODEX_HEADLESS", "");
  vi.stubEnv("PRODEX_MINIMIZE_WINDOW", "");
  vi.stubEnv("PRODEX_VIRTUAL_DISPLAY", "");
  status.mockResolvedValue(ready);
  readLaunch.mockResolvedValue(saved);
  record.mockResolvedValue(undefined);
  close.mockResolvedValue({ url: thread });
  actualHeadless.mockReturnValueOnce(false).mockReturnValue(true);
  open.mockReturnValue({ port: 9333, profileDir: saved.profile_dir, waitForEarlyExit: async () => undefined });
  out = []; errors = [];
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("one-time background login", () => {
  it("previews the complete handoff without touching a browser", async () => {
    expect(await run(["--background", "--dry-run"])).toBe(0);
    expect(out.join("\n")).toMatch(/same profile.*headless/i);
    expect(close).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it.each(["--headed", "--headless", "--minimized", "--virtual-display", "--no-wait"])("rejects ambiguous background flag %s", async (flag) => {
    await expect(run(["--background", flag])).rejects.toThrow(/--background cannot combine/);
    expect(open).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it("waits in a non-TTY and hands the same profile and conversation to headless", async () => {
    expect(await run(["--background", "--wait-timeout-ms", "100"])).toBe(0);
    expect(close).toHaveBeenCalledWith({ port: 9333, profileDir: saved.profile_dir });
    expect(open).toHaveBeenCalledWith({ port: 9333, profileDir: saved.profile_dir, headless: true, url: thread });
    expect(record).toHaveBeenLastCalledWith({ port: 9333, profile_dir: saved.profile_dir, headless: true, minimized: false });
    expect(out.join("\n")).toContain("background: READY");
    expect(close.mock.invocationCallOrder[0]).toBeLessThan(open.mock.invocationCallOrder[0]);
  });

  it("does not close or relaunch an already headless saved session", async () => {
    readLaunch.mockResolvedValue({ ...saved, headless: true });
    actualHeadless.mockReset().mockReturnValue(true);
    expect(await run(["--background", "--wait-timeout-ms", "100"])).toBe(0);
    expect(close).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(out.join("\n")).toContain("headless: signed-in session confirmed");
    expect(out.join("\n")).toContain("background: READY");
  });

  it("uses the actual headed process when the saved mode is stale", async () => {
    readLaunch.mockResolvedValue({ ...saved, headless: true });
    expect(await run(["--background", "--wait-timeout-ms", "100"])).toBe(0);
    expect(close).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ headless: true }));
  });

  it("refuses an unverified running profile without overwriting its saved identity", async () => {
    actualHeadless.mockReset().mockImplementation(() => { throw new Error("profile mismatch"); });
    await expect(run(["--background"])).rejects.toThrow(/profile mismatch/);
    expect(close).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("never records a headed replacement as headless", async () => {
    actualHeadless.mockReset().mockReturnValue(false);
    await expect(run(["--background", "--wait-timeout-ms", "100"])).rejects.toThrow(/not actually headless/);
    expect(record).not.toHaveBeenCalledWith(expect.objectContaining({ headless: true }));
    expect(out.join("\n")).not.toContain("background: READY");
  });

  it("preserves ordinary headed login behavior", async () => {
    expect(await run(["--headed", "--no-wait"])).toBe(0);
    expect(close).not.toHaveBeenCalled();
    expect(out.join("\n")).toMatch(/does not switch.*headless/i);
  });

  it("does not claim background readiness after a guarded close refusal", async () => {
    close.mockRejectedValue(new Error("browser_handoff_blocked: finish Chrome account confirmation"));
    await expect(run(["--background", "--wait-timeout-ms", "100"])).rejects.toThrow(/browser_handoff_blocked/);
    expect(open).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalledWith(expect.objectContaining({ headless: true }));
    expect(out.join("\n")).not.toContain("background: READY");
  });

  it("names a post-handoff challenge without claiming the stored login is erased", async () => {
    open.mockImplementation(() => {
      status.mockResolvedValue({ ...ready, loggedInLikely: false, hasComposer: false,
        blocker: { code: "cloudflare_check", message: "A visible verification is required", retryable: false } });
      return { port: 9333, profileDir: saved.profile_dir, waitForEarlyExit: async () => undefined };
    });
    expect(await run(["--background", "--wait-timeout-ms", "50"])).toBe(1);
    expect(out.join("\n") + errors.join("\n")).toContain("cloudflare_check");
    expect(out.join("\n")).not.toContain("background: READY");
    expect(out.join("\n")).not.toContain("profile is not signed in");
    expect(open).toHaveBeenCalledTimes(1);
  });
});
