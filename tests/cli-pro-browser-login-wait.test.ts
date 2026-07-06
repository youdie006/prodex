import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const openChatGptBrowserMock = vi.hoisted(() => vi.fn());
const getChatGptBrowserStatusMock = vi.hoisted(() => vi.fn());

vi.mock("../src/chatgpt-browser.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/chatgpt-browser.js")>();
  return {
    ...actual,
    openChatGptBrowser: openChatGptBrowserMock,
    getChatGptBrowserStatus: getChatGptBrowserStatusMock
  };
});

const { runCli } = await import("../src/cli.js");
const { waitForChatGptLoginReady } = await import("../src/cli-pro.js");

function status(overrides: Partial<{ reachable: boolean; loggedInLikely: boolean; hasComposer: boolean }> = {}) {
  return {
    reachable: false,
    loggedInLikely: false,
    hasComposer: false,
    modelHints: [] as string[],
    ...overrides
  };
}

describe("waitForChatGptLoginReady", () => {
  it("walks the login states once each and reports READY", async () => {
    const lines: string[] = [];
    const statuses = [
      status(),
      status({ reachable: true }),
      status({ reachable: true }),
      status({ reachable: true, loggedInLikely: true }),
      status({ reachable: true, loggedInLikely: true, hasComposer: true })
    ];
    let call = 0;

    const ready = await waitForChatGptLoginReady((line) => lines.push(line), { port: 9333, timeoutMs: 60_000, pollMs: 1 }, {
      statusFn: async () => statuses[Math.min(call++, statuses.length - 1)],
      sleepFn: async () => {}
    });

    expect(ready).toBe(true);
    expect(lines.filter((line) => line.includes("browser starting"))).toHaveLength(1);
    expect(lines.filter((line) => line.includes("waiting for ChatGPT login"))).toHaveLength(1);
    expect(lines.filter((line) => line.includes("open a chat so the prompt composer"))).toHaveLength(1);
    expect(lines[lines.length - 1]).toMatch(/^login: READY - logged-in ChatGPT tab with composer detected \(\d+s\)\.$/);
  });

  it("surfaces page blockers while waiting", async () => {
    const lines: string[] = [];
    const blocked = {
      ...status({ reachable: true, loggedInLikely: true }),
      blocker: {
        code: "cloudflare_check",
        message: "ChatGPT is behind a Cloudflare check.",
        retryable: true
      }
    };
    const statuses = [blocked, status({ reachable: true, loggedInLikely: true, hasComposer: true })];
    let call = 0;

    const ready = await waitForChatGptLoginReady((line) => lines.push(line), { port: 9333, timeoutMs: 60_000, pollMs: 1 }, {
      statusFn: async () => statuses[Math.min(call++, statuses.length - 1)],
      sleepFn: async () => {}
    });

    expect(ready).toBe(true);
    expect(lines).toContain("login: blocked - ChatGPT is behind a Cloudflare check.");
  });

  it("gives up after the timeout with a check hint", async () => {
    const lines: string[] = [];
    let fakeNow = 0;

    const ready = await waitForChatGptLoginReady((line) => lines.push(line), { port: 9333, timeoutMs: 10_000, pollMs: 1 }, {
      statusFn: async () => status({ reachable: true }),
      sleepFn: async () => {},
      now: () => (fakeNow += 3_000)
    });

    expect(ready).toBe(false);
    expect(lines[lines.length - 1]).toContain("not ready after 10s");
    expect(lines[lines.length - 1]).toContain("prodex pro browser check");
  });
});

describe("pro browser login --wait", () => {
  it("waits for readiness and exits 0 once the composer is detected", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-login-wait-"));
    openChatGptBrowserMock.mockReturnValueOnce({
      port: 9333,
      profileDir: "/tmp/fake-profile",
      waitForEarlyExit: async () => undefined
    });
    getChatGptBrowserStatusMock.mockResolvedValue(status({ reachable: true, loggedInLikely: true, hasComposer: true }));
    const errs: string[] = [];

    const code = await runCli(["pro", "browser", "login", "--wait", "--wait-timeout-ms", "5000"], {
      cwd,
      stdout: () => {},
      stderr: (line) => errs.push(line)
    });

    expect(code).toBe(0);
    expect(errs.some((line) => line.includes("login: READY"))).toBe(true);
  });

  it("exits 1 when readiness never arrives within the wait budget", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-login-wait-"));
    openChatGptBrowserMock.mockReturnValueOnce({
      port: 9333,
      profileDir: "/tmp/fake-profile",
      waitForEarlyExit: async () => undefined
    });
    getChatGptBrowserStatusMock.mockResolvedValue(status({ reachable: true }));
    const errs: string[] = [];

    const code = await runCli(["pro", "browser", "login", "--wait", "--wait-timeout-ms", "50"], {
      cwd,
      stdout: () => {},
      stderr: (line) => errs.push(line)
    });

    expect(code).toBe(1);
    expect(errs.some((line) => line.includes("not ready after"))).toBe(true);
  });

  it("does not wait in non-interactive runs unless --wait is passed", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-login-wait-"));
    openChatGptBrowserMock.mockReturnValueOnce({
      port: 9333,
      profileDir: "/tmp/fake-profile",
      waitForEarlyExit: async () => undefined
    });
    getChatGptBrowserStatusMock.mockResolvedValue(status({ reachable: true }));
    const errs: string[] = [];

    const code = await runCli(["pro", "browser", "login"], {
      cwd,
      stdout: () => {},
      stderr: (line) => errs.push(line)
    });

    expect(code).toBe(0);
    expect(errs.every((line) => !line.startsWith("login:"))).toBe(true);
  });
});
