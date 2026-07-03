import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { parseProMode, parseReasoningEffort } from "./chatgpt-browser.js";
import {
  ASK_PRO_SELECTION_CLEAR_FLAGS,
  ASK_PRO_SELECTION_DEFAULT_FLAGS,
  assertNoExtraArgs,
  assertOnlyOptions,
  isHelpSubcommand,
  printHelpIfRequested,
  readFlag,
  readPortFlag,
  readPositiveNumberFlag,
  resolveCwdFlag,
  resolveOptionalFileFlag,
  unknownSubcommandError
} from "./cli-args.js";
import { printInitHelp, printSetupHelp, printStartHelp, printStatusHelp, printTunnelHelp, printTunnelUrlHelp } from "./cli-help.js";
import { errorMessage, isLoopbackHost, isMissingFileError, sourceAwareSetupMessage } from "./cli-shared.js";
import {
  type BrowserDefaults,
  getTokenExpiryStatus,
  loadLocalConfig,
  type LocalConfig,
  writeLocalConfig,
  type WriteLocalConfigInput
} from "./config.js";
import { startHttpMcpServer } from "./http-mcp.js";
import { readVerifiedUtf8File, writeVerifiedUtf8File } from "./safe-file.js";
import { BridgeStore } from "./store.js";
import type { CliIO } from "./cli.js";

export async function runInitCommand(rest: string[], io: CliIO): Promise<number> {
    if (printHelpIfRequested(rest, "init", io.stdout, printInitHelp, { valueFlags: ["--cwd"] })) return 0;
    assertOnlyOptions(rest, "init", ["--cwd"]);
    const targetCwd = resolveCwdFlag(io.cwd, rest);
    const targetStore = new BridgeStore(targetCwd);
    await targetStore.ensure();
    await ensureBridgeGitignore(targetCwd);
    io.stdout("Initialized .bridge receipt ledger.");
    return 0;
}

export async function runSetupCommand(rest: string[], io: CliIO): Promise<number> {
    const setupValueFlags = ["--cwd", "--host", "--port", "--token", "--token-ttl-hours", ...ASK_PRO_SELECTION_DEFAULT_FLAGS];
    const setupBooleanFlags = [...ASK_PRO_SELECTION_CLEAR_FLAGS, "--interactive"];
    if (printHelpIfRequested(rest, "setup", io.stdout, printSetupHelp, { valueFlags: setupValueFlags, booleanFlags: setupBooleanFlags })) return 0;
    assertOnlyOptions(rest, "setup", setupValueFlags, setupBooleanFlags);
    const targetCwd = resolveCwdFlag(io.cwd, rest);
    const interactive = rest.includes("--interactive");
    if (interactive) {
      const conflicting = [...ASK_PRO_SELECTION_DEFAULT_FLAGS, ...ASK_PRO_SELECTION_CLEAR_FLAGS].filter((flag) => rest.includes(flag));
      if (conflicting.length > 0) {
        throw new Error(`setup --interactive collects the browser defaults itself; drop ${conflicting.join(", ")} or run without --interactive.`);
      }
    }
    const browserDefaults = interactive
      ? await runBrowserDefaultsWizard(resolvePromptUser(io), io.stdout)
      : parseBrowserDefaultFlags(rest);
    const config = await writeLocalConfig(targetCwd, {
      host: readFlag(rest, "--host") ?? "127.0.0.1",
      port: readPortFlag(rest, "--port") ?? 8787,
      token: readFlag(rest, "--token"),
      tokenTtlHours: readPositiveNumberFlag(rest, "--token-ttl-hours"),
      browserDefaults
    });
    io.stdout("Saved local ChatGPT Developer Mode MCP profile.");
    io.stdout(`Server URL: ${redactServerUrl(config.server_url)}`);
    io.stdout(formatTokenExpiryLine(config));
    io.stdout("Full URL is stored in .bridge/config.local.json.");
    if (config.browser_defaults) {
      io.stdout(`Browser send defaults: ${formatBrowserDefaults(config.browser_defaults)}`);
    }
    return 0;
}

export async function runStartCommand(rest: string[], io: CliIO): Promise<number> {
    if (printHelpIfRequested(rest, "start", io.stdout, printStartHelp, { valueFlags: ["--cwd", "--source-cli"] })) return 0;
    assertOnlyOptions(rest, "start", ["--cwd", "--source-cli"]);
    const targetCwd = resolveCwdFlag(io.cwd, rest);
    const sourceCli = resolveOptionalFileFlag(io.cwd, rest, "--source-cli");
    const setupHintCwd = readFlag(rest, "--cwd") ? targetCwd : undefined;
    const config = await loadLocalConfigForCommand(targetCwd, "start", sourceCli, setupHintCwd);
    assertTokenNotExpiredForCommand(config, sourceCli, setupHintCwd);
    const running = await startHttpMcpServer({
      cwd: targetCwd,
      host: config.host,
      port: config.port,
      token: config.token,
      tokenExpiresAt: config.token_expires_at
    });
    io.stdout(`prodex HTTP MCP listening on ${redactServerUrl(running.mcp_url)}`);
    io.stdout(formatTokenExpiryLine(config));
    await waitForShutdown(async () => running.close());
    return 0;
}

export async function runStatusCommand(rest: string[], io: CliIO): Promise<number> {
    if (
      printHelpIfRequested(rest, "status", io.stdout, printStatusHelp, {
        valueFlags: ["--cwd", "--source-cli"],
        booleanFlags: ["--show-token", "--url-only", "--unsafe-show-non-expiring-token"]
      })
    ) {
      return 0;
    }
    assertOnlyOptions(rest, "status", ["--cwd", "--source-cli"], ["--show-token", "--url-only", "--unsafe-show-non-expiring-token"]);
    const targetCwd = resolveCwdFlag(io.cwd, rest);
    const sourceCli = resolveOptionalFileFlag(io.cwd, rest, "--source-cli");
    const setupHintCwd = readFlag(rest, "--cwd") ? targetCwd : undefined;
    const config = await loadLocalConfigForCommand(targetCwd, "status", sourceCli, setupHintCwd);
    const showToken = rest.includes("--show-token");
    const allowNonExpiringTokenReveal = rest.includes("--unsafe-show-non-expiring-token");
    const tokenStatus = getTokenExpiryStatus(config);
    if (showToken && tokenStatus.status === "non_expiring" && !allowNonExpiringTokenReveal) {
      throw new Error(
        sourceAwareSetupMessage(
          "status --show-token requires a token with expiry. Run `prodex setup --token-ttl-hours <hours>` first, or pass --unsafe-show-non-expiring-token for local-only debugging.",
          sourceCli,
          { cwd: setupHintCwd }
        )
      );
    }
    if (showToken && tokenStatus.status === "expired") {
      throw new Error(
        sourceAwareSetupMessage(`token expired at ${tokenStatus.token_expires_at}. Run \`prodex setup --token-ttl-hours <hours>\`.`, sourceCli, {
          cwd: setupHintCwd
        })
      );
    }
    const nonExpiringRevealWarning =
      showToken && allowNonExpiringTokenReveal && tokenStatus.status === "non_expiring"
        ? sourceAwareSetupMessage(
            "Showing a non-expiring token. Keep this local-only and rotate it with `prodex setup --token-ttl-hours <hours>` before any tunnel or ChatGPT Project use.",
            sourceCli,
            { cwd: setupHintCwd }
          )
        : undefined;
    const serverUrl = formatServerUrlForOutput(config.server_url, { showToken });
    if (rest.includes("--url-only")) {
      if (showToken) io.stderr(TOKEN_BEARING_MCP_URL_AUTHORITY_WARNING);
      if (nonExpiringRevealWarning) io.stderr(nonExpiringRevealWarning);
      io.stdout(serverUrl);
      return 0;
    }
    const warnings = tokenStatus.warning ? [sourceAwareSetupMessage(tokenStatus.warning, sourceCli, { cwd: setupHintCwd })] : [];
    if (showToken) warnings.push(TOKEN_BEARING_MCP_URL_AUTHORITY_WARNING);
    if (nonExpiringRevealWarning) warnings.push(nonExpiringRevealWarning);
    io.stdout(
      JSON.stringify(
        {
          server_url: serverUrl,
          config_path: ".bridge/config.local.json",
          token_status: tokenStatus.status,
          token_expires_at: tokenStatus.token_expires_at ?? null,
          browser_defaults: config.browser_defaults ?? null,
          warnings
        },
        null,
        2
      )
    );
    return 0;
}

export async function runTunnelCommand(rest: string[], io: CliIO): Promise<number> {
    const [subcommand, ...tunnelArgs] = rest;
    if (!subcommand || isHelpSubcommand(subcommand)) {
      assertNoExtraArgs(tunnelArgs, "tunnel help", 0);
      printTunnelHelp(io.stdout);
      return 0;
    }
    if (subcommand !== "url") throw unknownSubcommandError("tunnel", subcommand, ["url"]);
    if (
      printHelpIfRequested(tunnelArgs, "tunnel url", io.stdout, printTunnelUrlHelp, {
        valueFlags: ["--cwd", "--public-url", "--source-cli"],
        booleanFlags: ["--show-token", "--url-only"]
      })
    ) {
      return 0;
    }
    assertOnlyOptions(tunnelArgs, "tunnel url", ["--cwd", "--public-url", "--source-cli"], ["--show-token", "--url-only"]);
    const targetCwd = resolveCwdFlag(io.cwd, tunnelArgs);
    const sourceCli = resolveOptionalFileFlag(io.cwd, tunnelArgs, "--source-cli");
    const setupHintCwd = readFlag(tunnelArgs, "--cwd") ? targetCwd : undefined;
    const publicUrl = readFlag(tunnelArgs, "--public-url");
    if (!publicUrl) throw new Error("tunnel url requires --public-url <https-url>");
    parseTunnelPublicUrl(publicUrl);
    const config = await loadLocalConfigForCommand(targetCwd, "tunnel url", sourceCli, setupHintCwd);
    const tokenStatus = getTokenExpiryStatus(config);
    if (tokenStatus.status === "non_expiring") {
      throw new Error(
        sourceAwareSetupMessage("tunnel url requires a short-lived token. Run `prodex setup --token-ttl-hours <hours>` first.", sourceCli, {
          cwd: setupHintCwd
        })
      );
    }
    if (tokenStatus.status === "expired") {
      throw new Error(
        sourceAwareSetupMessage(`token expired at ${tokenStatus.token_expires_at}. Run \`prodex setup --token-ttl-hours <hours>\`.`, sourceCli, {
          cwd: setupHintCwd
        })
      );
    }
    const mcpUrl = makeTunnelMcpUrl(publicUrl, config.token);
    const showToken = tunnelArgs.includes("--show-token");
    const outputUrl = showToken ? mcpUrl : redactServerUrl(mcpUrl);
    if (tunnelArgs.includes("--url-only")) {
      if (showToken) io.stderr(TOKEN_BEARING_MCP_URL_AUTHORITY_WARNING);
      io.stdout(outputUrl);
      return 0;
    }
    const warnings = [
      "This command does not create a tunnel. Keep `prodex start` running behind your own tunnel.",
      "Only paste the token-bearing URL into a trusted private MCP client."
    ];
    if (showToken) warnings.push(TOKEN_BEARING_MCP_URL_AUTHORITY_WARNING);
    io.stdout(
      JSON.stringify(
        {
          mcp_url: outputUrl,
          token_status: tokenStatus.status,
          token_expires_at: tokenStatus.token_expires_at,
          warnings
        },
        null,
        2
      )
    );
    return 0;
}

export const TOKEN_BEARING_MCP_URL_AUTHORITY_WARNING =
  "Token-bearing MCP URL authorizes all enabled bridge tools, including repo_read_file, repo_search, repo_write_file_dry_run, repo_write_file_apply, and repo_stage_reviewed_paths. Paste it only into your own trusted private MCP client.";

export function assertTokenNotExpiredForCommand(config: LocalConfig, sourceCli?: string, setupHintCwd?: string): void {
  const tokenStatus = getTokenExpiryStatus(config);
  if (tokenStatus.status === "expired") {
    throw new Error(sourceAwareSetupMessage(tokenStatus.warning.toLowerCase(), sourceCli, { cwd: setupHintCwd }));
  }
}

export async function ensureBridgeGitignore(cwd: string): Promise<void> {
  const bridgeIgnorePath = path.join(cwd, ".bridge", ".gitignore");
  await mkdir(path.dirname(bridgeIgnorePath), { recursive: true });
  await writeVerifiedUtf8File(
    bridgeIgnorePath,
    ["tasks/*.json", "results/*.json", "sessions/*.json", "receipts/*.json", "artifacts/*", "config.local.json", "receipt-key.local", "!.gitignore", ""].join("\n"),
    () => assertGitignoreTargetSafe(bridgeIgnorePath),
    { create: true }
  );
  const rootIgnorePath = path.join(cwd, ".gitignore");
  let current = "";
  try {
    current = await readVerifiedUtf8File(rootIgnorePath, () => assertGitignoreTargetSafe(rootIgnorePath));
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
  const ignored = new Set(current.split(/\r?\n/).filter(Boolean));
  const additions = ["node_modules/", "dist/"].filter((line) => !ignored.has(line));
  if (additions.length > 0) {
    await writeVerifiedUtf8File(
      rootIgnorePath,
      `${current}${current && !current.endsWith("\n") ? "\n" : ""}${additions.join("\n")}\n`,
      () => assertGitignoreTargetSafe(rootIgnorePath),
      { create: true }
    );
  }
}

export function formatBrowserDefaults(defaults: BrowserDefaults): string {
  const parts: string[] = [];
  if (defaults.model) parts.push(`model=${defaults.model}`);
  if (defaults.pro_mode) parts.push(`pro-mode=${defaults.pro_mode}`);
  if (defaults.effort) parts.push(`effort=${defaults.effort}`);
  if (defaults.project) parts.push(`project=${defaults.project}`);
  return parts.length > 0 ? parts.join(", ") : "(none)";
}

export function formatServerUrlForOutput(value: string, options: { showToken: boolean }): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    if (!options.showToken && url.searchParams.has("prodex_token")) url.searchParams.set("prodex_token", "***");
    return url.toString();
  } catch {
    const withoutUserinfo = value.replace(/\/\/[^/@\s]+@/g, "//");
    return options.showToken ? withoutUserinfo : withoutUserinfo.replace(/([?&]prodex_token=)[^&]+/g, "$1***");
  }
}

export function formatTokenExpiryLine(config: { token_expires_at?: string }): string {
  const tokenStatus = getTokenExpiryStatus(config);
  if (tokenStatus.status === "valid") return `Token expires: ${tokenStatus.token_expires_at}`;
  if (tokenStatus.status === "expired") return `Token expired: ${tokenStatus.token_expires_at}`;
  return "Token expires: never (local-only; use --token-ttl-hours before exposing through a tunnel).";
}

export async function loadLocalConfigForCommand(cwd: string, command: "start" | "status" | "tunnel url", sourceCli?: string, setupHintCwd?: string) {
  return loadLocalConfig(cwd).catch(async (error) => {
    if (isMissingFileError(error)) {
      throw new Error(
        sourceAwareSetupMessage(
          `${command} requires local MCP setup. Run \`prodex setup\` first. Add \`--token-ttl-hours <hours>\` before revealing token URLs, using tunnels, or connecting ChatGPT Projects.`,
          sourceCli,
          { cwd: setupHintCwd }
        )
      );
    }
    throw new Error(sourceAwareSetupMessage(errorMessage(error), sourceCli, { cwd: setupHintCwd }));
  });
}

export function makeTunnelMcpUrl(publicUrl: string, token: string): string {
  const url = parseTunnelPublicUrl(publicUrl);
  url.username = "";
  url.password = "";
  url.pathname = "/mcp";
  url.search = "";
  url.hash = "";
  url.searchParams.set("prodex_token", token);
  return url.toString();
}

export function parseBrowserDefaultFlags(args: string[]): WriteLocalConfigInput["browserDefaults"] | undefined {
  const model = readFlag(args, "--model");
  const proModeRaw = readFlag(args, "--pro-mode");
  const effortRaw = readFlag(args, "--effort");
  const project = readFlag(args, "--project");
  if (proModeRaw !== undefined && effortRaw !== undefined) {
    throw new Error("setup cannot combine --pro-mode and --effort; Pro sub-modes and reasoning effort are different model axes.");
  }
  const clears = [
    ["--clear-model", "--model", model] as const,
    ["--clear-pro-mode", "--pro-mode", proModeRaw] as const,
    ["--clear-effort", "--effort", effortRaw] as const,
    ["--clear-project", "--project", project] as const
  ].map(([clearFlag, setFlag, setValue]) => {
    const wantsClear = args.includes(clearFlag);
    if (wantsClear && setValue !== undefined) {
      throw new Error(`setup cannot combine ${setFlag} and ${clearFlag}; set a new default or clear it, not both.`);
    }
    return wantsClear;
  });
  const [clearModel, clearProMode, clearEffort, clearProject] = clears;
  const anySet = model !== undefined || proModeRaw !== undefined || effortRaw !== undefined || project !== undefined;
  if (!anySet && !clears.some(Boolean)) return undefined;
  // Cleared fields are passed as explicit undefined so the config merge deletes
  // them while untouched fields survive.
  return {
    ...(model !== undefined ? { model } : {}),
    ...(clearModel ? { model: undefined } : {}),
    ...(proModeRaw !== undefined ? { proMode: parseProMode(proModeRaw) } : {}),
    ...(clearProMode ? { proMode: undefined } : {}),
    ...(effortRaw !== undefined ? { effort: parseReasoningEffort(effortRaw) } : {}),
    ...(clearEffort ? { effort: undefined } : {}),
    ...(project !== undefined ? { project } : {}),
    ...(clearProject ? { project: undefined } : {})
  };
}

export function parseTunnelPublicUrl(publicUrl: string): URL {
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    throw new Error("--public-url must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("--public-url must use http or https");
  }
  if (url.protocol !== "https:" && !isLoopbackHost(url.hostname)) {
    throw new Error("--public-url must use https for non-loopback tunnel URLs");
  }
  return url;
}

export function redactServerUrl(value: string): string {
  return formatServerUrlForOutput(value, { showToken: false });
}

export function resolvePromptUser(io: CliIO): (question: string) => Promise<string> {
  if (io.promptUser) return io.promptUser;
  if (!process.stdin.isTTY) {
    throw new Error("setup --interactive needs a terminal (TTY). Use the --model/--pro-mode/--effort/--project flags instead.");
  }
  return async (question: string) => {
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await rl.question(question)).trim();
    } finally {
      rl.close();
    }
  };
}

export async function runBrowserDefaultsWizard(
  prompt: (question: string) => Promise<string>,
  stdout: (line: string) => void
): Promise<WriteLocalConfigInput["browserDefaults"] | undefined> {
  stdout("Browser send defaults (press Enter to skip a question; labels match the Korean ChatGPT UI):");
  const model = await askChoice(prompt, "Default model — 1) Pro [Enter=skip]: ", ["Pro"]);
  let proMode: "기본" | "확장" | undefined;
  let effort: "즉시" | "중간" | "높음" | "매우 높음" | undefined;
  if (model === "Pro") {
    proMode = (await askChoice(prompt, "Pro sub-mode — 1) 기본  2) 확장 [Enter=skip]: ", ["기본", "확장"])) as
      | "기본"
      | "확장"
      | undefined;
  } else {
    effort = (await askChoice(prompt, "Reasoning effort — 1) 즉시  2) 중간  3) 높음  4) 매우 높음 [Enter=skip]: ", [
      "즉시",
      "중간",
      "높음",
      "매우 높음"
    ])) as "즉시" | "중간" | "높음" | "매우 높음" | undefined;
  }
  const projectRaw = (await prompt('Default project name (existing sidebar project) [Enter=skip]: ')).trim();
  const project = projectRaw === "" ? undefined : projectRaw;
  if (model === undefined && proMode === undefined && effort === undefined && project === undefined) return undefined;
  return {
    ...(model !== undefined ? { model } : {}),
    ...(proMode !== undefined ? { proMode } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(project !== undefined ? { project } : {})
  };
}

export async function waitForShutdown(close: () => Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => {
    const shutdown = () => resolve();
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
  await close();
}

// Ask up to `attempts` times; empty input means skip (returns undefined).
export async function askChoice(
  prompt: (question: string) => Promise<string>,
  question: string,
  choices: readonly string[],
  attempts = 3
): Promise<string | undefined> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const raw = (await prompt(question)).trim();
    if (raw === "") return undefined;
    const index = Number.parseInt(raw, 10);
    if (Number.isInteger(index) && index >= 1 && index <= choices.length) return choices[index - 1];
  }
  throw new Error(`No valid choice after ${attempts} attempts; run setup again or use flags.`);
}

export async function assertGitignoreTargetSafe(filePath: string): Promise<void> {
  try {
    const stat = await lstat(filePath);
    if (stat.isSymbolicLink()) throw new Error(`${filePath} must not be a symlink`);
    if (!stat.isFile()) throw new Error(`${filePath} must be a regular file`);
  } catch (error) {
    if (isMissingFileError(error)) return;
    throw error;
  }
}
