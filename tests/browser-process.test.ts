import { describe, expect, it, vi } from "vitest";

const spawnSync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  spawnSync
}));

import {
  BrowserProcessInspectionError,
  assertLaunchedBrowserMainProcess,
  findMatchingBrowserProcesses,
  findOwnedBrowserCleanupProcesses,
  inspectBrowserProcesses,
  parseWindowsCimProcessJson,
  type BrowserProcessInfo
} from "../src/browser-process.js";
import { findWedgedBrowser } from "../src/chatgpt-browser.js";

const windowsProfile = "C:\\Users\\Test User\\AppData\\Local\\prodex\\chrome-profile";

function windowsProcesses(): BrowserProcessInfo[] {
  return parseWindowsCimProcessJson(JSON.stringify([
    {
      ExecutablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      ProcessId: 4100,
      CommandLine: `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=19333 "--user-data-dir=${windowsProfile}" --headless=new`
    },
    {
      ExecutablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      ProcessId: 4101,
      CommandLine: `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --type=renderer "--user-data-dir=${windowsProfile}"`
    },
    {
      ExecutablePath: "C:\\Program Files\\nodejs\\node.exe",
      ProcessId: 4199,
      CommandLine: `node.exe fixture.js "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=19333 --user-data-dir="${windowsProfile}"`
    }
  ]));
}

describe("browser process inspection", () => {
  it("revalidates cleanup ownership and selects recorded children even after the main exits", () => {
    const processes = windowsProcesses();
    const input = { platform: "win32" as const, port: 19333, profileDir: windowsProfile, launchedProcessId: 4100, knownProcessIds: new Set([4100, 4101]) };
    expect(findOwnedBrowserCleanupProcesses(processes, input).map(p => p.processId)).toEqual([4100, 4101]);
    expect(findOwnedBrowserCleanupProcesses(processes.slice(1), input).map(p => p.processId)).toEqual([4101]);
    expect(findOwnedBrowserCleanupProcesses([
      { ...processes[0], commandLine: processes[0].commandLine.replace(windowsProfile, `${windowsProfile}-other`) },
      { ...processes[1], executablePath: "C:\\Other\\node.exe" }
    ], input)).toEqual([]);
    expect(findOwnedBrowserCleanupProcesses([{ ...processes[0], commandLine: processes[0].commandLine.replace("19333", "19334") }], input)).toEqual([]);
  });

  it("never signals a successor browser or a previously unobserved child", () => {
    const processes = windowsProcesses();
    const input = { platform: "win32" as const, port: 19333, profileDir: windowsProfile, launchedProcessId: 4100, knownProcessIds: new Set([4100, 4101]) };
    expect(findOwnedBrowserCleanupProcesses([{ ...processes[0], processId: 4200 }, processes[1]], input)).toEqual([]);
    expect(findOwnedBrowserCleanupProcesses([{ ...processes[1], processId: 4201 }], input)).toEqual([]);
  });

  it("matches a quoted Windows Program Files browser and ignores a non-browser command mentioning it", () => {
    expect(findMatchingBrowserProcesses(windowsProcesses(), {
      platform: "win32",
      port: 19333,
      profileDir: windowsProfile
    }).map((processInfo) => processInfo.processId)).toEqual([4100, 4101]);
  });

  it("requires both the exact debugging port and profile", () => {
    const processes = windowsProcesses();
    expect(findMatchingBrowserProcesses(processes, {
      platform: "win32",
      port: 19334,
      profileDir: windowsProfile
    })).toEqual([]);
    expect(findMatchingBrowserProcesses(processes, {
      platform: "win32",
      port: 19333,
      profileDir: `${windowsProfile}-other`
    })).toEqual([]);
  });

  it("requires the unique matching main process to be the PID returned by launch", () => {
    const matching = findMatchingBrowserProcesses(windowsProcesses(), {
      platform: "win32",
      port: 19333,
      profileDir: windowsProfile
    });
    expect(assertLaunchedBrowserMainProcess(matching, 4100).processId).toBe(4100);
    expect(() => assertLaunchedBrowserMainProcess(matching, 4199)).toThrow(BrowserProcessInspectionError);
    expect(() => assertLaunchedBrowserMainProcess([
      ...matching,
      { ...matching[0], processId: 4200 }
    ], 4100)).toThrow(BrowserProcessInspectionError);
  });

  it("refuses an inaccessible Windows process list instead of treating it as empty", () => {
    const run = vi.fn(() => ({
      status: 1,
      signal: null,
      stdout: "",
      stderr: "Access is denied",
      pid: 12,
      output: [],
      error: undefined
    }));

    expect(() => inspectBrowserProcesses({ platform: "win32", run })).toThrow(BrowserProcessInspectionError);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toBe("powershell.exe");
    expect(run.mock.calls[0]?.[1]).not.toContain(windowsProfile);
  });

  it("reports an incomplete CIM entry with the process-inspection domain error", () => {
    expect(() => parseWindowsCimProcessJson("[null]")).toThrow(BrowserProcessInspectionError);
  });

  it("propagates process inspection failure through the wedged-browser launch guard", () => {
    spawnSync.mockReturnValue({ status: 1, stdout: "", stderr: "Access denied" });

    expect(() => findWedgedBrowser({ port: 19333, profileDir: "/tmp/prodex-profile" }))
      .toThrow(BrowserProcessInspectionError);
  });

  it("discovers a unique port's profile only when findWedgedBrowser has no explicit profile", () => {
    const customProfile = process.platform === "win32" ? "C:\\Users\\me\\custom-profile" : "/home/me/custom-profile";
    const otherProfile = process.platform === "win32" ? "C:\\Users\\me\\other-profile" : "/home/me/other-profile";
    spawnSync.mockImplementation((command: string) => {
      if (command === "powershell.exe") {
        return {
          status: 0,
          stdout: JSON.stringify([
            {
              ExecutablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
              ProcessId: 5100,
              CommandLine: `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=19444 --user-data-dir=${customProfile}`
            },
            {
              ExecutablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
              ProcessId: 5101,
              CommandLine: `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --type=renderer --user-data-dir=${customProfile}`
            }
          ])
        };
      }
      return {
        status: 0,
        stdout: [
          `me 5100 /usr/bin/google-chrome --remote-debugging-port=19444 --user-data-dir=${customProfile}`,
          `me 5101 /usr/bin/google-chrome --type=renderer --user-data-dir=${customProfile}`
        ].join("\n")
      };
    });

    expect(findWedgedBrowser({ port: 19444 })).toEqual([5100, 5101]);
    expect(findWedgedBrowser({ port: 19444, profileDir: otherProfile })).toEqual([]);
  });
});
