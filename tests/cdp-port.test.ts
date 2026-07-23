import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_CDP_PORT,
  chromeCommandCandidates,
  isWindowsBrowserExecutablePath,
  resolveCdpPort
} from "../src/chatgpt-browser.js";

describe("resolveCdpPort", () => {
  afterEach(() => {
    delete process.env.PRODEX_CDP_PORT;
  });

  it("defaults to 9333", () => {
    expect(resolveCdpPort()).toBe(9333);
    expect(DEFAULT_CDP_PORT).toBe(9333);
  });

  it("prefers an explicit port over the environment", () => {
    process.env.PRODEX_CDP_PORT = "9444";
    expect(resolveCdpPort(9555)).toBe(9555);
  });

  it("reads PRODEX_CDP_PORT when no explicit port is given", () => {
    process.env.PRODEX_CDP_PORT = "9444";
    expect(resolveCdpPort()).toBe(9444);
  });

  it("rejects a malformed PRODEX_CDP_PORT instead of silently falling back", () => {
    process.env.PRODEX_CDP_PORT = "not-a-port";
    expect(() => resolveCdpPort()).toThrow(/PRODEX_CDP_PORT/);
    process.env.PRODEX_CDP_PORT = "70000";
    expect(() => resolveCdpPort()).toThrow(/PRODEX_CDP_PORT/);
  });
});

describe("browserLaunchEnv", () => {
  it("injects DISPLAY=:0 on linux when no display is set but a WSLg X socket exists", async () => {
    const { browserLaunchEnv } = await import("../src/chatgpt-browser.js");
    const env = browserLaunchEnv("linux", { PATH: "/usr/bin" }, () => true);
    expect(env.DISPLAY).toBe(":0");
    expect(env.PATH).toBe("/usr/bin");
  });

  it("leaves the environment alone when a display is already set", async () => {
    const { browserLaunchEnv } = await import("../src/chatgpt-browser.js");
    const env = browserLaunchEnv("linux", { DISPLAY: ":1" }, () => true);
    expect(env.DISPLAY).toBe(":1");
  });

  it("leaves the environment alone without an X socket or on other platforms", async () => {
    const { browserLaunchEnv } = await import("../src/chatgpt-browser.js");
    expect(browserLaunchEnv("linux", {}, () => false).DISPLAY).toBeUndefined();
    expect(browserLaunchEnv("darwin", {}, () => true).DISPLAY).toBeUndefined();
  });
});

describe("chromeCommandCandidates", () => {
  it("keeps the PATH binary names on linux", () => {
    const candidates = chromeCommandCandidates("linux", {});
    expect(candidates).toContain("google-chrome");
    expect(candidates).toContain("chromium");
    expect(candidates.every((candidate) => !candidate.includes("/Applications/"))).toBe(true);
  });

  it("adds standard application bundle paths on macOS", () => {
    const candidates = chromeCommandCandidates("darwin", {});
    expect(candidates).toContain("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    expect(candidates).toContain("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
    expect(candidates).toContain("google-chrome");
  });

  it("adds standard install paths on Windows including LOCALAPPDATA", () => {
    const candidates = chromeCommandCandidates("win32", { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" });
    expect(candidates).toContain("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
    expect(candidates).toContain("C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe");
    expect(candidates).toContain("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe");
  });

  it("classifies every Windows browser candidate as exec-unsafe (--version opens a visible window)", () => {
    // Windows chrome.exe/msedge.exe do not implement a console --version: they
    // open a blank browser window instead (measured live - this was the source
    // of the recurring transient Edge+Chrome window pairs). Every .exe
    // candidate must be validated by file existence only, never by exec.
    const win = chromeCommandCandidates("win32", { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" });
    const exeCandidates = win.filter((c) => /\.exe$/i.test(c));
    expect(exeCandidates.length).toBeGreaterThan(0);
    for (const candidate of exeCandidates) {
      expect(isWindowsBrowserExecutablePath(candidate)).toBe(true);
    }
    expect(isWindowsBrowserExecutablePath("google-chrome")).toBe(false);
    expect(isWindowsBrowserExecutablePath("/usr/bin/google-chrome")).toBe(false);
    expect(isWindowsBrowserExecutablePath("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")).toBe(false);
  });

  it("never auto-selects Windows-host browsers under WSL", () => {
    // Auto-selecting a /mnt/c chrome.exe/msedge.exe from WSL either opened a
    // blank window (the old --version probe) or launched the user's Windows
    // browser with a Linux profile path (measured live). The dedicated browser
    // under WSL is a Linux chrome; a Windows browser is opt-in via
    // PRODEX_CHROME only.
    for (const env of [{ WSL_DISTRO_NAME: "Ubuntu" }, { WSL_INTEROP: "/run/WSL/1_interop" }, {}]) {
      const candidates = chromeCommandCandidates("linux", env);
      expect(candidates.some((candidate) => /\.exe$/i.test(candidate) || candidate.startsWith("/mnt/"))).toBe(false);
      expect(candidates).toContain("google-chrome");
    }
  });

  it("does not add Windows paths on plain linux", () => {
    const candidates = chromeCommandCandidates("linux", {});
    expect(candidates.every((candidate) => !candidate.startsWith("/mnt/c/"))).toBe(true);
  });
});
