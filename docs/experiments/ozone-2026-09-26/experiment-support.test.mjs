import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  externalLoadEvidence,
  loadFinalRecord,
  loadReadyRecord,
  mergeCleanupReports,
  parseExternalLoad,
  parseLoadHoldDurationMs,
  renderFixtureHtml,
  runCleanupSteps,
  selectFocusTrials
} from './experiment-support.mjs';

test('default focus plan is the exact cold AB and restart BA sequence', () => {
  const trials = selectFocusTrials(undefined);

  assert.deepEqual(trials.map(({ id, startup, arm, armPosition }) => ({ id, startup, arm, armPosition })), [
    { id: 'cold-A', startup: 'cold', arm: 'A', armPosition: 1 },
    { id: 'cold-B', startup: 'cold', arm: 'B', armPosition: 2 },
    { id: 'restart-B', startup: 'restart', arm: 'B', armPosition: 1 },
    { id: 'restart-A', startup: 'restart', arm: 'A', armPosition: 2 }
  ]);
  assert.deepEqual(trials.map((trial) => trial.armOrder.join('')), ['AB', 'AB', 'BA', 'BA']);
});

test('focus selector permits one exact predeclared trial and rejects unsafe selectors', () => {
  for (const id of ['cold-A', 'cold-B', 'restart-B', 'restart-A']) {
    assert.deepEqual(selectFocusTrials(id).map((trial) => trial.id), [id]);
  }

  for (const value of ['', 'all', '*', 'cold-A,restart-A', ' cold-A', '../../cold-A', 'cold-a']) {
    assert.throws(() => selectFocusTrials(value), /PRODEX_FOCUS_TRIAL/);
  }
});

test('external load is opt-in only and is never represented as target-observed', () => {
  assert.equal(parseExternalLoad(undefined), false);
  assert.equal(parseExternalLoad('1'), true);
  for (const value of ['', '0', 'true', 'yes', '2']) {
    assert.throws(() => parseExternalLoad(value), /PRODEX_FOCUS_EXTERNAL_LOAD/);
  }

  assert.deepEqual(externalLoadEvidence(true), {
    requested: true,
    observedByTarget: false,
    readiness: 'not-observed-by-target',
    coordinatorRequired: true
  });
  assert.deepEqual(externalLoadEvidence(false), {
    requested: false,
    observedByTarget: false,
    readiness: 'not-requested',
    coordinatorRequired: false
  });
});

test('load holder defaults to 90 seconds and rejects unbounded durations', () => {
  assert.equal(parseLoadHoldDurationMs(undefined), 90_000);
  assert.equal(parseLoadHoldDurationMs('1'), 1_000);
  assert.equal(parseLoadHoldDurationMs('180'), 180_000);

  for (const value of ['', '0', '-1', '1.5', '181', 'Infinity', ' 90', '090']) {
    assert.throws(() => parseLoadHoldDurationMs(value), /PRODEX_LOAD_HOLD_SECONDS/);
  }
});

test('render fixture exposes advancing animation state without injecting its identifier', () => {
  const html = renderFixtureHtml('load</script><script>bad()</script>');

  assert.match(html, /window\.__renderReady/);
  assert.match(html, /window\.__renderLoadState/);
  assert.match(html, /requestAnimationFrame\(draw\)/);
  assert.match(html, /state\.frames\+=1/);
  assert.doesNotMatch(html, /<script>bad\(\)<\/script>/);
});

test('cleanup runs every bounded step and reports failures without hiding later success', async () => {
  const order = [];
  const report = await runCleanupSteps([
    { phase: 'cleanup:browser', run: async () => { order.push('browser'); throw new Error('still alive'); } },
    { phase: 'cleanup:fixture', run: async () => { order.push('fixture'); } }
  ]);

  assert.deepEqual(order, ['browser', 'fixture']);
  assert.deepEqual(report, {
    confirmed: false,
    errors: [{ phase: 'cleanup:browser', message: 'still alive' }]
  });
  assert.deepEqual(mergeCleanupReports([
    report,
    { confirmed: true, errors: [] }
  ]), report);
});

test('load holder records expose stable coordinator keys', () => {
  const ready = loadReadyRecord({
    arch: 'x64', configuredDurationMs: 90_000, browser: {}, motion: {}, resources: {}
  });
  assert.deepEqual(Object.keys(ready), [
    'kind', 'schemaVersion', 'marker', 'arch', 'configuredDurationMs', 'browser', 'motion',
    'resources', 'resourceScope', 'profilePolicy', 'publicNavigation', 'authenticationData'
  ]);
  assert.equal(ready.kind, 'render-load-ready');
  assert.equal(ready.marker, 'READY');

  const final = loadFinalRecord({
    arch: 'x64', outcome: 'PASS', phase: 'complete', stopReason: 'duration', readyEmitted: true,
    configuredDurationMs: 90_000, heldMs: 90_001, finalEvidence: {},
    cleanup: { confirmed: true, errors: [] },
    resources: {}, failure: null
  });
  assert.deepEqual(Object.keys(final), [
    'kind', 'schemaVersion', 'arch', 'outcome', 'phase', 'stopReason', 'readyEmitted',
    'configuredDurationMs', 'heldMs', 'finalEvidence', 'cleanup', 'resources', 'resourceScope', 'failure',
    'publicNavigation', 'authenticationData'
  ]);
  assert.equal(final.kind, 'render-load-final');
});
