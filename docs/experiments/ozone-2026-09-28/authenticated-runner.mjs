import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const CDP_PORT = 9333;
const DEFAULT_HOLD_MS = 240_000;
const MAX_HOLD_SECONDS = 300;
const READY_TIMEOUT_MS = 20_000;
const CLEANUP_TIMEOUT_MS = 20_000;
const POLL_MS = 100;
const EXPECTED_WRAPPER = '/opt/prodex-ozone152/chrome';
const EXPECTED_EXECUTABLE = '/usr/lib/chromium/chromium';
const EXPECTED_WRAPPER_EXEC =
  'exec /usr/lib/chromium/chromium --ozone-platform=headless --window-size=1440,900 "$@"';
const SYSTEM_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

const SANDBOX_WEAKENING_FLAGS = Object.freeze([
  'no-sandbox',
  'disable-setuid-sandbox'
]);

const SECURITY_WEAKENING_FLAGS = Object.freeze([
  'allow-insecure-localhost',
  'allow-running-insecure-content',
  'disable-client-side-phishing-detection',
  'disable-features',
  'disable-site-isolation-trials',
  'disable-web-security',
  'ignore-certificate-errors',
  'ignore-urlfetcher-cert-requests',
  'remote-allow-origins',
  'single-process',
  'user-agent',
  'user-agent-product'
]);

const DISPLAY_PROCESS_NAMES = new Set([
  'X', 'Xdummy', 'Xorg', 'Xvfb', 'Xwayland',
  'cage', 'gamescope', 'gnome-shell', 'kwin_wayland', 'labwc',
  'mutter', 'sway', 'wayfire', 'wayvnc', 'weston', 'x11vnc'
]);

export function parseHoldDurationMs(value) {
  if (value === undefined) return DEFAULT_HOLD_MS;
  if (!/^(?:[1-9]|[1-9][0-9]|[12][0-9][0-9]|300)$/.test(value)) {
    throw new Error(`PRODEX_AUTH_TRIAL_HOLD_SECONDS must be an integer from 1 through ${MAX_HOLD_SECONDS}`);
  }
  return Number(value) * 1_000;
}

export function assertTrialEnvironment({ platform, uid, argv, env }) {
  assert.equal(platform, 'linux', 'authenticated trial requires Linux');
  assert.equal(uid, 1000, 'authenticated trial requires UID 1000');
  assert.deepEqual(argv, [], 'authenticated trial does not accept command-line arguments');
  assert.equal(env.HOME, '/home/node', 'authenticated trial requires HOME=/home/node');
  assert.equal(env.PRODEX_AUTH_TRIAL, '1', 'authenticated trial requires PRODEX_AUTH_TRIAL=1');
  for (const name of ['DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY']) {
    assert.equal(env[name], undefined, `authenticated trial requires ${name} to be unset`);
  }
  return {
    uid1000: true,
    homeVerified: true,
    optIn: true,
    displayEnvironmentClear: true
  };
}

export function isDirectEntrypoint(metaUrl, argv) {
  if (!Array.isArray(argv) || typeof argv[1] !== 'string') return false;
  return pathToFileURL(path.resolve(argv[1])).href === metaUrl;
}

export function validatePersistentProfileDirectory(profileStat) {
  assert.ok(profileStat && typeof profileStat.isDirectory === 'function' && profileStat.isDirectory(),
    'persistent profile directory is missing or is not a directory');
  return { profileDirectoryVerified: true };
}

export function buildLaunchPlan({ buildChromeLaunchArgs, defaultChatGptProfileDir, environment }) {
  const profileDir = defaultChatGptProfileDir();
  const args = buildChromeLaunchArgs({
    port: CDP_PORT,
    profileDir,
    url: 'about:blank',
    headless: false
  });
  const env = {
    HOME: '/home/node',
    PRODEX_AUTH_TRIAL: '1',
    PATH: SYSTEM_PATH
  };
  for (const name of ['LANG', 'LC_ALL', 'LC_CTYPE', 'TZ']) {
    if (typeof environment[name] === 'string' && environment[name].length > 0) env[name] = environment[name];
  }
  return { command: EXPECTED_WRAPPER, args, port: CDP_PORT, profileDir, env };
}

export function validateWrapperSource(source) {
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  assert.equal(lines.shift(), '#!/bin/sh', 'ozone wrapper must use the fixed /bin/sh interpreter');
  const commands = [];
  for (const line of lines) {
    if (line === '') continue;
    if (line.startsWith('#')) {
      assert.match(line, /^#[ A-Za-z0-9.,:;_/-]*$/, 'ozone wrapper contains an unsafe comment line');
      continue;
    }
    commands.push(line);
  }
  assert.deepEqual(commands, [EXPECTED_WRAPPER_EXEC],
    'ozone wrapper does not contain only the fixed Chromium 152 exec contract');
  return {
    wrapperVerified: true,
    executable: EXPECTED_EXECUTABLE,
    ozonePlatform: 'headless',
    windowSize: '1440,900'
  };
}

function commandLineFlagValue(processInfo, flag) {
  const escapedFlag = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wholeQuoted = new RegExp(`(?:^|\\s)"--${escapedFlag}=([^"]*)"(?=\\s|$)`, 'i')
    .exec(processInfo.commandLine);
  if (wholeQuoted) return wholeQuoted[1].trim();
  const match = new RegExp(
    `(?:^|\\s)--${escapedFlag}=(?:"([^"]*)"|'([^']*)'|(.+?))(?=\\s+"?--[A-Za-z0-9-]+(?:=|\\s|$)|\\s+about:blank(?:\\s|$)|\\s*$)`,
    'i'
  ).exec(processInfo.commandLine);
  return match ? (match[1] ?? match[2] ?? match[3])?.trim() : undefined;
}

function commandLineHasFlag(processInfo, flag) {
  const escapedFlag = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\s)(?:"--${escapedFlag}(?:=[^"]*)?"|--${escapedFlag})(?==|\\s|$)`, 'i')
    .test(processInfo.commandLine);
}

function normalizedAbsolute(value) {
  return path.posix.normalize(path.posix.resolve(value));
}

export function assertAdmissionSnapshot({
  processes,
  profileDir,
  port,
  portReachable,
  displaySockets,
  displayProcesses
}) {
  const portClaimed = processes.some((processInfo) =>
    commandLineFlagValue(processInfo, 'remote-debugging-port') === String(port));
  assert.equal(portReachable || portClaimed, false, 'dedicated CDP port is not empty');

  const expectedProfile = normalizedAbsolute(profileDir);
  const profileClaimed = processes.some((processInfo) => {
    const value = commandLineFlagValue(processInfo, 'user-data-dir');
    return value !== undefined && normalizedAbsolute(value) === expectedProfile;
  });
  assert.equal(profileClaimed, false, 'persistent target profile already has browser ownership');
  assert.deepEqual(displaySockets, [], 'X or Wayland display socket is present');
  assert.deepEqual(displayProcesses, [], 'X or Wayland display process is present');
  return {
    portEmpty: true,
    profileUnowned: true,
    displaySocketsAbsent: true,
    displayProcessesAbsent: true
  };
}

export function validateBrowserProcess(processInfo, expected, helpers = {}) {
  const flagValue = helpers.flagValue ?? commandLineFlagValue;
  const hasFlag = helpers.hasFlag ?? commandLineHasFlag;
  assert.equal(processInfo.processId, expected.launchedProcessId,
    'browser main PID does not match the wrapper process');
  assert.equal(processInfo.executablePath, EXPECTED_EXECUTABLE,
    'browser main executable is not stock Chromium');
  assert.equal(flagValue(processInfo, 'remote-debugging-port'), String(expected.port),
    'browser main process changed the dedicated CDP port');
  assert.equal(normalizedAbsolute(flagValue(processInfo, 'user-data-dir') ?? ''),
    normalizedAbsolute(expected.profileDir), 'browser main process changed the persistent profile');
  assert.equal(flagValue(processInfo, 'ozone-platform'), 'headless',
    'browser main process is not using ozone=headless');
  assert.equal(flagValue(processInfo, 'window-size'), '1440,900',
    'browser main process changed the fixed window size');
  assert.equal(hasFlag(processInfo, 'headless'), false,
    'browser main process used the browser headless switch');
  for (const flag of SANDBOX_WEAKENING_FLAGS) {
    assert.equal(hasFlag(processInfo, flag), false, `browser main process used forbidden --${flag}`);
  }
  for (const flag of SECURITY_WEAKENING_FLAGS) {
    assert.equal(hasFlag(processInfo, flag), false, `browser main process used forbidden --${flag}`);
  }
  assert.match(processInfo.commandLine, /(?:^|\s)--new-window(?:\s|$)/,
    'browser main process is not an ordinary new window launch');
  assert.match(processInfo.commandLine, /(?:^|\s)about:blank(?:\s|$)/,
    'browser main process did not start at about:blank');
  return {
    executableVerified: true,
    pidVerified: true,
    portVerified: true,
    profileVerified: true,
    ozoneHeadless: true,
    windowSizeVerified: true,
    browserHeadlessSwitchAbsent: true,
    sandboxWeakeningAbsent: true,
    securityWeakeningAbsent: true
  };
}

export function parseProcSecurityStatus(source) {
  const noNewPrivileges = /^NoNewPrivs:\s*1\s*$/m.test(source);
  const capabilities = /^CapEff:\s*([0-9a-fA-F]+)\s*$/m.exec(source)?.[1];
  const effectiveCapabilitiesEmpty = typeof capabilities === 'string' && /^0+$/.test(capabilities);
  assert.equal(noNewPrivileges, true, 'browser main process does not have NoNewPrivs=1');
  assert.equal(effectiveCapabilitiesEmpty, true, 'browser main process does not have CapEff=0');
  return { noNewPrivileges, effectiveCapabilitiesEmpty };
}

export function validateCdpVersion(version, port) {
  assert.match(version?.Browser ?? '', /^Chrome\/152\./, 'CDP browser is not Chrome 152');
  assert.equal(typeof version?.['Protocol-Version'], 'string', 'CDP protocol version is missing');
  assert.equal(typeof version?.webSocketDebuggerUrl, 'string', 'CDP browser websocket is missing');
  const socket = new URL(version.webSocketDebuggerUrl);
  assert.equal(socket.protocol, 'ws:', 'CDP browser websocket is not ws');
  assert.equal(socket.hostname, '127.0.0.1', 'CDP browser websocket is not loopback-only');
  assert.equal(Number(socket.port), port, 'CDP browser websocket changed the dedicated port');
  assert.equal(socket.username || socket.password, '', 'CDP browser websocket contains credentials');
  assert.match(socket.pathname, /^\/devtools\/browser\/[^/]+$/, 'CDP endpoint is not a browser websocket');
  return {
    chrome152: true,
    browser: version.Browser,
    protocolVersion: version['Protocol-Version'],
    localBrowserWebSocket: true,
    browserSocket: version.webSocketDebuggerUrl
  };
}

export function cleanupDecision({ browserExited, ownershipRevalidated, browserSocketLocal }) {
  if (browserExited) return 'already-exited';
  if (!ownershipRevalidated) return 'fail-ownership';
  if (!browserSocketLocal) return 'fail-socket';
  return 'browser-close';
}

export function readyRecord({ holdDurationMs, environment, wrapper, version, processSecurity, browserSecurity, admission }) {
  return {
    kind: 'auth-trial-ready',
    schemaVersion: 1,
    mode: 'ozone-headless',
    browser: version.browser,
    protocolVersion: version.protocolVersion,
    holdDurationMs,
    security: {
      uid1000: environment.uid1000,
      homeVerified: environment.homeVerified,
      authTrialOptIn: environment.optIn,
      displayEnvironmentClear: environment.displayEnvironmentClear,
      wrapperVerified: wrapper.wrapperVerified,
      chrome152: version.chrome152,
      executableVerified: browserSecurity.executableVerified,
      launchPidVerified: browserSecurity.pidVerified,
      cdpPortVerified: browserSecurity.portVerified,
      targetProfileVerified: browserSecurity.profileVerified,
      ozoneHeadless: browserSecurity.ozoneHeadless,
      windowSizeVerified: browserSecurity.windowSizeVerified,
      persistentProfileDirectoryVerified: admission.profileDirectoryVerified,
      noNewPrivileges: processSecurity.noNewPrivileges,
      effectiveCapabilitiesEmpty: processSecurity.effectiveCapabilitiesEmpty,
      browserHeadlessSwitchAbsent: browserSecurity.browserHeadlessSwitchAbsent,
      sandboxWeakeningAbsent: browserSecurity.sandboxWeakeningAbsent,
      securityWeakeningAbsent: browserSecurity.securityWeakeningAbsent,
      portInitiallyEmpty: admission.portEmpty,
      profileInitiallyUnowned: admission.profileUnowned,
      displaySocketsAbsent: admission.displaySocketsAbsent,
      displayProcessesAbsent: admission.displayProcessesAbsent,
      localBrowserWebSocket: true
    },
    navigation: 'not-performed',
    authenticationData: 'not-read'
  };
}

export function finalRecord({
  outcome,
  stopReason,
  heldMs,
  cleanupConfirmed,
  cleanupMethod = 'Browser.close',
  failure
}) {
  return {
    kind: 'auth-trial-final',
    schemaVersion: 1,
    outcome,
    stopReason,
    heldMs,
    cleanup: {
      confirmed: cleanupConfirmed,
      method: cleanupMethod,
      persistentProfilePreserved: true
    },
    failure
  };
}

async function loadRuntimeDependencies() {
  const [chatGptBrowser, browserProcess, browserSmoke] = await Promise.all([
    import('/app/dist/chatgpt-browser.js'),
    import('/app/dist/browser-process.js'),
    import('/app/scripts/browser-launch-smoke.mjs')
  ]);
  return {
    buildChromeLaunchArgs: chatGptBrowser.buildChromeLaunchArgs,
    defaultChatGptProfileDir: chatGptBrowser.defaultChatGptProfileDir,
    assertLaunchedBrowserMainProcess: browserProcess.assertLaunchedBrowserMainProcess,
    browserProcessFlagValue: browserProcess.browserProcessFlagValue,
    browserProcessHasFlag: browserProcess.browserProcessHasFlag,
    findMatchingBrowserProcesses: browserProcess.findMatchingBrowserProcesses,
    inspectBrowserProcesses: browserProcess.inspectBrowserProcesses,
    withCdpSession: browserSmoke.withCdpSession
  };
}

async function detectDisplaySockets(uid, environment) {
  const locations = [
    { directory: '/tmp/.X11-unix', pattern: /^X\d+$/ },
    { directory: `/run/user/${uid}`, pattern: /^wayland-\d+(?:\.lock)?$/ }
  ];
  if (typeof environment.XDG_RUNTIME_DIR === 'string' && path.isAbsolute(environment.XDG_RUNTIME_DIR) &&
      !locations.some((item) => item.directory === environment.XDG_RUNTIME_DIR)) {
    locations.push({ directory: environment.XDG_RUNTIME_DIR, pattern: /^wayland-\d+(?:\.lock)?$/ });
  }
  const found = [];
  for (const { directory, pattern } of locations) {
    try {
      for (const name of await readdir(directory)) {
        if (pattern.test(name)) found.push(path.join(directory, name));
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return found;
}

async function detectDisplayProcesses() {
  const found = [];
  for (const entry of await readdir('/proc', { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try {
      const name = (await readFile(`/proc/${entry.name}/comm`, 'utf8')).trim();
      if (DISPLAY_PROCESS_NAMES.has(name)) found.push({ pid: Number(entry.name), name });
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'EPERM'].includes(error?.code)) throw error;
    }
  }
  return found;
}

async function loopbackPortOccupied(port) {
  const server = createNetServer();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, occupied) => {
      if (settled) return;
      settled = true;
      server.removeAllListeners();
      if (error) reject(error);
      else resolve(occupied);
    };
    server.once('error', (error) => {
      if (error?.code === 'EADDRINUSE') finish(undefined, true);
      else finish(error);
    });
    server.once('listening', () => {
      server.close((error) => finish(error, false));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function captureAdmission(dependencies, plan) {
  const [portReachable, displaySockets, displayProcesses, profileStat] = await Promise.all([
    loopbackPortOccupied(plan.port),
    detectDisplaySockets(process.getuid(), process.env),
    detectDisplayProcesses(),
    stat(plan.profileDir)
  ]);
  return {
    ...validatePersistentProfileDirectory(profileStat),
    ...assertAdmissionSnapshot({
      processes: dependencies.inspectBrowserProcesses(),
      profileDir: plan.profileDir,
      port: plan.port,
      portReachable,
      displaySockets,
      displayProcesses
    })
  };
}

async function assertDisplayIsolation() {
  const [displaySockets, displayProcesses] = await Promise.all([
    detectDisplaySockets(process.getuid(), process.env),
    detectDisplayProcesses()
  ]);
  assert.deepEqual(displaySockets, [], 'X or Wayland display socket appeared during the trial');
  assert.deepEqual(displayProcesses, [], 'X or Wayland display process appeared during the trial');
}

function currentOwnedIdentity(browser, dependencies) {
  const matching = dependencies.findMatchingBrowserProcesses(dependencies.inspectBrowserProcesses(), {
    port: browser.port,
    profileDir: browser.profileDir
  });
  const main = dependencies.assertLaunchedBrowserMainProcess(matching, browser.child.pid);
  for (const processInfo of matching) browser.ownedProcessIds.add(processInfo.processId);
  const security = validateBrowserProcess(main, {
    launchedProcessId: browser.child.pid,
    port: browser.port,
    profileDir: browser.profileDir
  }, {
    flagValue: dependencies.browserProcessFlagValue,
    hasFlag: dependencies.browserProcessHasFlag
  });
  return { main, matching, security };
}

async function readCdpVersion(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(1_000)
  });
  if (!response.ok) throw new Error(`CDP version returned HTTP ${response.status}`);
  return response.json();
}

function createChildWatch(child) {
  let result = null;
  let resolveExit;
  const promise = new Promise((resolve) => { resolveExit = resolve; });
  const finish = (value) => {
    if (result) return;
    result = value;
    resolveExit(value);
  };
  child.once('error', (error) => finish({ error: error.message }));
  child.once('exit', (code, signal) => finish({ code, signal }));
  return { promise, current: () => result };
}

async function waitForBrowserReady(browser, dependencies, stop) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    if (stop.requested()) throw new Error(`${stop.requested()} requested before trial readiness`);
    const earlyExit = browser.watch.current();
    if (earlyExit) throw new Error(`browser exited before trial readiness: ${JSON.stringify(earlyExit)}`);
    try {
      const processes = dependencies.inspectBrowserProcesses();
      const launched = processes.find((processInfo) => processInfo.processId === browser.child.pid);
      if (launched) {
        validateBrowserProcess(launched, {
          launchedProcessId: browser.child.pid,
          port: browser.port,
          profileDir: browser.profileDir
        }, {
          flagValue: dependencies.browserProcessFlagValue,
          hasFlag: dependencies.browserProcessHasFlag
        });
      }
      const identity = currentOwnedIdentity(browser, dependencies);
      const procStatus = await readFile(`/proc/${identity.main.processId}/status`, 'utf8');
      const processSecurity = parseProcSecurityStatus(procStatus);
      const revalidated = currentOwnedIdentity(browser, dependencies);
      assert.equal(revalidated.main.processId, identity.main.processId,
        'browser identity changed while reading process security');
      await assertDisplayIsolation();
      const version = validateCdpVersion(await readCdpVersion(browser.port), browser.port);
      browser.browserSocket = version.browserSocket;
      browser.ownershipVerified = true;
      return { version, processSecurity, browserSecurity: revalidated.security };
    } catch (error) {
      lastError = error;
      if (error instanceof assert.AssertionError) throw error;
      await sleep(POLL_MS);
    }
  }
  throw new Error(`authenticated browser readiness timed out: ${errorMessage(lastError)}`);
}

function createStopController() {
  let requestedSignal = null;
  let resolveSignal;
  const promise = new Promise((resolve) => { resolveSignal = resolve; });
  const handlers = new Map();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => {
      if (requestedSignal) return;
      requestedSignal = signal;
      resolveSignal({ kind: 'stop', reason: signal });
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  return {
    promise,
    requested: () => requestedSignal,
    dispose() {
      for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    }
  };
}

async function waitForHold(browser, stop, durationMs) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'stop', reason: 'deadline' }), durationMs);
  });
  try {
    return await Promise.race([
      deadline,
      stop.promise,
      browser.watch.promise.then((exit) => ({ kind: 'browser-exit', exit }))
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

async function waitForOwnedBrowserExit(browser, dependencies, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const matching = dependencies.findMatchingBrowserProcesses(dependencies.inspectBrowserProcesses(), {
        port: browser.port,
        profileDir: browser.profileDir
      });
      for (const processInfo of matching) browser.ownedProcessIds.add(processInfo.processId);
      const ownedAlive = [...browser.ownedProcessIds].some(processIsAlive);
      if (matching.length === 0 && !ownedAlive && !(await loopbackPortOccupied(browser.port))) return true;
    } catch {
      // Recheck until the bounded cleanup deadline; uncertainty is not success.
    }
    await sleep(POLL_MS);
  }
  return false;
}

async function closeOwnedBrowser(browser, dependencies) {
  if (await waitForOwnedBrowserExit(browser, dependencies, 250)) {
    return { confirmed: true, method: 'already-exited' };
  }

  let identity;
  try {
    identity = currentOwnedIdentity(browser, dependencies);
  } catch (error) {
    if (await waitForOwnedBrowserExit(browser, dependencies, CLEANUP_TIMEOUT_MS)) {
      return { confirmed: true, method: 'already-exited' };
    }
    return { confirmed: false, method: 'ownership-not-revalidated', error: errorMessage(error) };
  }
  let version;
  try {
    version = validateCdpVersion(await readCdpVersion(browser.port), browser.port);
  } catch (error) {
    if (await waitForOwnedBrowserExit(browser, dependencies, CLEANUP_TIMEOUT_MS)) {
      return { confirmed: true, method: 'already-exited' };
    }
    return { confirmed: false, method: 'browser-socket-not-revalidated', error: errorMessage(error) };
  }
  try {
    identity = currentOwnedIdentity(browser, dependencies);
  } catch (error) {
    if (await waitForOwnedBrowserExit(browser, dependencies, CLEANUP_TIMEOUT_MS)) {
      return { confirmed: true, method: 'already-exited' };
    }
    return { confirmed: false, method: 'ownership-not-revalidated', error: errorMessage(error) };
  }
  const action = cleanupDecision({
    browserExited: false,
    ownershipRevalidated: identity.main.processId === browser.child.pid,
    browserSocketLocal: version.localBrowserWebSocket
  });
  if (action !== 'browser-close') {
    return { confirmed: false, method: action, error: 'safe Browser.close preconditions were not met' };
  }

  let closeError;
  try {
    await dependencies.withCdpSession(version.browserSocket, (send) => send('Browser.close'));
  } catch (error) {
    closeError = error;
  }
  if (await waitForOwnedBrowserExit(browser, dependencies, CLEANUP_TIMEOUT_MS)) {
    return { confirmed: true, method: 'Browser.close' };
  }
  return {
    confirmed: false,
    method: 'Browser.close',
    error: closeError ? errorMessage(closeError) : 'owned browser did not exit before the cleanup deadline'
  };
}

async function runAuthenticatedTrial() {
  let phase = 'configuration';
  let holdDurationMs = null;
  let heldMs = 0;
  let readyAt;
  let readyEmitted = false;
  let stopReason = 'failure';
  let failure = null;
  let cleanup = { confirmed: true, method: 'not-started' };
  let browser;
  const stop = createStopController();

  try {
    holdDurationMs = parseHoldDurationMs(process.env.PRODEX_AUTH_TRIAL_HOLD_SECONDS);
    const environment = assertTrialEnvironment({
      platform: process.platform,
      uid: process.getuid?.(),
      argv: process.argv.slice(2),
      env: process.env
    });

    phase = 'dependencies';
    const dependencies = await loadRuntimeDependencies();
    phase = 'wrapper';
    await access(EXPECTED_WRAPPER, constants.R_OK | constants.X_OK);
    const wrapper = validateWrapperSource(await readFile(EXPECTED_WRAPPER, 'utf8'));
    const plan = buildLaunchPlan({
      buildChromeLaunchArgs: dependencies.buildChromeLaunchArgs,
      defaultChatGptProfileDir: dependencies.defaultChatGptProfileDir,
      environment: process.env
    });

    phase = 'admission';
    const admission = await captureAdmission(dependencies, plan);
    await captureAdmission(dependencies, plan);
    if (stop.requested()) throw new Error(`${stop.requested()} requested before browser launch`);

    phase = 'browser-launch';
    const child = spawn(plan.command, plan.args, { env: plan.env, stdio: 'ignore' });
    const watch = createChildWatch(child);
    child.unref();
    assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0, 'browser launch did not return a PID');
    browser = {
      child,
      watch,
      port: plan.port,
      profileDir: plan.profileDir,
      browserSocket: undefined,
      ownershipVerified: false,
      ownedProcessIds: new Set([child.pid])
    };

    phase = 'browser-ready';
    const verified = await waitForBrowserReady(browser, dependencies, stop);
    const record = readyRecord({
      holdDurationMs,
      environment,
      wrapper,
      version: verified.version,
      processSecurity: verified.processSecurity,
      browserSecurity: verified.browserSecurity,
      admission
    });
    console.log(JSON.stringify(record));
    readyEmitted = true;
    readyAt = performance.now();

    phase = 'hold';
    const result = await waitForHold(browser, stop, holdDurationMs);
    heldMs = Number((performance.now() - readyAt).toFixed(3));
    if (result.kind === 'browser-exit') {
      stopReason = 'browser-exit';
      throw new Error(`owned browser exited during hold: ${JSON.stringify(result.exit)}`);
    }
    stopReason = result.reason;
    phase = 'complete';
  } catch (error) {
    failure = { phase, message: errorMessage(error) };
    stopReason = stop.requested() ?? stopReason;
  } finally {
    phase = 'cleanup';
    if (browser) {
      try {
        const dependencies = await loadRuntimeDependencies();
        cleanup = await closeOwnedBrowser(browser, dependencies);
      } catch (error) {
        cleanup = { confirmed: false, method: 'Browser.close', error: errorMessage(error) };
      }
    }
    stop.dispose();
  }

  if (readyEmitted && stopReason === 'failure') stopReason = 'runner-failure';
  const outcome = failure || !cleanup.confirmed ? 'FAIL' : 'PASS';
  if (!failure && !cleanup.confirmed) {
    failure = { phase: 'cleanup', message: cleanup.error ?? 'browser cleanup was not confirmed' };
  }
  console.log(JSON.stringify(finalRecord({
    outcome,
    stopReason,
    heldMs,
    cleanupConfirmed: cleanup.confirmed,
    cleanupMethod: cleanup.method,
    failure
  })));
  if (outcome !== 'PASS') process.exitCode = 1;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error ?? 'unknown error');
}

if (isDirectEntrypoint(import.meta.url, process.argv)) {
  await runAuthenticatedTrial();
}
