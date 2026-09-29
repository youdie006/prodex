import { afterEach, describe, expect, it, vi } from "vitest";

const processFixture = vi.hoisted(() => vi.fn());
vi.mock("../src/browser-process.js", async (original) => ({
  ...await original<typeof import("../src/browser-process.js")>(),
  inspectBrowserProcesses: processFixture
}));

import { getBrowserRuntimeInfo } from "../src/browser-runtime.js";

const port = 19333;
const profile = process.platform === "win32" ? "C:\\prodex-test" : "/tmp/prodex-test";
const main = {
  executablePath: process.platform === "win32" ? "C:\\Chrome\\chrome.exe" : "/usr/bin/google-chrome",
  processId: 100,
  commandLine: `chrome --remote-debugging-port=${port} --user-data-dir=${profile} --headless=new`
};

function fixture(metadata: unknown = { Browser: "HeadlessChrome/152.0.7977.84", "Protocol-Version": "1.3" }) {
  processFixture.mockReturnValue([main]);
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(metadata)));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("read-only browser runtime evidence", () => {
  it("records CDP metadata and actual headless identity without exposing profile, socket or user agent", async () => {
    const fetchMock = fixture({ Browser: "HeadlessChrome/152.0.7977.84", "Protocol-Version": "1.3", "User-Agent": "private", webSocketDebuggerUrl: "ws://secret" });
    const result = await getBrowserRuntimeInfo({ port, savedLaunch: { port, profile_dir: profile, headless: true } });
    expect(result).toMatchObject({ browser_product: "HeadlessChrome/152.0.7977.84", protocol_version: "1.3", actual_mode: "headless", saved_mode: "headless", mode_matches_saved: true, metadata: "available", process_identity: "verified" });
    expect(JSON.stringify(result)).not.toMatch(/private|secret|prodex-test/);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`http://127.0.0.1:${port}/json/version`, expect.objectContaining({ redirect: "error" }));
  });

  it("does not infer headless mode from a HeadlessChrome product string", async () => {
    fixture();
    processFixture.mockReturnValue([{ ...main, commandLine: main.commandLine.replace(" --headless=new", "") }]);
    expect(await getBrowserRuntimeInfo({ port, savedLaunch: { port, profile_dir: profile, headless: true } }))
      .toMatchObject({ actual_mode: "headed", saved_mode: "headless", mode_matches_saved: false });
  });

  it("reports virtual display only as a saved preference, not a proved process mode", async () => {
    fixture();
    processFixture.mockReturnValue([{ ...main, commandLine: main.commandLine.replace(" --headless=new", "") }]);
    expect(await getBrowserRuntimeInfo({ port, savedLaunch: { port, profile_dir: profile, virtual_display: 91 } }))
      .toMatchObject({ actual_mode: "headed", saved_mode: "virtual-display", mode_matches_saved: null });
  });

  it("does not substitute a future headless resume preference for the last launch mode", async () => {
    fixture();
    processFixture.mockReturnValue([{ ...main, commandLine: main.commandLine.replace(" --headless=new", "") }]);
    expect(await getBrowserRuntimeInfo({ port, savedLaunch: { port, profile_dir: profile, headless: false, resume_headless: true } }))
      .toMatchObject({ actual_mode: "headed", saved_mode: "headed", resume_headless: true, mode_matches_saved: true });
  });

  it.each([undefined, { port: 19334, profile_dir: profile, headless: true }, { port, profile_dir: `${profile}-other`, headless: true }])("ignores saved configuration not bound to this process's port and profile: %j", async (savedLaunch) => {
    fixture();
    expect(await getBrowserRuntimeInfo({ port, savedLaunch })).toMatchObject({ actual_mode: "headless", saved_mode: "unknown", mode_matches_saved: null });
  });

  it.each([[], [main, { ...main, processId: 101 }]])("does not assert mode with absent or ambiguous identity", async (processes) => {
    fixture();
    processFixture.mockReturnValue(processes);
    expect(await getBrowserRuntimeInfo({ port })).toMatchObject({ actual_mode: "unknown", process_identity: "unverified" });
  });

  it("keeps a process inspection failure separate from page readiness or authentication", async () => {
    fixture();
    processFixture.mockImplementation(() => { throw new Error("access denied"); });
    const result = await getBrowserRuntimeInfo({ port });
    expect(result).toMatchObject({ metadata: "available", actual_mode: "unknown", process_identity: "unverified" });
    expect(JSON.stringify(result)).not.toMatch(/login|ready|restart|access denied/);
  });

  it.each([null, {}, { Browser: "Firefox/140.0", "Protocol-Version": "1.3" }, { Browser: "Chrome/152.0\nforged=true", "Protocol-Version": "1.3" }])("does not advertise Chromium compatibility from malformed/unsupported metadata: %j", async (metadata) => {
    fixture(metadata);
    expect(await getBrowserRuntimeInfo({ port })).toMatchObject({ metadata: "unsupported", browser_product: null, protocol_version: null });
  });

  it("reports a refused or redirected endpoint without a login recommendation", async () => {
    fixture();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("connection refused"); }));
    const result = await getBrowserRuntimeInfo({ port });
    expect(result).toMatchObject({ metadata: "unavailable", browser_product: null, protocol_version: null });
    expect(JSON.stringify(result)).not.toMatch(/login|restart|ready/);
  });

  it.each([0, -1, 65536, NaN])("refuses invalid local ports before any probe: %s", async (invalidPort) => {
    const fetchMock = fixture();
    await expect(getBrowserRuntimeInfo({ port: invalidPort })).rejects.toThrow(/port/i);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(processFixture).not.toHaveBeenCalled();
  });
});
