import { beforeEach, describe, expect, it, vi } from "vitest";

const withBrowserSendLockMock = vi.hoisted(() => vi.fn());
const findWedgedBrowserMock = vi.hoisted(() => vi.fn(() => [] as number[]));
const readLastBrowserLoginLaunchMock = vi.hoisted(() => vi.fn());
const getChatGptBrowserStatusMock = vi.hoisted(() => vi.fn());
const endWedgedBrowserMock = vi.hoisted(() => vi.fn());
const openChatGptBrowserMock = vi.hoisted(() => vi.fn());
const openChatGptTabMock = vi.hoisted(() => vi.fn());
const getDedicatedBrowserHeadlessModeMock = vi.hoisted(() => vi.fn());

vi.mock("../src/browser-handoff.js", () => ({
  getDedicatedBrowserHeadlessMode: getDedicatedBrowserHeadlessModeMock
}));

vi.mock("../src/browser-send-lock.js", () => ({
  withBrowserSendLock: withBrowserSendLockMock
}));

vi.mock("../src/chatgpt-browser.js", async () => {
  const actual = await vi.importActual<typeof import("../src/chatgpt-browser.js")>("../src/chatgpt-browser.js");
  return {
    ...actual,
    findWedgedBrowser: findWedgedBrowserMock,
    readLastBrowserLoginLaunch: readLastBrowserLoginLaunchMock,
    getChatGptBrowserStatus: getChatGptBrowserStatusMock,
    endWedgedBrowser: endWedgedBrowserMock,
    openChatGptBrowser: openChatGptBrowserMock,
    openChatGptTab: openChatGptTabMock
  };
});

import { attemptBrowserAutoRecovery } from "../src/cli-pro.js";

const ready = {
  reachable: true,
  loggedInLikely: true,
  hasComposer: true,
  modelHints: [] as string[]
};

beforeEach(() => {
  vi.clearAllMocks();
  readLastBrowserLoginLaunchMock.mockResolvedValue({ port: 9333, profile_dir: "/saved/profile", headless: true });
  getDedicatedBrowserHeadlessModeMock.mockReset().mockReturnValue(true);
  getChatGptBrowserStatusMock.mockResolvedValue(ready);
  openChatGptBrowserMock.mockImplementation(() => {
    throw new Error("recovery must not launch");
  });
});

describe("browser auto-recovery send lock", () => {
  it("waits for the shared lock, then reuses a browser that became ready while queued", async () => {
    let enterLock!: () => void;
    let releaseLock!: () => void;
    const lockEntered = new Promise<void>((resolve) => {
      enterLock = resolve;
    });
    const lockHeld = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    withBrowserSendLockMock.mockImplementation(async (_waitMs, _onWait, fn) => {
      enterLock();
      await lockHeld;
      return fn();
    });

    const recovery = attemptBrowserAutoRecovery(() => {}, { port: 9333 });
    await Promise.resolve();

    expect(withBrowserSendLockMock).toHaveBeenCalledOnce();
    await lockEntered;
    expect(getChatGptBrowserStatusMock).not.toHaveBeenCalled();
    expect(readLastBrowserLoginLaunchMock).not.toHaveBeenCalled();
    expect(findWedgedBrowserMock).not.toHaveBeenCalled();
    expect(endWedgedBrowserMock).not.toHaveBeenCalled();
    expect(openChatGptBrowserMock).not.toHaveBeenCalled();

    releaseLock();

    await expect(recovery).resolves.toBe(true);
    expect(getChatGptBrowserStatusMock).toHaveBeenCalledOnce();
    expect(readLastBrowserLoginLaunchMock).toHaveBeenCalledOnce();
    expect(getDedicatedBrowserHeadlessModeMock).toHaveBeenCalledWith({ port: 9333, profileDir: "/saved/profile" });
    expect(findWedgedBrowserMock).not.toHaveBeenCalled();
    expect(endWedgedBrowserMock).not.toHaveBeenCalled();
    expect(openChatGptBrowserMock).not.toHaveBeenCalled();
    expect(openChatGptTabMock).not.toHaveBeenCalled();
  });

  it("refuses a READY browser when the saved profile does not own its process", async () => {
    withBrowserSendLockMock.mockImplementation(async (_waitMs, _onWait, fn) => fn());
    getDedicatedBrowserHeadlessModeMock.mockImplementation(() => { throw new Error("profile differs"); });
    await expect(attemptBrowserAutoRecovery(() => {}, { port: 9333 })).resolves.toBe(false);
    expect(openChatGptBrowserMock).not.toHaveBeenCalled();
    expect(endWedgedBrowserMock).not.toHaveBeenCalled();
  });

  it.each([undefined, { port: 9333 }, { port: 9444 }])("refuses READY reuse without a matching saved profile: %j", async (record) => {
    withBrowserSendLockMock.mockImplementation(async (_waitMs, _onWait, fn) => fn());
    readLastBrowserLoginLaunchMock.mockResolvedValue(record);
    await expect(attemptBrowserAutoRecovery(() => {}, { port: 9333 })).resolves.toBe(false);
    if (record?.port === 9444) expect(getChatGptBrowserStatusMock).not.toHaveBeenCalled();
    expect(openChatGptBrowserMock).not.toHaveBeenCalled();
    expect(endWedgedBrowserMock).not.toHaveBeenCalled();
  });

  it.each(["login_required", "cloudflare_check", "chatgpt_page_missing"])(
    "stops without changing a reachable browser blocked by %s",
    async (code) => {
      withBrowserSendLockMock.mockImplementation(async (_waitMs, _onWait, fn) => fn());
      getChatGptBrowserStatusMock.mockResolvedValue({
        ...ready,
        hasComposer: false,
        blocker: { code, message: `blocked by ${code}`, retryable: true }
      });
      const lines: string[] = [];

      await expect(attemptBrowserAutoRecovery((line) => lines.push(line), { port: 9333 })).resolves.toBe(false);

      expect(lines.join("\n")).toMatch(new RegExp(`stopped.*${code}`, "i"));
      expect(readLastBrowserLoginLaunchMock).toHaveBeenCalledOnce();
      expect(findWedgedBrowserMock).not.toHaveBeenCalled();
      expect(endWedgedBrowserMock).not.toHaveBeenCalled();
      expect(openChatGptBrowserMock).not.toHaveBeenCalled();
      expect(openChatGptTabMock).not.toHaveBeenCalled();
    }
  );
});
