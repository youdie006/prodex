import { formatCliCommand, formatSourceCliOption, shellQuote } from "./cli-args.js";

export type BrowserCommandOptions = {
  cwd?: string;
  profileDir?: string;
  port?: number;
  targetUrl?: string;
  url?: string;
  launchTimeoutMs?: number;
};

export function formatInitCommand(sourceCli?: string, options: { cwd?: string } = {}): string {
  return [`${formatCliCommand(sourceCli)} init`, options.cwd ? `--cwd ${shellQuote(options.cwd)}` : undefined].filter(Boolean).join(" ");
}

export function formatSetupCommand(sourceCli?: string, options: { cwd?: string } = {}): string {
  return [`${formatCliCommand(sourceCli)} setup`, options.cwd ? `--cwd ${shellQuote(options.cwd)}` : undefined].filter(Boolean).join(" ");
}

export function formatBrowserLoginCommand(sourceCli?: string, options: BrowserCommandOptions = {}): string {
  return formatCommandInCwd(formatBrowserLoginCommandBody(sourceCli, options), options.cwd);
}

export function formatBrowserSmokeCommand(sourceCli?: string, options: BrowserCommandOptions = {}): string {
  return formatCommandInCwd(formatBrowserSmokeCommandBody(sourceCli, options), options.cwd);
}

export function formatBrowserCheckCommand(sourceCli?: string, options: BrowserCommandOptions = {}): string {
  const command = [`${formatCliCommand(sourceCli)} pro browser check${formatSourceCliOption(sourceCli)}`, options.port ? `--port ${options.port}` : undefined]
    .filter(Boolean)
    .join(" ");
  return formatCommandInCwd(command, options.cwd);
}

export function formatBrowserTargetAskCommand(sourceCli?: string, options: BrowserCommandOptions = {}): string {
  const command = [
    `${formatCliCommand(sourceCli)} pro browser ask${formatSourceCliOption(sourceCli)}`,
    options.port ? `--port ${options.port}` : undefined,
    `--target-url ${options.targetUrl ? shellQuote(options.targetUrl) : "<chatgpt-url>"} --confirm-target "prompt"`
  ]
    .filter(Boolean)
    .join(" ");
  return formatCommandInCwd(command, options.cwd);
}

export function formatProShowCommand(taskId: string, sourceCli?: string, options: { cwd?: string } = {}): string {
  return [`${formatCliCommand(sourceCli)} pro show ${shellQuote(taskId)}${formatSourceCliOption(sourceCli)}`, options.cwd ? `--cwd ${shellQuote(options.cwd)}` : undefined]
    .filter(Boolean)
    .join(" ");
}

export function formatProLatestCommand(sourceCli?: string, options: { cwd?: string } = {}): string {
  return [`${formatCliCommand(sourceCli)} pro latest${formatSourceCliOption(sourceCli)}`, options.cwd ? `--cwd ${shellQuote(options.cwd)}` : undefined]
    .filter(Boolean)
    .join(" ");
}

export function sourceAwareResultMessage(message: string, sourceCli?: string, options: { cwd?: string } = {}): string {
  if (!sourceCli && !options.cwd) return message;
  return message.replace(
    /`prodex results reseal ([^`\s]+) --confirm-current-result`/g,
    (_match, taskId: string) => `\`${formatResultResealCommand(taskId, sourceCli, options)}\``
  );
}

export function sourceAwareResultError(error: unknown, sourceCli?: string, options: { cwd?: string } = {}): unknown {
  if (!isUntrustedResultError(error)) return error;
  return new Error(sourceAwareResultMessage(errorMessage(error), sourceCli, options), { cause: error });
}

export function formatBlockedConsultRecordedMessage(message: string, taskId: string, sourceCli?: string, options: { cwd?: string } = {}): string {
  return `${message}\nblocked consult recorded: ${taskId}; inspect with \`${formatProShowCommand(taskId, sourceCli, options)}\` or \`${formatProLatestCommand(sourceCli, options)}\`.`;
}

export function formatReleaseStatusCommand(sourceCli?: string, options: { cwd?: string } = {}): string {
  return [`${formatCliCommand(sourceCli)} release status${formatSourceCliOption(sourceCli)}`, options.cwd ? `--cwd ${shellQuote(options.cwd)}` : undefined]
    .filter(Boolean)
    .join(" ");
}

export function formatReleasePackCommand(sourceCli?: string, options: { cwd?: string } = {}): string {
  return [
    `${formatCliCommand(sourceCli)} release pack${formatSourceCliOption(sourceCli)}`,
    options.cwd ? `--cwd ${shellQuote(options.cwd)}` : undefined,
    "--pack-destination <dir>"
  ]
    .filter(Boolean)
    .join(" ");
}

export function sourceAwareBrowserNextStep(nextStep: string | undefined, sourceCli?: string, options: BrowserCommandOptions = {}): string | undefined {
  if (!nextStep) return nextStep;
  const targetRetry = nextStep.match(/^Open (https:\/\/chatgpt\.com\/\S+) in the (visible|dedicated) browser and retry(\. Current: .+|\.)$/);
  if (targetRetry) {
    const [, targetUrl, location, suffix] = targetRetry;
    return `Open ${targetUrl} in the ${location} browser and run \`${formatBrowserTargetAskCommand(sourceCli, {
      ...options,
      targetUrl
    })}\`${suffix}`;
  }
  if (!sourceCli && !options.port && !options.cwd) return nextStep;
  return nextStep
    .replace(/`cd (.+?) && prodex pro browser login([^`]*)?`/g, (_match, cwdPrefix: string, storedArgs: string | undefined) => {
      return `\`cd ${cwdPrefix} && ${formatBrowserLoginCommandBody(sourceCli, browserOptionsWithStoredPort(options, storedArgs))}\``;
    })
    .replace(/`cd (.+?) && prodex pro browser smoke([^`]*)?`/g, (_match, cwdPrefix: string, storedArgs: string | undefined) => {
      return `\`cd ${cwdPrefix} && ${formatBrowserSmokeCommandBody(sourceCli, browserOptionsWithStoredPort(options, storedArgs))}\``;
    })
    .replace(/`cd (.+?) && prodex pro browser ask([^`]*)?`/g, (_match, cwdPrefix: string, storedArgs: string | undefined) => {
      return `\`cd ${cwdPrefix} && ${formatBrowserAskCommandBody(sourceCli)}${storedArgs ?? ""}\``;
    })
    .replace(/`prodex pro browser login([^`]*)?`/g, (_match, storedArgs: string | undefined) => {
      return `\`${formatBrowserLoginCommand(sourceCli, browserOptionsWithStoredPort(options, storedArgs))}\``;
    })
    .replace(/`prodex pro browser smoke([^`]*)?`/g, (_match, storedArgs: string | undefined) => {
      return `\`${formatBrowserSmokeCommand(sourceCli, browserOptionsWithStoredPort(options, storedArgs))}\``;
    })
    .replace(/`prodex pro browser ask([^`]*)?`/g, (_match, storedArgs: string | undefined) => {
      return `\`${formatBrowserAskCommandBody(sourceCli)}${storedArgs ?? ""}\``;
    })
    .replaceAll("pass --target-url with --confirm-target", `run \`${formatBrowserTargetAskCommand(sourceCli, options)}\``);
}

export function sourceAwareBrowserBlocker<T extends { next_step?: string }>(blocker: T, sourceCli?: string, options: BrowserCommandOptions = {}): T {
  const nextStep = sourceAwareBrowserNextStep(blocker.next_step, sourceCli, options);
  return nextStep === blocker.next_step ? blocker : { ...blocker, next_step: nextStep };
}

export function sourceAwareSetupMessage(message: string, sourceCli?: string, options: { cwd?: string } = {}): string {
  if (!sourceCli && !options.cwd) return message;
  const setupCommand = formatSetupCommand(sourceCli, options);
  return message
    .replaceAll("`prodex setup --token-ttl-hours <hours>`", `\`${setupCommand} --token-ttl-hours <hours>\``)
    .replaceAll("`prodex setup`", `\`${setupCommand}\``);
}

export function sourceAwareReleaseMessage(message: string, sourceCli?: string, options: { cwd?: string } = {}): string {
  if (!sourceCli && !options.cwd) return message;
  return message
    .replaceAll("`prodex release pack --pack-destination <dir>`", `\`${formatReleasePackCommand(sourceCli, options)}\``)
    .replaceAll("`prodex release status`", `\`${formatReleaseStatusCommand(sourceCli, options)}\``);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isUntrustedResultError(error: unknown): error is Error & { code: "EUNTRUSTED_RESULT"; taskId: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "taskId" in error &&
    (error as { code?: unknown }).code === "EUNTRUSTED_RESULT" &&
    typeof (error as { taskId?: unknown }).taskId === "string"
  );
}

export function formatCommandInCwd(command: string, cwd?: string): string {
  return cwd ? `cd ${shellQuote(cwd)} && ${command}` : command;
}

export function browserOptionsWithStoredPort(options: BrowserCommandOptions, storedArgs?: string): BrowserCommandOptions {
  if (options.port || !storedArgs) return options;
  const match = storedArgs.match(/(?:^|\s)--port\s+(\d{1,5})(?:\s|$)/);
  if (!match) return options;
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return options;
  return { ...options, port };
}

export function formatBrowserSmokeCommandBody(sourceCli?: string, options: BrowserCommandOptions = {}): string {
  const command = [`${formatCliCommand(sourceCli)} pro browser smoke${formatSourceCliOption(sourceCli)}`, options.port ? `--port ${options.port}` : undefined]
    .filter(Boolean)
    .join(" ");
  return command;
}

export function formatBrowserLoginCommandBody(sourceCli?: string, options: BrowserCommandOptions = {}): string {
  const command = [
    `${formatCliCommand(sourceCli)} pro browser login${formatSourceCliOption(sourceCli)}`,
    options.profileDir ? `--profile-dir ${shellQuote(options.profileDir)}` : undefined,
    options.port ? `--port ${options.port}` : undefined,
    options.url ? `--url ${shellQuote(options.url)}` : undefined,
    options.launchTimeoutMs ? `--launch-timeout-ms ${options.launchTimeoutMs}` : undefined
  ]
    .filter(Boolean)
    .join(" ");
  return command;
}

// ask retry commands carry their own --target-url/--confirm-target/"prompt" tail, so callers
// preserve the stored argument tail verbatim and only re-point this bare base at the source CLI.
export function formatBrowserAskCommandBody(sourceCli?: string): string {
  return `${formatCliCommand(sourceCli)} pro browser ask${formatSourceCliOption(sourceCli)}`;
}

export function formatResultResealCommand(taskId: string, sourceCli?: string, options: { cwd?: string } = {}): string {
  return [
    `${formatCliCommand(sourceCli)} results reseal ${shellQuote(taskId)} --confirm-current-result`,
    options.cwd ? `--cwd ${shellQuote(options.cwd)}` : undefined
  ]
    .filter(Boolean)
    .join(" ");
}

export function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

export function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

export function firstLine(value: string): string {
  return value.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
}

// Human-pacing for visible-browser sends: chatgpt.com anti-bot systems react to
// machine-speed request bursts, so an agent loop is throttled to no faster than
// one send per DEFAULT_MIN_SEND_INTERVAL_MS. Returns how long to wait before the
// next send given the previous send's start time (0 = send now).
export const DEFAULT_MIN_SEND_INTERVAL_MS = 10_000;

export function resolveMinSendIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PRODEX_MIN_SEND_INTERVAL_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_MIN_SEND_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_MIN_SEND_INTERVAL_MS;
  return Math.floor(parsed);
}

export function computeSendPacingWaitMs(lastSendAtMs: number | undefined, nowMs: number, intervalMs: number): number {
  if (intervalMs <= 0 || lastSendAtMs === undefined) return 0;
  const elapsed = nowMs - lastSendAtMs;
  if (!Number.isFinite(elapsed) || elapsed < 0) return 0; // clock skew / bad marker: do not wait
  return elapsed >= intervalMs ? 0 : intervalMs - elapsed;
}
