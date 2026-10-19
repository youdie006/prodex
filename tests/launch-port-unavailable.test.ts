import { spawn } from "node:child_process";
import { createServer, type AddressInfo, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import type { ChatGptBrowserLaunch } from "../src/chatgpt-browser.js";
import { assertBrowserLaunchStayedAlive } from "../src/cli-pro.js";

// Measured 2026-10-19: after a Windows restart, Hyper-V reserved TCP ports
// 9240-9339, and with WSL's mirrored networking Chrome could not bind 9333
// ("bind() failed: Address already in use", "Cannot start http server for
// devtools"). The browser still ran and loaded ChatGPT, but prodex said to
// check the display or profile lock - and left that Chrome running, so every
// later revive refused it as a wedged browser.
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function occupiedPort(): Promise<number> {
  const server = createServer((socket) => socket.destroy());
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function freePort(): Promise<number> {
  const port = await occupiedPort();
  await new Promise((resolve) => servers.pop()!.close(resolve));
  return port;
}

function launched(port: number): { launch: ChatGptBrowserLaunch; alive: () => boolean } {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  const launch: ChatGptBrowserLaunch = {
    command: "chrome",
    args: [],
    processId: child.pid,
    profileDir: "/tmp/profile",
    port,
    waitForEarlyExit: async () => undefined
  };
  return { launch, alive: () => child.exitCode === null && child.signalCode === null };
}

describe("a browser launch whose DevTools endpoint never appears", () => {
  it("names a control port that something else holds", async () => {
    const port = await occupiedPort();
    const { launch } = launched(port);
    await expect(assertBrowserLaunchStayedAlive(launch, 300)).rejects.toThrow(
      new RegExp(`port ${port} on 127\\.0\\.0\\.1 is already taken.*excludedportrange.*--port`, "s")
    );
  });

  it("ends the browser it started, so the next attempt is not refused as a wedged one", async () => {
    const { launch, alive } = launched(await freePort());
    await expect(assertBrowserLaunchStayedAlive(launch, 300)).rejects.toThrow(/did not expose a reachable DevTools endpoint/);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(alive()).toBe(false);
  });
});
