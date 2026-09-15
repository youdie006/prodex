#!/usr/bin/env node
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";

import { openChatGptBrowser } from "../dist/chatgpt-browser.js";
import {
  assertLaunchedBrowserMainProcess,
  findMatchingBrowserProcesses,
  inspectBrowserProcesses,
} from "../dist/browser-process.js";

const READY_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 5_000;
const SMOKE_MARKER = "prodex-browser-launch-smoke";

try {
  await runSmoke();
} catch (error) {
  console.error(`browser launch smoke failed: ${errorMessage(error)}`);
  process.exitCode = 1;
}

async function runSmoke() {
  const profileDir = await mkdtemp(path.join(tmpdir(), "prodex browser launch smoke-"));
  const port = await unusedLoopbackPort();
  let browserSocket;
  let launch;
  let ownershipVerified = false;
  let shutdownConfirmed = false;
  let completed = false;
  let mainPid;
  const ownedProcessIds = new Set();
  try {
    launch = openChatGptBrowser({ port, profileDir, url: "about:blank", headless: true });
    if (!Number.isSafeInteger(launch.processId) || launch.processId <= 0) {
      throw new Error("browser launch did not return a process ID");
    }
    ownedProcessIds.add(launch.processId);
    const identity = await waitForLaunchedBrowserIdentity(launch, port, profileDir, READY_TIMEOUT_MS);
    for (const pid of identity.processIds) ownedProcessIds.add(pid);
    ownershipVerified = true;
    mainPid = identity.main.processId;

    const version = await waitForCdp(launch, READY_TIMEOUT_MS);
    const candidateBrowserSocket = localCdpSocket(version.webSocketDebuggerUrl, port, "browser");
    const readyIdentity = await waitForLaunchedBrowserIdentity(launch, port, profileDir, REQUEST_TIMEOUT_MS);
    for (const pid of readyIdentity.processIds) ownedProcessIds.add(pid);
    browserSocket = candidateBrowserSocket;
    const page = await findBlankPage(port);

    const evaluation = await cdpRequest(localCdpSocket(page.webSocketDebuggerUrl, port, "page"), "Runtime.evaluate", {
      expression: `({ marker: ${JSON.stringify(SMOKE_MARKER)}, answer: 20 + 22, href: location.href })`,
      returnByValue: true
    });
    const value = evaluation?.result?.value;
    if (value?.marker !== SMOKE_MARKER || value.answer !== 42 || value.href !== "about:blank") {
      throw new Error("the real browser JavaScript evaluation returned an unexpected value");
    }

    const closeIdentity = await waitForLaunchedBrowserIdentity(launch, port, profileDir, REQUEST_TIMEOUT_MS);
    for (const pid of closeIdentity.processIds) ownedProcessIds.add(pid);
    await cdpRequest(browserSocket, "Browser.close");
    await waitForOwnedBrowserExit(port, profileDir, ownedProcessIds, CLOSE_TIMEOUT_MS);
    shutdownConfirmed = true;
    completed = true;
  } finally {
    if (!completed) {
      shutdownConfirmed = await cleanupOwnedBrowser({
        port,
        profileDir,
        browserSocket,
        launchProcessId: launch?.processId,
        ownershipVerified,
        ownedProcessIds
      });
    }
    if (shutdownConfirmed) {
      await rm(profileDir, { recursive: true, force: true });
    } else {
      throw new Error(`browser shutdown could not be confirmed; temporary profile retained at ${profileDir}`);
    }
  }
  console.log(
    `browser_launch_smoke=ok platform=${process.platform} port=${port} main_pid=${mainPid} evaluation=42 graceful_close=ok cleanup=ok`
  );
}

async function unusedLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not allocate a loopback port");
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForCdp(launch, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    const earlyExit = await launch.waitForEarlyExit(0);
    if (earlyExit) throw new Error(`browser exited before CDP was ready: ${JSON.stringify(earlyExit)}`);
    try {
      return await readCdpJson(launch.port, "version");
    } catch (error) {
      lastError = error;
      await sleep(200);
    }
  }
  throw new Error(`CDP did not become ready within ${timeoutMs}ms: ${errorMessage(lastError)}`);
}

async function waitForLaunchedBrowserIdentity(launch, port, profileDir, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    const earlyExit = await launch.waitForEarlyExit(0);
    if (earlyExit) throw new Error(`browser exited before process identity was verified: ${JSON.stringify(earlyExit)}`);
    try {
      return assertCurrentLaunchedBrowserIdentity(port, profileDir, launch.processId);
    } catch (error) {
      lastError = error;
      await sleep(200);
    }
  }
  throw new Error(`browser process identity was not verified within ${timeoutMs}ms: ${errorMessage(lastError)}`);
}

function assertCurrentLaunchedBrowserIdentity(port, profileDir, launchedProcessId) {
  const matching = findMatchingBrowserProcesses(inspectBrowserProcesses(), { port, profileDir });
  return {
    main: assertLaunchedBrowserMainProcess(matching, launchedProcessId),
    processIds: matching.map((processInfo) => processInfo.processId)
  };
}

async function findBlankPage(port) {
  const targets = await readCdpJson(port, "list");
  if (!Array.isArray(targets)) throw new Error("CDP target list was not an array");
  const pages = targets.filter((target) => target?.type === "page" && target.url === "about:blank");
  if (pages.length !== 1) throw new Error(`expected one about:blank page, found ${pages.length}`);
  return pages[0];
}

async function readCdpJson(port, resource) {
  const response = await fetch(`http://127.0.0.1:${port}/json/${resource}`, {
    signal: AbortSignal.timeout(1_500)
  });
  if (!response.ok) throw new Error(`CDP ${resource} returned HTTP ${response.status}`);
  return response.json();
}

function localCdpSocket(value, port, kind) {
  if (typeof value !== "string") throw new Error(`CDP ${kind} socket is missing`);
  const url = new URL(value);
  if (url.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      Number(url.port) !== port || url.username || url.password || !url.pathname.startsWith(`/devtools/${kind}/`)) {
    throw new Error(`CDP ${kind} socket is not the expected loopback endpoint`);
  }
  return value;
}

async function cdpRequest(socketUrl, method, params = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl);
    let sent = false;
    let finished = false;
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.on("error", () => {});
      socket.terminate();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`${method} timed out`)), REQUEST_TIMEOUT_MS);
    socket.once("open", () => {
      try {
        socket.send(JSON.stringify({ id: 1, method, params }));
        sent = true;
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on("message", (data) => {
      let reply;
      try {
        reply = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (reply.id !== 1) return;
      finish(reply.error ? new Error(reply.error.message ?? `${method} failed`) : undefined, reply.result);
    });
    socket.once("error", (error) => finish(error));
    socket.once("close", () => {
      finish(method === "Browser.close" && sent ? undefined : new Error(`${method} socket closed before a reply`));
    });
  });
}

async function waitForOwnedBrowserExit(port, profileDir, ownedProcessIds, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const matching = findMatchingBrowserProcesses(inspectBrowserProcesses(), { port, profileDir });
      for (const processInfo of matching) ownedProcessIds.add(processInfo.processId);
      if (matching.length === 0 && ![...ownedProcessIds].some(processIsAlive) && !(await cdpReachable(port))) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`owned browser did not exit after Browser.close: ${errorMessage(lastError)}`);
}

async function cleanupOwnedBrowser({ port, profileDir, browserSocket, launchProcessId, ownershipVerified, ownedProcessIds }) {
  if (browserSocket && ownershipVerified) {
    try {
      const identity = assertCurrentLaunchedBrowserIdentity(port, profileDir, launchProcessId);
      for (const pid of identity.processIds) ownedProcessIds.add(pid);
      await cdpRequest(browserSocket, "Browser.close");
    } catch {
      // Continue with ordinary termination of only the process this smoke launched.
    }
  }
  try {
    await waitForOwnedBrowserExit(port, profileDir, ownedProcessIds, 5_000);
    return true;
  } catch {
    // The directly launched process gets one ordinary shutdown request below.
  }
  if (Number.isSafeInteger(launchProcessId) && launchProcessId > 0) {
    try {
      process.kill(launchProcessId, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  try {
    await waitForOwnedBrowserExit(port, profileDir, ownedProcessIds, 10_000);
    return true;
  } catch {
    return false;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function cdpReachable(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(750)
    });
    return response.ok;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
