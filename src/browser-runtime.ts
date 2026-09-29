import { realpathSync } from "node:fs";
import path from "node:path";
import type { BrowserLoginLaunchRecord } from "./chatgpt-browser.js";
import {
  browserProcessFlagValue,
  browserProcessHasFlag,
  findBrowserProcessesByPort,
  inspectBrowserProcesses,
  isMainBrowserProcess
} from "./browser-process.js";

export interface BrowserRuntimeInfo {
  platform: NodeJS.Platform;
  arch: string;
  metadata: "available" | "unavailable" | "unsupported";
  browser_product: string | null;
  protocol_version: string | null;
  process_identity: "verified" | "unverified";
  actual_mode: "headless" | "headed" | "unknown";
  saved_mode: "headless" | "headed" | "virtual-display" | "unknown";
  resume_headless: boolean | null;
  mode_matches_saved: boolean | null;
}

function canonicalProfile(profile: string): string {
  let resolved = profile;
  try { resolved = realpathSync(profile); } catch { /* Missing paths remain comparable as reported. */ }
  const normalized = path.normalize(resolved);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

/** Evidence only: this never changes a browser, reads account state, or declares ChatGPT ready. */
export async function getBrowserRuntimeInfo(options: {
  port: number;
  timeoutMs?: number;
  savedLaunch?: Partial<BrowserLoginLaunchRecord>;
}): Promise<BrowserRuntimeInfo> {
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error("Invalid browser runtime port.");
  const timeoutMs = options.timeoutMs ?? 1500;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid browser runtime timeout.");
  const result: BrowserRuntimeInfo = {
    platform: process.platform, arch: process.arch,
    metadata: "unavailable", browser_product: null, protocol_version: null,
    process_identity: "unverified", actual_mode: "unknown", saved_mode: "unknown",
    resume_headless: null, mode_matches_saved: null
  };
  try {
    const response = await fetch(`http://127.0.0.1:${options.port}/json/version`, {
      redirect: "error", signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) throw new Error("Runtime endpoint unavailable.");
    const data: unknown = await response.json();
    const metadata = data && typeof data === "object" ? data as Record<string, unknown> : {};
    const product = metadata.Browser;
    const protocol = metadata["Protocol-Version"];
    result.metadata = "unsupported";
    if (typeof product === "string" && /^(?:HeadlessChrome|Chrome|Chromium|Edg|Edge|Brave)\/\d+(?:\.\d+){1,3}$/.test(product) &&
        typeof protocol === "string" && /^\d+\.\d+$/.test(protocol)) {
      result.metadata = "available";
      result.browser_product = product;
      result.protocol_version = protocol;
    }
  } catch {
    // A dead endpoint is not evidence that authentication was lost.
  }
  try {
    const processes = inspectBrowserProcesses();
    const mains = findBrowserProcessesByPort(processes, { port: options.port }).filter(isMainBrowserProcess);
    if (mains.length !== 1) return result;
    const main = mains[0];
    result.process_identity = "verified";
    result.actual_mode = browserProcessHasFlag(main, "headless") ? "headless" : "headed";
    const saved = options.savedLaunch;
    const actualProfile = browserProcessFlagValue(main, "user-data-dir");
    if (saved?.port !== options.port || !saved.profile_dir || !actualProfile ||
        browserProcessHasFlag(main, "incognito") || browserProcessHasFlag(main, "guest")) return result;
    if (canonicalProfile(actualProfile) !== canonicalProfile(saved.profile_dir)) return result;
    result.saved_mode = saved.headless === true ? "headless" : typeof saved.virtual_display === "number" ? "virtual-display" : "headed";
    result.resume_headless = saved.resume_headless === true;
    // A headed flag alone cannot prove which display actually hosts the process.
    result.mode_matches_saved = result.saved_mode === "virtual-display" ? null : result.saved_mode === result.actual_mode;
  } catch {
    // Preserve available metadata when OS process identity cannot be inspected.
  }
  return result;
}
