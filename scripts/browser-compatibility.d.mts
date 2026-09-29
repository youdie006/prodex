export interface BrowserCompatibilityCapabilities {
  runtimeEnabled: boolean;
  runtimeEvaluated: boolean;
  domEnabled: boolean;
  keyboardInput: boolean;
  mouseInput: boolean;
  fileAttachment: boolean;
  profileRestartMarker: boolean;
}

interface BrowserCompatibilityEvidenceBase {
  browser: string;
  protocol: string;
  platform: string;
  arch: string;
  runtime_enable: true;
  runtime_evaluate: true;
  dom: true;
  keyboard: true;
  mouse: true;
  file_attachment: true;
  profile_restart: "synthetic_marker";
}

interface BrowserCompatibilityInputBase {
  cdpVersion: Record<string, unknown>;
  platform: string;
  arch: string;
  capabilities: BrowserCompatibilityCapabilities;
}

interface HeadlessBrowserCompatibilityEvidence extends BrowserCompatibilityEvidenceBase {
  headless_process: true;
  headed_process?: never;
}

interface HeadedBrowserCompatibilityEvidence extends BrowserCompatibilityEvidenceBase {
  headless_process?: never;
  headed_process: true;
}

export type BrowserCompatibilityEvidence =
  | HeadlessBrowserCompatibilityEvidence
  | HeadedBrowserCompatibilityEvidence;

type BrowserCompatibilityInput =
  | (BrowserCompatibilityInputBase & { headlessProcess: boolean; headedProcess?: boolean })
  | (BrowserCompatibilityInputBase & { headlessProcess?: boolean; headedProcess: boolean });

export function createBrowserCompatibilityEvidence(
  input: BrowserCompatibilityInputBase & { headlessProcess: true; headedProcess?: false }
): HeadlessBrowserCompatibilityEvidence;
export function createBrowserCompatibilityEvidence(
  input: BrowserCompatibilityInputBase & { headlessProcess?: false; headedProcess: true }
): HeadedBrowserCompatibilityEvidence;
export function createBrowserCompatibilityEvidence(input: BrowserCompatibilityInput): BrowserCompatibilityEvidence;
