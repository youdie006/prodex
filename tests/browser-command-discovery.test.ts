import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const processMocks = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
const fileMocks = vi.hoisted(() => ({ statSync: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  ...processMocks
}));
vi.mock("node:fs", async (original) => ({
  ...await original<typeof import("node:fs")>(),
  ...fileMocks
}));

import { chromeCommandCandidates, openChatGptBrowser } from "../src/chatgpt-browser.js";

const originalPlatform = process.platform;
const originalChrome = process.env.PRODEX_CHROME;
const names = ["google-chrome", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"];
const options = { port: 59334, profileDir: "/synthetic-browser-profile", headless: true, url: "about:blank" };

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PRODEX_CHROME;
  fileMocks.statSync.mockImplementation(() => { throw Object.assign(new Error("not installed"), { code: "ENOENT" }); });
  processMocks.spawnSync.mockImplementation(() => ({ status: 0, stdout: "", stderr: "" }));
  processMocks.spawn.mockImplementation(() => Object.assign(new EventEmitter(), { pid: 424242, unref: vi.fn() }));
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform });
  if (originalChrome === undefined) delete process.env.PRODEX_CHROME;
  else process.env.PRODEX_CHROME = originalChrome;
});

it.each(["linux", "darwin", "win32"] as const)("rejects fake PATH browsers with no installed fallback on %s without launching", (platform) => {
  Object.defineProperty(process, "platform", { value: platform });
  expect(() => openChatGptBrowser(options)).toThrow("Could not find Chrome/Chromium");
  expect(processMocks.spawn).not.toHaveBeenCalled();
  expect(processMocks.spawnSync.mock.calls.filter(([, args]) => args[0] === "--version").map(([command]) => command)).toEqual(names);
  expect(fileMocks.statSync.mock.calls.map(([command]) => command)).toEqual(chromeCommandCandidates(platform).slice(names.length));
});

it.each(["linux", "darwin", "win32"] as const)("launches only the stubbed compatible PATH candidate on %s", (platform) => {
  Object.defineProperty(process, "platform", { value: platform });
  processMocks.spawnSync.mockImplementation((command, args) => ({
    status: 0, stdout: command === "chromium" && args[0] === "--version" ? "Chromium 152.0.0.0" : "", stderr: ""
  }));
  const result = openChatGptBrowser(options);
  expect(result.command).toBe("chromium");
  expect(result.processId).toBe(424242);
  expect(processMocks.spawn).toHaveBeenCalledOnce();
  expect(processMocks.spawn.mock.calls[0][1]).toContain("about:blank");
  expect(processMocks.spawn.mock.calls[0][1]).toContain("--headless=new");
  expect(fileMocks.statSync.mock.calls.every(([command]) => platform === "linux" && command === "/tmp/.X11-unix/X0")).toBe(true);
});

it.each(["darwin", "win32"] as const)("can fall through fake PATH browsers to an installed %s browser without a real process", (platform) => {
  Object.defineProperty(process, "platform", { value: platform });
  const installed = chromeCommandCandidates(platform)[names.length];
  fileMocks.statSync.mockImplementation((command) => ({ isFile: () => command === installed }));
  processMocks.spawnSync.mockImplementation((command, args) => ({
    status: 0, stdout: command === installed && args[0] === "--version" ? "Google Chrome 152.0.0.0" : "", stderr: ""
  }));
  const result = openChatGptBrowser(options);
  expect(result.command).toBe(installed);
  expect(processMocks.spawn).toHaveBeenCalledOnce();
  expect(processMocks.spawn.mock.calls[0][0]).toBe(installed);
  if (platform === "win32") {
    expect(processMocks.spawnSync.mock.calls.some(([command]) => command === installed)).toBe(false);
  }
});
