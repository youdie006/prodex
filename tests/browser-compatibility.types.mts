import {
  createBrowserCompatibilityEvidence,
  type BrowserCompatibilityEvidence
} from "../scripts/browser-compatibility.mjs";

const capabilities = {
  runtimeEnabled: true,
  runtimeEvaluated: true,
  domEnabled: true,
  keyboardInput: true,
  mouseInput: true,
  fileAttachment: true,
  profileRestartMarker: true
};

const commonInput = {
  cdpVersion: { Browser: "Chrome/145.0.7632.76", "Protocol-Version": "1.3" },
  platform: "linux",
  arch: "x64",
  capabilities
};

const headedEvidence = createBrowserCompatibilityEvidence({
  ...commonInput,
  headedProcess: true
});
const headedMarker: true = headedEvidence.headed_process;
const absentHeadlessMarker: undefined = headedEvidence.headless_process;

const headlessEvidence = createBrowserCompatibilityEvidence({
  ...commonInput,
  headlessProcess: true
});
const headlessMarker: true = headlessEvidence.headless_process;
const absentHeadedMarker: undefined = headlessEvidence.headed_process;

const commonEvidence = {
  browser: "Chrome/145.0.7632.76",
  protocol: "1.3",
  platform: "linux",
  arch: "x64",
  runtime_enable: true,
  runtime_evaluate: true,
  dom: true,
  keyboard: true,
  mouse: true,
  file_attachment: true,
  profile_restart: "synthetic_marker"
} as const;

// @ts-expect-error compatibility evidence contains exactly one true process marker
const contradictoryEvidence: BrowserCompatibilityEvidence = { ...commonEvidence, headless_process: true, headed_process: true };

void [headedMarker, absentHeadlessMarker, headlessMarker, absentHeadedMarker, contradictoryEvidence];
