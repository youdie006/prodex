import { describe, expect, it } from "vitest";

import { findBrowserProcessesByPort, inspectBrowserProcesses } from "../src/browser-process.js";

// Measured 2026-10-08: with the host browser down and the browser container up,
// `pro browser reset` on the host offered to end 12 processes - all of them the
// container's Chromium. Its processes are visible in the host's process list,
// run as the same uid, and also pass --remote-debugging-port=9333, but that
// port lives in the container's own network namespace.
const psOutput = [
  "USER PID COMMAND",
  "node 100 /usr/lib/chromium/chromium --remote-debugging-port=9333 --user-data-dir=/home/node/.local/share/prodex/chrome-chatgpt-pro",
  "node 101 /usr/lib/chromium/chromium --type=renderer --user-data-dir=/home/node/.local/share/prodex/chrome-chatgpt-pro",
  "me 200 /opt/google/chrome/chrome --remote-debugging-port=9333 --user-data-dir=/home/me/.local/share/prodex/chrome-chatgpt-pro",
  "me 201 /opt/google/chrome/chrome --type=renderer --user-data-dir=/home/me/.local/share/prodex/chrome-chatgpt-pro"
].join("\n");

function inspect(namespaces: Record<string, string | undefined>, stdout = psOutput) {
  return inspectBrowserProcesses({
    platform: "linux",
    run: () => ({ status: 0, stdout }),
    readNetworkNamespace: (pid) => namespaces[String(pid)]
  });
}

describe("browser processes in another network namespace", () => {
  it("are not ours, so a port-only search ignores them", () => {
    const processes = inspect({ self: "net:[1]", "100": "net:[2]", "101": "net:[2]", "200": "net:[1]", "201": "net:[1]" });
    expect(processes.map((p) => p.processId)).toEqual([200, 201]);
    expect(findBrowserProcessesByPort(processes, { platform: "linux", port: 9333 }).map((p) => p.processId)).toEqual([200, 201]);
  });

  it("leave only the container browser out when the host one is down", () => {
    const containerOnly = psOutput.split("\n").filter((line) => !line.startsWith("me ")).join("\n");
    const processes = inspect({ self: "net:[1]", "100": "net:[2]", "101": "net:[2]" }, containerOnly);
    expect(findBrowserProcessesByPort(processes, { platform: "linux", port: 9333 })).toEqual([]);
  });

  it("keep a process whose namespace cannot be read, as before", () => {
    expect(inspect({ self: "net:[1]" }).map((p) => p.processId)).toEqual([100, 101, 200, 201]);
  });
});
