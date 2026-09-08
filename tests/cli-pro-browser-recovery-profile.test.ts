import { describe, expect, it, vi } from "vitest";

const findWedgedBrowserMock = vi.hoisted(() => vi.fn(() => [] as number[]));
const readLastBrowserLoginLaunchMock = vi.hoisted(() => vi.fn());
const openChatGptBrowserMock = vi.hoisted(() => vi.fn());
const getChatGptBrowserStatusMock = vi.hoisted(() => vi.fn());
const endWedgedBrowserMock = vi.hoisted(() => vi.fn(async (pids: number[]) => ({ ended: pids, failed: [] as number[] })));

vi.mock("../src/chatgpt-browser.js", async () => {
  const actual = await vi.importActual<typeof import("../src/chatgpt-browser.js")>("../src/chatgpt-browser.js");
  return {
    ...actual,
    findWedgedBrowser: findWedgedBrowserMock,
    readLastBrowserLoginLaunch: readLastBrowserLoginLaunchMock,
    openChatGptBrowser: openChatGptBrowserMock,
    getChatGptBrowserStatus: getChatGptBrowserStatusMock,
    endWedgedBrowser: endWedgedBrowserMock,
    assertBrowserLaunchStayedAlive: async () => undefined
  };
});

import { attemptBrowserAutoRecovery } from "../src/cli-pro.js";

describe("unattended browser recovery", () => {
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

  it("puts the browser it ended on the receipt, not just on stderr", async () => {
    // Ending someone's browser was narrated only as a progress line. A person
    // reading `pro latest` afterwards, or an agent reading the MCP result,
    // never learned that their browser had been killed and replaced.
    findWedgedBrowserMock.mockReturnValue([4242]);
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

    await attemptBrowserAutoRecovery(() => {}, { port: 9333, notes });

    expect(endWedgedBrowserMock).toHaveBeenCalledWith([4242]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/^browser_recovered: .*pid 4242/);
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
