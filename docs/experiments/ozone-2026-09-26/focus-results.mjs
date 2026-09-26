export function mustStop(result) {
  return result.cleanup?.confirmed !== true ||
    (result.status === 'fail' &&
      (!result.initial || result.commands?.some(command => command.ok === false)));
}

export function classifyTrials(results, plannedTrials, harnessFailures) {
  const validInputTrials = results.filter(result => Array.isArray(result.events) &&
    ['measure:key-down', 'measure:key-up'].every(phase =>
      result.commands?.some(command => command.phase === phase && command.ok === true))).length;
  const invalid = harnessFailures.length > 0 || results.some(mustStop);
  const failed = results.some(result => result.status !== 'pass');
  return {
    plannedTrials,
    attemptedTrials: results.length,
    validInputTrials,
    unattemptedTrials: plannedTrials - results.length,
    outcome: invalid ? 'INVALID_INFRASTRUCTURE' : failed ? 'FAIL' :
      validInputTrials !== plannedTrials ? 'INCOMPLETE' : 'INCONCLUSIVE_NON_REPRODUCTION'
  };
}
