import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { ReceiptKindSchema, TaskStatusSchema } from "./schema.js";
import type { BridgeStore, ListReceiptsInput } from "./store.js";

export const TOP_LEVEL_COMMANDS = [
  "help",
  "version",
  "init",
  "setup",
  "start",
  "status",
  "tunnel",
  "doctor",
  "onboard",
  "project",
  "claude",
  "tasks",
  "results",
  "receipts",
  "sessions",
  "pro",
  "release",
  "mcp"
] as const;
export function isHelpSubcommand(value: string): boolean {
  return value === "help" || value === "--help" || value === "-h";
}
export interface HelpRequestOptions {
  valueFlags?: readonly string[];
  booleanFlags?: readonly string[];
  maxPositionals?: number;
}
export function findHelpFlagIndexBeforePromptDelimiter(args: string[]): number {
  const delimiterIndex = args.indexOf("--");
  const limit = delimiterIndex === -1 ? args.length : delimiterIndex;
  return args.findIndex((arg, index) => index < limit && isHelpSubcommand(arg));
}
export function assertHelpRequestArgs(args: string[], command: string, options: HelpRequestOptions): void {
  const delimiterIndex = args.indexOf("--");
  const commandArgs = delimiterIndex === -1 ? args : args.slice(0, delimiterIndex);
  const valueFlagSet = new Set(options.valueFlags ?? []);
  const booleanFlagSet = new Set(options.booleanFlags ?? []);
  const maxPositionals = options.maxPositionals ?? 0;
  let positionals = 0;

  for (let index = 0; index < commandArgs.length; index += 1) {
    const arg = commandArgs[index];
    if (isHelpSubcommand(arg)) continue;
    if (valueFlagSet.has(arg)) {
      const next = commandArgs[index + 1];
      if (next && !isHelpSubcommand(next)) {
        readFlagValue(commandArgs, index, arg);
        index += 1;
      }
      continue;
    }
    if (booleanFlagSet.has(arg)) continue;
    if (arg.startsWith("-")) {
      throw unknownOptionError(arg, command, [...valueFlagSet, ...booleanFlagSet]);
    }
    if (positionals >= maxPositionals) {
      throw new Error(`Unexpected argument for ${command}: ${arg}`);
    }
    positionals += 1;
  }
}
export function unknownSubcommandError(command: string, subcommand: string, expected: readonly string[]): Error {
  const suggestion = closestSuggestion(subcommand, expected);
  const suggestionText = suggestion ? ` Did you mean \`prodex ${command} ${suggestion}\`?` : "";
  return new Error(`Unknown ${command} subcommand: ${subcommand}.${suggestionText} Expected one of: ${expected.join(", ")}. Run \`prodex ${command} --help\`.`);
}
export function unknownTopLevelCommandError(command: string): Error {
  const suggestion = closestSuggestion(command, TOP_LEVEL_COMMANDS);
  const suggestionText = suggestion ? ` Did you mean \`prodex ${suggestion}\`?` : "";
  return new Error(`Unknown command: ${command}.${suggestionText} Run \`prodex help\`.`);
}
export function unknownOptionError(option: string, command: string | undefined, candidates: readonly string[]): Error {
  const suggestion = closestSuggestion(option, candidates);
  const suggestionText = suggestion ? `. Did you mean \`${suggestion}\`?` : "";
  const context = command ? ` for ${command}` : "";
  return new Error(`Unknown option${context}: ${option}${suggestionText}`);
}
export function closestSuggestion<T extends string>(value: string, candidates: readonly T[]): T | undefined {
  let best: { command: string; distance: number; prefixMatch: boolean } | undefined;
  for (const candidate of candidates) {
    const distance = editDistance(value, candidate);
    const prefixMatch = isUsefulPrefixSuggestion(value, candidate);
    if (!best || (prefixMatch && !best.prefixMatch) || (prefixMatch === best.prefixMatch && distance < best.distance)) {
      best = { command: candidate, distance, prefixMatch };
    }
  }
  return best && (best.prefixMatch || best.distance <= 2) ? (best.command as T) : undefined;
}
export function isUsefulPrefixSuggestion(value: string, candidate: string): boolean {
  return value.length >= 5 && candidate.startsWith(value);
}
export function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = Array.from({ length: right.length + 1 }, () => 0);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        previous[rightIndex - 1] + substitutionCost
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}
export function formatCliCommand(sourceCli?: string): string {
  return sourceCli ? `node ${shellQuote(sourceCli)}` : "prodex";
}
export function formatSourceCliOption(sourceCli?: string): string {
  return sourceCli ? ` --source-cli ${shellQuote(sourceCli)}` : "";
}
export function readFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return readFlagValue(args, index, flag);
}
export function readPositiveNumberFlag(args: string[], flag: string): number | undefined {
  const value = readNumberFlag(args, flag);
  if (value === undefined) return undefined;
  if (value <= 0) throw new Error(`${flag} must be greater than 0`);
  return value;
}
export function readPositiveIntegerFlag(args: string[], flag: string): number | undefined {
  // Millisecond flags: fractional values are a footgun (--wait-timeout-ms 1.5
  // used to mean a 1.5ms budget), so require whole numbers.
  const value = readNumberFlag(args, flag);
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${flag} must be a positive integer`);
  return value;
}
export function readPortFlag(args: string[], flag: string): number | undefined {
  const value = readNumberFlag(args, flag);
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${flag} must be an integer from 1 to 65535`);
  }
  return value;
}
export function readRepeatedFlag(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) {
      values.push(readFlagValue(args, index, flag));
      index += 1;
    }
  }
  return values;
}
export function resolveCwdFlag(defaultCwd: string, args: string[]): string {
  const cwd = readFlag(args, "--cwd");
  if (!cwd) return defaultCwd;
  return resolveExistingDirectoryFlag(defaultCwd, cwd, "--cwd");
}
export function resolveOptionalFileFlag(defaultCwd: string, args: string[], flag: string): string | undefined {
  const value = readFlag(args, flag);
  return value ? resolveExistingFileFlag(defaultCwd, value, flag) : undefined;
}
export function resolveExistingPathFlag(defaultCwd: string, value: string, flag: string): string {
  const resolved = path.resolve(defaultCwd, value);
  try {
    return realpathSync(resolved);
  } catch {
    throw new Error(`${flag} does not exist or is not accessible: ${resolved}`);
  }
}
export function resolveExistingFileFlag(defaultCwd: string, value: string, flag: string): string {
  const resolved = resolveExistingPathFlag(defaultCwd, value, flag);
  if (!statSync(resolved).isFile()) {
    throw new Error(`${flag} must be a file: ${resolved}`);
  }
  return resolved;
}
export function resolveExistingDirectoryFlag(defaultCwd: string, value: string, flag: string): string {
  const resolved = resolveExistingPathFlag(defaultCwd, value, flag);
  if (!statSync(resolved).isDirectory()) {
    throw new Error(`${flag} must be a directory: ${resolved}`);
  }
  return resolved;
}
export function assertOnlyOptions(args: string[], command: string, valueFlags: readonly string[], booleanFlags: readonly string[] = []): void {
  const valueFlagSet = new Set(valueFlags);
  const booleanFlagSet = new Set(booleanFlags);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (valueFlagSet.has(arg)) {
      readFlagValue(args, index, arg);
      index += 1;
      continue;
    }
    if (booleanFlagSet.has(arg)) continue;
    if (arg.startsWith("-")) {
      throw unknownOptionError(arg, command, [...valueFlagSet, ...booleanFlagSet]);
    }
    throw new Error(`Unexpected argument for ${command}: ${arg}`);
  }
}
export function readPositionalsWithOptions(
  args: string[],
  command: string,
  maxPositionals: number,
  valueFlags: readonly string[],
  booleanFlags: readonly string[] = []
): string[] {
  const valueFlagSet = new Set(valueFlags);
  const booleanFlagSet = new Set(booleanFlags);
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (valueFlagSet.has(arg)) {
      readFlagValue(args, index, arg);
      index += 1;
      continue;
    }
    if (booleanFlagSet.has(arg)) continue;
    if (arg.startsWith("-")) {
      throw unknownOptionError(arg, command, [...valueFlagSet, ...booleanFlagSet]);
    }
    if (positionals.length >= maxPositionals) {
      throw new Error(`Unexpected argument for ${command}: ${arg}`);
    }
    positionals.push(arg);
  }
  return positionals;
}
export function assertNoExtraArgs(args: string[], command: string, maxPositionals: number): void {
  for (const arg of args.slice(maxPositionals)) {
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option for ${command}: ${arg}`);
    }
    throw new Error(`Unexpected argument for ${command}: ${arg}`);
  }
}
export const ASK_PRO_BOOLEAN_FLAGS = new Set(["--dry-run", "--send", "--confirm-target"]);
export const ASK_PRO_SELECTION_VALUE_FLAGS = ["--project", "--project-new", "--model", "--pro-mode", "--effort"] as const;
export const ASK_PRO_VALUE_FLAGS = new Set([
  "--cwd",
  "--file",
  "--port",
  "--timeout-ms",
  "--target-url",
  "--source-cli",
  ...ASK_PRO_SELECTION_VALUE_FLAGS
]);
export const ASK_PRO_PREVIEW_VALUE_FLAGS = new Set([
  "--cwd",
  "--file",
  "--port",
  "--timeout-ms",
  "--target-url",
  ...ASK_PRO_SELECTION_VALUE_FLAGS
]);
// Setup persists defaults for a subset of the per-ask selection flags. A new
// project is created per-ask, never as a standing default, so --project-new is
// intentionally excluded here.
export const ASK_PRO_SELECTION_DEFAULT_FLAGS = ["--model", "--pro-mode", "--effort", "--project"] as const;
export const ASK_PRO_SELECTION_CLEAR_FLAGS = ["--clear-model", "--clear-pro-mode", "--clear-effort", "--clear-project"] as const;
export function parseAskProArgs(args: string[], valueFlags = ASK_PRO_VALUE_FLAGS): { optionArgs: string[]; promptParts: string[] } {
  const delimiterIndex = args.indexOf("--");
  const optionArgs = delimiterIndex === -1 ? args : args.slice(0, delimiterIndex);
  const promptTail = delimiterIndex === -1 ? [] : args.slice(delimiterIndex + 1);
  const positionalPromptParts: string[] = [];

  for (let index = 0; index < optionArgs.length; index += 1) {
    const arg = optionArgs[index];
    if (!arg.startsWith("--")) {
      if (arg.startsWith("-")) throw unknownOptionError(arg, undefined, [...valueFlags, ...ASK_PRO_BOOLEAN_FLAGS]);
      positionalPromptParts.push(arg);
      continue;
    }
    if (ASK_PRO_BOOLEAN_FLAGS.has(arg)) continue;
    if (valueFlags.has(arg)) {
      readFlagValue(optionArgs, index, arg);
      index += 1;
      continue;
    }
    throw unknownOptionError(arg, undefined, [...valueFlags, ...ASK_PRO_BOOLEAN_FLAGS]);
  }

  return { optionArgs, promptParts: [...positionalPromptParts, ...promptTail] };
}
export function askProOptionArgs(args: string[]): string[] {
  const delimiterIndex = args.indexOf("--");
  return delimiterIndex === -1 ? args : args.slice(0, delimiterIndex);
}
export function hasAskProMode(args: string[]): boolean {
  const optionArgs = askProOptionArgs(args);
  return optionArgs.includes("--send") || optionArgs.includes("--dry-run");
}
export function hasAskProSendMode(args: string[]): boolean {
  return askProOptionArgs(args).includes("--send");
}
export function hasAskProDryRunMode(args: string[]): boolean {
  return askProOptionArgs(args).includes("--dry-run");
}
export function readFlagValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}
export function readSessionStatusFlag(args: string[]): Parameters<BridgeStore["listSessions"]>[0] {
  const value = readFlag(args, "--status");
  if (value === undefined) return undefined;
  if (value === "preview" || value === "running" || value === "done" || value === "blocked") return value;
  throw new Error("--status must be one of preview, running, done, blocked");
}
export const TASK_STATUSES = TaskStatusSchema.options satisfies readonly NonNullable<Parameters<BridgeStore["listTasks"]>[0]>[];
export function readTaskStatusFlag(args: string[]): Parameters<BridgeStore["listTasks"]>[0] {
  const value = readFlag(args, "--status");
  if (value === undefined) return undefined;
  if (TaskStatusSchema.safeParse(value).success) return value as Parameters<BridgeStore["listTasks"]>[0];
  throw new Error(`--status must be one of ${TASK_STATUSES.join(", ")}`);
}
export function readReceiptKindFlag(args: string[]): ListReceiptsInput["kind"] {
  const value = readFlag(args, "--kind");
  if (value === undefined) return undefined;
  if (ReceiptKindSchema.safeParse(value).success) return value as ListReceiptsInput["kind"];
  throw new Error(`--kind must be one of ${RECEIPT_KINDS.join(", ")}`);
}

export function readNumberFlag(args: string[], flag: string): number | undefined {
  const raw = readFlag(args, flag);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${flag} requires a finite number`);
  return value;
}

export const RECEIPT_KINDS = ReceiptKindSchema.options satisfies readonly NonNullable<ListReceiptsInput["kind"]>[];

export function printHelpIfRequested(
  args: string[],
  command: string,
  stdout: (line: string) => void,
  printHelp: (stdout: (line: string) => void) => void,
  options: HelpRequestOptions = {}
): boolean {
  const helpIndex = findHelpFlagIndexBeforePromptDelimiter(args);
  if (helpIndex === -1) return false;
  assertHelpRequestArgs(args, command, options);
  printHelp(stdout);
  return true;
}
