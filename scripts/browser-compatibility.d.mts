export interface BrowserCompatibilityCapabilities {
  runtimeEnabled: boolean;
  runtimeEvaluated: boolean;
  domEnabled: boolean;
  keyboardInput: boolean;
  mouseInput: boolean;
  fileAttachment: boolean;
  profileRestartMarker: boolean;
}

export interface BrowserCompatibilityEvidence {
  browser: string;
  protocol: string;
  platform: string;
  arch: string;
  headless_process: true;
  runtime_enable: true;
  runtime_evaluate: true;
  dom: true;
  keyboard: true;
  mouse: true;
  file_attachment: true;
  profile_restart: "synthetic_marker";
}

export function createBrowserCompatibilityEvidence(input: {
  cdpVersion: Record<string, unknown>;
  platform: string;
  arch: string;
  headlessProcess: boolean;
  capabilities: BrowserCompatibilityCapabilities;
}): BrowserCompatibilityEvidence;
