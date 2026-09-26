import assert from 'node:assert/strict';
import { test } from 'vitest';
import { classifyTrials, mustStop } from './focus-results.mjs';

const measured = () => ({
  status: 'pass', initial: {}, events: [], cleanup: { confirmed: true },
  commands: ['measure:key-down', 'measure:key-up'].map(phase => ({ phase, ok: true }))
});

test('pre-input and cleanup failures stop subsequent trials', () => {
  assert.equal(mustStop({ status: 'fail', cleanup: { confirmed: true } }), true);
  assert.equal(mustStop({ ...measured(), cleanup: { confirmed: false } }), true);
  assert.equal(mustStop({ ...measured(), status: 'fail', commands: [{ ok: false }] }), true);
  assert.equal(mustStop({ ...measured(), status: 'fail' }), false);
});

test('attempts are not measurements and an incomplete matrix cannot pass', () => {
  const failed = { status: 'fail', cleanup: { confirmed: false }, commands: [] };
  const result = classifyTrials([measured(), measured(), failed], 16, []);
  assert.deepEqual(result, {
    plannedTrials: 16, attemptedTrials: 3, validInputTrials: 2,
    unattemptedTrials: 13, outcome: 'INVALID_INFRASTRUCTURE'
  });
  assert.equal(classifyTrials([measured()], 16, []).outcome, 'INCOMPLETE');
  assert.equal(classifyTrials([measured()], 1, []).outcome, 'INCONCLUSIVE_NON_REPRODUCTION');
});

test('observed input failures stay failures; harness errors invalidate the run', () => {
  assert.equal(classifyTrials([{ ...measured(), status: 'fail' }], 1, []).outcome, 'FAIL');
  assert.equal(classifyTrials([measured()], 1, [{}]).outcome, 'INVALID_INFRASTRUCTURE');
  const missingTrace = { ...measured(), events: undefined };
  assert.equal(classifyTrials([missingTrace], 1, []).validInputTrials, 0);
  assert.notEqual(classifyTrials([missingTrace], 1, []).outcome, 'INCONCLUSIVE_NON_REPRODUCTION');
});
