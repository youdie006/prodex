import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { openChatGptBrowser } from '/app/dist/chatgpt-browser.js';
import {
  assertLaunchedBrowserMainProcess,
  browserProcessFlagValue,
  browserProcessHasFlag,
  findMatchingBrowserProcesses,
  findOwnedBrowserCleanupProcesses,
  inspectBrowserProcesses
} from '/app/dist/browser-process.js';
import { withCdpSession } from '/app/scripts/browser-launch-smoke.mjs';
import {
  loadFinalRecord,
  loadReadyRecord,
  mergeCleanupReports,
  parseLoadHoldDurationMs,
  renderFixtureHtml,
  runCleanupSteps
} from './experiment-support.mjs';

const READY_TIMEOUT_MS = 20_000;
const EXIT_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 5_000;
const POLL_MS = 100;
const EXPECTED_CHROME = /^Chrome\/154\./;
const EXPECTED_EXECUTABLE = '/opt/prodex-cft154/chrome';
const EXPECTED_WRAPPER = '/opt/prodex-ozone/chrome';
const LOAD_ID = 'external-render-load';

const FORBIDDEN_BROWSER_FLAGS = Object.freeze([
  'headless',
  'no-sandbox',
  'disable-setuid-sandbox',
  'disable-web-security',
  'ignore-certificate-errors',
  'allow-insecure-localhost',
  'user-agent',
  'user-agent-product',
  'disable-gpu',
  'disable-software-rasterizer',
  'use-angle',
  'use-gl'
]);

await run().catch((error) => {
  console.log(JSON.stringify(loadFinalRecord({
    arch: process.arch,
    outcome: 'FAIL',
    phase: 'unhandled',
    stopReason: 'failure',
    readyEmitted: false,
    configuredDurationMs: null,
    heldMs: 0,
    finalEvidence: null,
    cleanup: { confirmed: false, errors: [] },
    resources: {},
    failure: { phase: 'unhandled', message: errorMessage(error) }
  })));
  process.exitCode = 1;
});

async function run() {
  let phase = 'configuration';
  let configuredDurationMs = null;
  let tempRoot;
  let fixture;
  let browser;
  let readyEmitted = false;
  let readyAt;
  let heldMs = 0;
  let finalEvidence = null;
  let stopReason = 'failure';
  let failure = null;
  let cleanup = { confirmed: true, errors: [] };
  const resources = {};
  const stop = createStopController();

  try {
    configuredDurationMs = parseLoadHoldDurationMs(process.env.PRODEX_LOAD_HOLD_SECONDS);
    assert.deepEqual(process.argv.slice(2), [], 'load holder does not accept command-line arguments');
    phase = 'admission';
    await assertOfflineAdmission();
    resources.before = await readCgroupResources();

    phase = 'profile:create';
    tempRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'prodex-ozone-load-')));
    const profileDir = path.join(tempRoot, 'ephemeral-profile');
    await mkdir(profileDir, { recursive: true, mode: 0o700 });

    phase = 'fixture:start';
    fixture = await startRenderFixtureServer();
    phase = 'browser:allocate-port';
    const port = await unusedLoopbackPort();
    phase = 'browser:launch';
    browser = launchOwnedBrowser({ port, profileDir });
    phase = 'browser:ready';
    const initialReady = await waitForOwnedBrowserReady(browser);

    phase = 'motion:verify';
    const motion = await navigateAndVerifyMotion(browser, fixture.url);
    const processCheck = verifyOwnedBrowserProcesses(browser);
    const version = await readCdpJson(browser.port, 'version');
    assert.match(version?.Browser ?? '', EXPECTED_CHROME, 'load browser changed after motion verification');
    assert.equal(stop.requested(), null, 'stop requested before readiness was established');
    resources.ready = await readCgroupResources();

    const readyRecord = loadReadyRecord({
      arch: process.arch,
      configuredDurationMs,
      browser: browserEvidence(browser, initialReady, processCheck, version),
      motion,
      resources: { before: resources.before, ready: resources.ready }
    });
    console.log(`READY ${JSON.stringify(readyRecord)}`);
    readyEmitted = true;
    readyAt = performance.now();

    phase = 'hold';
    stopReason = await stop.wait(configuredDurationMs);
    heldMs = Number((performance.now() - readyAt).toFixed(3));
    phase = 'post-hold:motion';
    const finalMotion = await verifyExistingMotion(browser, fixture.url);
    phase = 'post-hold:process';
    const finalProcessCheck = verifyOwnedBrowserProcesses(browser);
    const finalVersion = await readCdpJson(browser.port, 'version');
    const finalBrowser = browserEvidence(browser, initialReady, finalProcessCheck, finalVersion);
    resources.postHold = await readCgroupResources();
    finalEvidence = {
      motion: finalMotion,
      browser: finalBrowser,
      resources: resources.postHold
    };
    phase = 'complete';
  } catch (error) {
    failure = { phase, message: errorMessage(error) };
    stopReason = stop.requested() ?? 'failure';
  } finally {
    const browserCleanup = browser
      ? await runCleanupSteps([{ phase: 'cleanup:browser', run: () => closeOwnedBrowser(browser) }])
      : { confirmed: true, errors: [] };
    const fixtureCleanup = fixture
      ? await runCleanupSteps([{ phase: 'cleanup:fixture-server', run: async () => {
        assert.equal(await closeFixtureServer(fixture.server), true, 'fixture server did not close within 5 seconds');
      } }])
      : { confirmed: true, errors: [] };
    let profileCleanup = { confirmed: true, errors: [] };
    if (tempRoot && browserCleanup.confirmed) {
      profileCleanup = await runCleanupSteps([{
        phase: 'cleanup:temporary-root',
        run: () => rm(tempRoot, { recursive: true, force: true })
      }]);
    } else if (tempRoot) {
      profileCleanup = {
        confirmed: false,
        errors: [{
          phase: 'cleanup:temporary-root',
          message: 'not removed because browser cleanup was unconfirmed'
        }]
      };
    }
    cleanup = mergeCleanupReports([browserCleanup, fixtureCleanup, profileCleanup]);
    resources.after = await readCgroupResources();
    stop.dispose();
  }

  const outcome = failure || !cleanup.confirmed ? 'FAIL' : 'PASS';
  const finalPhase = outcome === 'PASS' ? 'complete' : failure?.phase ?? 'cleanup';
  console.log(JSON.stringify(loadFinalRecord({
    arch: process.arch,
    outcome,
    phase: finalPhase,
    stopReason,
    readyEmitted,
    configuredDurationMs,
    heldMs,
    finalEvidence,
    cleanup,
    resources,
    failure
  })));
  if (outcome !== 'PASS') process.exitCode = 1;
}

async function assertOfflineAdmission() {
  assert.equal(process.platform, 'linux', 'load holder refuses non-Linux hosts');
  assert.equal(process.getuid?.(), 1000, 'load holder requires UID 1000');

  const addresses = Object.entries(networkInterfaces()).flatMap(([name, values]) =>
    (values ?? []).map((value) => ({ name, ...value })));
  assert.ok(addresses.length > 0, 'network namespace did not expose a loopback interface');
  assert.deepEqual(addresses.filter((address) => address.internal !== true), [],
    'load holder refuses a namespace with non-internal network interfaces');

  assert.equal(process.env.PRODEX_CHROME, EXPECTED_WRAPPER,
    'PRODEX_CHROME must select the checked ozone wrapper');
  const wrapper = await readFile(EXPECTED_WRAPPER, 'utf8');
  assert.match(wrapper, /--ozone-platform=headless(?:\s|$)/,
    'ozone wrapper must select the headless platform');
  assert.doesNotMatch(wrapper, /--headless(?:=|\s|$)/,
    'ozone wrapper must not add a browser headless switch');
  assert.doesNotMatch(wrapper, /--no-sandbox(?:=|\s|$)/,
    'ozone wrapper must preserve the browser sandbox');
  assert.doesNotMatch(wrapper,
    /--(?:disable-gpu|disable-software-rasterizer|use-angle|use-gl|user-agent|disable-web-security)(?:=|\s|$)/,
    'ozone wrapper must not add graphics, identity, or security experiment flags');
}

function launchOwnedBrowser({ port, profileDir }) {
  assert.equal(findMatchingBrowserProcesses(inspectBrowserProcesses(), { port, profileDir }).length, 0,
    'load profile or port was already owned by a browser');
  const launch = openChatGptBrowser({ port, profileDir, headless: false, url: 'about:blank' });
  assert.ok(Number.isSafeInteger(launch.processId) && launch.processId > 0,
    'load launch did not return a PID');
  assert.equal(launch.port, port, 'load launch changed the requested port');
  assert.equal(launch.profileDir, profileDir, 'load launch changed the requested profile');
  assert.equal(launch.command, EXPECTED_WRAPPER, 'load launch did not use the ozone wrapper');
  assert.equal(launch.args.some((argument) => argument === '--headless' || argument.startsWith('--headless=')), false,
    'load launch unexpectedly requested browser headless mode');
  return {
    role: 'external-render-load',
    port,
    profileDir,
    launch,
    browserSocket: undefined,
    ownershipVerified: false,
    ownedProcessIds: new Set([launch.processId])
  };
}

async function waitForOwnedBrowserReady(browser) {
  assert.equal(await realpath(browser.launch.profileDir), await realpath(browser.profileDir));
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    const earlyExit = await browser.launch.waitForEarlyExit(0);
    if (earlyExit) throw new Error(`load browser exited before readiness: ${JSON.stringify(earlyExit)}`);
    try {
      const processCheck = verifyOwnedBrowserProcesses(browser);
      const version = await readCdpJson(browser.port, 'version');
      assert.match(version?.Browser ?? '', EXPECTED_CHROME, 'load browser is not stock Chrome 154');
      browser.browserSocket = localCdpSocket(version.webSocketDebuggerUrl, browser.port, 'browser');
      browser.ownershipVerified = true;
      return { processCheck, version };
    } catch (error) {
      lastError = error;
      await sleep(POLL_MS);
    }
  }
  throw new Error(`load browser readiness timed out after 20 seconds: ${errorMessage(lastError)}`);
}

function verifyOwnedBrowserProcesses(browser) {
  const matching = findMatchingBrowserProcesses(inspectBrowserProcesses(), {
    port: browser.port,
    profileDir: browser.profileDir
  });
  const main = assertLaunchedBrowserMainProcess(matching, browser.launch.processId);
  for (const processInfo of matching) browser.ownedProcessIds.add(processInfo.processId);
  assertBrowserMode(main, browser.port, browser.profileDir);
  return { main, matching };
}

function assertBrowserMode(main, port, profileDir) {
  assert.equal(main.executablePath, EXPECTED_EXECUTABLE,
    'load browser did not use the stock Chrome 154 executable');
  assert.equal(browserProcessFlagValue(main, 'remote-debugging-port'), String(port),
    'load browser did not retain its dedicated CDP port');
  assert.equal(browserProcessFlagValue(main, 'user-data-dir'), profileDir,
    'load browser did not retain its ephemeral profile');
  assert.equal(browserProcessFlagValue(main, 'ozone-platform'), 'headless',
    'load browser did not use ozone=headless');
  for (const flag of FORBIDDEN_BROWSER_FLAGS) {
    assert.equal(browserProcessHasFlag(main, flag), false, `load browser used forbidden --${flag}`);
  }
}

function browserEvidence(browser, initialReady, processCheck, version) {
  assert.equal(initialReady.version.Browser, version.Browser, 'browser version changed before READY');
  assert.equal(initialReady.version['Protocol-Version'], version['Protocol-Version'],
    'browser protocol changed before READY');
  return {
    role: browser.role,
    mainPid: processCheck.main.processId,
    processCount: processCheck.matching.length,
    port: browser.port,
    profileDir: browser.profileDir,
    profileKind: 'ephemeral-disposable',
    profilePortOwnershipVerified: browser.ownershipVerified,
    executable: processCheck.main.executablePath,
    browser: version.Browser,
    protocolVersion: version['Protocol-Version'],
    ozonePlatform: browserProcessFlagValue(processCheck.main, 'ozone-platform'),
    browserHeadlessSwitch: browserProcessHasFlag(processCheck.main, 'headless'),
    noSandboxSwitch: browserProcessHasFlag(processCheck.main, 'no-sandbox')
  };
}

async function navigateAndVerifyMotion(browser, fixtureBaseUrl) {
  const expectedUrl = `${fixtureBaseUrl}/load/${LOAD_ID}`;
  const blank = await waitForPage(browser.port, 'about:blank', undefined, READY_TIMEOUT_MS);
  assert.ok(typeof blank.id === 'string' && blank.id.length > 0, 'load blank target ID was missing');
  await withCdpSession(localCdpSocket(blank.webSocketDebuggerUrl, browser.port, 'page'), async (send) => {
    await send('Page.enable');
    const navigation = await send('Page.navigate', { url: expectedUrl });
    if (navigation?.errorText) throw new Error(`local render navigation failed: ${navigation.errorText}`);
  });

  const page = await waitForPage(browser.port, expectedUrl, blank.id, READY_TIMEOUT_MS);
  return withCdpSession(localCdpSocket(page.webSocketDebuggerUrl, browser.port, 'page'), async (send) => {
    await send('Runtime.enable');
    await waitForRuntimeCondition(send,
      'document.readyState === "complete" && Boolean(window.__renderReady) && Boolean(window.__renderLoadState)');
    const rendered = await send('Runtime.evaluate', {
      expression: 'window.__renderReady',
      awaitPromise: true,
      returnByValue: true
    });
    assert.equal(runtimeValue(rendered, 'render readiness')?.ready, true, 'render fixture did not reach readiness');
    return measureMotion(send);
  });
}

async function verifyExistingMotion(browser, fixtureBaseUrl) {
  const expectedUrl = `${fixtureBaseUrl}/load/${LOAD_ID}`;
  const page = await waitForPage(browser.port, expectedUrl, undefined, READY_TIMEOUT_MS);
  return withCdpSession(localCdpSocket(page.webSocketDebuggerUrl, browser.port, 'page'), async (send) => {
    await send('Runtime.enable');
    await waitForRuntimeCondition(send,
      'document.readyState === "complete" && Boolean(window.__renderLoadState)');
    return measureMotion(send);
  });
}

async function measureMotion(send) {
  const first = await readMotionSnapshot(send);
  await sleep(250);
  const second = await readMotionSnapshot(send);
  assert.ok(second.frames > first.frames, 'render frame count did not advance');
  assert.ok(second.lastFrameTimeMs > first.lastFrameTimeMs, 'render frame time did not advance');
  return {
    first,
    second,
    frameDelta: second.frames - first.frames,
    frameTimeDeltaMs: Number((second.lastFrameTimeMs - first.lastFrameTimeMs).toFixed(3))
  };
}

async function readMotionSnapshot(send) {
  const evaluation = await send('Runtime.evaluate', {
    expression: `(() => {
      const state=window.__renderLoadState;const canvas=document.querySelector('#load');
      return {loadId:state?.loadId,frames:state?.frames,lastFrameTimeMs:state?.lastFrameTimeMs,
        canvasConnected:Boolean(canvas?.isConnected),width:canvas?.width,height:canvas?.height,
        visibility:document.visibilityState};
    })()`,
    returnByValue: true
  });
  const snapshot = runtimeValue(evaluation, 'render motion snapshot');
  assert.equal(snapshot?.loadId, LOAD_ID, 'render fixture identity changed');
  assert.ok(Number.isSafeInteger(snapshot.frames) && snapshot.frames >= 3, 'render frame count was invalid');
  assert.ok(Number.isFinite(snapshot.lastFrameTimeMs), 'render frame time was invalid');
  assert.equal(snapshot.canvasConnected, true, 'render canvas was detached');
  assert.equal(snapshot.width, 1440, 'render canvas width changed');
  assert.equal(snapshot.height, 900, 'render canvas height changed');
  return snapshot;
}

async function startRenderFixtureServer() {
  const server = createHttpServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method !== 'GET' || requestUrl.pathname !== `/load/${LOAD_ID}`) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      response.end('not found\n');
      return;
    }
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
      'content-type': 'text/html; charset=utf-8'
    });
    response.end(renderFixtureHtml(LOAD_ID));
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = 1_000;
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('render fixture did not bind a loopback port');
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function closeFixtureServer(server) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (closed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(closed);
    };
    const timer = setTimeout(() => finish(false), REQUEST_TIMEOUT_MS);
    server.close((error) => finish(!error));
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
  });
}

async function closeOwnedBrowser(browser) {
  const deadline = Date.now() + EXIT_TIMEOUT_MS;
  refreshOwnedProcessIds(browser);
  if (browser.browserSocket && browser.ownershipVerified) {
    try {
      await withCdpSession(browser.browserSocket, (send) => send('Browser.close'));
    } catch {
      // Browser.close can close its websocket before the command reply arrives.
    }
  }
  if (await waitForOwnedBrowserExit(browser, Math.min(deadline, Date.now() + 7_000))) return;
  signalVerifiedOwnedProcesses(browser, 'SIGTERM');
  if (await waitForOwnedBrowserExit(browser, Math.min(deadline, Date.now() + 8_000))) return;
  signalVerifiedOwnedProcesses(browser, 'SIGKILL');
  if (await waitForOwnedBrowserExit(browser, deadline)) return;
  throw new Error('load browser owned processes did not exit within 20 seconds');
}

function refreshOwnedProcessIds(browser) {
  const matching = findMatchingBrowserProcesses(inspectBrowserProcesses(), {
    port: browser.port,
    profileDir: browser.profileDir
  });
  if (matching.length > 0) {
    assertLaunchedBrowserMainProcess(matching, browser.launch.processId);
    for (const processInfo of matching) browser.ownedProcessIds.add(processInfo.processId);
    browser.ownershipVerified = true;
  }
}

function signalVerifiedOwnedProcesses(browser, signal) {
  const verified = findOwnedBrowserCleanupProcesses(inspectBrowserProcesses(), {
    port: browser.port,
    profileDir: browser.profileDir,
    launchedProcessId: browser.launch.processId,
    knownProcessIds: browser.ownedProcessIds
  });
  for (const processInfo of [...verified].reverse()) {
    try {
      process.kill(processInfo.processId, signal);
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
}

async function waitForOwnedBrowserExit(browser, deadline) {
  while (Date.now() < deadline) {
    try {
      const matching = findMatchingBrowserProcesses(inspectBrowserProcesses(), {
        port: browser.port,
        profileDir: browser.profileDir
      });
      for (const processInfo of matching) browser.ownedProcessIds.add(processInfo.processId);
      const anyPidAlive = [...browser.ownedProcessIds].some(processIsAlive);
      if (matching.length === 0 && !anyPidAlive && !(await cdpReachable(browser.port))) return true;
    } catch {
      // Keep checking until the bounded exit deadline.
    }
    await sleep(POLL_MS);
  }
  return false;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

async function cdpReachable(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(500)
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function unusedLoopbackPort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('could not allocate a loopback port');
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForPage(port, expectedUrl, expectedId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastCount = 0;
  let lastUrl;
  while (Date.now() < deadline) {
    const targets = await readCdpJson(port, 'list');
    assert.ok(Array.isArray(targets), 'CDP target list was not an array');
    const pages = targets.filter((target) => target?.type === 'page' &&
      (expectedId === undefined ? target.url === expectedUrl : target.id === expectedId));
    lastCount = pages.length;
    if (pages.length === 1) {
      lastUrl = pages[0].url;
      if (lastUrl === expectedUrl) return pages[0];
    }
    if (pages.length > 1) throw new Error(`expected one render page, found ${pages.length}`);
    await sleep(POLL_MS);
  }
  throw new Error(`render page readiness timed out after ${timeoutMs}ms (found ${lastCount}${lastUrl ? ` at ${lastUrl}` : ''})`);
}

async function waitForRuntimeCondition(send, expression) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const evaluation = await send('Runtime.evaluate', { expression, returnByValue: true });
      if (runtimeValue(evaluation, 'render fixture readiness') === true) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(POLL_MS);
  }
  throw new Error(`render fixture readiness timed out after 20 seconds: ${errorMessage(lastError)}`);
}

async function readCdpJson(port, resource) {
  assert.ok(Number.isSafeInteger(port) && port > 0 && port <= 65535, 'invalid local CDP port');
  assert.ok(resource === 'version' || resource === 'list', 'unsupported CDP metadata resource');
  const response = await fetch(`http://127.0.0.1:${port}/json/${resource}`, {
    signal: AbortSignal.timeout(1_000)
  });
  if (!response.ok) throw new Error(`CDP ${resource} returned HTTP ${response.status}`);
  return response.json();
}

function localCdpSocket(value, port, kind) {
  if (typeof value !== 'string') throw new Error(`CDP ${kind} socket is missing`);
  const url = new URL(value);
  if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      Number(url.port) !== port || url.username || url.password || !url.pathname.startsWith(`/devtools/${kind}/`)) {
    throw new Error(`CDP ${kind} socket is not the expected loopback endpoint`);
  }
  return value;
}

async function readCgroupResources() {
  const values = {};
  for (const name of ['pids.current', 'pids.max', 'pids.events', 'memory.current', 'memory.max', 'memory.events']) {
    try {
      values[name] = (await readFile(`/sys/fs/cgroup/${name}`, 'utf8')).trim();
    } catch (error) {
      values[name] = { unavailable: error?.code ?? 'read_failed' };
    }
  }
  return values;
}

function createStopController() {
  const signals = ['SIGINT', 'SIGTERM'];
  const handlers = new Map();
  let requestedSignal = null;
  let wake;
  for (const signal of signals) {
    const handler = () => {
      requestedSignal ??= signal;
      wake?.(requestedSignal);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return {
    requested: () => requestedSignal,
    wait(durationMs) {
      if (requestedSignal) return Promise.resolve(requestedSignal);
      return new Promise((resolve) => {
        let settled = false;
        const finish = (reason) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          wake = undefined;
          resolve(reason);
        };
        const timer = setTimeout(() => finish('duration'), durationMs);
        wake = finish;
      });
    },
    dispose() {
      for (const [signal, handler] of handlers) process.removeListener(signal, handler);
      wake = undefined;
    }
  };
}

function runtimeValue(evaluation, label) {
  if (evaluation?.exceptionDetails) throw new Error(`${label} raised a JavaScript exception`);
  if (!evaluation?.result || !('value' in evaluation.result)) throw new Error(`${label} did not return a value`);
  return evaluation.result.value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
