import { describe, expect, it, vi } from "vitest";

const findWedgedBrowserMock = vi.hoisted(() => vi.fn(() => [] as number[]));
const readLastBrowserLoginLaunchMock = vi.hoisted(() => vi.fn());
const openChatGptBrowserMock = vi.hoisted(() => vi.fn());

vi.mock("../src/chatgpt-browser.js", async () => {
  const actual = await vi.importActual<typeof import("../src/chatgpt-browser.js")>("../src/chatgpt-browser.js");
  return {
    ...actual,
    findWedgedBrowser: findWedgedBrowserMock,
    readLastBrowserLoginLaunch: readLastBrowserLoginLaunchMock,
    openChatGptBrowser: openChatGptBrowserMock,
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
});
