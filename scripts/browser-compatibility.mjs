const CHROMIUM_BROWSER_PATTERN = /^(?:Chrome|HeadlessChrome|Chromium|Edg|Microsoft Edge)\/\d+(?:\.\d+){1,3}$/;
const EVIDENCE_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const REQUIRED_CAPABILITIES = [
  ["runtimeEnabled", "Runtime.enable"],
  ["runtimeEvaluated", "Runtime.evaluate"],
  ["domEnabled", "DOM"],
  ["keyboardInput", "keyboard input"],
  ["mouseInput", "mouse input"],
  ["fileAttachment", "file attachment"],
  ["profileRestartMarker", "profile restart marker"]
];

export function createBrowserCompatibilityEvidence(input) {
  const cdpVersion = input?.cdpVersion;
  if (!cdpVersion || typeof cdpVersion !== "object" || Array.isArray(cdpVersion)) {
    throw new Error("CDP browser metadata is missing");
  }
  const browser = cdpVersion.Browser;
  if (typeof browser !== "string" || browser.length === 0) {
    throw new Error("CDP browser metadata is missing");
  }
  if (!CHROMIUM_BROWSER_PATTERN.test(browser)) {
    throw new Error("CDP did not report Chromium-compatible browser metadata");
  }

  const protocol = cdpVersion["Protocol-Version"];
  if (typeof protocol !== "string" || protocol.length === 0) {
    throw new Error("CDP protocol metadata is missing");
  }
  if (!/^\d+\.\d+$/.test(protocol)) {
    throw new Error("CDP protocol metadata is invalid");
  }

  const platform = evidenceToken(input.platform, "platform");
  const arch = evidenceToken(input.arch, "arch");
  const headlessProcess = input.headlessProcess === true;
  const headedProcess = input.headedProcess === true;
  if (headlessProcess && headedProcess) {
    throw new Error("Conflicting inspected browser process mode evidence");
  }
  if (!headlessProcess && !headedProcess) {
    throw new Error("Inspected browser identity did not prove a headless process or a headed process");
  }
  for (const [capability, label] of REQUIRED_CAPABILITIES) {
    if (input.capabilities?.[capability] !== true) {
      throw new Error(`Browser compatibility smoke did not prove ${label}`);
    }
  }

  return {
    browser,
    protocol,
    platform,
    arch,
    ...(headlessProcess ? { headless_process: true } : { headed_process: true }),
    runtime_enable: true,
    runtime_evaluate: true,
    dom: true,
    keyboard: true,
    mouse: true,
    file_attachment: true,
    profile_restart: "synthetic_marker"
  };
}

function evidenceToken(value, label) {
  if (typeof value !== "string" || !EVIDENCE_TOKEN_PATTERN.test(value)) {
    throw new Error(`Browser compatibility ${label} evidence is invalid`);
  }
  return value;
}
