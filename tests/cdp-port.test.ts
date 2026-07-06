import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_CDP_PORT, chromeCommandCandidates, resolveCdpPort } from "../src/chatgpt-browser.js";

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

  it("adds Windows-host browser paths when running under WSL", () => {
    const candidates = chromeCommandCandidates("linux", { WSL_DISTRO_NAME: "Ubuntu" });
    expect(candidates).toContain("/mnt/c/Program Files/Google/Chrome/Application/chrome.exe");
    expect(candidates).toContain("google-chrome");
  });
});
