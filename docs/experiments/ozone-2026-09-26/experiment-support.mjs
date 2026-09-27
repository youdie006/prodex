const FOCUS_TRIAL_IDS = Object.freeze(['cold-A', 'cold-B', 'restart-B', 'restart-A']);

export const FOCUS_TRIALS = Object.freeze([
  focusTrial({ trial: 1, id: 'cold-A', pair: 1, startup: 'cold', arm: 'A', armOrder: ['A', 'B'], armPosition: 1 }),
  focusTrial({ trial: 2, id: 'cold-B', pair: 1, startup: 'cold', arm: 'B', armOrder: ['A', 'B'], armPosition: 2 }),
  focusTrial({ trial: 3, id: 'restart-B', pair: 2, startup: 'restart', arm: 'B', armOrder: ['B', 'A'], armPosition: 1 }),
  focusTrial({ trial: 4, id: 'restart-A', pair: 2, startup: 'restart', arm: 'A', armOrder: ['B', 'A'], armPosition: 2 })
]);

export function selectFocusTrials(value) {
  if (value === undefined) return [...FOCUS_TRIALS];
  if (!FOCUS_TRIAL_IDS.includes(value)) {
    throw new Error(`PRODEX_FOCUS_TRIAL must be unset or exactly one of: ${FOCUS_TRIAL_IDS.join(', ')}`);
  }
  return [FOCUS_TRIALS.find((trial) => trial.id === value)];
}

export function parseExternalLoad(value) {
  if (value === undefined) return false;
  if (value === '1') return true;
  throw new Error('PRODEX_FOCUS_EXTERNAL_LOAD must be unset or exactly 1');
}

export function externalLoadEvidence(requested) {
  return {
    requested,
    observedByTarget: false,
    readiness: requested ? 'not-observed-by-target' : 'not-requested',
    coordinatorRequired: requested
  };
}

export function parseLoadHoldDurationMs(value) {
  if (value === undefined) return 90_000;
  if (!/^(?:[1-9]|[1-9][0-9]|1[0-7][0-9]|180)$/.test(value)) {
    throw new Error('PRODEX_LOAD_HOLD_SECONDS must be an integer from 1 through 180');
  }
  return Number(value) * 1_000;
}

export function renderFixtureHtml(loadId) {
  const id = JSON.stringify(loadId).replaceAll('<', '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Synthetic render load</title>
<style>html,body,canvas{margin:0;width:100%;height:100%;display:block;background:#fff}</style></head><body>
<canvas id="load" width="1440" height="900"></canvas><script>(()=>{
const loadId=${id};const canvas=document.querySelector('#load');const context=canvas.getContext('2d');
const state={loadId,frames:0,lastFrameTimeMs:null};let ready;window.__renderLoadState=state;
window.__renderReady=new Promise(resolve=>{ready=resolve});
function draw(time){for(let i=0;i<720;i++){const x=(i*37+time/3)%1440;const y=(i*53+time/5)%900;context.fillStyle='hsl('+((i+time/20)%360)+' 75% 50%)';context.fillRect(x,y,24,24)}state.frames+=1;state.lastFrameTimeMs=time;if(state.frames===3)ready({ready:true,frames:state.frames,loadId});requestAnimationFrame(draw)}
requestAnimationFrame(draw);})();</script></body></html>`;
}

export function loadReadyRecord({ arch, configuredDurationMs, browser, motion, resources }) {
  return {
    kind: 'render-load-ready',
    schemaVersion: 1,
    marker: 'READY',
    arch,
    configuredDurationMs,
    browser,
    motion,
    resources,
    resourceScope: 'load-container-only',
    profilePolicy: 'ephemeral-disposable',
    publicNavigation: 'not_tested',
    authenticationData: 'not_accessed'
  };
}

export function loadFinalRecord({
  arch,
  outcome,
  phase,
  stopReason,
  readyEmitted,
  configuredDurationMs,
  heldMs,
  finalEvidence,
  cleanup,
  resources,
  failure
}) {
  return {
    kind: 'render-load-final',
    schemaVersion: 1,
    arch,
    outcome,
    phase,
    stopReason,
    readyEmitted,
    configuredDurationMs,
    heldMs,
    finalEvidence,
    cleanup,
    resources,
    resourceScope: 'load-container-only',
    failure,
    publicNavigation: 'not_tested',
    authenticationData: 'not_accessed'
  };
}

export async function runCleanupSteps(steps) {
  const errors = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      errors.push({ phase: step.phase, message: errorMessage(error) });
    }
  }
  return { confirmed: errors.length === 0, errors };
}

export function mergeCleanupReports(reports) {
  const errors = reports.flatMap((report) => report.errors);
  return { confirmed: errors.length === 0, errors };
}

function focusTrial(value) {
  return Object.freeze({
    ...value,
    repeat: 1,
    armOrder: Object.freeze([...value.armOrder])
  });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
