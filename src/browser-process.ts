import { spawnSync } from "node:child_process";
import path from "node:path";

export interface BrowserProcessInfo {
  executablePath: string;
  processId: number;
  commandLine: string;
}

interface ProcessListRunResult {
  status: number | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  error?: Error;
}

export type ProcessListRunner = (
  command: string,
  args: string[],
  options: { encoding: "utf8"; timeout: number; maxBuffer: number; windowsHide: boolean }
) => ProcessListRunResult;

export class BrowserProcessInspectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserProcessInspectionError";
  }
}

const WINDOWS_CIM_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
  "$items = @(Get-CimInstance -ClassName Win32_Process -Filter \"Name = 'chrome.exe' OR Name = 'chromium.exe' OR Name = 'msedge.exe' OR Name = 'brave.exe'\" -Property ExecutablePath,ProcessId,CommandLine | Select-Object ExecutablePath,ProcessId,CommandLine)",
  "ConvertTo-Json -Compress -InputObject $items"
].join("; ");

const WINDOWS_PROCESS_ARGS = [
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  WINDOWS_CIM_SCRIPT
];

const POSIX_MAIN_EXECUTABLES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
] as const;

const MAC_HELPER_EXECUTABLE = /^\/Applications\/(?:Google Chrome|Chromium|Microsoft Edge|Brave Browser)\.app\/Contents\/Frameworks\/.*?\/Helpers\/(?:Google Chrome|Chromium|Microsoft Edge|Brave Browser) Helper(?: \([^)]*\))?/i;
const BROWSER_BASENAME = /^(?:google[ -]?chrome|chromium(?:-browser)?|chrome|microsoft[ -]edge|msedge|brave[ -]browser|brave)(?:\.exe)?$/i;

function resultText(value: string | Buffer | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return undefined;
}

function defaultProcessListRunner(
  command: string,
  args: string[],
  options: { encoding: "utf8"; timeout: number; maxBuffer: number; windowsHide: boolean }
): ProcessListRunResult {
  return spawnSync(command, args, options);
}

/** Read process identity without passing a port, profile, or other user data to a shell. */
export function inspectBrowserProcesses(options: {
  platform?: NodeJS.Platform;
  run?: ProcessListRunner;
} = {}): BrowserProcessInfo[] {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? defaultProcessListRunner;
  const command = platform === "win32" ? "powershell.exe" : "ps";
  const args = platform === "win32" ? WINDOWS_PROCESS_ARGS : ["-Ao", "user,pid,command"];
  const listed = run(command, [...args], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true
  });
  const stdout = resultText(listed.stdout);
  if (listed.error || listed.status !== 0 || stdout === undefined) {
    throw new BrowserProcessInspectionError("Could not inspect browser processes.");
  }
  return platform === "win32" ? parseWindowsCimProcessJson(stdout) : parsePosixProcessList(stdout);
}

export function parseWindowsCimProcessJson(raw: string): BrowserProcessInfo[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim() || "[]");
  } catch {
    throw new BrowserProcessInspectionError("Windows browser process inspection returned invalid JSON.");
  }
  const entries = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? [parsed] : undefined;
  if (!entries) throw new BrowserProcessInspectionError("Windows browser process inspection returned an invalid result.");
  return entries.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw new BrowserProcessInspectionError("Windows could not provide complete browser process identity.");
    }
    const record = entry as { ExecutablePath?: unknown; ProcessId?: unknown; CommandLine?: unknown };
    if (typeof record.ExecutablePath !== "string" || record.ExecutablePath.length === 0 ||
        !Number.isInteger(record.ProcessId) || Number(record.ProcessId) <= 0 ||
        typeof record.CommandLine !== "string" || record.CommandLine.length === 0) {
      throw new BrowserProcessInspectionError("Windows could not provide complete browser process identity.");
    }
    return {
      executablePath: record.ExecutablePath,
      processId: Number(record.ProcessId),
      commandLine: record.CommandLine
    };
  });
}

export function parsePosixProcessList(raw: string): BrowserProcessInfo[] {
  const processes: BrowserProcessInfo[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*\S+\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const processId = Number(match[1]);
    const commandLine = match[2];
    const executablePath = posixBrowserExecutable(commandLine);
    if (!executablePath || !Number.isSafeInteger(processId) || processId <= 0) continue;
    processes.push({ executablePath, processId, commandLine });
  }
  return processes;
}

function posixBrowserExecutable(commandLine: string): string | undefined {
  for (const executable of POSIX_MAIN_EXECUTABLES) {
    if (commandLine === executable || (commandLine.startsWith(executable) && /^\s--/.test(commandLine.slice(executable.length)))) {
      return executable;
    }
  }
  const helper = MAC_HELPER_EXECUTABLE.exec(commandLine)?.[0];
  if (helper && (helper.length === commandLine.length || /^\s--/.test(commandLine.slice(helper.length)))) return helper;
  const firstToken = commandLine.split(/\s+/, 1)[0];
  return BROWSER_BASENAME.test(path.posix.basename(firstToken)) ? firstToken : undefined;
}

function flagValue(commandLine: string, flag: string): string | undefined {
  const escapedFlag = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const wholeArgumentQuoted = new RegExp(`(?:^|\\s)\"--${escapedFlag}=([^\"]*)\"(?=\\s|$)`, "i").exec(commandLine);
  if (wholeArgumentQuoted) return wholeArgumentQuoted[1].trim();
  const match = new RegExp(
    `(?:^|\\s)--${escapedFlag}=(?:\"([^\"]*)\"|'([^']*)'|(.+?))(?=\\s+\"?--[A-Za-z0-9-]+(?:=|\\s|$)|\\s*$)`,
    "i"
  ).exec(commandLine);
  return match ? (match[1] ?? match[2] ?? match[3])?.trim() : undefined;
}

export function browserProcessFlagValue(processInfo: BrowserProcessInfo, flag: string): string | undefined {
  return flagValue(processInfo.commandLine, flag);
}

export function browserProcessHasFlag(processInfo: BrowserProcessInfo, flag: string): boolean {
  const escapedFlag = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)(?:\"--${escapedFlag}(?:=[^\"]*)?\"|--${escapedFlag})(?==|\\s|$)`, "i").test(processInfo.commandLine);
}

function isMainBrowserExecutable(processInfo: BrowserProcessInfo): boolean {
  const normalized = processInfo.executablePath.replaceAll("\\", "/");
  if (/\/Helpers\//i.test(normalized)) return false;
  return BROWSER_BASENAME.test(path.posix.basename(normalized)) || POSIX_MAIN_EXECUTABLES.includes(normalized as typeof POSIX_MAIN_EXECUTABLES[number]);
}

export function isMainBrowserProcess(processInfo: BrowserProcessInfo): boolean {
  return isMainBrowserExecutable(processInfo) && !browserProcessHasFlag(processInfo, "type");
}

export function assertLaunchedBrowserMainProcess(
  processes: BrowserProcessInfo[],
  launchedProcessId: number
): BrowserProcessInfo {
  const mains = processes.filter(isMainBrowserProcess);
  if (!Number.isSafeInteger(launchedProcessId) || launchedProcessId <= 0 ||
      mains.length !== 1 || mains[0].processId !== launchedProcessId) {
    throw new BrowserProcessInspectionError("The inspected browser main process does not match the process launched by prodex.");
  }
  return mains[0];
}

function isBrowserProcess(processInfo: BrowserProcessInfo): boolean {
  const normalized = processInfo.executablePath.replaceAll("\\", "/");
  return BROWSER_BASENAME.test(path.posix.basename(normalized)) || MAC_HELPER_EXECUTABLE.test(normalized);
}

function normalizedProfile(value: string, platform: NodeJS.Platform): string {
  if (platform === "win32") return path.win32.normalize(value).toLocaleLowerCase("en-US");
  return path.posix.normalize(value);
}

export function findMatchingBrowserProcesses(
  processes: BrowserProcessInfo[],
  input: { platform?: NodeJS.Platform; port: number; profileDir: string }
): BrowserProcessInfo[] {
  const platform = input.platform ?? process.platform;
  const expectedProfile = normalizedProfile(input.profileDir, platform);
  const sameProfile = (processInfo: BrowserProcessInfo): boolean => {
    const profile = browserProcessFlagValue(processInfo, "user-data-dir");
    return profile !== undefined && normalizedProfile(profile, platform) === expectedProfile;
  };
  const mains = processes.filter((processInfo) => {
    if (!isMainBrowserProcess(processInfo) || !sameProfile(processInfo)) return false;
    const port = browserProcessFlagValue(processInfo, "remote-debugging-port");
    return port !== undefined && Number(port) === input.port && /^\d+$/.test(port);
  });
  if (mains.length === 0) return [];
  const mainIds = new Set(mains.map((processInfo) => processInfo.processId));
  const children = processes.filter((processInfo) => {
    return !mainIds.has(processInfo.processId) && isBrowserProcess(processInfo) && sameProfile(processInfo);
  });
  return [...mains, ...children];
}

export function findBrowserProcessesByPort(
  processes: BrowserProcessInfo[],
  input: { platform?: NodeJS.Platform; port: number; fallbackProfileDir?: string }
): BrowserProcessInfo[] {
  const mains = processes.filter((processInfo) => {
    if (!isMainBrowserProcess(processInfo)) return false;
    const port = browserProcessFlagValue(processInfo, "remote-debugging-port");
    return port !== undefined && /^\d+$/.test(port) && Number(port) === input.port;
  });
  if (mains.length === 0) return [];
  if (mains.length !== 1) {
    throw new BrowserProcessInspectionError("More than one browser main process claims the requested debugging port.");
  }
  const profileDir = browserProcessFlagValue(mains[0], "user-data-dir") ?? input.fallbackProfileDir;
  if (!profileDir) {
    throw new BrowserProcessInspectionError("The browser on the requested debugging port did not expose its profile identity.");
  }
  return findMatchingBrowserProcesses(processes, {
    platform: input.platform,
    port: input.port,
    profileDir
  });
}
