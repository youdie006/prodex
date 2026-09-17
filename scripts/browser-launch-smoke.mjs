#!/usr/bin/env node
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

import { createBrowserCompatibilityEvidence } from "./browser-compatibility.mjs";
import { runNavigationProbe } from "./browser-navigation-probe.mjs";
import { openChatGptBrowser } from "../dist/chatgpt-browser.js";
import {
  assertLaunchedBrowserMainProcess,
  browserProcessHasFlag,
  findMatchingBrowserProcesses,
  findOwnedBrowserCleanupProcesses,
  inspectBrowserProcesses,
} from "../dist/browser-process.js";

const READY_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 5_000;
const SMOKE_MARKER = "prodex-browser-launch-smoke";
const PROFILE_MARKER_KEY = "prodex-browser-launch-smoke-marker";
const PROFILE_MARKER_VALUE = "synthetic-local-profile-marker-v1";
const ATTACHMENT_NAME = "prodex-browser-smoke-attachment.txt";
const ATTACHMENT_CONTENT = "prodex browser smoke attachment\n";
const FIXTURE_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Prodex browser smoke</title></head>
<body>
  <label>Keyboard <input id="keyboard" autocomplete="off"></label>
  <button id="mouse" type="button">Mouse</button>
  <label>File <input id="file" type="file"></label>
  <script>document.querySelector("#mouse").addEventListener("click", () => { document.body.dataset.mouse = "clicked"; });</script>
</body>
</html>`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseSmokeOptions(process.argv.slice(2));
    await runSmoke(options);
  } catch (error) {
    console.error(`browser launch smoke failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}

export function parseSmokeOptions(values) {
  const options = { headed: false, publicChatGpt: false };
  for (const value of values) {
    if (value === "--headed") {
      options.headed = true;
      continue;
    }
    if (value === "--public-chatgpt") {
      options.publicChatGpt = true;
      continue;
    }
    if (value.startsWith("-")) throw new Error(`unknown option ${value}`);
    throw new Error(`unexpected argument ${value}`);
  }
  return options;
}

export function browserSmokeOutcome(publicNavigation) {
  return !publicNavigation || publicNavigation.outcome === "response" ? "ok" : "failed";
}

async function runSmoke(options) {
  const headless = !options.headed;
  const tempRoot = await realpath(await mkdtemp(path.join(tmpdir(), "prodex browser compatibility smoke-")));
  const profileDir = path.join(tempRoot, "profile");
  const attachmentPath = path.join(tempRoot, ATTACHMENT_NAME);
  let fixture;
  let activeBrowser;
  let evidence;
  let navigationDiagnostics;
  let publicNavigation;
  let port;
  let mainPid;
  try {
    await mkdir(profileDir);
    await writeFile(attachmentPath, ATTACHMENT_CONTENT, "utf8");
    fixture = await startFixtureServer();
    port = await unusedLoopbackPort();

    activeBrowser = beginOwnedBrowser(port, profileDir, headless);
    const firstReady = await waitForOwnedBrowserReady(activeBrowser, READY_TIMEOUT_MS);
    mainPid = firstReady.identity.main.processId;
    const capabilities = await verifyLocalCapabilities({
      port,
      fixtureUrl: fixture.url,
      attachmentPath
    });
    navigationDiagnostics = await verifyLocalNavigationDiagnostics(port, fixture.url);
    await closeOwnedBrowser(activeBrowser);
    activeBrowser = undefined;

    activeBrowser = beginOwnedBrowser(port, profileDir, headless);
    const restartReady = await waitForOwnedBrowserReady(activeBrowser, READY_TIMEOUT_MS);
    assertSameBrowserMetadata(firstReady.version, restartReady.version);
    const marker = await verifySyntheticProfileMarker(port, fixture.url);
    capabilities.profileRestartMarker = marker.verified;
    if (options.publicChatGpt) {
      publicNavigation = await withCdpSession(localCdpSocket(marker.page.webSocketDebuggerUrl, port, "page"),
        (send, subscribe) => runNavigationProbe({ send, subscribe }, { url: "https://chatgpt.com/" }));
      // Preserve a partial report even if later owned-browser cleanup fails.
      console.log(`public_navigation_diagnostics=${JSON.stringify(publicNavigation)}`);
    }
    await closeOwnedBrowser(activeBrowser);
    activeBrowser = undefined;

    evidence = createBrowserCompatibilityEvidence({
      cdpVersion: firstReady.version,
      platform: process.platform,
      arch: process.arch,
      headlessProcess: firstReady.headlessProcess && restartReady.headlessProcess,
      headedProcess: firstReady.headedProcess && restartReady.headedProcess,
      capabilities
    });
  } finally {
    const browserShutdownConfirmed = activeBrowser
      ? validProcessId(activeBrowser.launch.processId) && await cleanupOwnedBrowser({
          port,
          profileDir,
          browserSocket: activeBrowser.browserSocket,
          launchProcessId: activeBrowser.launch.processId,
          ownershipVerified: activeBrowser.ownershipVerified,
          ownedProcessIds: activeBrowser.ownedProcessIds
        })
      : true;
    const fixtureShutdownConfirmed = fixture ? await closeFixtureServer(fixture.server) : true;
    if (browserShutdownConfirmed && fixtureShutdownConfirmed) {
      await rm(tempRoot, { recursive: true, force: true });
    } else {
      throw new Error(`browser or fixture shutdown could not be confirmed; temporary files retained at ${tempRoot}`);
    }
  }
  const outcome = browserSmokeOutcome(publicNavigation);
  console.log(
    `browser_launch_smoke=${outcome} platform=${process.platform} port=${port} main_pid=${mainPid} evaluation=42 graceful_close=ok cleanup=ok evidence=${JSON.stringify(evidence)} navigation_diagnostics=${JSON.stringify(navigationDiagnostics)}`
  );
  if (outcome !== "ok") {
    throw new Error(`public navigation did not pass: ${publicNavigation.outcome}; no retry or login attempted`);
  }
}

async function unusedLoopbackPort() {
  const server = createNetServer();
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

async function startFixtureServer() {
  const server = createHttpServer((request, response) => {
    if (request.method === "GET" && request.url === "/navigation-redirect") {
      response.writeHead(302, { location: "/navigation-final?synthetic=redirect", "cache-control": "no-store" });
      response.end();
      return;
    }
    if (request.method === "GET" && request.url === "/navigation-final?synthetic=redirect") {
      response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      response.end('<!doctype html><title>Navigation fixture</title><iframe src="/navigation-child"></iframe>');
      return;
    }
    if (request.method === "GET" && request.url === "/navigation-child") {
      response.writeHead(418, { "content-type": "text/html", "cache-control": "no-store" });
      response.end("<!doctype html><title>Child fixture</title>");
      return;
    }
    if (request.method === "GET" && request.url === "/navigation-refusal") {
      response.writeHead(403, { "content-type": "text/html", "cf-mitigated": "challenge", "cache-control": "no-store" });
      response.end("<!doctype html><title>Synthetic refusal</title>");
      return;
    }
    if (request.method !== "GET" || request.url !== "/") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found\n");
      return;
    }
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'",
      "content-type": "text/html; charset=utf-8"
    });
    response.end(FIXTURE_HTML);
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = 1_000;
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeFixtureServer(server);
    throw new Error("could not start the loopback browser fixture");
  }
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

async function closeFixtureServer(server) {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (closed) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(closed);
    };
    const timer = setTimeout(() => finish(false), REQUEST_TIMEOUT_MS);
    server.close((error) => finish(!error));
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
  });
}

function beginOwnedBrowser(port, profileDir, headless) {
  const launch = openChatGptBrowser({ port, profileDir, url: "about:blank", headless });
  return {
    launch,
    headless,
    requestedPort: port,
    requestedProfileDir: profileDir,
    browserSocket: undefined,
    ownershipVerified: false,
    ownedProcessIds: new Set(validProcessId(launch.processId) ? [launch.processId] : [])
  };
}

async function waitForOwnedBrowserReady(activeBrowser, timeoutMs) {
  const { launch } = activeBrowser;
  if (!validProcessId(launch.processId)) throw new Error("browser launch did not return a process ID");
  if (launch.port !== activeBrowser.requestedPort ||
      await realpath(launch.profileDir) !== await realpath(activeBrowser.requestedProfileDir)) {
    throw new Error("browser launch did not retain the requested disposable port and profile");
  }
  const identity = await waitForLaunchedBrowserIdentity(launch, launch.port, launch.profileDir, timeoutMs);
  for (const pid of identity.processIds) activeBrowser.ownedProcessIds.add(pid);
  activeBrowser.ownershipVerified = true;
  assertBrowserProcessMode(identity.main, activeBrowser.headless, "inspected");

  const version = await waitForCdp(launch, timeoutMs);
  const candidateBrowserSocket = localCdpSocket(version.webSocketDebuggerUrl, launch.port, "browser");
  const readyIdentity = await waitForLaunchedBrowserIdentity(
    launch,
    launch.port,
    launch.profileDir,
    REQUEST_TIMEOUT_MS
  );
  for (const pid of readyIdentity.processIds) activeBrowser.ownedProcessIds.add(pid);
  const processMode = assertBrowserProcessMode(readyIdentity.main, activeBrowser.headless, "ready");
  activeBrowser.browserSocket = candidateBrowserSocket;
  return {
    version,
    identity: readyIdentity,
    ...processMode
  };
}

function assertBrowserProcessMode(processInfo, expectedHeadless, stage) {
  const inspectedHeadless = browserProcessHasFlag(processInfo, "headless");
  if (inspectedHeadless !== expectedHeadless) {
    if (expectedHeadless) throw new Error(`${stage} browser main process is not actually headless`);
    throw new Error(`${stage} browser main process is still headless instead of headed`);
  }
  return {
    headlessProcess: inspectedHeadless,
    headedProcess: !inspectedHeadless
  };
}

function validProcessId(processId) {
  return Number.isSafeInteger(processId) && processId > 0;
}

async function closeOwnedBrowser(activeBrowser) {
  const { launch } = activeBrowser;
  const identity = await waitForLaunchedBrowserIdentity(
    launch,
    launch.port,
    launch.profileDir,
    REQUEST_TIMEOUT_MS
  );
  for (const pid of identity.processIds) activeBrowser.ownedProcessIds.add(pid);
  await cdpRequest(activeBrowser.browserSocket, "Browser.close");
  await waitForOwnedBrowserExit(
    launch.port,
    launch.profileDir,
    activeBrowser.ownedProcessIds,
    CLOSE_TIMEOUT_MS
  );
}

function assertSameBrowserMetadata(first, restart) {
  if (first?.Browser !== restart?.Browser || first?.["Protocol-Version"] !== restart?.["Protocol-Version"]) {
    throw new Error("browser or protocol metadata changed across the same-profile restart");
  }
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

export async function waitForFixturePage(port, fixtureUrl, timeoutMs, expectedTargetId) {
  const deadline = Date.now() + timeoutMs;
  let lastCount = 0;
  let lastUrl;
  while (Date.now() < deadline) {
    const targets = await readCdpJson(port, "list");
    if (!Array.isArray(targets)) throw new Error("CDP target list was not an array");
    const pages = targets.filter((target) => target?.type === "page" &&
      (expectedTargetId === undefined ? target.url === fixtureUrl : target.id === expectedTargetId));
    lastCount = pages.length;
    if (pages.length === 1) {
      lastUrl = pages[0].url;
      if (lastUrl === fixtureUrl) return pages[0];
    }
    if (pages.length > 1) {
      if (expectedTargetId !== undefined) throw new Error(`expected one loopback fixture target ${expectedTargetId}, found ${pages.length}`);
      throw new Error(`expected one loopback fixture page, found ${pages.length}`);
    }
    await sleep(200);
  }
  if (expectedTargetId !== undefined) {
    throw new Error(`loopback fixture target ${expectedTargetId} was not ready at ${fixtureUrl} within ${timeoutMs}ms (found ${lastCount}${lastUrl === undefined ? "" : ` at ${lastUrl}`})`);
  }
  throw new Error(`loopback fixture page was not ready within ${timeoutMs}ms (found ${lastCount})`);
}

async function verifyLocalCapabilities({ port, fixtureUrl, attachmentPath }) {
  const page = await navigateBlankPageToFixture(port, fixtureUrl);
  const capabilities = {
    runtimeEnabled: false,
    runtimeEvaluated: false,
    domEnabled: false,
    keyboardInput: false,
    mouseInput: false,
    fileAttachment: false,
    profileRestartMarker: false
  };
  await withCdpSession(localCdpSocket(page.webSocketDebuggerUrl, port, "page"), async (send) => {
    await send("Runtime.enable");
    capabilities.runtimeEnabled = true;
    await waitForFixtureDom(send);

    await send("DOM.enable");
    const documentResult = await send("DOM.getDocument");
    const rootNodeId = documentResult?.root?.nodeId;
    if (!Number.isSafeInteger(rootNodeId) || rootNodeId <= 0) {
      throw new Error("DOM.getDocument did not return a root node");
    }
    const keyboardNodeId = await queryNode(send, rootNodeId, "#keyboard");
    const mouseNodeId = await queryNode(send, rootNodeId, "#mouse");
    const fileNodeId = await queryNode(send, rootNodeId, "#file");
    capabilities.domEnabled = true;

    await send("DOM.focus", { nodeId: keyboardNodeId });
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "k",
      code: "KeyK",
      text: "k",
      unmodifiedText: "k",
      windowsVirtualKeyCode: 75,
      nativeVirtualKeyCode: 75
    });
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "k",
      code: "KeyK",
      windowsVirtualKeyCode: 75,
      nativeVirtualKeyCode: 75
    });

    const boxResult = await send("DOM.getBoxModel", { nodeId: mouseNodeId });
    const mousePoint = centerOfQuad(boxResult?.model?.border);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...mousePoint });
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...mousePoint,
      button: "left",
      buttons: 1,
      clickCount: 1
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      ...mousePoint,
      button: "left",
      buttons: 0,
      clickCount: 1
    });

    await send("DOM.setFileInputFiles", { nodeId: fileNodeId, files: [attachmentPath] });
    const evaluation = await send("Runtime.evaluate", {
      expression: `(() => {
        localStorage.clear();
        localStorage.setItem(${JSON.stringify(PROFILE_MARKER_KEY)}, ${JSON.stringify(PROFILE_MARKER_VALUE)});
        const file = document.querySelector("#file").files[0];
        return {
          marker: ${JSON.stringify(SMOKE_MARKER)},
          answer: 20 + 22,
          href: location.href,
          keyboard: document.querySelector("#keyboard").value,
          mouse: document.body.dataset.mouse,
          fileCount: document.querySelector("#file").files.length,
          fileName: file?.name,
          fileSize: file?.size,
          storageEntries: localStorage.length
        };
      })()`,
      returnByValue: true
    });
    const value = runtimeValue(evaluation, "local capability evaluation");
    if (value?.marker !== SMOKE_MARKER || value.answer !== 42 || value.href !== fixtureUrl) {
      throw new Error("the real browser JavaScript evaluation returned an unexpected value");
    }
    if (value.keyboard !== "k") throw new Error("CDP keyboard input did not update the loopback fixture");
    if (value.mouse !== "clicked") throw new Error("CDP mouse input did not click the loopback fixture");
    if (value.fileCount !== 1 || value.fileName !== ATTACHMENT_NAME ||
        value.fileSize !== Buffer.byteLength(ATTACHMENT_CONTENT)) {
      throw new Error("CDP file attachment did not select the synthetic local file");
    }
    if (value.storageEntries !== 1) {
      throw new Error("the disposable loopback origin stored data other than the synthetic marker");
    }
    capabilities.runtimeEvaluated = true;
    capabilities.keyboardInput = true;
    capabilities.mouseInput = true;
    capabilities.fileAttachment = true;
  });
  return capabilities;
}

async function verifySyntheticProfileMarker(port, fixtureUrl) {
  const page = await navigateBlankPageToFixture(port, fixtureUrl);
  const verified = await withCdpSession(localCdpSocket(page.webSocketDebuggerUrl, port, "page"), async (send) => {
    await send("Runtime.enable");
    await waitForFixtureDom(send);
    const evaluation = await send("Runtime.evaluate", {
      expression: `({
        marker: localStorage.getItem(${JSON.stringify(PROFILE_MARKER_KEY)}),
        storageEntries: localStorage.length,
        href: location.href
      })`,
      returnByValue: true
    });
    const value = runtimeValue(evaluation, "same-profile marker evaluation");
    if (value?.marker !== PROFILE_MARKER_VALUE || value.storageEntries !== 1 || value.href !== fixtureUrl) {
      throw new Error("the synthetic local marker did not persist across the same-profile restart");
    }
    return true;
  });
  return { verified, page };
}

async function verifyLocalNavigationDiagnostics(port, fixtureUrl) {
  const page = await waitForFixturePage(port, fixtureUrl, READY_TIMEOUT_MS);
  const reports = [];
  for (const fixture of [
    { route: "/navigation-redirect", outcome: "response", statuses: [302, 200] },
    { route: "/navigation-refusal", outcome: "http_error", statuses: [403] }
  ]) {
    const report = await withCdpSession(localCdpSocket(page.webSocketDebuggerUrl, port, "page"),
      (send, subscribe) => runNavigationProbe({ send, subscribe }, {
        url: new URL(fixture.route, fixtureUrl).href
      }));
    const statuses = report.diagnostics?.responses.map(response => response.status);
    if (report.outcome !== fixture.outcome || report.diagnostics?.correlation !== "confirmed" ||
        JSON.stringify(statuses) !== JSON.stringify(fixture.statuses)) {
      console.error(`local_navigation_diagnostics=${JSON.stringify(report)}`);
      throw new Error("local navigation diagnostic fixture did not match");
    }
    reports.push(report);
  }
  return reports;
}

async function navigateBlankPageToFixture(port, fixtureUrl) {
  const blankPage = await waitForFixturePage(port, "about:blank", READY_TIMEOUT_MS);
  if (typeof blankPage.id !== "string" || blankPage.id.length === 0) {
    throw new Error("CDP blank page target ID is missing");
  }
  await withCdpSession(localCdpSocket(blankPage.webSocketDebuggerUrl, port, "page"), async (send) => {
    await send("Page.enable");
    const navigation = await send("Page.navigate", { url: fixtureUrl });
    if (navigation?.errorText) throw new Error(`loopback fixture navigation failed: ${navigation.errorText}`);
  });
  return waitForFixturePage(port, fixtureUrl, READY_TIMEOUT_MS, blankPage.id);
}

async function waitForFixtureDom(send) {
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const evaluation = await send("Runtime.evaluate", {
      expression: `document.readyState === "complete" &&
        Boolean(document.querySelector("#keyboard")) &&
        Boolean(document.querySelector("#mouse")) &&
        Boolean(document.querySelector("#file"))`,
      returnByValue: true
    });
    if (runtimeValue(evaluation, "fixture readiness evaluation") === true) return;
    await sleep(100);
  }
  throw new Error("loopback fixture DOM did not become ready");
}

async function queryNode(send, rootNodeId, selector) {
  const result = await send("DOM.querySelector", { nodeId: rootNodeId, selector });
  if (!Number.isSafeInteger(result?.nodeId) || result.nodeId <= 0) {
    throw new Error(`DOM.querySelector did not find ${selector}`);
  }
  return result.nodeId;
}

function centerOfQuad(quad) {
  if (!Array.isArray(quad) || quad.length !== 8 || quad.some((value) => !Number.isFinite(value))) {
    throw new Error("DOM.getBoxModel did not return a usable mouse target");
  }
  return {
    x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
    y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4
  };
}

function runtimeValue(evaluation, label) {
  if (evaluation?.exceptionDetails) throw new Error(`${label} raised a JavaScript exception`);
  if (!evaluation?.result || !("value" in evaluation.result)) {
    throw new Error(`${label} did not return a value`);
  }
  return evaluation.result.value;
}

export async function withCdpSession(socketUrl, callback) {
  const socket = new WebSocket(socketUrl);
  const listeners = new Set();
  const pending = new Set();
  try {
    await waitForSocketOpen(socket);
    socket.on("message", data => {
      let event;
      try { event = JSON.parse(data.toString()); } catch { return; }
      if (typeof event?.method !== "string" || event.id !== undefined) return;
      for (const listener of listeners) listener(event);
    });
    const subscribe = listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    let requestId = 0;
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++requestId;
      let finished = false;
      const finish = (error, value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        pending.delete(cancel);
        socket.removeListener("message", onMessage);
        socket.removeListener("error", onError);
        socket.removeListener("close", onClose);
        if (error) reject(error);
        else resolve(value);
      };
      const onMessage = (data) => {
        let reply;
        try {
          reply = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (reply.id !== id) return;
        finish(reply.error ? new Error(reply.error.message ?? `${method} failed`) : undefined, reply.result);
      };
      const onError = (error) => finish(error);
      const onClose = () => finish(new Error(`${method} socket closed before a reply`));
      const cancel = () => finish(new Error("CDP session closed before a reply"));
      const timer = setTimeout(() => finish(Object.assign(new Error(`${method} timed out`), { code: "CDP_TIMEOUT" })), REQUEST_TIMEOUT_MS);
      pending.add(cancel);
      socket.on("message", onMessage);
      socket.once("error", onError);
      socket.once("close", onClose);
      try {
        socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return await callback(send, subscribe);
  } finally {
    for (const cancel of [...pending]) cancel();
    listeners.clear();
    socket.removeAllListeners();
    socket.on("error", () => {});
    socket.terminate();
  }
}

function waitForSocketOpen(socket) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.removeListener("open", onOpen);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
      if (error) reject(error);
      else resolve();
    };
    const onOpen = () => finish();
    const onError = (error) => finish(error);
    const onClose = () => finish(new Error("CDP socket closed before opening"));
    const timer = setTimeout(() => finish(new Error("CDP socket open timed out")), REQUEST_TIMEOUT_MS);
    socket.once("open", onOpen);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
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
  try {
    // Children can outlive the main process. Reinspect each recorded PID before
    // signaling, and never act on a successor browser or an unrelated reused PID.
    for (const pid of [...ownedProcessIds].reverse()) {
      const verified = findOwnedBrowserCleanupProcesses(inspectBrowserProcesses(), {
        port, profileDir, launchedProcessId: launchProcessId, knownProcessIds: ownedProcessIds
      });
      if (!verified.some((processInfo) => processInfo.processId === pid)) continue;
      try { process.kill(pid, "SIGTERM"); } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
  } catch {
    return false;
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
