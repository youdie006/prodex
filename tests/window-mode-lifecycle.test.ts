import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ensureVirtualDisplayMock = vi.hoisted(() => vi.fn());
const findWedgedBrowserMock = vi.hoisted(() => vi.fn(() => [] as number[]));
const getChatGptBrowserStatusMock = vi.hoisted(() => vi.fn());
const minimizeChatGptWindowMock = vi.hoisted(() => vi.fn());
const openChatGptBrowserMock = vi.hoisted(() => vi.fn());
const readLastBrowserLoginLaunchMock = vi.hoisted(() => vi.fn());
const recordBrowserLoginLaunchMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../src/chatgpt-browser.js", async () => {
  const actual = await vi.importActual<typeof import("../src/chatgpt-browser.js")>("../src/chatgpt-browser.js");
  return {
    ...actual,
    ensureVirtualDisplay: ensureVirtualDisplayMock,
    findWedgedBrowser: findWedgedBrowserMock,
    getChatGptBrowserStatus: getChatGptBrowserStatusMock,
    minimizeChatGptWindow: minimizeChatGptWindowMock,
    openChatGptBrowser: openChatGptBrowserMock,
    readLastBrowserLoginLaunch: readLastBrowserLoginLaunchMock,
    recordBrowserLoginLaunch: recordBrowserLoginLaunchMock
  };
});

const { resolveBrowserWindowMode } = await import("../src/chatgpt-browser.js");
const { attemptBrowserAutoRecovery, waitForChatGptLoginReady } = await import("../src/cli-pro.js");
const { runCli } = await import("../src/cli.js");

const ready = {
  reachable: true,
  loggedInLikely: true,
  hasComposer: true,
  modelHints: [] as string[]
};
const unreachable = {
  reachable: false,
  loggedInLikely: false,
  hasComposer: false,
  modelHints: [] as string[],
  blocker: { code: "browser_unreachable", message: "connection refused", retryable: true }
};

function launch(profileDir = "/custom/profile", port = 9333) {
  return { port, profileDir, waitForEarlyExit: async () => undefined };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("PRODEX_HEADLESS", "");
  vi.stubEnv("PRODEX_VIRTUAL_DISPLAY", "");
  vi.stubEnv("PRODEX_MINIMIZE_WINDOW", "");
  readLastBrowserLoginLaunchMock.mockResolvedValue(undefined);
  ensureVirtualDisplayMock.mockResolvedValue({ displayNumber: 99, xauthority: "/tmp/Xauthority-99", startedNow: false });
  minimizeChatGptWindowMock.mockResolvedValue({ minimized: true, visibilityState: "visible" });
  openChatGptBrowserMock.mockReturnValue(launch());
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("browser window mode precedence", () => {
  it("keeps visible auth recovery temporary while the next launch remains headless", () => {
    const lastLogin = { headless: false, minimized: false, resume_headless: true };
    expect(resolveBrowserWindowMode({ lastLogin })).toEqual({ headless: false, virtualDisplay: false, minimized: false });
    expect(resolveBrowserWindowMode({ lastLogin, forRelaunch: true })).toEqual({ headless: true, virtualDisplay: false, minimized: false });
    expect(resolveBrowserWindowMode({ lastLogin, forRelaunch: true, flags: { headed: true } }).headless).toBe(false);
    expect(resolveBrowserWindowMode({ lastLogin, forRelaunch: true, env: { PRODEX_HEADLESS: "0" } }).headless).toBe(false);
  });
  it("treats a disabled environment setting as an explicit headed override", () => {
    expect(
      resolveBrowserWindowMode({
        env: { PRODEX_HEADLESS: "0" },
        lastLogin: { headless: true }
      })
    ).toEqual({ headless: false, virtualDisplay: false, minimized: false });
  });

  it("selects environment modes as a group instead of merging a saved virtual display", () => {
    const lastLogin = { headless: false, minimized: false, virtual_display: 77 };
    expect(resolveBrowserWindowMode({ env: { PRODEX_HEADLESS: "1" }, lastLogin })).toEqual({
      headless: true,
      virtualDisplay: false,
      minimized: false
    });
    expect(resolveBrowserWindowMode({ env: { PRODEX_MINIMIZE_WINDOW: "yes" }, lastLogin })).toEqual({
      headless: false,
      virtualDisplay: false,
      minimized: true
    });
    expect(
      resolveBrowserWindowMode({
        env: { PRODEX_VIRTUAL_DISPLAY: "1" },
        lastLogin: { headless: true }
      })
    ).toEqual({ headless: false, virtualDisplay: true, minimized: false });
  });

  it("lets --headed override environment and saved no-window modes", () => {
    expect(
      resolveBrowserWindowMode({
        flags: { headed: true },
        env: { PRODEX_VIRTUAL_DISPLAY: "1" },
        lastLogin: { headless: true }
      })
    ).toEqual({ headless: false, virtualDisplay: false, minimized: false });
  });

  it("rejects conflicting true modes from either flags or environment", () => {
    expect(() => resolveBrowserWindowMode({ flags: { headless: true, minimized: true } })).toThrow(/cannot combine.*--headless.*--minimized/i);
    expect(() =>
      resolveBrowserWindowMode({ env: { PRODEX_HEADLESS: "true", PRODEX_VIRTUAL_DISPLAY: "1" } })
    ).toThrow(/cannot combine.*PRODEX_HEADLESS.*PRODEX_VIRTUAL_DISPLAY/i);
  });

  it("keeps saved and ordinary default modes when neither flags nor environment select a group", () => {
    expect(resolveBrowserWindowMode({ lastLogin: { minimized: true } })).toEqual({
      headless: false,
      virtualDisplay: false,
      minimized: true
    });
    expect(resolveBrowserWindowMode({})).toEqual({ headless: false, virtualDisplay: false, minimized: false });
  });
});

describe("pro browser login window lifecycle", () => {
  it("reopens headless after the temporary visible auth browser has closed", async () => {
    readLastBrowserLoginLaunchMock.mockResolvedValue({ profile_dir: "/custom/profile", port: 9333, headless: false, resume_headless: true });
    getChatGptBrowserStatusMock.mockResolvedValueOnce(unreachable).mockResolvedValue(ready);
    await runCli(["pro", "browser", "login", "--port", "9333", "--no-wait"], { cwd: "/tmp/project", stdout: () => {}, stderr: () => {} });
    expect(openChatGptBrowserMock).toHaveBeenCalledWith(expect.objectContaining({ headless: true, profileDir: "/custom/profile" }));
  });

  it("reuses an open auth window without losing its headless relaunch preference", async () => {
    const saved = { profile_dir: "/custom/profile", port: 9333, headless: false, minimized: false, resume_headless: true };
    readLastBrowserLoginLaunchMock.mockResolvedValue(saved);
    getChatGptBrowserStatusMock.mockResolvedValue(ready);
    await runCli(["pro", "browser", "login", "--port", "9333", "--no-wait"], { cwd: "/tmp/project", stdout: () => {}, stderr: () => {} });
    expect(openChatGptBrowserMock).not.toHaveBeenCalled();
    expect(recordBrowserLoginLaunchMock).toHaveBeenCalledWith(saved);
  });

  it("clears the temporary headless preference when headed mode is explicitly selected", async () => {
    readLastBrowserLoginLaunchMock.mockResolvedValue({ profile_dir: "/custom/profile", port: 9333, headless: false, resume_headless: true });
    getChatGptBrowserStatusMock.mockResolvedValue(ready);
    await runCli(["pro", "browser", "login", "--port", "9333", "--headed", "--no-wait"], { cwd: "/tmp/project", stdout: () => {}, stderr: () => {} });
    expect(recordBrowserLoginLaunchMock).toHaveBeenCalledWith({ profile_dir: "/custom/profile", port: 9333, headless: false, minimized: false });
  });

  it("reuses the saved profile on the same port and forwards resolved headed false explicitly", async () => {
    readLastBrowserLoginLaunchMock.mockResolvedValue({ profile_dir: "/custom/profile", port: 9333, headless: true });
    vi.stubEnv("PRODEX_HEADLESS", "0");
    getChatGptBrowserStatusMock.mockResolvedValueOnce(unreachable).mockResolvedValue(ready);

    await runCli(["pro", "browser", "login", "--port", "9333", "--no-wait"], {
      cwd: "/tmp/project",
      stdout: () => {},
      stderr: () => {}
    });

    expect(openChatGptBrowserMock).toHaveBeenCalledWith(
      expect.objectContaining({ port: 9333, profileDir: "/custom/profile", headless: false })
    );
    expect(recordBrowserLoginLaunchMock).toHaveBeenCalledWith(
      expect.objectContaining({ port: 9333, profile_dir: "/custom/profile", headless: false })
    );
  });

  it("does not import a saved custom profile from a different port", async () => {
    readLastBrowserLoginLaunchMock.mockResolvedValue({ profile_dir: "/custom/profile", port: 9444 });
    openChatGptBrowserMock.mockReturnValue(launch("/default/profile", 9333));
    getChatGptBrowserStatusMock.mockResolvedValueOnce(unreachable).mockResolvedValue(ready);

    await runCli(["pro", "browser", "login", "--port", "9333", "--no-wait"], {
      cwd: "/tmp/project",
      stdout: () => {},
      stderr: () => {}
    });

    expect(openChatGptBrowserMock).toHaveBeenCalledWith(expect.objectContaining({ port: 9333, profileDir: undefined }));
    expect(recordBrowserLoginLaunchMock).toHaveBeenCalledWith(expect.objectContaining({
      port: 9333,
      profile_dir: "/default/profile"
    }));
  });

  it("reuses a running browser without inventing a profile or allocating another virtual display", async () => {
    readLastBrowserLoginLaunchMock.mockResolvedValue({
      profile_dir: "/custom/profile",
      port: 9333,
      headless: false,
      minimized: false,
      virtual_display: 77
    });
    getChatGptBrowserStatusMock.mockResolvedValue(ready);

    await runCli(["pro", "browser", "login", "--port", "9333", "--no-wait"], {
      cwd: "/tmp/project",
      stdout: () => {},
      stderr: () => {}
    });

    expect(openChatGptBrowserMock).not.toHaveBeenCalled();
    expect(ensureVirtualDisplayMock).not.toHaveBeenCalled();
    expect(recordBrowserLoginLaunchMock).toHaveBeenCalledWith({
      profile_dir: "/custom/profile",
      port: 9333,
      headless: false,
      minimized: false,
      virtual_display: 77
    });
  });

  it("refuses a different explicit profile for a known running browser", async () => {
    readLastBrowserLoginLaunchMock.mockResolvedValue({ profile_dir: "/custom/profile", port: 9333 });
    getChatGptBrowserStatusMock.mockResolvedValue(ready);

    await expect(
      runCli(
        ["pro", "browser", "login", "--port", "9333", "--profile-dir", "/different/profile", "--no-wait"],
        { cwd: "/tmp/project", stdout: () => {}, stderr: () => {} }
      )
    ).rejects.toThrow(/already running.*\/custom\/profile.*different profile/i);

    expect(openChatGptBrowserMock).not.toHaveBeenCalled();
    expect(recordBrowserLoginLaunchMock).not.toHaveBeenCalled();
  });

  it("records the actual new display when the saved display cannot be reused", async () => {
    readLastBrowserLoginLaunchMock.mockResolvedValue({ profile_dir: "/custom/profile", port: 9333, virtual_display: 77 });
    ensureVirtualDisplayMock.mockResolvedValue({ displayNumber: 78, xauthority: "/tmp/Xauthority-78", startedNow: true });
    getChatGptBrowserStatusMock.mockResolvedValueOnce(unreachable).mockResolvedValue(ready);

    await runCli(["pro", "browser", "login", "--port", "9333", "--no-wait"], {
      cwd: "/tmp/project", stdout: () => {}, stderr: () => {}
    });

    expect(recordBrowserLoginLaunchMock).toHaveBeenCalledWith(expect.objectContaining({ virtual_display: 78 }));
  });

  it("does not overwrite a running browser launch record with an invented default profile", async () => {
    getChatGptBrowserStatusMock.mockResolvedValue(ready);

    await runCli(["pro", "browser", "login", "--port", "9333", "--no-wait"], {
      cwd: "/tmp/project",
      stdout: () => {},
      stderr: () => {}
    });

    expect(openChatGptBrowserMock).not.toHaveBeenCalled();
    expect(recordBrowserLoginLaunchMock).not.toHaveBeenCalled();
  });

  it("does not claim --headed restored an already-running minimized window", async () => {
    readLastBrowserLoginLaunchMock.mockResolvedValue({
      profile_dir: "/custom/profile",
      port: 9333,
      minimized: true
    });
    getChatGptBrowserStatusMock.mockResolvedValue(ready);

    await expect(
      runCli(["pro", "browser", "login", "--port", "9333", "--headed", "--no-wait"], {
        cwd: "/tmp/project",
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow(/minimized.*visible headed.*close.*--headed/i);

    expect(openChatGptBrowserMock).not.toHaveBeenCalled();
    expect(recordBrowserLoginLaunchMock).not.toHaveBeenCalled();
  });

  it("restores a saved minimized preference through the shared mode resolver", async () => {
    readLastBrowserLoginLaunchMock.mockResolvedValue({ profile_dir: "/custom/profile", port: 9333, minimized: true });
    getChatGptBrowserStatusMock.mockResolvedValueOnce(unreachable).mockResolvedValue(ready);

    await runCli(["pro", "browser", "login", "--port", "9333", "--no-wait"], {
      cwd: "/tmp/project",
      stdout: () => {},
      stderr: () => {}
    });

    expect(minimizeChatGptWindowMock).toHaveBeenCalledWith({ port: 9333 });
  });

  it("accepts --headed as the explicit visible reauthentication mode", async () => {
    readLastBrowserLoginLaunchMock.mockResolvedValue({ profile_dir: "/custom/profile", port: 9333, virtual_display: 77 });
    vi.stubEnv("PRODEX_HEADLESS", "1");
    getChatGptBrowserStatusMock.mockResolvedValueOnce(unreachable).mockResolvedValue(ready);

    await runCli(["pro", "browser", "login", "--port", "9333", "--headed", "--no-wait"], {
      cwd: "/tmp/project",
      stdout: () => {},
      stderr: () => {}
    });

    expect(openChatGptBrowserMock).toHaveBeenCalledWith(expect.objectContaining({ headless: false }));
    expect(openChatGptBrowserMock.mock.calls[0]?.[0]).not.toHaveProperty("virtualDisplay");
  });
});

describe("unattended recovery window lifecycle", () => {
  it("gives a headed login instruction when captcha appears with no interactive window", async () => {
    const lines: string[] = [];
    const captcha = {
      ...ready,
      hasComposer: false,
      blocker: {
        code: "cloudflare_check",
        message: "ChatGPT is waiting for human verification.",
        retryable: true
      }
    };
    let probe = 0;

    const recovered = await waitForChatGptLoginReady(
      (line) => lines.push(line),
      {
        port: 9333,
        timeoutMs: 1_000,
        pollMs: 1,
        windowMode: { headless: false, virtualDisplay: true, minimized: false },
        headedLoginCommand: "prodex pro browser login --headed"
      },
      {
        statusFn: async () => (probe++ === 0 ? captcha : ready),
        sleepFn: async () => {}
      }
    );

    expect(recovered).toBe(false);
    expect(probe).toBe(1);
    expect(lines.join("\n")).toContain("prodex pro browser login --headed");
    expect(lines.join("\n")).toMatch(/cloudflare_check requires visible manual handling/i);
  });

  it("uses the same environment-selected mode for CLI login and MCP auto-recovery", async () => {
    readLastBrowserLoginLaunchMock.mockResolvedValue({
      profile_dir: "/custom/profile",
      port: 9333,
      headless: false,
      virtual_display: 77
    });
    vi.stubEnv("PRODEX_HEADLESS", "1");
    getChatGptBrowserStatusMock.mockResolvedValueOnce(unreachable).mockResolvedValue(ready);

    await runCli(["pro", "browser", "login", "--port", "9333", "--no-wait"], {
      cwd: "/tmp/project",
      stdout: () => {},
      stderr: () => {}
    });
    const loginOptions = openChatGptBrowserMock.mock.calls[0]?.[0];
    openChatGptBrowserMock.mockClear();
    getChatGptBrowserStatusMock.mockReset().mockResolvedValueOnce(unreachable).mockResolvedValue(ready);

    const recovered = await attemptBrowserAutoRecovery(() => {}, { port: 9333 });
    const recoveryOptions = openChatGptBrowserMock.mock.calls[0]?.[0];

    expect(recovered).toBe(true);
    expect(loginOptions).toEqual(expect.objectContaining({ profileDir: "/custom/profile", headless: true }));
    expect(recoveryOptions).toEqual(expect.objectContaining({ profileDir: "/custom/profile", headless: true }));
    expect(loginOptions).not.toHaveProperty("virtualDisplay");
    expect(recoveryOptions).not.toHaveProperty("virtualDisplay");
    expect(ensureVirtualDisplayMock).not.toHaveBeenCalled();
  });

  it("reports a virtual-display setup failure and never falls back to a desktop browser", async () => {
    getChatGptBrowserStatusMock.mockReset().mockResolvedValueOnce(unreachable).mockResolvedValue(ready);
    readLastBrowserLoginLaunchMock.mockResolvedValue({ profile_dir: "/custom/profile", port: 9333, virtual_display: 77 });
    ensureVirtualDisplayMock.mockRejectedValue(new Error("xauth setup failed"));
    const errors: string[] = [];

    const recovered = await attemptBrowserAutoRecovery((line) => errors.push(line), { port: 9333 });

    expect(recovered).toBe(false);
    expect(errors.join("\n")).toContain("xauth setup failed");
    expect(openChatGptBrowserMock).not.toHaveBeenCalled();
  });

  it("honors a false headless environment override during recovery", async () => {
    readLastBrowserLoginLaunchMock.mockResolvedValue({ profile_dir: "/custom/profile", port: 9333, headless: true });
    vi.stubEnv("PRODEX_HEADLESS", "false");
    getChatGptBrowserStatusMock.mockReset().mockResolvedValueOnce(unreachable).mockResolvedValue(ready);

    const recovered = await attemptBrowserAutoRecovery(() => {}, { port: 9333 });

    expect(recovered).toBe(true);
    expect(openChatGptBrowserMock).toHaveBeenCalledWith(
      expect.objectContaining({ profileDir: "/custom/profile", headless: false })
    );
  });

  it("restores the minimized mode selected by environment without reviving a saved virtual mode", async () => {
    readLastBrowserLoginLaunchMock.mockResolvedValue({ profile_dir: "/custom/profile", port: 9333, virtual_display: 77 });
    vi.stubEnv("PRODEX_MINIMIZE_WINDOW", "1");
    getChatGptBrowserStatusMock.mockReset().mockResolvedValueOnce(unreachable).mockResolvedValue(ready);

    const recovered = await attemptBrowserAutoRecovery(() => {}, { port: 9333 });

    expect(recovered).toBe(true);
    expect(ensureVirtualDisplayMock).not.toHaveBeenCalled();
    expect(openChatGptBrowserMock).toHaveBeenCalledWith(expect.objectContaining({ headless: false }));
    expect(openChatGptBrowserMock.mock.calls[0]?.[0]).not.toHaveProperty("virtualDisplay");
    expect(minimizeChatGptWindowMock).toHaveBeenCalledWith({ port: 9333 });
  });

  it("positively recovers with a saved virtual display and custom profile", async () => {
    readLastBrowserLoginLaunchMock.mockResolvedValue({ profile_dir: "/custom/profile", port: 9333, virtual_display: 77 });
    ensureVirtualDisplayMock.mockResolvedValue({ displayNumber: 77, xauthority: "/tmp/Xauthority-77", startedNow: false });
    getChatGptBrowserStatusMock.mockReset().mockResolvedValueOnce(unreachable).mockResolvedValue(ready);

    const recovered = await attemptBrowserAutoRecovery(() => {}, { port: 9333 });

    expect(recovered).toBe(true);
    expect(ensureVirtualDisplayMock).toHaveBeenCalledWith({ displayNumber: 77 });
    expect(openChatGptBrowserMock).toHaveBeenCalledWith({
      port: 9333,
      profileDir: "/custom/profile",
      headless: false,
      virtualDisplay: { displayNumber: 77, xauthority: "/tmp/Xauthority-77" }
    });
  });

  it("records the actual mode and new display after recovery", async () => {
    readLastBrowserLoginLaunchMock.mockResolvedValue({ profile_dir: "/custom/profile", port: 9333, virtual_display: 77 });
    ensureVirtualDisplayMock.mockResolvedValue({ displayNumber: 78, xauthority: "/tmp/Xauthority-78", startedNow: true });
    getChatGptBrowserStatusMock.mockReset().mockResolvedValueOnce(unreachable).mockResolvedValue(ready);

    expect(await attemptBrowserAutoRecovery(() => {}, { port: 9333 })).toBe(true);
    expect(recordBrowserLoginLaunchMock).toHaveBeenCalledWith({
      profile_dir: "/custom/profile", port: 9333, headless: false, minimized: false, virtual_display: 78
    });
  });
});
