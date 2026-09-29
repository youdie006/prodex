import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

import {
  assertAdmissionSnapshot,
  assertTrialEnvironment,
  buildLaunchPlan,
  cleanupDecision,
  finalRecord,
  isDirectEntrypoint,
  parseHoldDurationMs,
  parseProcSecurityStatus,
  readyRecord,
  validatePersistentProfileDirectory,
  validateBrowserProcess,
  validateCdpVersion,
  validateWrapperSource
} from './authenticated-runner.mjs';

const PROFILE = '/home/node/.local/share/prodex/chrome-chatgpt-pro';

test('hold duration defaults to 240 seconds and remains bounded at 300 seconds', () => {
  assert.equal(parseHoldDurationMs(undefined), 240_000);
  assert.equal(parseHoldDurationMs('1'), 1_000);
  assert.equal(parseHoldDurationMs('300'), 300_000);

  for (const value of ['', '0', '-1', '1.5', '301', 'Infinity', ' 240', '0240']) {
    assert.throws(() => parseHoldDurationMs(value), /PRODEX_AUTH_TRIAL_HOLD_SECONDS/);
  }
});

test('trial environment requires the explicit opt-in and display-free UID 1000 container', () => {
  const valid = {
    platform: 'linux',
    uid: 1000,
    argv: [],
    env: { HOME: '/home/node', PRODEX_AUTH_TRIAL: '1' }
  };
  assert.deepEqual(assertTrialEnvironment(valid), {
    uid1000: true,
    homeVerified: true,
    optIn: true,
    displayEnvironmentClear: true
  });

  for (const patch of [
    { platform: 'darwin' },
    { uid: 0 },
    { argv: ['--force'] },
    { env: { HOME: '/root', PRODEX_AUTH_TRIAL: '1' } },
    { env: { HOME: '/home/node' } },
    { env: { HOME: '/home/node', PRODEX_AUTH_TRIAL: 'true' } },
    { env: { HOME: '/home/node', PRODEX_AUTH_TRIAL: '1', DISPLAY: ':0' } },
    { env: { HOME: '/home/node', PRODEX_AUTH_TRIAL: '1', XAUTHORITY: '/tmp/xauth' } },
    { env: { HOME: '/home/node', PRODEX_AUTH_TRIAL: '1', WAYLAND_DISPLAY: 'wayland-0' } }
  ]) {
    assert.throws(() => assertTrialEnvironment({ ...valid, ...patch }));
  }
});

test('normal direct-file execution is detected without treating the script path as an option', () => {
  const script = fileURLToPath(new URL('./authenticated-runner.mjs', import.meta.url));
  assert.equal(isDirectEntrypoint(new URL('./authenticated-runner.mjs', import.meta.url).href,
    [process.execPath, script]), true);
  assert.equal(isDirectEntrypoint(new URL('./authenticated-runner.mjs', import.meta.url).href,
    [process.execPath, `${script}.other`]), false);

  const env = { ...process.env, HOME: '/home/node', PRODEX_AUTH_TRIAL: '0' };
  delete env.DISPLAY;
  delete env.XAUTHORITY;
  delete env.WAYLAND_DISPLAY;
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8', env, timeout: 5_000 });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  const records = result.stdout.trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, 'auth-trial-final');
  assert.equal(records[0].outcome, 'FAIL');
  assert.equal(records[0].cleanup.confirmed, true);
});

test('persistent profile prerequisite accepts only an existing directory without inspecting contents', () => {
  assert.deepEqual(validatePersistentProfileDirectory({ isDirectory: () => true }), {
    profileDirectoryVerified: true
  });
  assert.throws(() => validatePersistentProfileDirectory({ isDirectory: () => false }), /profile directory/);
  assert.throws(() => validatePersistentProfileDirectory(undefined), /profile directory/);
});

test('launch plan uses the exact wrapper, default profile, fixed port, blank page, and sanitized environment', () => {
  const calls = [];
  const plan = buildLaunchPlan({
    buildChromeLaunchArgs(options) {
      calls.push(options);
      return [
        `--remote-debugging-port=${options.port}`,
        `--user-data-dir=${options.profileDir}`,
        '--new-window',
        options.url
      ];
    },
    defaultChatGptProfileDir: () => PROFILE,
    environment: {
      HOME: '/home/node', PRODEX_AUTH_TRIAL: '1', PATH: '/custom/bin', LANG: 'C.UTF-8',
      DISPLAY: ':0', XAUTHORITY: '/tmp/xauth', WAYLAND_DISPLAY: 'wayland-0', SECRET: 'not-forwarded'
    }
  });

  assert.deepEqual(calls, [{ port: 9333, profileDir: PROFILE, url: 'about:blank', headless: false }]);
  assert.deepEqual(plan, {
    command: '/opt/prodex-ozone152/chrome',
    args: [`--remote-debugging-port=9333`, `--user-data-dir=${PROFILE}`, '--new-window', 'about:blank'],
    port: 9333,
    profileDir: PROFILE,
    env: {
      HOME: '/home/node',
      PRODEX_AUTH_TRIAL: '1',
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      LANG: 'C.UTF-8'
    }
  });
  assert.equal('DISPLAY' in plan.env, false);
  assert.equal('XAUTHORITY' in plan.env, false);
  assert.equal('WAYLAND_DISPLAY' in plan.env, false);
  assert.equal('SECRET' in plan.env, false);
});

test('wrapper validation permits only the fixed Chromium Ozone headless exec contract', () => {
  const wrapper = '#!/bin/sh\nexec /usr/lib/chromium/chromium --ozone-platform=headless --window-size=1440,900 "$@"\n';
  assert.deepEqual(validateWrapperSource(wrapper), {
    wrapperVerified: true,
    executable: '/usr/lib/chromium/chromium',
    ozonePlatform: 'headless',
    windowSize: '1440,900'
  });
  assert.deepEqual(validateWrapperSource(
    '#!/bin/sh\n# Fixed same-version Ozone trial wrapper.\n\n' + wrapper.split('\n')[1] + '\n'
  ), {
    wrapperVerified: true,
    executable: '/usr/lib/chromium/chromium',
    ozonePlatform: 'headless',
    windowSize: '1440,900'
  });

  for (const unsafe of [
    wrapper.replace('exec ', 'echo preparing\nexec '),
    wrapper.replace(' --ozone-platform=headless', ''),
    wrapper.replace('--window-size=1440,900', '--window-size=800,600'),
    wrapper.replace(' "$@"', ' --no-sandbox "$@"'),
    wrapper.replace('/usr/lib/chromium/chromium', '/usr/bin/google-chrome')
  ]) {
    assert.throws(() => validateWrapperSource(unsafe), /wrapper/);
  }
});

test('admission refuses occupied profile, CDP port, display sockets, or display processes', () => {
  const clean = {
    processes: [],
    profileDir: PROFILE,
    port: 9333,
    portReachable: false,
    displaySockets: [],
    displayProcesses: []
  };
  assert.deepEqual(assertAdmissionSnapshot(clean), {
    portEmpty: true,
    profileUnowned: true,
    displaySocketsAbsent: true,
    displayProcessesAbsent: true
  });

  assert.throws(() => assertAdmissionSnapshot({ ...clean, portReachable: true }), /CDP port/);
  assert.throws(() => assertAdmissionSnapshot({
    ...clean,
    processes: [{ processId: 41, executablePath: '/usr/lib/chromium/chromium', commandLine: `chromium --user-data-dir=${PROFILE} --remote-debugging-port=9444` }]
  }), /profile/);
  assert.throws(() => assertAdmissionSnapshot({ ...clean, displaySockets: ['/tmp/.X11-unix/X0'] }), /display socket/);
  assert.throws(() => assertAdmissionSnapshot({ ...clean, displayProcesses: [{ pid: 9, name: 'Xvfb' }] }), /display process/);
});

test('browser validation requires exact process identity, Ozone mode, port, profile, and no weakening flags', () => {
  const base = {
    executablePath: '/usr/lib/chromium/chromium',
    processId: 123,
    commandLine: `/usr/lib/chromium/chromium --ozone-platform=headless --window-size=1440,900 --remote-debugging-port=9333 --user-data-dir=${PROFILE} --new-window about:blank`
  };
  const expected = { launchedProcessId: 123, port: 9333, profileDir: PROFILE };
  assert.deepEqual(validateBrowserProcess(base, expected), {
    executableVerified: true,
    pidVerified: true,
    portVerified: true,
    profileVerified: true,
    ozoneHeadless: true,
    windowSizeVerified: true,
    browserHeadlessSwitchAbsent: true,
    sandboxWeakeningAbsent: true,
    securityWeakeningAbsent: true
  });

  for (const changed of [
    { ...base, processId: 124 },
    { ...base, executablePath: '/opt/prodex-ozone152/chrome' },
    { ...base, commandLine: base.commandLine.replace('--remote-debugging-port=9333', '--remote-debugging-port=9444') },
    { ...base, commandLine: base.commandLine.replace(`--user-data-dir=${PROFILE}`, '--user-data-dir=/tmp/other') },
    { ...base, commandLine: base.commandLine.replace('--ozone-platform=headless', '--ozone-platform=x11') },
    { ...base, commandLine: `${base.commandLine} --headless=new` },
    { ...base, commandLine: `${base.commandLine} --no-sandbox` },
    { ...base, commandLine: `${base.commandLine} --disable-web-security` }
  ]) {
    assert.throws(() => validateBrowserProcess(changed, expected));
  }
});

test('proc and CDP validation require container hardening, Chrome 152, and a local browser websocket', () => {
  assert.deepEqual(parseProcSecurityStatus('Name:\tchromium\nNoNewPrivs:\t1\nCapEff:\t0000000000000000\n'), {
    noNewPrivileges: true,
    effectiveCapabilitiesEmpty: true
  });
  assert.throws(() => parseProcSecurityStatus('NoNewPrivs:\t0\nCapEff:\t0000000000000000\n'), /NoNewPrivs/);
  assert.throws(() => parseProcSecurityStatus('NoNewPrivs:\t1\nCapEff:\t0000000000000400\n'), /CapEff/);

  assert.deepEqual(validateCdpVersion({
    Browser: 'Chrome/152.0.8110.2',
    'Protocol-Version': '1.3',
    webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/browser/abc'
  }, 9333), {
    chrome152: true,
    browser: 'Chrome/152.0.8110.2',
    protocolVersion: '1.3',
    localBrowserWebSocket: true,
    browserSocket: 'ws://127.0.0.1:9333/devtools/browser/abc'
  });
  assert.throws(() => validateCdpVersion({ Browser: 'Chrome/154.0.0.0', 'Protocol-Version': '1.3', webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/browser/a' }, 9333), /Chrome 152/);
  assert.throws(() => validateCdpVersion({ Browser: 'Chrome/152.0.0.0', 'Protocol-Version': '1.3', webSocketDebuggerUrl: 'ws://example.com:9333/devtools/browser/a' }, 9333), /loopback/);
  assert.throws(() => validateCdpVersion({ Browser: 'Chrome/152.0.0.0', 'Protocol-Version': '1.3', webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/a' }, 9333), /browser websocket/);
});

test('cleanup decision closes only a currently revalidated owned browser', () => {
  assert.equal(cleanupDecision({ browserExited: true, ownershipRevalidated: false, browserSocketLocal: false }), 'already-exited');
  assert.equal(cleanupDecision({ browserExited: false, ownershipRevalidated: true, browserSocketLocal: true }), 'browser-close');
  assert.equal(cleanupDecision({ browserExited: false, ownershipRevalidated: false, browserSocketLocal: true }), 'fail-ownership');
  assert.equal(cleanupDecision({ browserExited: false, ownershipRevalidated: true, browserSocketLocal: false }), 'fail-socket');
});

test('records expose bounded non-sensitive readiness and final cleanup evidence', () => {
  const ready = readyRecord({
    holdDurationMs: 240_000,
    environment: { uid1000: true, homeVerified: true, optIn: true, displayEnvironmentClear: true },
    wrapper: { wrapperVerified: true },
    version: { chrome152: true, browser: 'Chrome/152.0.8110.2', protocolVersion: '1.3' },
    processSecurity: { noNewPrivileges: true, effectiveCapabilitiesEmpty: true },
    browserSecurity: {
      executableVerified: true,
      pidVerified: true,
      portVerified: true,
      profileVerified: true,
      ozoneHeadless: true,
      windowSizeVerified: true,
      browserHeadlessSwitchAbsent: true,
      sandboxWeakeningAbsent: true,
      securityWeakeningAbsent: true
    },
    admission: {
      profileDirectoryVerified: true,
      portEmpty: true,
      profileUnowned: true,
      displaySocketsAbsent: true,
      displayProcessesAbsent: true
    }
  });
  assert.deepEqual(ready, {
    kind: 'auth-trial-ready',
    schemaVersion: 1,
    mode: 'ozone-headless',
    browser: 'Chrome/152.0.8110.2',
    protocolVersion: '1.3',
    holdDurationMs: 240_000,
    security: {
      uid1000: true,
      homeVerified: true,
      authTrialOptIn: true,
      displayEnvironmentClear: true,
      wrapperVerified: true,
      chrome152: true,
      executableVerified: true,
      launchPidVerified: true,
      cdpPortVerified: true,
      targetProfileVerified: true,
      ozoneHeadless: true,
      windowSizeVerified: true,
      persistentProfileDirectoryVerified: true,
      noNewPrivileges: true,
      effectiveCapabilitiesEmpty: true,
      browserHeadlessSwitchAbsent: true,
      sandboxWeakeningAbsent: true,
      securityWeakeningAbsent: true,
      portInitiallyEmpty: true,
      profileInitiallyUnowned: true,
      displaySocketsAbsent: true,
      displayProcessesAbsent: true,
      localBrowserWebSocket: true
    },
    navigation: 'not-performed',
    authenticationData: 'not-read'
  });
  assert.equal(JSON.stringify(ready).includes(PROFILE), false);
  assert.ok(Object.keys(ready.security).length >= 15);
  assert.equal(Object.values(ready.security).every((value) => value === true), true);

  assert.deepEqual(finalRecord({ outcome: 'PASS', stopReason: 'deadline', heldMs: 240_001, cleanupConfirmed: true, failure: null }), {
    kind: 'auth-trial-final',
    schemaVersion: 1,
    outcome: 'PASS',
    stopReason: 'deadline',
    heldMs: 240_001,
    cleanup: { confirmed: true, method: 'Browser.close', persistentProfilePreserved: true },
    failure: null
  });
});

test('runner source remains one-browser, non-navigating, non-login, non-destructive, and direct-file compatible', async () => {
  const source = await readFile(new URL('./authenticated-runner.mjs', import.meta.url), 'utf8');

  assert.equal([...source.matchAll(/\bspawn\(/g)].length, 1);
  assert.match(source, /import\('\/app\/dist\/chatgpt-browser\.js'\)/);
  assert.match(source, /import\('\/app\/dist\/browser-process\.js'\)/);
  assert.match(source, /import\('\/app\/scripts\/browser-launch-smoke\.mjs'\)/);
  assert.match(source, /buildChromeLaunchArgs/);
  assert.match(source, /defaultChatGptProfileDir/);
  assert.match(source, /withCdpSession/);
  assert.match(source, /Browser\.close/);
  assert.match(source, /pathToFileURL\(path\.resolve\(argv\[1\]\)\)\.href === metaUrl/);
  assert.match(source, /process\.argv\.slice\(2\)/);
  assert.doesNotMatch(source, /process\.argv\.length === 1/);
  assert.match(source, /PRODEX_AUTH_TRIAL_HOLD_SECONDS/);
  assert.match(source, /stat\(plan\.profileDir\)/);
  assert.doesNotMatch(source, /recordBrowserLoginLaunch|readLastBrowserLoginLaunch/);
  assert.doesNotMatch(source, /openChatGptBrowser|getChatGptBrowserStatus/);
  assert.doesNotMatch(source, /Page\.navigate|https:\/\/chatgpt\.com|Runtime\.evaluate/);
  assert.doesNotMatch(source, /SIGKILL|rm\(|unlink\(|rmdir\(/);
  assert.doesNotMatch(source, /readdir\([^\n]*profileDir|readFile\([^\n]*profileDir/);

  const cleanup = /async function closeOwnedBrowser[\s\S]*?\n}/.exec(source)?.[0];
  assert.ok(cleanup);
  assert.equal([...cleanup.matchAll(/currentOwnedIdentity\(/g)].length, 2);
  assert.match(cleanup, /waitForOwnedBrowserExit\(browser, dependencies, CLEANUP_TIMEOUT_MS\)/);
  assert.ok(cleanup.lastIndexOf('currentOwnedIdentity(') < cleanup.indexOf("send('Browser.close')"));
});
