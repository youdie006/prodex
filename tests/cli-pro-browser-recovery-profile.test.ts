import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findWedgedBrowserMock = vi.hoisted(() => vi.fn(() => [] as number[]));
const readLastBrowserLoginLaunchMock = vi.hoisted(() => vi.fn());
const openChatGptBrowserMock = vi.hoisted(() => vi.fn());
const getChatGptBrowserStatusMock = vi.hoisted(() => vi.fn());
const endWedgedBrowserMock = vi.hoisted(() => vi.fn(async (pids: number[]) => ({ ended: pids, failed: [] as number[] })));
const ensureVirtualDisplayMock = vi.hoisted(() => vi.fn());
const minimizeChatGptWindowMock = vi.hoisted(() => vi.fn());
const recordBrowserLoginLaunchMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../src/chatgpt-browser.js", async () => {
  const actual = await vi.importActual<typeof import("../src/chatgpt-browser.js")>("../src/chatgpt-browser.js");
  return {
    ...actual,
    findWedgedBrowser: findWedgedBrowserMock,
    readLastBrowserLoginLaunch: readLastBrowserLoginLaunchMock,
    openChatGptBrowser: openChatGptBrowserMock,
    getChatGptBrowserStatus: getChatGptBrowserStatusMock,
    endWedgedBrowser: endWedgedBrowserMock,
    ensureVirtualDisplay: ensureVirtualDisplayMock,
    minimizeChatGptWindow: minimizeChatGptWindowMock,
    recordBrowserLoginLaunch: recordBrowserLoginLaunchMock,
    assertBrowserLaunchStayedAlive: async () => undefined
  };
});

import { attemptBrowserAutoRecovery } from "../src/cli-pro.js";

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
  blocker: { code: "browser_unreachable", message: "gone", retryable: true }
};

beforeEach(() => {
  vi.stubEnv("PRODEX_NO_AUTO_CLEAR", "");
  vi.stubEnv("PRODEX_HEADLESS", "");
  vi.stubEnv("PRODEX_VIRTUAL_DISPLAY", "");
  vi.stubEnv("PRODEX_MINIMIZE_WINDOW", "");
  findWedgedBrowserMock.mockReset().mockReturnValue([]);
  readLastBrowserLoginLaunchMock.mockReset().mockResolvedValue(undefined);
  openChatGptBrowserMock.mockReset().mockReturnValue({
    port: 9333,
    profileDir: "/default/profile",
    waitForEarlyExit: async () => undefined
  });
  getChatGptBrowserStatusMock.mockReset().mockResolvedValue(ready);
  endWedgedBrowserMock.mockReset().mockImplementation(async (pids: number[]) => ({ ended: pids, failed: [] }));
  ensureVirtualDisplayMock.mockReset().mockResolvedValue({
    displayNumber: 77,
    xauthority: "/tmp/Xauthority-77",
    startedNow: false
  });
  minimizeChatGptWindowMock.mockReset().mockResolvedValue({ minimized: true, visibilityState: "visible" });
  recordBrowserLoginLaunchMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("unattended browser recovery", () => {
  it("refuses a saved browser identity from another control port", async () => {
    readLastBrowserLoginLaunchMock.mockResolvedValue({
      profile_dir: "/profiles/profile-B",
      port: 9444,
      virtual_display: 77
    });
    openChatGptBrowserMock.mockReturnValue({
      port: 9333,
      profileDir: "/profiles/profile-B",
      waitForEarlyExit: async () => undefined
    });
    const lines: string[] = [];

    const recovered = await attemptBrowserAutoRecovery((line) => lines.push(line), { port: 9333 });

    expect(recovered).toBe(false);
    expect(lines.join("\n")).toMatch(/saved browser identity.*9444.*9333/i);
    expect(findWedgedBrowserMock).not.toHaveBeenCalled();
    expect(ensureVirtualDisplayMock).not.toHaveBeenCalled();
    expect(endWedgedBrowserMock).not.toHaveBeenCalled();
    expect(openChatGptBrowserMock).not.toHaveBeenCalled();
  });

  it("looks for the wedged browser under the profile the user actually logged in with", async () => {
    // The relaunch already reads this record, because launching the default
    // profile for a custom-profile user sends to the wrong account. The scan
    // that decides what to KILL was never told: it matched the main process by
    // port but every helper by the DEFAULT profile, so a second browser on that
    // profile - healthy, someone else's tabs - joined the SIGKILL list.
    readLastBrowserLoginLaunchMock.mockResolvedValue({ profile_dir: "/custom/profile" });
    openChatGptBrowserMock.mockImplementation(() => {
      throw new Error("stop before launching");
    });

    await attemptBrowserAutoRecovery(() => {}, { port: 9333 });

    expect(findWedgedBrowserMock).toHaveBeenCalledWith({ port: 9333, profileDir: "/custom/profile" });
  });

  it("does not relaunch when browser termination reports a residual pid", async () => {
    vi.useFakeTimers();
    findWedgedBrowserMock.mockReturnValueOnce([4242]).mockReturnValue([]);
    readLastBrowserLoginLaunchMock.mockResolvedValue({ profile_dir: "/custom/profile", port: 9333 });
    endWedgedBrowserMock.mockResolvedValue({ ended: [], failed: [4242] });
    getChatGptBrowserStatusMock
      .mockResolvedValueOnce(unreachable)
      .mockResolvedValueOnce(unreachable)
      .mockResolvedValueOnce(unreachable)
      .mockResolvedValue(ready);
    const lines: string[] = [];

    const recovery = attemptBrowserAutoRecovery((line) => lines.push(line), { port: 9333 });
    await vi.runAllTimersAsync();
    const recovered = await recovery;

    expect(recovered).toBe(false);
    expect(lines.join("\n")).toMatch(/still running.*pid 4242/i);
    expect(openChatGptBrowserMock).not.toHaveBeenCalled();
  });

  it("does not relaunch while the old browser remains after every ownership scan", async () => {
    vi.useFakeTimers();
    findWedgedBrowserMock.mockReturnValue([4242]);
    readLastBrowserLoginLaunchMock.mockResolvedValue({ profile_dir: "/custom/profile", port: 9333 });
    getChatGptBrowserStatusMock
      .mockResolvedValueOnce(unreachable)
      .mockResolvedValueOnce(unreachable)
      .mockResolvedValueOnce(unreachable)
      .mockResolvedValue(ready);
    const lines: string[] = [];

    const recovery = attemptBrowserAutoRecovery((line) => lines.push(line), { port: 9333 });
    await vi.runAllTimersAsync();
    const recovered = await recovery;

    expect(recovered).toBe(false);
    expect(findWedgedBrowserMock).toHaveBeenCalledTimes(11);
    expect(lines.join("\n")).toMatch(/still running.*pid 4242/i);
    expect(openChatGptBrowserMock).not.toHaveBeenCalled();
  });

  it("puts the browser it ended on the receipt, not just on stderr", async () => {
    // Ending someone's browser was narrated only as a progress line. A person
    // reading `pro latest` afterwards, or an agent reading the MCP result,
    // never learned that their browser had been killed and replaced.
    findWedgedBrowserMock.mockReturnValueOnce([4242]).mockReturnValue([]);
    readLastBrowserLoginLaunchMock.mockResolvedValue({ profile_dir: "/custom/profile" });
    getChatGptBrowserStatusMock.mockResolvedValue({
      reachable: false,
      loggedInLikely: false,
      hasComposer: false,
      modelHints: [],
      blocker: { code: "browser_unreachable", message: "gone", retryable: true }
    });
    openChatGptBrowserMock.mockImplementation(() => {
      throw new Error("stop before launching");
    });
    const notes: string[] = [];

    const recovered = await attemptBrowserAutoRecovery(() => {}, { port: 9333, notes });

    expect(recovered).toBe(false);
    expect(endWedgedBrowserMock).toHaveBeenCalledWith([4242]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/^browser_recovery_started: .*pid 4242/);
    expect(notes.some((note) => note.startsWith("browser_recovered:"))).toBe(false);
  });

  it("records recovery as complete only after the restarted browser is ready", async () => {
    findWedgedBrowserMock.mockReturnValueOnce([4242]).mockReturnValue([]);
    getChatGptBrowserStatusMock.mockReset();
    getChatGptBrowserStatusMock
      .mockResolvedValueOnce(unreachable).mockResolvedValueOnce(unreachable).mockResolvedValueOnce(unreachable)
      .mockResolvedValue({ reachable: true, loggedInLikely: true, hasComposer: true, modelHints: [] });
    openChatGptBrowserMock.mockReturnValue({ port: 9333, profileDir: "/custom/profile", waitForEarlyExit: async () => undefined });
    const notes: string[] = [];
    const recovered = await attemptBrowserAutoRecovery(() => {}, { port: 9333, notes });
    expect(recovered).toBe(true);
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatch(/^browser_recovery_started:/);
    expect(notes[1]).toMatch(/^browser_recovered: .*pid 4242/);
  });

  it("does not end a browser that is merely slow to answer", async () => {
    // Three 2s timeouts on a loaded machine are not three signs of death.
    findWedgedBrowserMock.mockReturnValue([4242]);
    endWedgedBrowserMock.mockClear();
    getChatGptBrowserStatusMock.mockResolvedValue({
      reachable: false,
      loggedInLikely: false,
      hasComposer: false,
      modelHints: [],
      blocker: { code: "browser_slow", message: "busy", retryable: true }
    });
    const notes: string[] = [];

    await attemptBrowserAutoRecovery(() => {}, { port: 9333, notes });

    expect(endWedgedBrowserMock).not.toHaveBeenCalled();
    expect(notes).toEqual([]);
  });
});
