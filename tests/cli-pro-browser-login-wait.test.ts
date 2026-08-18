import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const openChatGptBrowserMock = vi.hoisted(() => vi.fn());
const getChatGptBrowserStatusMock = vi.hoisted(() => vi.fn());
const minimizeChatGptWindowMock = vi.hoisted(() => vi.fn());

vi.mock("../src/chatgpt-browser.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/chatgpt-browser.js")>();
  return {
    ...actual,
    openChatGptBrowser: openChatGptBrowserMock,
    // The wedged scan reads this machine's process table; a Chrome running here
    // must not decide what a unit test sees.
    findWedgedBrowser: () => [],
    getChatGptBrowserStatus: getChatGptBrowserStatusMock,
    minimizeChatGptWindow: minimizeChatGptWindowMock
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

  it("opens the ChatGPT tab itself when the running Chrome has none", async () => {
    // Reported from a live machine: Chrome was already running, so login said
    // "reusing it (no new window opened)" - and then told the user to finish
    // logging in "in the opened window" while blocking on
    // "no chatgpt.com tab is open". There was no window to log into and prodex
    // never opened one, so the wait could not end.
    const lines: string[] = [];
    const missing = {
      ...status({ reachable: true }),
      blocker: {
        code: "chatgpt_page_missing",
        message: "Chrome debug port is reachable, but no chatgpt.com tab is open.",
        retryable: true
      }
    };
    const statuses = [missing, missing, status({ reachable: true, loggedInLikely: true, hasComposer: true })];
    let call = 0;
    const opened: number[] = [];

    const ready = await waitForChatGptLoginReady((line) => lines.push(line), { port: 9333, timeoutMs: 60_000, pollMs: 1 }, {
      statusFn: async () => statuses[Math.min(call++, statuses.length - 1)],
      sleepFn: async () => {},
      openTabFn: async (port: number) => {
        opened.push(port);
      }
    });

    expect(ready).toBe(true);
    // Opened once, not once per poll: a tab per second would bury the user.
    expect(opened).toEqual([9333]);
    expect(lines.some((line) => /opening a ChatGPT tab/i.test(line))).toBe(true);
  });

  it("does not claim a window was opened when it reused a running Chrome", async () => {
    const lines: string[] = [];
    await waitForChatGptLoginReady((line) => lines.push(line), { port: 9333, timeoutMs: 1, pollMs: 1 }, {
      statusFn: async () => status({ reachable: true, loggedInLikely: true, hasComposer: true }),
      sleepFn: async () => {},
      now: (() => {
        let t = 0;
        return () => (t += 1);
      })()
    });
    // "the opened window" is wrong whenever login reused a running browser.
    expect(lines.some((line) => line.includes("the opened window"))).toBe(false);
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

  it("names Cloudflare as the reason a headless login never becomes ready", async () => {
    // Field failure: headless Chrome gets a Cloudflare "Just a moment..."
    // interstitial on chatgpt.com and never reaches the composer, but the
    // login reported "the profile is not signed in" - sending the user to
    // re-login instead of telling them headless is the problem.
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-login-wait-"));
    const priorLastLogin = process.env.PRODEX_LAST_LOGIN_FILE;
    process.env.PRODEX_LAST_LOGIN_FILE = path.join(cwd, "last-login.json");
    openChatGptBrowserMock.mockReturnValueOnce({
      port: 9333,
      profileDir: "/tmp/fake-profile",
      waitForEarlyExit: async () => undefined
    });
    const challenged = {
      ...status({ reachable: true }),
      title: "Just a moment...",
      blocker: {
        code: "cloudflare_check",
        message: "ChatGPT is showing a Cloudflare or human-verification interstitial.",
        retryable: true,
        next_step: "Complete the visible browser check manually, then retry."
      }
    };
    // First probe decides "is something already running" - nothing is, so the
    // headless launch happens; every later read sees the challenge.
    let probe = 0;
    getChatGptBrowserStatusMock.mockImplementation(async () => (probe++ === 0 ? status() : challenged));
    const out: string[] = [];

    try {
      const code = await runCli(["pro", "browser", "login", "--headless", "--wait-timeout-ms", "50"], {
        cwd,
        stdout: (line) => out.push(line),
        stderr: () => {}
      });

      const text = out.join("\n");
      expect(code).toBe(1);
      expect(text).toMatch(/cloudflare/i);
      expect(text).not.toMatch(/not signed in/i);
      expect(text).toMatch(/virtual display|Xvfb/i);
    } finally {
      if (priorLastLogin === undefined) delete process.env.PRODEX_LAST_LOGIN_FILE;
      else process.env.PRODEX_LAST_LOGIN_FILE = priorLastLogin;
      getChatGptBrowserStatusMock.mockReset();
    }
  });

  it("minimizes the window on --minimized and confirms the tab still reads visible", async () => {
    // Measured live under WSLg: a minimized Chrome still reports
    // visibilityState "visible", so a real headed browser (which Cloudflare
    // accepts) can run with no window on the desktop.
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-login-wait-"));
    const priorLastLogin = process.env.PRODEX_LAST_LOGIN_FILE;
    process.env.PRODEX_LAST_LOGIN_FILE = path.join(cwd, "last-login.json");
    openChatGptBrowserMock.mockReturnValueOnce({
      port: 9333,
      profileDir: "/tmp/fake-profile",
      waitForEarlyExit: async () => undefined
    });
    getChatGptBrowserStatusMock.mockResolvedValue(status({ reachable: true, loggedInLikely: true, hasComposer: true }));
    minimizeChatGptWindowMock.mockResolvedValue({ minimized: true, visibilityState: "visible" });
    const out: string[] = [];

    try {
      const code = await runCli(["pro", "browser", "login", "--minimized"], {
        cwd,
        stdout: (line) => out.push(line),
        stderr: () => {}
      });

      expect(code).toBe(0);
      expect(minimizeChatGptWindowMock).toHaveBeenCalledTimes(1);
      expect(out.join("\n")).toMatch(/minimized/i);
      const record = JSON.parse(await readFile(process.env.PRODEX_LAST_LOGIN_FILE!, "utf8")) as { minimized?: boolean };
      expect(record.minimized).toBe(true);
    } finally {
      if (priorLastLogin === undefined) delete process.env.PRODEX_LAST_LOGIN_FILE;
      else process.env.PRODEX_LAST_LOGIN_FILE = priorLastLogin;
      minimizeChatGptWindowMock.mockReset();
      getChatGptBrowserStatusMock.mockReset();
    }
  });

  it("restores the window when minimizing would hide the tab from prodex", async () => {
    // On a normal Linux desktop a minimized window reports "hidden", and a
    // hidden tab is exactly what the send path refuses. Leaving the user with
    // a minimized-but-unusable browser would be the silent-breakage pattern.
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-login-wait-"));
    const priorLastLogin = process.env.PRODEX_LAST_LOGIN_FILE;
    process.env.PRODEX_LAST_LOGIN_FILE = path.join(cwd, "last-login.json");
    openChatGptBrowserMock.mockReturnValueOnce({
      port: 9333,
      profileDir: "/tmp/fake-profile",
      waitForEarlyExit: async () => undefined
    });
    getChatGptBrowserStatusMock.mockResolvedValue(status({ reachable: true, loggedInLikely: true, hasComposer: true }));
    minimizeChatGptWindowMock.mockResolvedValue({ minimized: false, visibilityState: "hidden" });
    const out: string[] = [];

    try {
      await runCli(["pro", "browser", "login", "--minimized"], {
        cwd,
        stdout: (line) => out.push(line),
        stderr: () => {}
      });

      const text = out.join("\n");
      expect(text).toMatch(/hidden/i);
      expect(text).toMatch(/restored/i);
      const record = JSON.parse(await readFile(process.env.PRODEX_LAST_LOGIN_FILE!, "utf8")) as { minimized?: boolean };
      expect(record.minimized).not.toBe(true);
    } finally {
      if (priorLastLogin === undefined) delete process.env.PRODEX_LAST_LOGIN_FILE;
      else process.env.PRODEX_LAST_LOGIN_FILE = priorLastLogin;
      minimizeChatGptWindowMock.mockReset();
      getChatGptBrowserStatusMock.mockReset();
    }
  });

  it("refuses --headless together with --virtual-display", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-login-wait-"));
    await expect(
      runCli(["pro", "browser", "login", "--headless", "--virtual-display"], { cwd, stdout: () => {}, stderr: () => {} })
    ).rejects.toThrow(/cannot combine --headless and --virtual-display/);
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
