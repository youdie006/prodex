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
import { classifyTrials, mustStop } from './focus-results.mjs';

const READY_TIMEOUT_MS = 20_000;
const EXIT_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 5_000;
const POLL_MS = 100;
const EXPECTED_CHROME = /^Chrome\/154\./;
const EXPECTED_EXECUTABLE = '/opt/prodex-cft154/chrome';
const EXPECTED_WRAPPER = '/opt/prodex-ozone/chrome';
const PRIME_MARKER_KEY = 'prodex-ozone-focus-prime-v1';
const probeStartedAt = performance.now();
const allocatedBrowserPorts = new Set();

const PAIRS = Object.freeze([
  { pair: 1, repeat: 1, startup: 'cold', load: 'isolated', armOrder: ['A', 'B'] },
  { pair: 2, repeat: 1, startup: 'restart', load: 'single-render-load', armOrder: ['B', 'A'] },
  { pair: 3, repeat: 1, startup: 'cold', load: 'single-render-load', armOrder: ['A', 'B'] },
  { pair: 4, repeat: 1, startup: 'restart', load: 'isolated', armOrder: ['B', 'A'] },
  { pair: 5, repeat: 2, startup: 'restart', load: 'isolated', armOrder: ['A', 'B'] },
  { pair: 6, repeat: 2, startup: 'cold', load: 'single-render-load', armOrder: ['B', 'A'] },
  { pair: 7, repeat: 2, startup: 'restart', load: 'single-render-load', armOrder: ['A', 'B'] },
  { pair: 8, repeat: 2, startup: 'cold', load: 'isolated', armOrder: ['B', 'A'] }
]);

const TRIALS = Object.freeze(PAIRS.flatMap((pair) => pair.armOrder.map((arm, armPosition) => Object.freeze({
  ...pair,
  arm,
  armPosition: armPosition + 1,
  trial: (pair.pair - 1) * 2 + armPosition + 1,
  id: `pair-${String(pair.pair).padStart(2, '0')}-${arm}`
}))));

const KEY_DOWN = Object.freeze({
  type: 'keyDown',
  key: 'k',
  code: 'KeyK',
  text: 'k',
  unmodifiedText: 'k',
  windowsVirtualKeyCode: 75,
  nativeVirtualKeyCode: 75
});

const KEY_UP = Object.freeze({
  type: 'keyUp',
  key: 'k',
  code: 'KeyK',
  windowsVirtualKeyCode: 75,
  nativeVirtualKeyCode: 75
});

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
  console.log(JSON.stringify({
    kind: 'focus-probe-final',
    schemaVersion: 1,
    outcome: 'FAIL',
    phase: 'admission-or-harness',
    failures: [{ phase: 'admission-or-harness', message: errorMessage(error) }],
    publicNavigation: 'not_tested',
    authenticationData: 'not_accessed'
  }));
  process.exitCode = 1;
});

async function run() {
  await assertOfflineAdmission();
  assertPredeclaredDesign();

  let tempRoot;
  let fixture;
  const results = [];
  const harnessFailures = [];
  try {
    tempRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'prodex-ozone-focus-')));
    fixture = await startFixtureServer();
    for (const trial of TRIALS) {
      const result = await runTrial(trial, tempRoot, fixture.url);
      results.push(result);
      console.log(JSON.stringify(result));
      if (mustStop(result)) break;
    }
  } finally {
    if (fixture) {
      const closed = await closeFixtureServer(fixture.server);
      if (!closed) harnessFailures.push({ phase: 'cleanup:fixture-server', message: 'fixture server did not close within 5 seconds' });
    }
    if (tempRoot && results.every((result) => result.cleanup?.confirmed === true)) {
      try {
        await rm(tempRoot, { recursive: true, force: true });
      } catch (error) {
        harnessFailures.push({ phase: 'cleanup:temporary-root', message: errorMessage(error) });
      }
    }
  }

  const trialFailures = results
    .filter((result) => result.status === 'fail')
    .map((result) => ({ trial: result.trial.id, ...result.failure }));
  const failures = [...trialFailures, ...harnessFailures];
  const matrix = PAIRS.map((pair) => {
    const arms = Object.fromEntries(results
      .filter((result) => result.trial.pair === pair.pair)
      .map((result) => [result.trial.arm, result.status]));
    return {
      pair: pair.pair,
      repeat: pair.repeat,
      startup: pair.startup,
      load: pair.load,
      armOrder: pair.armOrder.join(''),
      A: arms.A ?? 'not-run',
      B: arms.B ?? 'not-run'
    };
  });
  const classification = classifyTrials(results, TRIALS.length, harnessFailures);
  const allPassed = classification.outcome === 'INCONCLUSIVE_NON_REPRODUCTION';
  console.log(JSON.stringify({
    kind: 'focus-probe-final',
    schemaVersion: 2,
    arch: process.arch,
    ...classification,
    interpretation: allPassed
      ? 'All measured trials passed; this does not establish that the original focus failure is fixed.'
      : 'An incomplete or failed matrix cannot establish an input comparison; infrastructure failures stop remaining trials.',
    matrix,
    failures,
    cleanup: harnessFailures.length === 0 && results.every((result) => result.cleanup?.confirmed === true),
    workloadLimitation: 'single-render-load shares the target container CPU budget; it is not the original separate-container load model',
    publicNavigation: 'not_tested',
    authenticationData: 'not_accessed'
  }));
  if (!allPassed) process.exitCode = 1;
}

async function assertOfflineAdmission() {
  assert.equal(process.platform, 'linux', 'focus probe refuses non-Linux hosts');
  assert.equal(process.getuid?.(), 1000, 'focus probe requires UID 1000');

  const interfaces = networkInterfaces();
  const addresses = Object.entries(interfaces).flatMap(([name, values]) =>
    (values ?? []).map((value) => ({ name, ...value })));
  assert.ok(addresses.length > 0, 'network namespace did not expose a loopback interface');
  const nonInternal = addresses.filter((address) => address.internal !== true);
  assert.deepEqual(nonInternal, [], 'focus probe refuses a namespace with non-internal network interfaces');

  assert.equal(process.env.PRODEX_CHROME, EXPECTED_WRAPPER, 'PRODEX_CHROME must select the checked ozone wrapper');
  const wrapper = await readFile(EXPECTED_WRAPPER, 'utf8');
  assert.match(wrapper, /--ozone-platform=headless(?:\s|$)/, 'ozone wrapper must select the headless platform');
  assert.doesNotMatch(wrapper, /--headless(?:=|\s|$)/, 'ozone wrapper must not add a browser headless switch');
  assert.doesNotMatch(wrapper, /--no-sandbox(?:=|\s|$)/, 'ozone wrapper must preserve the browser sandbox');
  assert.doesNotMatch(wrapper, /--(?:disable-gpu|disable-software-rasterizer|use-angle|use-gl|user-agent|disable-web-security)(?:=|\s|$)/,
    'ozone wrapper must not add graphics, identity, or security experiment flags');
}

function assertPredeclaredDesign() {
  assert.equal(PAIRS.length, 8);
  assert.equal(TRIALS.length, 16);
  for (const startup of ['cold', 'restart']) {
    for (const load of ['isolated', 'single-render-load']) {
      const pairs = PAIRS.filter((pair) => pair.startup === startup && pair.load === load);
      assert.equal(pairs.length, 2, `expected two pairs for ${startup}/${load}`);
      assert.deepEqual(pairs.map((pair) => pair.repeat).sort(), [1, 2]);
      assert.deepEqual(pairs.map((pair) => pair.armOrder.join('')).sort(), ['AB', 'BA']);
    }
  }
}

async function runTrial(plan, tempRoot, fixtureBaseUrl) {
  const resourcesBefore = await readCgroupResources();
  const state = {
    phase: 'trial:prepare',
    active: [],
    commands: [],
    events: undefined,
    initial: undefined,
    barrier: undefined,
    preKeyRecheck: undefined,
    final: undefined,
    targetBrowser: undefined,
    loadBrowser: undefined,
    restart: { primed: false, sameProfile: false, metadataStable: false },
    cleanupErrors: []
  };
  const trialRoot = path.join(tempRoot, plan.id);
  const targetProfile = path.join(trialRoot, 'target-profile');
  const loadProfile = path.join(trialRoot, 'load-profile');
  const targetIdentity = `${plan.id}:target`;
  const sessionIdentity = `${plan.id}:session`;
  let failure;

  try {
    await mkdir(targetProfile, { recursive: true });
    if (plan.load === 'single-render-load') await mkdir(loadProfile, { recursive: true });

    if (plan.load === 'single-render-load') {
      state.phase = 'load:allocate-port';
      const loadPort = await unusedLoopbackPort();
      state.phase = 'load:launch';
      const loadBrowser = launchOwnedBrowser({ role: 'render-load', port: loadPort, profileDir: loadProfile });
      state.active.push(loadBrowser);
      state.phase = 'load:ready';
      const ready = await waitForOwnedBrowserReady(loadBrowser);
      state.loadBrowser = browserEvidence(loadBrowser, ready);
      state.phase = 'load:navigate';
      await navigateBlankPage(loadBrowser, fixtureUrl(fixtureBaseUrl, 'load', plan.id), 'render');
    }

    state.phase = 'target:allocate-port';
    const targetPort = await unusedLoopbackPort();
    let primeVersion;
    if (plan.startup === 'restart') {
      state.phase = 'restart:prime-launch';
      const prime = launchOwnedBrowser({ role: 'target-prime', port: targetPort, profileDir: targetProfile });
      state.active.push(prime);
      state.phase = 'restart:prime-ready';
      const primeReady = await waitForOwnedBrowserReady(prime);
      primeVersion = primeReady.version;
      state.phase = 'restart:prime-navigate';
      const primePage = await navigateBlankPage(prime, fixtureUrl(fixtureBaseUrl, 'prime', plan.id), 'prime');
      state.phase = 'restart:prime-marker';
      await withCdpSession(localCdpSocket(primePage.webSocketDebuggerUrl, targetPort, 'page'), async (send) => {
        const evaluation = await send('Runtime.evaluate', {
          expression: `localStorage.setItem(${JSON.stringify(PRIME_MARKER_KEY)}, ${JSON.stringify(plan.id)}); localStorage.getItem(${JSON.stringify(PRIME_MARKER_KEY)})`,
          returnByValue: true
        });
        assert.equal(runtimeValue(evaluation, 'prime marker'), plan.id);
      });
      state.phase = 'restart:prime-close';
      await closeOwnedBrowser(prime);
      state.active.splice(state.active.indexOf(prime), 1);
      state.restart.primed = true;
    }

    state.phase = 'target:launch';
    const target = launchOwnedBrowser({ role: 'target-measured', port: targetPort, profileDir: targetProfile });
    state.active.push(target);
    state.phase = 'target:ready';
    const targetReady = await waitForOwnedBrowserReady(target);
    state.targetBrowser = browserEvidence(target, targetReady);
    if (primeVersion) {
      state.restart.sameProfile = target.profileDir === targetProfile && target.port === targetPort;
      state.restart.metadataStable = primeVersion.Browser === targetReady.version.Browser &&
        primeVersion['Protocol-Version'] === targetReady.version['Protocol-Version'];
      assert.equal(state.restart.sameProfile, true, 'restart did not retain the same profile and port');
      assert.equal(state.restart.metadataStable, true, 'browser metadata changed across restart');
    }

    state.phase = 'target:navigate';
    const page = await navigateBlankPage(target, fixtureUrl(fixtureBaseUrl, 'focus', plan.id), 'focus');
    state.phase = 'measure:session-open';
    const measurement = await withCdpSession(
      localCdpSocket(page.webSocketDebuggerUrl, targetPort, 'page'),
      async (send) => {
        try {
          return await measureArm(send, plan, state);
        } catch (error) {
          // Capture a partial trace before closing the session; do not retry input.
          try {
            const partial = await send('Runtime.evaluate', {
              expression: 'window.__focusProbe ? ({...window.__focusProbe.snapshot("failure"), events:window.__focusProbe.events.slice()}) : null',
              returnByValue: true
            });
            state.final = runtimeValue(partial, 'failure trace');
            state.events = state.final?.events;
          } catch (traceError) {
            state.traceError = errorMessage(traceError);
          }
          throw error;
        }
      }
    );
    Object.assign(state, measurement);
    state.phase = 'measure:assertions';
    const assertions = assertMeasurement(plan, state);
    state.phase = 'trial:complete';
    state.assertions = assertions;
  } catch (error) {
    failure = { phase: state.phase, message: errorMessage(error) };
  } finally {
    for (const browser of [...state.active].reverse()) {
      state.phase = `cleanup:${browser.role}`;
      try {
        await closeOwnedBrowser(browser);
      } catch (error) {
        state.cleanupErrors.push({ phase: state.phase, message: errorMessage(error) });
      }
    }
    state.active.length = 0;
    if (state.cleanupErrors.length === 0) {
      try {
        await rm(trialRoot, { recursive: true, force: true });
      } catch (error) {
        state.cleanupErrors.push({ phase: 'cleanup:trial-profile-root', message: errorMessage(error) });
      }
    }
  }

  if (!failure && state.cleanupErrors.length > 0) failure = state.cleanupErrors[0];
  const status = failure ? 'fail' : 'pass';
  return {
    kind: 'focus-probe-trial',
    schemaVersion: 1,
    trial: {
      trial: plan.trial,
      id: plan.id,
      pair: plan.pair,
      repeat: plan.repeat,
      startup: plan.startup,
      load: plan.load,
      arm: plan.arm,
      armOrder: plan.armOrder.join(''),
      armPosition: plan.armPosition,
      stage: 'attempted',
      targetIdentity,
      sessionIdentity
    },
    status,
    resources: { before: resourcesBefore, after: await readCgroupResources() },
    ...(failure ? { failure } : {}),
    browser: state.targetBrowser,
    ...(state.loadBrowser ? { renderLoadBrowser: state.loadBrowser } : {}),
    restart: state.restart,
    commandClock: 'monotonic performance.now milliseconds since probe start',
    commands: state.commands,
    documentIdentity: state.initial?.documentIdentity,
    initial: state.initial,
    ...(state.barrier ? { barrier: state.barrier } : {}),
    ...(state.preKeyRecheck ? { preKeyRecheck: state.preKeyRecheck } : {}),
    final: state.final,
    events: state.events,
    ...(state.traceError ? { traceError: state.traceError } : {}),
    assertions: state.assertions,
    cleanup: { confirmed: state.cleanupErrors.length === 0, errors: state.cleanupErrors },
    workloadModel: plan.load === 'single-render-load'
      ? 'same-container-single-render-browser'
      : 'same-container-isolated-target',
    workloadLimitation: plan.load === 'single-render-load'
      ? 'shares the target container CPU budget; differs from the original separate-container load'
      : null,
    publicNavigation: 'not_tested',
    authenticationData: 'not_accessed'
  };
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

async function measureArm(send, plan, state) {
  const timed = async (phase, method, params = {}) => {
    state.phase = phase;
    const command = {
      sequence: state.commands.length + 1,
      phase,
      method,
      sentAtMs: monotonicMs()
    };
    state.commands.push(command);
    try {
      const value = await send(method, params);
      command.replyAtMs = monotonicMs();
      command.ok = true;
      return value;
    } catch (error) {
      command.replyAtMs = monotonicMs();
      command.ok = false;
      command.error = errorMessage(error);
      throw error;
    }
  };

  await timed('measure:runtime-enable', 'Runtime.enable');
  await timed('measure:dom-enable', 'DOM.enable');
  const documentResult = await timed('measure:document', 'DOM.getDocument');
  const rootNodeId = documentResult?.root?.nodeId;
  assert.ok(Number.isSafeInteger(rootNodeId) && rootNodeId > 0, 'DOM.getDocument did not return a root node');
  const inputResult = await timed('measure:query-input', 'DOM.querySelector', { nodeId: rootNodeId, selector: '#probe-input' });
  const inputNodeId = inputResult?.nodeId;
  assert.ok(Number.isSafeInteger(inputNodeId) && inputNodeId > 0, 'focus fixture input was not found');
  const boxResult = await timed('measure:input-box', 'DOM.getBoxModel', { nodeId: inputNodeId });
  const mousePoint = centerOfQuad(boxResult?.model?.border);

  const setup = await timed('measure:install-observers', 'Runtime.evaluate', {
    expression: observerSetupExpression(),
    returnByValue: true
  });
  const initial = runtimeValue(setup, 'observer setup');
  state.initial = initial;

  await timed('measure:dom-focus', 'DOM.focus', { nodeId: inputNodeId });
  let barrier;
  let preKeyRecheck;
  if (plan.arm === 'B') {
    await timed('measure:click-move', 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...mousePoint });
    await timed('measure:click-press', 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...mousePoint,
      button: 'left',
      buttons: 1,
      clickCount: 1
    });
    await timed('measure:click-release', 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...mousePoint,
      button: 'left',
      buttons: 0,
      clickCount: 1
    });
    const barrierEvaluation = await timed('measure:focus-barrier', 'Runtime.evaluate', {
      expression: 'window.__focusProbe.readyPromise',
      awaitPromise: true,
      returnByValue: true
    });
    barrier = runtimeValue(barrierEvaluation, 'focus readiness barrier');
    state.barrier = barrier;
    assert.equal(barrier?.ok, true, `focus readiness barrier aborted: ${barrier?.reason ?? 'unknown'}`);
    const recheck = await timed('measure:immediate-focus-recheck', 'Runtime.evaluate', {
      expression: 'window.__focusProbe.snapshot("immediate-pre-key-recheck")',
      returnByValue: true
    });
    preKeyRecheck = runtimeValue(recheck, 'immediate focus recheck');
    state.preKeyRecheck = preKeyRecheck;
    assertReadySnapshot(preKeyRecheck, initial.documentIdentity, 'immediate focus recheck');
  }

  await timed('measure:key-down', 'Input.dispatchKeyEvent', KEY_DOWN);
  await timed('measure:key-up', 'Input.dispatchKeyEvent', KEY_UP);

  const completionEvaluation = await timed('measure:input-completion', 'Runtime.evaluate', {
    expression: 'window.__focusProbe.inputCompletion',
    awaitPromise: true,
    returnByValue: true
  });
  const completion = runtimeValue(completionEvaluation, 'input completion barrier');
  assert.equal(completion?.ok, true, `input completion barrier aborted: ${completion?.reason ?? 'unknown'}`);

  const finalEvaluation = await timed('measure:final-inspection', 'Runtime.evaluate', {
    expression: `Promise.all([window.__focusProbe.readyPromise, window.__focusProbe.inputCompletion]).then(([focusReady, inputCompletion]) => ({
      ...window.__focusProbe.snapshot('final'),
      focusReady,
      inputCompletion,
      events: window.__focusProbe.events.slice()
    }))`,
    awaitPromise: true,
    returnByValue: true
  });
  const final = runtimeValue(finalEvaluation, 'final inspection');
  return { initial, barrier, preKeyRecheck, final, events: final.events };
}

function observerSetupExpression() {
  return `(() => {
    if (window.__focusProbe) throw new Error('focus probe observers already installed');
    const input = document.querySelector('#probe-input');
    if (!input) throw new Error('focus probe input missing');
    const documentIdentity = window.__focusFixture?.documentIdentity;
    if (typeof documentIdentity !== 'string') throw new Error('synthetic document identity missing');
    const events = [];
    const readinessEvent = type => type === 'focus' || type === 'focusin' || type === 'blur' ||
      type === 'focusout' || type.startsWith('pointer') || type.startsWith('mouse') || type === 'click';
    const targetName = target => target === input ? 'input' : target === document ? 'document' :
      target instanceof Element ? (target.id ? 'element#' + target.id : 'element:' + target.tagName.toLowerCase()) : 'other';
    const snapshot = trigger => ({
      trigger,
      atMs: performance.now(),
      eventSequence: events.length,
      documentIdentity: window.__focusFixture?.documentIdentity ?? null,
      documentHasFocus: document.hasFocus(),
      activeElement: document.activeElement === input ? 'input' : targetName(document.activeElement),
      inputConnected: input.isConnected,
      disabled: input.disabled,
      readOnly: input.readOnly,
      value: input.value
    });
    let finishReady;
    let readyFinished = false;
    const readyPromise = new Promise(resolve => { finishReady = resolve; });
    const readyTimer = setTimeout(() => {
      if (readyFinished) return;
      readyFinished = true;
      finishReady({ ok: false, reason: 'five-second-watchdog', snapshot: snapshot('watchdog') });
    }, 5000);
    const checkReady = trigger => {
      if (readyFinished) return;
      const state = snapshot(trigger);
      if (state.documentHasFocus && state.activeElement === 'input' && state.inputConnected && !state.disabled && !state.readOnly) {
        readyFinished = true;
        clearTimeout(readyTimer);
        finishReady({ ok: true, trigger, snapshot: state });
      }
    };
    let finishInput;
    let inputFinished = false;
    const inputCompletion = new Promise(resolve => { finishInput = resolve; });
    const inputTimer = setTimeout(() => {
      if (inputFinished) return;
      inputFinished = true;
      finishInput({ ok: false, reason: 'five-second-watchdog', snapshot: snapshot('input-watchdog') });
    }, 5000);
    const observedTypes = [
      'focus', 'focusin', 'blur', 'focusout',
      'pointerover', 'pointerenter', 'pointermove', 'pointerdown', 'pointerup',
      'mouseover', 'mouseenter', 'mousemove', 'mousedown', 'mouseup', 'click',
      'keydown', 'beforeinput', 'input', 'keyup'
    ];
    for (const type of observedTypes) {
      document.addEventListener(type, event => {
        events.push({
          sequence: events.length + 1,
          atMs: performance.now(),
          type: event.type,
          target: targetName(event.target),
          isTrusted: event.isTrusted,
          focus: {
            documentHasFocus: document.hasFocus(),
            activeElement: document.activeElement === input ? 'input' : targetName(document.activeElement)
          },
          value: input.value,
          key: 'key' in event ? event.key : null,
          code: 'code' in event ? event.code : null,
          data: 'data' in event ? event.data : null,
          inputType: 'inputType' in event ? event.inputType : null,
          button: 'button' in event ? event.button : null
        });
        if (readinessEvent(event.type)) checkReady(event.type);
        if (!inputFinished && event.type === 'keyup' && event.key === 'k') {
          inputFinished = true;
          clearTimeout(inputTimer);
          finishInput({ ok: true, trigger: 'keyup', snapshot: snapshot('keyup') });
        }
      }, { capture: true, passive: true });
    }
    window.__focusProbe = Object.freeze({ events, readyPromise, inputCompletion, snapshot });
    checkReady('immediate');
    return {
      ...snapshot('installed'),
      primeMarker: localStorage.getItem(${JSON.stringify(PRIME_MARKER_KEY)})
    };
  })()`;
}

function assertMeasurement(plan, state) {
  const { initial, final, events, commands } = state;
  assert.ok(initial && final && Array.isArray(events), 'measurement did not produce a final observation');
  assert.equal(initial.value, '', 'input was not initially empty');
  assert.equal(initial.inputConnected, true);
  assert.equal(initial.disabled, false);
  assert.equal(initial.readOnly, false);
  assert.equal(initial.primeMarker, plan.startup === 'restart' ? plan.id : null, 'restart marker did not match startup condition');
  assert.equal(final.documentIdentity, initial.documentIdentity, 'document identity changed during measurement');
  assert.equal(final.documentHasFocus, true, 'document did not retain focus');
  assert.equal(final.activeElement, 'input', 'input did not retain focus');
  assert.equal(final.value, 'k', 'input did not contain exactly one k');
  assert.equal(final.focusReady?.ok, true, 'focus readiness never completed');
  assert.equal(final.inputCompletion?.ok, true, 'input completion never completed');

  const inputEvents = events.filter((event) => ['keydown', 'beforeinput', 'input', 'keyup'].includes(event.type));
  assert.deepEqual(inputEvents.map((event) => event.type), ['keydown', 'beforeinput', 'input', 'keyup'],
    'keyboard/input event order or count differed from the predeclared sequence');
  assert.ok(inputEvents.every((event) => event.target === 'input'), 'keyboard/input event targeted something other than the input');
  assert.ok(inputEvents.every((event) => event.isTrusted === true), 'keyboard/input event was not trusted');
  assert.deepEqual(inputEvents.filter((event) => event.type === 'keydown' || event.type === 'keyup').map((event) => event.key), ['k', 'k']);
  assert.deepEqual(inputEvents.filter((event) => event.type === 'beforeinput' || event.type === 'input').map((event) => event.data), ['k', 'k']);

  assert.equal(commands.filter((command) => command.phase === 'measure:key-down').length, 1);
  assert.equal(commands.filter((command) => command.phase === 'measure:key-up').length, 1);
  assert.ok(commands.every((command) => Number.isFinite(command.sentAtMs) && Number.isFinite(command.replyAtMs) &&
    command.replyAtMs >= command.sentAtMs), 'command monotonic timings were incomplete or reversed');

  const clicks = events.filter((event) => event.type === 'click');
  const presses = events.filter((event) => event.type === 'mousedown');
  const releases = events.filter((event) => event.type === 'mouseup');
  const pointerDown = events.filter((event) => event.type === 'pointerdown');
  const pointerUp = events.filter((event) => event.type === 'pointerup');
  if (plan.arm === 'B') {
    assertReadySnapshot(state.barrier?.snapshot, initial.documentIdentity, 'focus barrier');
    assertReadySnapshot(state.preKeyRecheck, initial.documentIdentity, 'pre-key recheck');
    assert.equal(clicks.length, 1, 'B did not generate exactly one click');
    assert.equal(presses.length, 1, 'B did not generate exactly one mousedown');
    assert.equal(releases.length, 1, 'B did not generate exactly one mouseup');
    assert.equal(pointerDown.length, 1, 'B did not generate exactly one pointerdown');
    assert.equal(pointerUp.length, 1, 'B did not generate exactly one pointerup');
    assert.ok([...clicks, ...presses, ...releases, ...pointerDown, ...pointerUp]
      .every((event) => event.target === 'input' && event.isTrusted === true), 'B click sequence was not trusted on the input');
    assert.equal(events.some((event) => event.sequence > state.barrier.snapshot.eventSequence &&
      (event.type === 'blur' || event.type === 'focusout')), false,
      'B lost input focus before completion');
    assert.equal(commands.filter((command) => command.phase === 'measure:click-press').length, 1);
    assert.equal(commands.filter((command) => command.phase === 'measure:click-release').length, 1);
  } else {
    assert.equal(clicks.length + presses.length + releases.length + pointerDown.length + pointerUp.length, 0,
      'A unexpectedly generated a click sequence');
    assert.equal(commands.some((command) => command.phase.startsWith('measure:click-')), false);
    const focusIndex = commands.findIndex((command) => command.phase === 'measure:dom-focus');
    const keyDownIndex = commands.findIndex((command) => command.phase === 'measure:key-down');
    assert.equal(keyDownIndex, focusIndex + 1, 'A issued a diagnostic RPC between DOM.focus and keyDown');
  }

  return {
    exactValue: true,
    orderedTrustedInputEvents: true,
    exactlyOneKeyPair: true,
    documentUnchanged: true,
    focusMaintained: true,
    clickCount: clicks.length
  };
}

function assertReadySnapshot(snapshot, documentIdentity, label) {
  assert.ok(snapshot, `${label} was missing`);
  assert.equal(snapshot.documentIdentity, documentIdentity, `${label} observed a changed document`);
  assert.equal(snapshot.documentHasFocus, true, `${label} observed an unfocused document`);
  assert.equal(snapshot.activeElement, 'input', `${label} observed a different active element`);
  assert.equal(snapshot.inputConnected, true, `${label} observed a detached input`);
  assert.equal(snapshot.disabled, false, `${label} observed a disabled input`);
  assert.equal(snapshot.readOnly, false, `${label} observed a read-only input`);
}

function launchOwnedBrowser({ role, port, profileDir }) {
  assert.equal(findMatchingBrowserProcesses(inspectBrowserProcesses(), { port, profileDir }).length, 0,
    `${role} profile or port was already owned by a browser`);
  const launch = openChatGptBrowser({ port, profileDir, headless: false, url: 'about:blank' });
  assert.ok(Number.isSafeInteger(launch.processId) && launch.processId > 0, `${role} launch did not return a PID`);
  assert.equal(launch.port, port, `${role} launch changed the requested port`);
  assert.equal(launch.profileDir, profileDir, `${role} launch changed the requested profile`);
  assert.equal(launch.command, EXPECTED_WRAPPER, `${role} launch did not use the ozone wrapper`);
  assert.equal(launch.args.some((argument) => argument === '--headless' || argument.startsWith('--headless=')), false,
    `${role} launch unexpectedly requested browser headless mode`);
  return {
    role,
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
    if (earlyExit) throw new Error(`${browser.role} exited before readiness: ${JSON.stringify(earlyExit)}`);
    try {
      const matching = findMatchingBrowserProcesses(inspectBrowserProcesses(), {
        port: browser.port,
        profileDir: browser.profileDir
      });
      const main = assertLaunchedBrowserMainProcess(matching, browser.launch.processId);
      for (const processInfo of matching) browser.ownedProcessIds.add(processInfo.processId);
      assertBrowserMode(main, browser.role, browser.port, browser.profileDir);
      const version = await readCdpJson(browser.port, 'version');
      assert.match(version?.Browser ?? '', EXPECTED_CHROME, `${browser.role} is not stock Chrome 154`);
      browser.browserSocket = localCdpSocket(version.webSocketDebuggerUrl, browser.port, 'browser');
      browser.ownershipVerified = true;
      return { main, version };
    } catch (error) {
      lastError = error;
      await sleep(POLL_MS);
    }
  }
  throw new Error(`${browser.role} readiness timed out after 20 seconds: ${errorMessage(lastError)}`);
}

function assertBrowserMode(main, role, port, profileDir) {
  assert.equal(main.executablePath, EXPECTED_EXECUTABLE, `${role} did not use the stock Chrome 154 executable`);
  assert.equal(browserProcessFlagValue(main, 'remote-debugging-port'), String(port), `${role} did not retain its dedicated CDP port`);
  assert.equal(browserProcessFlagValue(main, 'user-data-dir'), profileDir, `${role} did not retain its dedicated profile`);
  assert.equal(browserProcessFlagValue(main, 'ozone-platform'), 'headless', `${role} did not use ozone=headless`);
  for (const flag of FORBIDDEN_BROWSER_FLAGS) {
    assert.equal(browserProcessHasFlag(main, flag), false, `${role} used forbidden --${flag}`);
  }
}

function browserEvidence(browser, ready) {
  return {
    role: browser.role,
    mainPid: ready.main.processId,
    port: browser.port,
    profileDir: browser.profileDir,
    profilePortOwnershipVerified: browser.ownershipVerified,
    executable: ready.main.executablePath,
    browser: ready.version.Browser,
    protocolVersion: ready.version['Protocol-Version'],
    ozonePlatform: browserProcessFlagValue(ready.main, 'ozone-platform'),
    browserHeadlessSwitch: browserProcessHasFlag(ready.main, 'headless'),
    noSandboxSwitch: browserProcessHasFlag(ready.main, 'no-sandbox')
  };
}

async function navigateBlankPage(browser, url, readiness) {
  const blank = await waitForPage(browser.port, 'about:blank', undefined, READY_TIMEOUT_MS);
  assert.ok(typeof blank.id === 'string' && blank.id.length > 0, `${browser.role} blank target ID was missing`);
  await withCdpSession(localCdpSocket(blank.webSocketDebuggerUrl, browser.port, 'page'), async (send) => {
    await send('Page.enable');
    const navigation = await send('Page.navigate', { url });
    if (navigation?.errorText) throw new Error(`${browser.role} local navigation failed: ${navigation.errorText}`);
  });
  const page = await waitForPage(browser.port, url, blank.id, READY_TIMEOUT_MS);
  await withCdpSession(localCdpSocket(page.webSocketDebuggerUrl, browser.port, 'page'), async (send) => {
    await send('Runtime.enable');
    await waitForRuntimeCondition(send, readiness === 'focus'
      ? 'document.readyState === "complete" && Boolean(document.querySelector("#probe-input")) && Boolean(window.__focusFixture?.documentIdentity)'
      : readiness === 'render'
        ? 'document.readyState === "complete" && Boolean(window.__renderReady)'
        : 'document.readyState === "complete"');
    if (readiness === 'render') {
      const rendered = await send('Runtime.evaluate', {
        expression: 'window.__renderReady',
        awaitPromise: true,
        returnByValue: true
      });
      assert.equal(runtimeValue(rendered, 'render load readiness')?.ready, true, 'render load did not animate');
    }
  });
  return page;
}

async function waitForRuntimeCondition(send, expression) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const evaluation = await send('Runtime.evaluate', { expression, returnByValue: true });
      if (runtimeValue(evaluation, 'local fixture readiness') === true) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(POLL_MS);
  }
  throw new Error(`local fixture readiness timed out after 20 seconds: ${errorMessage(lastError)}`);
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
  throw new Error(`${browser.role} owned processes did not exit within 20 seconds`);
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
      // Keep checking until the single bounded exit deadline.
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
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const server = createNetServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('could not allocate a loopback port');
    const port = address.port;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (allocatedBrowserPorts.has(port)) continue;
    allocatedBrowserPorts.add(port);
    return port;
  }
  throw new Error('could not allocate a fresh dedicated loopback port');
}

async function startFixtureServer() {
  const server = createHttpServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    const match = /^\/(focus|prime|load)\/([A-Za-z0-9-]+)$/.exec(requestUrl.pathname);
    if (request.method !== 'GET' || !match) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      response.end('not found\n');
      return;
    }
    const [, kind, trialId] = match;
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
      'content-type': 'text/html; charset=utf-8'
    });
    response.end(kind === 'focus' ? focusFixtureHtml(trialId) : kind === 'load' ? renderFixtureHtml(trialId) : primeFixtureHtml(trialId));
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
  if (!address || typeof address === 'string') throw new Error('fixture server did not bind a loopback port');
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

function focusFixtureHtml(trialId) {
  const id = jsonForInlineScript(trialId);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Synthetic focus fixture</title>
<style>html,body{margin:0;background:#fff;color:#111;font:16px sans-serif}#probe-input{position:fixed;left:80px;top:80px;width:360px;height:48px;padding:4px;font:22px sans-serif}</style></head>
<body><input id="probe-input" autocomplete="off" spellcheck="false" aria-label="Synthetic focus input">
<script>window.__focusFixture=Object.freeze({trialId:${id},documentIdentity:${id}+':doc:'+crypto.randomUUID()});</script></body></html>`;
}

function primeFixtureHtml(trialId) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Synthetic restart prime</title></head><body data-trial=${JSON.stringify(trialId)}>restart prime</body></html>`;
}

function renderFixtureHtml(trialId) {
  const id = jsonForInlineScript(trialId);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Synthetic render load</title>
<style>html,body,canvas{margin:0;width:100%;height:100%;display:block;background:#fff}</style></head><body>
<canvas id="load" width="1440" height="900"></canvas><script>(()=>{
const trialId=${id};const canvas=document.querySelector('#load');const context=canvas.getContext('2d');let frames=0;let ready;
window.__renderReady=new Promise(resolve=>{ready=resolve});
function draw(time){for(let i=0;i<720;i++){const x=(i*37+time/3)%1440;const y=(i*53+time/5)%900;context.fillStyle='hsl('+((i+time/20)%360)+' 75% 50%)';context.fillRect(x,y,24,24)}frames+=1;if(frames===3)ready({ready:true,frames,trialId});requestAnimationFrame(draw)}
requestAnimationFrame(draw);})();</script></body></html>`;
}

function fixtureUrl(baseUrl, kind, trialId) {
  return `${baseUrl}/${kind}/${encodeURIComponent(trialId)}`;
}

function jsonForInlineScript(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
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
    if (pages.length > 1) throw new Error(`expected one synthetic page, found ${pages.length}`);
    await sleep(POLL_MS);
  }
  throw new Error(`synthetic page readiness timed out after ${timeoutMs}ms (found ${lastCount}${lastUrl ? ` at ${lastUrl}` : ''})`);
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

function centerOfQuad(quad) {
  if (!Array.isArray(quad) || quad.length !== 8 || quad.some((value) => !Number.isFinite(value))) {
    throw new Error('DOM.getBoxModel did not return a usable input target');
  }
  return {
    x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
    y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4
  };
}

function runtimeValue(evaluation, label) {
  if (evaluation?.exceptionDetails) throw new Error(`${label} raised a JavaScript exception`);
  if (!evaluation?.result || !('value' in evaluation.result)) throw new Error(`${label} did not return a value`);
  return evaluation.result.value;
}

function monotonicMs() {
  return Number((performance.now() - probeStartedAt).toFixed(3));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
