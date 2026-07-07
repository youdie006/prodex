#!/usr/bin/env node
import { execFile } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { renderBanner, shouldColorize } from "./banner.js";
import { buildDryRunBundle } from "./bundle.js";
import {
  chatGptVisibilityBlocker,
  defaultChatGptProfileDir,
  getChatGptBrowserStatus,
  normalizeChatGptTargetUrl,
  type ChatGptBrowserLaunch,
  listChatGptModelOptions,
  openChatGptBrowser,
  parseProMode,
  parseReasoningEffort,
  resolveCdpPort,
  sendChatGptPrompt
} from "./chatgpt-browser.js";
import {
  type BrowserDefaults,
  getTokenExpiryStatus,
  loadBrowserDefaults,
  loadLocalConfig,
  writeLocalConfig,
  type LocalConfig,
  type WriteLocalConfigInput
} from "./config.js";
import { startHttpMcpServer } from "./http-mcp.js";
import { createMcpToolHandlers } from "./mcp-tools.js";
import { runMcpServer } from "./mcp.js";
import { readVerifiedUtf8File, writeVerifiedUtf8File } from "./safe-file.js";
import { ReceiptKindSchema, TaskStatusSchema, type BridgeFile, type Receipt } from "./schema.js";
import { BridgeStore, MAX_FETCHABLE_RESULT_ARTIFACT_BYTES, type ListReceiptsInput } from "./store.js";
import {
  printHelpIfRequested,
  ASK_PRO_BOOLEAN_FLAGS,
  ASK_PRO_PREVIEW_VALUE_FLAGS,
  ASK_PRO_SELECTION_CLEAR_FLAGS,
  ASK_PRO_SELECTION_DEFAULT_FLAGS,
  ASK_PRO_VALUE_FLAGS,
  assertHelpRequestArgs,
  assertNoExtraArgs,
  assertOnlyOptions,
  findHelpFlagIndexBeforePromptDelimiter,
  formatCliCommand,
  formatSourceCliOption,
  hasAskProDryRunMode,
  hasAskProMode,
  hasAskProSendMode,
  isHelpSubcommand,
  parseAskProArgs,
  readFlag,
  readPortFlag,
  readPositionalsWithOptions,
  readPositiveNumberFlag,
  readReceiptKindFlag,
  readRepeatedFlag,
  readSessionStatusFlag,
  readTaskStatusFlag,
  resolveCwdFlag,
  resolveExistingPathFlag,
  resolveOptionalFileFlag,
  shellQuote,
  unknownSubcommandError,
  unknownTopLevelCommandError,
  type HelpRequestOptions
} from "./cli-args.js";
import {
  listRawResultsForInspection,
  listTasksForInspection,
  runReceiptsCommand,
  runResultsCommand,
  runSessionsCommand,
  runTasksCommand
} from "./cli-ledger.js";
import {
  isMissingFileError,
  type BrowserCommandOptions,
  errorMessage,
  formatBlockedConsultRecordedMessage,
  formatBrowserCheckCommand,
  formatBrowserLoginCommand,
  formatBrowserSmokeCommand,
  formatBrowserTargetAskCommand,
  formatInitCommand,
  formatReleaseStatusCommand,
  formatSetupCommand,
  isUntrustedResultError,
  sourceAwareBrowserBlocker,
  sourceAwareBrowserNextStep,
  sourceAwareReleaseMessage,
  sourceAwareResultError,
  sourceAwareResultMessage,
  sourceAwareSetupMessage
} from "./cli-shared.js";
import {
  TOKEN_BEARING_MCP_URL_AUTHORITY_WARNING,
  redactServerUrl,
  runInitCommand,
  runSetupCommand,
  runStartCommand,
  runStatusCommand,
  runTunnelCommand
} from "./cli-server.js";
import {
  type ConsultRecord,
  assertNoMissingTerminalConsultResults,
  assertNoOrphanConsultResults,
  formatConfigWarningLine,
  isConsultRecord,
  performBrowserConsultForMcp,
  runAskProCommand,
  runChatgptCommand,
  runConsultsCommand,
  runProCommand
} from "./cli-pro.js";
import {
  CLI_VERSION,
  printClaudeHelp,
  printDoctorHelp,
  printHelp,
  printInitHelp,
  printMcpHelp,
  printOnboardHelp,
  printProBrowserHelp,
  printProHelp,
  printProjectHelp,
  printReceiptsHelp,
  printReleaseHelp,
  printResultsHelp,
  printSessionsHelp,
  printSetupHelp,
  printStartHelp,
  printStatusHelp,
  printTasksHelp,
  printTunnelHelp,
  printTunnelUrlHelp
} from "./cli-help.js";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESERVED_PACKAGE_NAMES = new Set(["node_modules", "favicon.ico"]);

const DOCTOR_REQUIRED_MCP_TOOLS = [
  "bridge_create_task",
  "bridge_list_tasks",
  "bridge_get_task",
  "bridge_claim_task",
  "bridge_complete_task",
  "bridge_block_task",
  "bridge_list_results",
  "bridge_fetch_result",
  "bridge_fetch_result_artifact",
  "bridge_list_receipts",
  "bridge_get_receipt",
  "bridge_list_sessions",
  "bridge_get_session",
  "repo_read_file",
  "repo_search",
  "repo_write_file_dry_run",
  "repo_write_file_apply",
  "repo_stage_reviewed_paths"
] as const;

export interface CliIO {
  cwd: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  allowAskProBrowserSend?: boolean;
  /** Answer an interactive question (used by `setup --interactive`); defaults to terminal readline. */
  promptUser?: (question: string) => Promise<string>;
  /** Read all piped stdin (used by `ask --stdin`); defaults to reading process.stdin. */
  readStdin?: () => Promise<string>;
  /** Whether this run is an interactive terminal (gates guided login and auto-recovery); defaults to process.stdout.isTTY. */
  isInteractive?: boolean;
}

export async function runCli(args: string[], io: CliIO = defaultIo()): Promise<number> {
  const [command, ...rest] = args;
  const store = new BridgeStore(io.cwd);

  if (command === "--version" || command === "-v" || command === "version") {
    io.stdout(CLI_VERSION);
    return 0;
  }

  if (!command || command === "help" || command === "--help" || command === "-h") {
    if (shouldColorize()) io.stdout(renderBanner({ color: true }));
    printHelp(io.stdout);
    return 0;
  }

  if (command === "init") return runInitCommand(rest, io);

  if (command === "setup") return runSetupCommand(rest, io);

  if (command === "start") return runStartCommand(rest, io);

  if (command === "status") return runStatusCommand(rest, io);

  if (command === "tunnel") return runTunnelCommand(rest, io);

  if (command === "doctor") {
    if (printHelpIfRequested(rest, "doctor", io.stdout, printDoctorHelp, { valueFlags: ["--cwd", "--source-cli"] })) return 0;
    assertOnlyOptions(rest, "doctor", ["--cwd", "--source-cli"]);
    const targetCwd = resolveCwdFlag(io.cwd, rest);
    const sourceCli = resolveOptionalFileFlag(io.cwd, rest, "--source-cli");
    return runDoctor(new BridgeStore(targetCwd), { ...io, cwd: targetCwd }, sourceCli, readFlag(rest, "--cwd") ? targetCwd : undefined);
  }

  if (command === "release") {
    const [subcommand, ...releaseArgs] = rest;
    if (!subcommand || isHelpSubcommand(subcommand)) {
      assertNoExtraArgs(releaseArgs, "release help", 0);
      printReleaseHelp(io.stdout);
      return 0;
    }
    if (subcommand === "status") {
      if (printHelpIfRequested(releaseArgs, "release status", io.stdout, printReleaseHelp, { valueFlags: ["--cwd", "--source-cli"] })) return 0;
      assertOnlyOptions(releaseArgs, "release status", ["--cwd", "--source-cli"]);
      const targetCwd = resolveCwdFlag(io.cwd, releaseArgs);
      const sourceCli = resolveOptionalFileFlag(io.cwd, releaseArgs, "--source-cli");
      io.stdout(await formatReleaseStatus(targetCwd, sourceCli, readFlag(releaseArgs, "--cwd") ? targetCwd : undefined));
      return 0;
    }
    if (subcommand === "pack") {
      if (
        printHelpIfRequested(releaseArgs, "release pack", io.stdout, printReleaseHelp, {
          valueFlags: ["--cwd", "--pack-destination", "--source-cli"],
          booleanFlags: ["--keep-workdir"]
        })
      ) {
        return 0;
      }
      assertOnlyOptions(releaseArgs, "release pack", ["--cwd", "--pack-destination", "--source-cli"], ["--keep-workdir"]);
      const targetCwd = resolveCwdFlag(io.cwd, releaseArgs);
      const sourceCli = resolveOptionalFileFlag(io.cwd, releaseArgs, "--source-cli");
      const packDestination = readFlag(releaseArgs, "--pack-destination");
      if (!packDestination) throw new Error("release pack requires --pack-destination <dir>");
      await runReleasePackCommand({
        cwd: io.cwd,
        packageRoot: targetCwd,
        packDestination: path.resolve(io.cwd, packDestination),
        keepWorkdir: releaseArgs.includes("--keep-workdir"),
        sourceCli,
        releaseStatusCwd: readFlag(releaseArgs, "--cwd") ? targetCwd : undefined,
        stdout: io.stdout,
        stderr: io.stderr
      });
      return 0;
    }
    throw unknownSubcommandError("release", subcommand, ["status", "pack"]);
  }

  if (command === "onboard") {
    if (printHelpIfRequested(rest, "onboard", io.stdout, printOnboardHelp, { valueFlags: ["--cwd", "--source-cli"] })) return 0;
    assertOnlyOptions(rest, "onboard", ["--cwd", "--source-cli"]);
    const targetCwd = resolveCwdFlag(io.cwd, rest);
    if (shouldColorize()) io.stdout(renderBanner({ color: true }));
    io.stdout(formatOnboardingGuide(targetCwd, await hasOnboardingReadme(targetCwd), resolveOptionalFileFlag(io.cwd, rest, "--source-cli")));
    return 0;
  }

  if (command === "project") {
    const [subcommand, ...projectArgs] = rest;
    if (!subcommand || isHelpSubcommand(subcommand)) {
      assertNoExtraArgs(projectArgs, "project help", 0);
      printProjectHelp(io.stdout);
      return 0;
    }
    if (subcommand !== "prompt") throw unknownSubcommandError("project", subcommand, ["prompt"]);
    if (printHelpIfRequested(projectArgs, "project prompt", io.stdout, printProjectHelp, { valueFlags: ["--cwd", "--source-cli"] })) return 0;
    assertOnlyOptions(projectArgs, "project prompt", ["--cwd", "--source-cli"]);
    io.stdout(formatProjectVerificationPrompt(resolveCwdFlag(io.cwd, projectArgs), resolveOptionalFileFlag(io.cwd, projectArgs, "--source-cli")));
    return 0;
  }

  if (command === "claude") {
    const [subcommand, ...claudeArgs] = rest;
    if (!subcommand || isHelpSubcommand(subcommand)) {
      assertNoExtraArgs(claudeArgs, "claude help", 0);
      printClaudeHelp(io.stdout);
      return 0;
    }
    if (subcommand === "prompt") {
      if (printHelpIfRequested(claudeArgs, "claude prompt", io.stdout, printClaudeHelp, { valueFlags: ["--cwd", "--source-cli"] })) return 0;
      assertOnlyOptions(claudeArgs, "claude prompt", ["--cwd", "--source-cli"]);
      io.stdout(formatClaudeVerificationPrompt(resolveCwdFlag(io.cwd, claudeArgs), resolveOptionalFileFlag(io.cwd, claudeArgs, "--source-cli")));
      return 0;
    }
    if (subcommand === "config") {
      if (printHelpIfRequested(claudeArgs, "claude config", io.stdout, printClaudeHelp, { valueFlags: ["--cwd", "--source-cli"] })) return 0;
      assertOnlyOptions(claudeArgs, "claude config", ["--cwd", "--source-cli"]);
      io.stdout(formatClaudeConfig(resolveCwdFlag(io.cwd, claudeArgs), resolveOptionalFileFlag(io.cwd, claudeArgs, "--source-cli")));
      return 0;
    }
    throw unknownSubcommandError("claude", subcommand, ["prompt", "config"]);
  }

  if (command === "chatgpt") return runChatgptCommand(rest, io);

  if (command === "tasks") return runTasksCommand(rest, io);

  if (command === "results") return runResultsCommand(rest, io);

  if (command === "receipts") return runReceiptsCommand(rest, io);

  if (command === "sessions") return runSessionsCommand(rest, io);

  if (command === "pro") return runProCommand(rest, io, runCli);

  // Top-level shortcut for the flagship flow: `prodex ask "..."` is
  // `prodex pro browser ask "..."` without the namespace prefix. Validation
  // errors from the underlying dispatch name the internal ask-pro command,
  // which the alias user never typed - rewrite them to say "ask".
  if (command === "ask") {
    try {
      return await runProCommand(["browser", "ask", ...rest], io, runCli);
    } catch (error) {
      if (error instanceof Error && /\bask-pro\b|\bpro browser ask\b/.test(error.message)) {
        throw new Error(
          error.message
            .replace(/\bprodex pro browser ask\b/g, "prodex ask")
            .replace(/\bpro browser ask\b/g, "ask")
            .replace(/\bask-pro\b/g, "ask"),
          { cause: error }
        );
      }
      throw error;
    }
  }

  if (command === "consults") return runConsultsCommand(rest, io);

  if (command === "ask-pro") return runAskProCommand(rest, io);

  if (command === "mcp") {
    if (printHelpIfRequested(rest, "mcp", io.stdout, printMcpHelp, { valueFlags: ["--cwd"] })) return 0;
    assertOnlyOptions(rest, "mcp", ["--cwd"]);
    const mcpCwd = resolveCwdFlag(io.cwd, rest);
    // pro_consult is stdio-only: the HTTP MCP surface is exposed to ChatGPT
    // itself (and possibly a tunnel) and must never drive the user's browser.
    await runMcpServer(mcpCwd, {
      browserConsult: (input, onProgress) => performBrowserConsultForMcp(mcpCwd, input, onProgress)
    });
    return 0;
  }

  throw unknownTopLevelCommandError(command);
}

function defaultIo(): CliIO {
  return {
    cwd: process.cwd(),
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
    isInteractive: process.stdout.isTTY === true,
    readStdin: async () => {
      if (process.stdin.isTTY) return "";
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks).toString("utf8");
    }
  };
}




















function isHelpArgs(args: string[]): boolean {
  return args.length > 0 && isHelpSubcommand(args[0]);
}













function formatProjectVerificationPrompt(cwd: string, sourceCli?: string): string {
  const cli = formatCliCommand(sourceCli);
  const quotedCwd = shellQuote(cwd);
  const sourceCliOption = formatSourceCliOption(sourceCli);
  return `ChatGPT Project MCP verification prompt

Paste this into the ChatGPT Project after adding the prodex MCP server URL.
${TOKEN_BEARING_MCP_URL_AUTHORITY_WARNING}

Please verify the prodex MCP bridge for this private project:

1. Call the MCP tool \`bridge_create_task\` with:

   {
     "title": "prodex MCP verification",
     "prompt": "Verify that this ChatGPT Project can create tasks through the local prodex MCP bridge.",
     "repo_id": "default"
   }

2. Call \`bridge_list_tasks\` with:

   { "status": "new" }

3. Call \`bridge_get_task\` with the task_id returned by \`bridge_create_task\`.

4. Reply with the task_id and whether all three MCP calls succeeded. Ask me to run the local completion command below, then wait.

5. After I reply exactly \`local completion done\`, call \`bridge_fetch_result\` with:

   { "task_id": "<task-id>" }

6. If the fetched result lists artifacts, call \`bridge_fetch_result_artifact\` for each listed result artifact path:

   { "task_id": "<task-id>", "path": "<artifact-path>" }

7. Reply with whether \`bridge_fetch_result\` returned the verification result summary and whether every listed result artifact was readable. Do not call repo_write_file_dry_run, repo_write_file_apply, repo_stage_reviewed_paths, or any write/stage tool for this verification.

Local follow-up after ChatGPT replies:

cd ${quotedCwd}
${cli} tasks list --status new --cwd ${quotedCwd}
${cli} tasks show <task-id> --cwd ${quotedCwd}
${cli} tasks complete <task-id> --cwd ${quotedCwd} --summary "prodex MCP verification result" --artifact .bridge/artifacts/results/mcp-verification.md="prodex MCP verification artifact"

Then reply to ChatGPT with:

local completion done

If ChatGPT cannot see or call the MCP tools, keep the server terminal running and check locally:

${cli} status --cwd ${quotedCwd}${sourceCliOption}
${cli} doctor --cwd ${quotedCwd}${sourceCliOption}`;
}

function formatOnboardingGuide(cwd: string, hasReadme: boolean, sourceCli?: string): string {
  const quotedCwd = shellQuote(cwd);
  const cli = sourceCli ? `node ${shellQuote(sourceCli)}` : "prodex";
  const sourceCliOption = sourceCli ? ` --source-cli ${shellQuote(sourceCli)}` : "";
  const proAskCommand = hasReadme ? `${cli} pro ask --cwd ${quotedCwd} --file README.md "Review this repo"` : `${cli} pro ask --cwd ${quotedCwd} "Review this repo"`;
  const proBrowserAskCommand = hasReadme
    ? `${cli} pro browser ask${sourceCliOption} --cwd ${quotedCwd} --file README.md "Review this repo"`
    : `${cli} pro browser ask${sourceCliOption} --cwd ${quotedCwd} "Review this repo"`;
  return `prodex onboarding

repo: ${cwd}

1. Ask ChatGPT Pro from this terminal (standalone; no MCP needed):
   ${cli} pro browser login${sourceCliOption}  # opens visible browser
   ${cli} pro browser login --dry-run${sourceCliOption}  # preview, no browser opens
   In an interactive terminal, login waits and narrates until your ChatGPT session is READY.
   cd ${quotedCwd}
   ${cli} ask --new-chat "Review this repo"${sourceCliOption}  # short form of pro browser ask
   ${proAskCommand}  # dry-run/manual preview
   ${proBrowserAskCommand}  # visible-browser send
   ${cli} pro latest${sourceCliOption} --cwd ${quotedCwd}
   ${cli} pro browser help${sourceCliOption}
   ${cli} pro browser check${sourceCliOption} --cwd ${quotedCwd}
   ${cli} pro browser smoke${sourceCliOption} --cwd ${quotedCwd}

2. Let coding agents consult ChatGPT (stdio MCP: Claude, Codex, Cursor, ...):
   ${cli} claude config --cwd ${quotedCwd}${sourceCliOption}
   ${cli} claude prompt --cwd ${quotedCwd}${sourceCliOption}
   Agents get the bridge/ledger tools plus pro_consult (ask ChatGPT Pro directly; see docs/clients.md for Codex timeout and approval notes).
   ${cli} pro debate-prompt --topic "your question"${sourceCliOption}  # structured GPT Pro debate prompt for your agent

3. Local bridge health and records:
   ${cli} init --cwd ${quotedCwd}
   ${cli} doctor --cwd ${quotedCwd}${sourceCliOption}
   ${cli} pro list${sourceCliOption} --cwd ${quotedCwd}
   ${cli} results show latest --cwd ${quotedCwd}
   ${cli} results artifact latest --cwd ${quotedCwd}
   ${cli} results reseal <task-id> --confirm-current-result --cwd ${quotedCwd}  # only after reviewing .bridge/results/<task-id>.json

4. ChatGPT Project HTTP MCP:
   Note: HTTP MCP uses a short-lived token. Paste token-bearing URLs only into your own trusted private MCP client.
   ${TOKEN_BEARING_MCP_URL_AUTHORITY_WARNING}
   ${cli} setup --cwd ${quotedCwd} --token-ttl-hours 24
   ${cli} start --cwd ${quotedCwd}${sourceCliOption}
   Keep this terminal open while ChatGPT uses the bridge; run the next commands in a second terminal.
   ${cli} status --cwd ${quotedCwd} --show-token --url-only${sourceCliOption}
   ${cli} project prompt --cwd ${quotedCwd}${sourceCliOption}

Safety notes:
- This command only prints commands; it does not start servers, open browsers, or write files.
- Visible-browser sends require a manual, visible browser session and stop on login, captcha, Cloudflare, permission, rate-limit, or usage-limit blockers.`;
}

async function hasOnboardingReadme(cwd: string): Promise<boolean> {
  try {
    const stat = await lstat(path.join(cwd, "README.md"));
    return stat.isFile();
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}

function formatClaudeVerificationPrompt(cwd: string, sourceCli?: string): string {
  const cli = formatCliCommand(sourceCli);
  const quotedCwd = shellQuote(cwd);
  const sourceCliOption = sourceCli ? ` --source-cli ${shellQuote(sourceCli)}` : "";
  return `Claude MCP verification prompt

Paste this into Claude after adding the prodex stdio MCP server.

Please verify the prodex MCP bridge for this private repo:

1. Call the MCP tool \`bridge_create_task\` with:

   {
     "title": "prodex Claude MCP verification",
     "prompt": "Verify that Claude can create tasks through the local prodex MCP bridge.",
     "repo_id": "default"
   }

2. Call \`bridge_list_tasks\` with:

   { "status": "new" }

3. Call \`bridge_get_task\` with the task_id returned by \`bridge_create_task\`.

4. Reply with the task_id and whether all three MCP calls succeeded. Ask me to run the local completion command below, then wait.

5. After I reply exactly \`local completion done\`, call \`bridge_fetch_result\` with:

   { "task_id": "<task-id>" }

6. If the fetched result lists artifacts, call \`bridge_fetch_result_artifact\` for each listed result artifact path:

   { "task_id": "<task-id>", "path": "<artifact-path>" }

7. Reply with whether \`bridge_fetch_result\` returned the verification result summary and whether every listed result artifact was readable. Do not call repo_write_file_dry_run, repo_write_file_apply, repo_stage_reviewed_paths, or any write/stage tool for this verification.

Local follow-up after Claude replies:

cd ${quotedCwd}
${cli} tasks list --status new --cwd ${quotedCwd}
${cli} tasks show <task-id> --cwd ${quotedCwd}
${cli} tasks complete <task-id> --cwd ${quotedCwd} --summary "prodex Claude MCP verification result" --artifact .bridge/artifacts/results/claude-verification.md="prodex Claude MCP verification artifact"

Then reply to Claude with:

local completion done

If Claude cannot see or call the MCP tools, regenerate the config and run the local health check:

${cli} claude config --cwd ${quotedCwd}${sourceCliOption}
${cli} doctor --cwd ${quotedCwd}${sourceCliOption}`;
}

function formatClaudeConfig(cwd: string, sourceCli: string | undefined): string {
  return JSON.stringify(
    {
      mcpServers: {
        prodex: sourceCli
          ? { command: "node", args: [sourceCli, "mcp", "--cwd", cwd] }
          : { command: "prodex", args: ["mcp", "--cwd", cwd] }
      }
    },
    null,
    2
  );
}























function formatGitPushUpstreamCommand(branch: string): string {
  return `git push -u origin ${shellQuote(branch)}`;
}







async function formatReleaseStatus(cwd: string, sourceCli?: string, releaseHintCwd?: string): Promise<string> {
  const packageJsonPath = path.join(cwd, "package.json");
  const raw = await readReleasePackageJson(packageJsonPath).catch(async (error) => {
    if (!isMissingFileError(error)) throw error;
    return undefined;
  });
  if (raw === undefined) {
    const lines = [formatReleaseStatusCommand(sourceCli, { cwd: releaseHintCwd }), "package: <missing package.json>"];
    lines.push(`metadata: blocked package.json not found at ${packageJsonPath}`);
    const gitStatus = await readReleaseGitStatus(cwd);
    lines.push(gitStatus.line);
    if (gitStatus.next) lines.push(`git_next: ${gitStatus.next}`);
    lines.push("next: run this command from a package root or pass `--cwd /absolute/path/to/repo`");
    lines.push("verification: run `npm run release:verify` anytime without weakening the publish guard");
    return lines.join("\n");
  }
  let packageJson: { name?: unknown; version?: unknown; license?: unknown; private?: unknown; bin?: unknown };
  try {
    packageJson = JSON.parse(raw) as { name?: unknown; version?: unknown; license?: unknown; private?: unknown; bin?: unknown };
  } catch {
    const lines = [formatReleaseStatusCommand(sourceCli, { cwd: releaseHintCwd }), "package: <invalid package.json>"];
    lines.push(`metadata: blocked package.json is not valid JSON at ${packageJsonPath}`);
    const gitStatus = await readReleaseGitStatus(cwd);
    lines.push(gitStatus.line);
    if (gitStatus.next) lines.push(`git_next: ${gitStatus.next}`);
    lines.push("next: fix package.json syntax, then run `npm run release:check`");
    lines.push("verification: run `npm run release:verify` anytime without weakening the publish guard");
    return lines.join("\n");
  }
  const name = typeof packageJson.name === "string" && packageJson.name.trim() ? packageJson.name : "<unnamed>";
  const version = typeof packageJson.version === "string" && packageJson.version.trim() ? packageJson.version : "<unversioned>";
  const lines = [formatReleaseStatusCommand(sourceCli, { cwd: releaseHintCwd }), `package: ${name}@${version}`];
  const license = typeof packageJson.license === "string" ? packageJson.license.trim() : "";
  const identityError = packageIdentityError(packageJson);
  let metadataNext = "run `npm run release:check` before publishing";
  let metadataReady = false;
  let packReady = false;
  const packCheckEligible = !identityError;

  if (identityError) {
    lines.push(`metadata: blocked ${identityError.message}`);
    metadataNext = identityError.next;
  } else if (packageJson.private === true) {
    lines.push("metadata: blocked package.json private: true prevents npm publish");
    metadataNext = "remove `private: true` before public publishing, then run `npm run release:check`";
  } else {
    if (!license) {
      lines.push("metadata: blocked package.json must include an explicit license before publishing");
      metadataNext = await missingPackageLicenseNextStep(cwd);
    } else if (license === "UNLICENSED") {
      lines.push('metadata: blocked license "UNLICENSED" is not publishable');
      metadataNext = "choose a public license and add LICENSE, then run `npm run release:check`";
    } else if (license !== "MIT") {
      lines.push(`metadata: blocked license=${license} package.json license must be MIT before publishing`);
      metadataNext = "set package.json license to MIT and use the MIT LICENSE text, then run `npm run release:check`";
    } else {
      const licenseFile = await readLicenseFileStatus(path.join(cwd, "LICENSE"), license);
      if (licenseFile.status === "missing") {
        lines.push(`metadata: blocked license=${license} license_file=missing`);
        metadataNext = "add LICENSE, then run `npm run release:check`";
      } else if (licenseFile.status === "invalid") {
        lines.push(`metadata: blocked license=${license} license_file=invalid - LICENSE must be a regular file and must not be a symlink`);
        metadataNext = "replace LICENSE with a regular file, then run `npm run release:check`";
      } else if (licenseFile.status === "hardlinked") {
        lines.push(`metadata: blocked license=${license} license_file=invalid - LICENSE must not have hard links`);
        metadataNext = "replace LICENSE with a non-hard-linked regular file, then run `npm run release:check`";
      } else if (licenseFile.status === "mismatch") {
        lines.push(`metadata: blocked license=${license} license_file=mismatch - LICENSE content must match package.json license MIT`);
        metadataNext = "replace LICENSE with the MIT LICENSE text, then run `npm run release:check`";
      } else {
        lines.push(`metadata: ok license=${license} license_file=present`);
        metadataReady = true;
      }
    }
  }
  if (packCheckEligible) {
    const packStatus = await readReleasePackStatus(cwd, packageJson, sourceCli, releaseHintCwd);
    lines.push(packStatus.line);
    if (packStatus.next) {
      if (metadataReady) {
        metadataNext = packStatus.next;
      } else {
        lines.push(`pack_next: ${packStatus.next}`);
      }
    } else {
      packReady = true;
    }
  }
  const gitStatus = await readReleaseGitStatus(cwd);
  lines.push(gitStatus.line);
  if (gitStatus.next) lines.push(`git_next: ${gitStatus.next}`);
  if (metadataReady && packReady && !gitStatus.next) {
    metadataNext = "run `prodex release pack --pack-destination <dir>`, then run the printed release_pack_verify dry-run before npm publish";
  }
  lines.push(`next: ${sourceAwareReleaseMessage(metadataNext, sourceCli, { cwd: releaseHintCwd })}`);
  lines.push("verification: run `npm run release:verify` anytime without weakening the publish guard");
  return lines.join("\n");
}

function packageIdentityError(packageJson: { name?: unknown; version?: unknown }): { message: string; next: string } | undefined {
  if (!isNonEmptyPackageString(packageJson.name) || !isNonEmptyPackageString(packageJson.version)) {
    return {
      message: "package.json must include non-empty string name and version",
      next: "set package.json name and version, then run `npm run release:check`"
    };
  }
  if (!isNpmPublishablePackageName(packageJson.name)) {
    return {
      message: "package.json name must be npm-publishable",
      next: "fix package.json name, then run `npm run release:check`"
    };
  }
  if (!isValidSemverVersion(packageJson.version)) {
    return {
      message: "package.json version must be valid semver",
      next: "fix package.json version, then run `npm run release:check`"
    };
  }
  return undefined;
}

async function missingPackageLicenseNextStep(cwd: string): Promise<string> {
  const licenseFile = await readLicenseFileStatus(path.join(cwd, "LICENSE"));
  if (licenseFile.status === "present") {
    return "choose a license and set package.json license, then run `npm run release:check`";
  }
  if (licenseFile.status === "invalid") {
    return "choose a license and replace LICENSE with a regular file, then run `npm run release:check`";
  }
  if (licenseFile.status === "hardlinked") {
    return "choose a license and replace LICENSE with a non-hard-linked regular file, then run `npm run release:check`";
  }
  return "choose a license, add LICENSE, then run `npm run release:check`";
}

function isNonEmptyPackageString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isNpmPublishablePackageName(value: string): boolean {
  if (!isNonEmptyPackageString(value) || value.length > 214 || value !== value.toLowerCase()) return false;
  if (RESERVED_PACKAGE_NAMES.has(value)) return false;
  if (value.startsWith("@")) {
    const parts = value.slice(1).split("/");
    return parts.length === 2 && parts.every(isPackageNameSegment);
  }
  return !value.includes("/") && isPackageNameSegment(value);
}

function isPackageNameSegment(value: string): boolean {
  return /^(?![._])[a-z0-9][a-z0-9._~-]*$/.test(value);
}

function isValidSemverVersion(value: string): boolean {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value);
}

async function readReleasePackageJson(packageJsonPath: string): Promise<string> {
  return readFile(packageJsonPath, "utf8");
}

type ReleaseGitStatus = {
  line: string;
  next?: string;
};

type ReleasePackStatus = {
  line: string;
  next?: string;
};

async function readReleasePackStatus(cwd: string, packageJson: { bin?: unknown }, sourceCli?: string, releaseHintCwd?: string): Promise<ReleasePackStatus> {
  try {
    const { stdout } = await execFileAsync(commandForPlatform("npm"), ["pack", "--json", "--dry-run", "--ignore-scripts"], {
      cwd,
      timeout: 120_000,
      maxBuffer: 20 * 1024 * 1024
    });
    const files = parsePackedFiles(stdout);
    const nonRegular = await findNonRegularPackedFiles(cwd, files);
    if (nonRegular.length > 0) {
      return {
        line: `pack: blocked packed files must be regular non-symlink files: ${formatPathList(nonRegular)}`,
        next: "replace non-regular or symlinked packed files with regular files, then run `npm run release:check`"
      };
    }
    const invalid = findExecutableNonBinPackedFiles(files, packageJson);
    if (invalid.length > 0) {
      return {
        line: `pack: blocked packed files have unexpected executable modes outside package bin entries: ${formatPathList(invalid)}`,
        next: sourceAwareReleaseMessage(
          "fix file modes or publish from a filesystem that preserves executable bits, then run `npm run release:check`; on WSL/Windows mounts, create a sanitized tarball with `prodex release pack --pack-destination <dir>` after `npm run release:verify`; release pack prints `npm publish --dry-run <tarball>` and warns that tarball publish bypasses prepublishOnly before printing `npm publish <tarball>`",
          sourceCli,
          { cwd: releaseHintCwd }
        )
      };
    }
    const hardLinked = await findHardLinkedPackedFiles(cwd, files);
    if (hardLinked.length > 0) {
      return {
        line: `pack: blocked packed files have hard links: ${formatPathList(hardLinked)}`,
        next: "replace hard-linked packed files with independent files, then run `npm run release:check`"
      };
    }
    return { line: "pack: ok file_modes=ok" };
  } catch (error) {
    return {
      line: `pack: blocked npm pack dry-run failed: ${firstErrorLine(error)}`,
      next: "fix npm pack dry-run, then run `npm run release:check`"
    };
  }
}

type PackedFile = {
  path: string;
  mode: number;
};

function parsePackedFiles(stdout: string): PackedFile[] {
  let entries: Array<{ files?: unknown }>;
  try {
    entries = JSON.parse(stdout) as Array<{ files?: unknown }>;
  } catch {
    throw new Error("npm pack dry-run did not return valid JSON");
  }
  const files = entries?.[0]?.files;
  if (!Array.isArray(files)) {
    throw new Error("npm pack dry-run did not return a file list");
  }
  for (const file of files) {
    if (typeof file?.path !== "string" || file.path.trim() === "") {
      throw new Error("npm pack dry-run file entry is missing a path");
    }
    if (typeof file.mode !== "number") {
      throw new Error(`npm pack dry-run file entry is missing mode metadata: ${normalizePackagePath(file.path)}`);
    }
  }
  return files;
}

function findExecutableNonBinPackedFiles(files: PackedFile[], packageJson: { bin?: unknown }): string[] {
  const binPaths = packageBinPaths(packageJson.bin);
  return files
    .filter((file) => (file.mode & 0o111) !== 0)
    .map((file) => normalizePackagePath(file.path))
    .filter((filePath) => !binPaths.has(filePath));
}

async function findNonRegularPackedFiles(cwd: string, files: PackedFile[]): Promise<string[]> {
  const invalid: string[] = [];
  for (const file of files) {
    const packagePath = normalizePackagePath(file.path);
    const filePath = path.join(cwd, packagePath);
    const relative = path.relative(cwd, filePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      invalid.push(packagePath);
      continue;
    }
    try {
      const stat = await lstat(filePath);
      if (stat.isSymbolicLink() || !stat.isFile()) invalid.push(packagePath);
    } catch (error) {
      if (isMissingFileError(error)) invalid.push(packagePath);
      else throw error;
    }
  }
  return invalid;
}

async function findHardLinkedPackedFiles(cwd: string, files: PackedFile[]): Promise<string[]> {
  const invalid: string[] = [];
  for (const file of files) {
    const packagePath = normalizePackagePath(file.path);
    const filePath = path.join(cwd, packagePath);
    const relative = path.relative(cwd, filePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      invalid.push(packagePath);
      continue;
    }
    try {
      const stat = await lstat(filePath);
      if (stat.nlink > 1) invalid.push(packagePath);
    } catch (error) {
      if (isMissingFileError(error)) invalid.push(packagePath);
      else throw error;
    }
  }
  return invalid;
}

function packageBinPaths(bin: unknown): Set<string> {
  const paths = new Set<string>();
  if (typeof bin === "string") {
    paths.add(normalizePackagePath(bin));
  } else if (typeof bin === "object" && bin !== null) {
    for (const value of Object.values(bin)) {
      if (typeof value === "string") paths.add(normalizePackagePath(value));
    }
  }
  return paths;
}

function normalizePackagePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\/+/, "");
}

function formatPathList(paths: string[]): string {
  const shown = paths.slice(0, 8).join(", ");
  return paths.length > 8 ? `${shown}, ... (${paths.length} files)` : shown;
}

async function runReleasePackCommand(input: {
  cwd: string;
  packageRoot: string;
  packDestination: string;
  keepWorkdir: boolean;
  sourceCli?: string;
  releaseStatusCwd?: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}): Promise<void> {
  const scriptPath = path.join(packageRoot, "scripts", "release-pack.mjs");
  const args = [scriptPath, "--root", input.packageRoot, "--pack-destination", input.packDestination];
  if (input.keepWorkdir) args.push("--keep-workdir");
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, args, {
      cwd: input.cwd,
      timeout: 120_000,
      maxBuffer: 20 * 1024 * 1024
    });
    writeCommandOutput(sourceAwareReleaseMessage(stdout, input.sourceCli, { cwd: input.releaseStatusCwd }), input.stdout);
    writeCommandOutput(stderr, input.stderr);
  } catch (error) {
    throw new Error(firstErrorLine(error));
  }
}

function writeCommandOutput(output: string, write: (line: string) => void): void {
  const trimmed = output.replace(/\r?\n$/, "");
  if (!trimmed) return;
  for (const line of trimmed.split(/\r?\n/)) write(line);
}

function commandForPlatform(command: string): string {
  return process.platform === "win32" && command === "npm" ? "npm.cmd" : command;
}

function firstErrorLine(error: unknown): string {
  const failed = typeof error === "object" && error !== null ? error : {};
  const stderr = firstOutputLine((failed as { stderr?: unknown }).stderr);
  if (stderr) return stderr;
  const stdout = firstOutputLine((failed as { stdout?: unknown }).stdout);
  if (stdout) return stdout;
  if (typeof (failed as { code?: unknown }).code === "number") return `exit code ${(failed as { code: number }).code}`;
  if (typeof (failed as { signal?: unknown }).signal === "string" && (failed as { signal: string }).signal) {
    return `signal ${(failed as { signal: string }).signal}`;
  }
  return errorMessage(error).split(/\r?\n/)[0];
}

function firstOutputLine(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

async function readReleaseGitStatus(cwd: string): Promise<ReleaseGitStatus> {
  try {
    const insideWorkTree = (await gitStdout(cwd, ["rev-parse", "--is-inside-work-tree"])).trim();
    if (insideWorkTree !== "true") {
      return {
        line: "git: blocked not a git worktree",
        next: "initialize a git repo and commit the release state before public release"
      };
    }
  } catch {
    return {
      line: "git: blocked not a git worktree",
      next: "initialize a git repo and commit the release state before public release"
    };
  }

  const [branch, commit, statusOutput, branchStatusOutput, remoteOutput, upstream] = await Promise.all([
    gitStdout(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).then((value) => value.trim() || "unknown", () => "unknown"),
    gitStdout(cwd, ["rev-parse", "--short", "HEAD"]).then((value) => value.trim() || "unknown", () => "unknown"),
    gitStdout(cwd, ["status", "--porcelain"]).then((value) => value.trim(), () => ""),
    gitStdout(cwd, ["status", "--porcelain=v1", "--branch"]).then((value) => value.trim(), () => ""),
    gitStdout(cwd, ["remote"]).then((value) => value.trim(), () => ""),
    gitStdout(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).then(
      (value) => value.trim(),
      () => ""
    )
  ]);
  const dirtyCount = statusOutput ? statusOutput.split(/\r?\n/).filter(Boolean).length : 0;
  const remotes = remoteOutput ? remoteOutput.split(/\r?\n/).map((remote) => remote.trim()).filter(Boolean) : [];
  const remoteText = remotes.length > 0 ? remotes.join(",") : "none";
  const gitContext = `branch=${branch} commit=${commit}`;

  if (dirtyCount > 0) {
    return {
      line: `git: blocked worktree has uncommitted changes files=${dirtyCount} ${gitContext} remote=${remoteText}`,
      next: "commit or stash local changes before release"
    };
  }

  if (branch === "HEAD") {
    return {
      line: `git: blocked detached HEAD commit=${commit} remote=${remoteText}`,
      next: "check out a release branch before public release"
    };
  }

  if (remotes.length === 0) {
    return {
      line: `git: blocked no remote configured ${gitContext}`,
      next: `add a remote, then push with upstream tracking: git remote add origin <git-url>; ${formatGitPushUpstreamCommand(branch)}`
    };
  }

  const relation = parseGitBranchRelation(branchStatusOutput);
  const effectiveUpstream = upstream || relation.upstream || "";
  if (!upstream && relation.gone && relation.upstream) {
    return {
      line: `git: blocked upstream is gone ${gitContext} remote=${remoteText} upstream=${relation.upstream}`,
      next: "restore upstream tracking before public release"
    };
  }

  if (!effectiveUpstream) {
    return {
      line: `git: blocked no upstream configured ${gitContext} remote=${remoteText}`,
      next: `push the branch with upstream tracking: ${formatGitPushUpstreamCommand(branch)}`
    };
  }

  if (relation.gone) {
    return {
      line: `git: blocked upstream is gone ${gitContext} remote=${remoteText} upstream=${effectiveUpstream}`,
      next: "restore upstream tracking before public release"
    };
  }
  if (relation.ahead > 0 && relation.behind > 0) {
    return {
      line: `git: blocked branch diverged ahead=${relation.ahead} behind=${relation.behind} ${gitContext} remote=${remoteText} upstream=${effectiveUpstream}`,
      next: "sync the branch with upstream before public release"
    };
  }
  if (relation.ahead > 0) {
    return {
      line: `git: blocked branch has unpushed commits ahead=${relation.ahead} ${gitContext} remote=${remoteText} upstream=${effectiveUpstream}`,
      next: "push local commits before public release"
    };
  }
  if (relation.behind > 0) {
    return {
      line: `git: blocked branch is behind upstream behind=${relation.behind} ${gitContext} remote=${remoteText} upstream=${effectiveUpstream}`,
      next: "sync the branch with upstream before public release"
    };
  }

  return {
    line: `git: ok ${gitContext} remote=${remoteText} upstream=${effectiveUpstream}`
  };
}

function parseGitBranchRelation(statusOutput: string): { ahead: number; behind: number; gone: boolean; upstream?: string } {
  const branchLine = statusOutput.split(/\r?\n/).find((line) => line.startsWith("## ")) ?? "";
  const relationText = /\[([^\]]+)\]/.exec(branchLine)?.[1] ?? "";
  const upstream = /\.\.\.([^\s\[]+)/.exec(branchLine)?.[1];
  const ahead = Number(/\bahead (\d+)\b/.exec(relationText)?.[1] ?? 0);
  const behind = Number(/\bbehind (\d+)\b/.exec(relationText)?.[1] ?? 0);
  return { ahead, behind, gone: /\bgone\b/.test(relationText), upstream };
}

async function gitStdout(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

async function readLicenseFileStatus(
  filePath: string,
  expectedLicense?: string
): Promise<{ status: "present" | "missing" | "invalid" | "hardlinked" | "mismatch" }> {
  try {
    const stat = await lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) return { status: "invalid" };
    if (stat.nlink > 1) return { status: "hardlinked" };
    const raw = await readFile(filePath, "utf8");
    if (expectedLicense === "MIT" && !isMitLicenseText(raw)) return { status: "mismatch" };
    return { status: "present" };
  } catch (error) {
    if (isMissingFileError(error)) return { status: "missing" };
    throw error;
  }
}

function isMitLicenseText(raw: string): boolean {
  return /\bMIT License\b/.test(raw);
}

async function runDoctor(store: BridgeStore, io: CliIO, sourceCli?: string, setupHintCwd?: string): Promise<number> {
  let ok = true;
  io.stdout("prodex doctor");

  try {
    const bridgeReady = await store.hasReadyBridgeStorageReadOnly();
    io.stdout(
      bridgeReady
        ? "bridge: ok (.bridge)"
        : `bridge: missing/incomplete (.bridge) - run \`${formatInitCommand(sourceCli, { cwd: setupHintCwd })}\` when you need local task/result storage`
    );
  } catch (error) {
    ok = false;
    io.stdout(`bridge: failed ${errorMessage(error)}`);
  }

  try {
    const config = await loadLocalConfig(io.cwd);
    const tokenStatus = getTokenExpiryStatus(config);
    if (tokenStatus.status === "expired") {
      ok = false;
      io.stdout(`config: failed token expired at ${tokenStatus.token_expires_at} - run \`${formatSetupCommand(sourceCli, { cwd: setupHintCwd })}\``);
    } else {
      io.stdout(`config: ok ${redactServerUrl(config.server_url)} token_status=${tokenStatus.status}`);
      const warningLine = formatConfigWarningLine(tokenStatus, sourceCli, setupHintCwd);
      if (warningLine) io.stdout(warningLine);
    }
  } catch (error) {
    if (isMissingFileError(error)) {
      io.stdout(`config: missing - run \`${formatSetupCommand(sourceCli, { cwd: setupHintCwd })}\``);
    } else {
      ok = false;
      io.stdout(`config: failed ${sourceAwareSetupMessage(errorMessage(error), sourceCli, { cwd: setupHintCwd })}`);
    }
  }

  try {
    const smoke = await runMcpWriteSmoke();
    io.stdout(`mcp_write_smoke: ok path=${smoke.path} receipt_payload=${smoke.receipt_payload} staged=${smoke.staged}`);
  } catch (error) {
    ok = false;
    io.stdout(`mcp_write_smoke: failed ${errorMessage(error)}`);
  }

  try {
    const smoke = await runHttpMcpCatalogSmoke();
    io.stdout(
      `http_mcp_smoke: ok task_flow=${smoke.taskFlow} finalizers=${smoke.finalizers} search=${smoke.search} tools=${smoke.tools.join(",")}`
    );
  } catch (error) {
    ok = false;
    io.stdout(`http_mcp_smoke: failed ${errorMessage(error)}`);
  }

  // Informational visible-browser status so an all-green doctor cannot hide a
  // missing browser setup. The browser is optional for bridge-only use, so
  // this line never fails doctor.
  try {
    const cdpPort = resolveCdpPort();
    const browser = await getChatGptBrowserStatus({ port: cdpPort, timeoutMs: 1_500 });
    if (browser.reachable && browser.loggedInLikely && browser.hasComposer) {
      io.stdout(`chatgpt: ok logged_in=true composer=true (port ${cdpPort})`);
    } else if (!browser.reachable) {
      io.stdout(
        `chatgpt: not connected (port ${cdpPort}) - optional; run \`${formatBrowserLoginCommand(sourceCli, { cwd: setupHintCwd })}\` for visible-browser Pro consults`
      );
    } else {
      io.stdout(
        `chatgpt: partial logged_in=${browser.loggedInLikely} composer=${browser.hasComposer}${browser.blocker ? ` blocker=${browser.blocker.code}` : ""} - optional; run \`${formatBrowserCheckCommand(sourceCli, { cwd: setupHintCwd })}\` for details`
      );
    }
  } catch (error) {
    io.stdout(`chatgpt: check failed ${errorMessage(error)} - optional; run \`${formatBrowserCheckCommand(sourceCli, { cwd: setupHintCwd })}\``);
  }

  return ok ? 0 : 1;
}

async function runHttpMcpCatalogSmoke(): Promise<{ tools: string[]; taskFlow: "ok"; finalizers: "ok"; search: "ok" }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "prodex-http-doctor-"));
  let running: Awaited<ReturnType<typeof startHttpMcpServer>> | undefined;
  let client: Client | undefined;
  let smokeFailed = false;
  try {
    await writeFile(path.join(cwd, "search-smoke.txt"), "before\n--doctor-rg-literal ok\nafter\n", "utf8");
    running = await startHttpMcpServer({
      cwd,
      host: "127.0.0.1",
      port: 0,
      token: "doctor-token"
    });
    client = new Client({ name: "prodex-doctor", version: CLI_VERSION });
    await withTimeout(
      client.connect(new StreamableHTTPClientTransport(new URL(running.mcp_url))),
      20_000,
      "timed out connecting to HTTP MCP server"
    );
    const result = await withTimeout(client.listTools(), 20_000, "timed out listing HTTP MCP tools");
    const names = result.tools.map((tool) => tool.name);
    const missing = DOCTOR_REQUIRED_MCP_TOOLS.filter((tool) => !names.includes(tool));
    if (missing.length > 0) throw new Error(`missing MCP tools: ${missing.join(",")}`);
    await runHttpMcpSearchSmoke(client);
    await runHttpMcpFinalizerSmoke(client);
    return { tools: [...DOCTOR_REQUIRED_MCP_TOOLS], taskFlow: "ok", finalizers: "ok", search: "ok" };
  } catch (error) {
    smokeFailed = true;
    throw error;
  } finally {
    const cleanupErrors: string[] = [];
    if (client) {
      try {
        await withTimeout(client.close(), 10_000, "timed out closing HTTP MCP client");
      } catch (error) {
        cleanupErrors.push(errorMessage(error));
      }
    }
    if (running) {
      try {
        await running.close({ forceAfterMs: 1_000, timeoutMs: 10_000 });
      } catch (error) {
        cleanupErrors.push(errorMessage(error));
      }
    }
    try {
      await rm(cwd, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(errorMessage(error));
    }
    if (cleanupErrors.length > 0 && !smokeFailed) {
      throw new Error(`HTTP MCP smoke cleanup failed: ${cleanupErrors.join("; ")}`);
    }
  }
}

async function runHttpMcpSearchSmoke(client: Client): Promise<void> {
  const result = await callHttpMcpJsonTool<{ matches: Array<{ path?: unknown; line?: unknown; text?: unknown }> }>(client, "repo_search", {
    query: "--doctor-rg-literal"
  });
  if (
    result.matches.length !== 1 ||
    result.matches[0]?.path !== "search-smoke.txt" ||
    result.matches[0]?.line !== 2 ||
    result.matches[0]?.text !== "--doctor-rg-literal ok"
  ) {
    throw new Error(`unexpected HTTP MCP search result: ${JSON.stringify(result)}`);
  }
}

async function runHttpMcpFinalizerSmoke(client: Client): Promise<void> {
  const doneTask = await callHttpMcpJsonTool<{ task: { id: string } }>(client, "bridge_create_task", {
    title: "Doctor HTTP complete smoke",
    prompt: "Complete this task over HTTP MCP"
  });
  assertDoctorMcpTask(doneTask.task, {
    taskId: doneTask.task.id,
    status: "new",
    title: "Doctor HTTP complete smoke"
  });
  const fetchedTask = await callHttpMcpJsonTool<{ task: DoctorMcpTask }>(client, "bridge_get_task", {
    task_id: doneTask.task.id
  });
  const newTasks = await callHttpMcpJsonTool<{ tasks: DoctorMcpTask[] }>(client, "bridge_list_tasks", {
    status: "new"
  });
  assertDoctorMcpTask(fetchedTask.task, {
    taskId: doneTask.task.id,
    status: "new",
    title: "Doctor HTTP complete smoke"
  });
  assertDoctorMcpTaskInList(newTasks.tasks, {
    taskId: doneTask.task.id,
    status: "new"
  });
  const claimedTask = await callHttpMcpJsonTool<{ task: DoctorMcpTask }>(client, "bridge_claim_task", {
    task_id: doneTask.task.id,
    claimed_by: "doctor-http-smoke"
  });
  const claimedTasks = await callHttpMcpJsonTool<{ tasks: DoctorMcpTask[] }>(client, "bridge_list_tasks", {
    status: "claimed"
  });
  assertDoctorMcpTask(claimedTask.task, {
    taskId: doneTask.task.id,
    status: "claimed",
    title: "Doctor HTTP complete smoke",
    claimedBy: "doctor-http-smoke"
  });
  assertDoctorMcpTaskInList(claimedTasks.tasks, {
    taskId: doneTask.task.id,
    status: "claimed"
  });
  const completed = await callHttpMcpJsonTool<{ result: DoctorMcpResult }>(client, "bridge_complete_task", {
    task_id: doneTask.task.id,
    summary: "Completed by doctor HTTP MCP",
    commands: ["doctor http finalizer smoke"]
  });
  const blockedTask = await callHttpMcpJsonTool<{ task: { id: string } }>(client, "bridge_create_task", {
    title: "Doctor HTTP block smoke",
    prompt: "Block this task over HTTP MCP"
  });
  const blocked = await callHttpMcpJsonTool<{ result: DoctorMcpResult }>(client, "bridge_block_task", {
    task_id: blockedTask.task.id,
    summary: "Blocked by doctor HTTP MCP",
    code: "doctor_http_blocker",
    retryable: true,
    next_step: "Inspect doctor output."
  });
  const fetchedDone = await callHttpMcpJsonTool<{ result: DoctorMcpResult }>(client, "bridge_fetch_result", {
    task_id: doneTask.task.id
  });
  const fetchedBlocked = await callHttpMcpJsonTool<{ result: DoctorMcpResult }>(client, "bridge_fetch_result", {
    task_id: blockedTask.task.id
  });
  const doneTasks = await callHttpMcpJsonTool<{ tasks: DoctorMcpTask[] }>(client, "bridge_list_tasks", {
    status: "done"
  });
  const blockedTasks = await callHttpMcpJsonTool<{ tasks: DoctorMcpTask[] }>(client, "bridge_list_tasks", {
    status: "blocked"
  });
  const results = await callHttpMcpJsonTool<{ results: DoctorMcpResult[] }>(client, "bridge_list_results", {});

  assertDoctorMcpResult(completed.result, {
    taskId: doneTask.task.id,
    status: "done",
    summary: "Completed by doctor HTTP MCP",
    commands: ["doctor http finalizer smoke"]
  });
  assertDoctorMcpResult(fetchedDone.result, {
    taskId: doneTask.task.id,
    status: "done",
    summary: "Completed by doctor HTTP MCP",
    commands: ["doctor http finalizer smoke"]
  });
  assertDoctorMcpResult(blocked.result, {
    taskId: blockedTask.task.id,
    status: "blocked",
    summary: "Blocked by doctor HTTP MCP",
    blockerCode: "doctor_http_blocker",
    retryable: true,
    nextStep: "Inspect doctor output."
  });
  assertDoctorMcpResult(fetchedBlocked.result, {
    taskId: blockedTask.task.id,
    status: "blocked",
    summary: "Blocked by doctor HTTP MCP",
    blockerCode: "doctor_http_blocker",
    retryable: true,
    nextStep: "Inspect doctor output."
  });
  assertDoctorMcpTaskInList(doneTasks.tasks, {
    taskId: doneTask.task.id,
    status: "done"
  });
  assertDoctorMcpTaskInList(blockedTasks.tasks, {
    taskId: blockedTask.task.id,
    status: "blocked"
  });
  assertDoctorMcpResultInList(results.results, {
    taskId: doneTask.task.id,
    status: "done",
    summary: "Completed by doctor HTTP MCP"
  });
  assertDoctorMcpResultInList(results.results, {
    taskId: blockedTask.task.id,
    status: "blocked",
    summary: "Blocked by doctor HTTP MCP"
  });
}

type DoctorMcpTask = {
  id?: unknown;
  status?: unknown;
  title?: unknown;
  claimed_by?: unknown;
};

type DoctorMcpResult = {
  task_id?: unknown;
  status?: unknown;
  summary?: unknown;
  commands?: unknown;
  blocker?: {
    code?: unknown;
    retryable?: unknown;
    next_step?: unknown;
  };
};

async function callHttpMcpJsonTool<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await withTimeout(
    client.callTool({ name, arguments: args }),
    20_000,
    `timed out calling HTTP MCP tool ${name}`
  );
  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (isMcpTextContent(item)) return JSON.parse(item.text) as T;
    }
  }
  throw new Error(`HTTP MCP tool ${name} did not return text content`);
}

function isMcpTextContent(item: unknown): item is { type: "text"; text: string } {
  return (
    typeof item === "object" &&
    item !== null &&
    "type" in item &&
    "text" in item &&
    item.type === "text" &&
    typeof item.text === "string"
  );
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function assertDoctorMcpResult(
  result: DoctorMcpResult,
  expected: {
    taskId: string;
    status: "done" | "blocked";
    summary: string;
    commands?: string[];
    blockerCode?: string;
    retryable?: boolean;
    nextStep?: string;
  }
): void {
  if (result.task_id !== expected.taskId || result.status !== expected.status || result.summary !== expected.summary) {
    throw new Error(`unexpected HTTP MCP result: ${JSON.stringify(result)} expected ${JSON.stringify(expected)}`);
  }
  if (expected.commands && JSON.stringify(result.commands) !== JSON.stringify(expected.commands)) {
    throw new Error(`unexpected HTTP MCP result commands: ${JSON.stringify(result.commands)} expected ${JSON.stringify(expected.commands)}`);
  }
  if (expected.blockerCode && result.blocker?.code !== expected.blockerCode) {
    throw new Error(`unexpected HTTP MCP blocker: ${JSON.stringify(result.blocker)} expected code ${expected.blockerCode}`);
  }
  if (expected.retryable !== undefined && result.blocker?.retryable !== expected.retryable) {
    throw new Error(`unexpected HTTP MCP blocker retryable: ${JSON.stringify(result.blocker)} expected ${expected.retryable}`);
  }
  if (expected.nextStep !== undefined && result.blocker?.next_step !== expected.nextStep) {
    throw new Error(`unexpected HTTP MCP blocker next_step: ${JSON.stringify(result.blocker)} expected ${expected.nextStep}`);
  }
}

function assertDoctorMcpTask(
  task: DoctorMcpTask,
  expected: {
    taskId: string;
    status: "new" | "claimed" | "done" | "blocked";
    title?: string;
    claimedBy?: string;
  }
): void {
  if (task.id !== expected.taskId || task.status !== expected.status) {
    throw new Error(`unexpected HTTP MCP task: ${JSON.stringify(task)} expected ${JSON.stringify(expected)}`);
  }
  if (expected.title !== undefined && task.title !== expected.title) {
    throw new Error(`unexpected HTTP MCP task title: ${JSON.stringify(task)} expected ${expected.title}`);
  }
  if (expected.claimedBy !== undefined && task.claimed_by !== expected.claimedBy) {
    throw new Error(`unexpected HTTP MCP task claimer: ${JSON.stringify(task)} expected ${expected.claimedBy}`);
  }
}

function assertDoctorMcpTaskInList(
  tasks: unknown,
  expected: {
    taskId: string;
    status: "new" | "claimed" | "done" | "blocked";
  }
): void {
  if (!Array.isArray(tasks)) {
    throw new Error(`unexpected HTTP MCP task list: ${JSON.stringify(tasks)}`);
  }
  if (!tasks.some((task) => isDoctorMcpTask(task) && task.id === expected.taskId && task.status === expected.status)) {
    throw new Error(`missing HTTP MCP task in list: ${JSON.stringify(expected)} from ${JSON.stringify(tasks)}`);
  }
}

function assertDoctorMcpResultInList(
  results: unknown,
  expected: {
    taskId: string;
    status: "done" | "blocked";
    summary: string;
  }
): void {
  if (!Array.isArray(results)) {
    throw new Error(`unexpected HTTP MCP result list: ${JSON.stringify(results)}`);
  }
  if (!results.some((result) => isDoctorMcpResult(result) && result.task_id === expected.taskId && result.status === expected.status && result.summary === expected.summary)) {
    throw new Error(`missing HTTP MCP result in list: ${JSON.stringify(expected)} from ${JSON.stringify(results)}`);
  }
}

function isDoctorMcpTask(task: unknown): task is DoctorMcpTask {
  return typeof task === "object" && task !== null;
}

function isDoctorMcpResult(result: unknown): result is DoctorMcpResult {
  return typeof result === "object" && result !== null;
}

async function runMcpWriteSmoke(): Promise<{ path: string; receipt_payload: "artifact"; staged: string }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "prodex-doctor-"));
  let smokeFailed = false;
  try {
    await writeFile(path.join(cwd, "notes.md"), "old\n", "utf8");
    await execFileAsync("git", ["init"], { cwd });
    await execFileAsync("git", ["config", "user.email", "doctor@example.com"], { cwd });
    await execFileAsync("git", ["config", "user.name", "PROdex Doctor"], { cwd });
    await execFileAsync("git", ["add", "notes.md"], { cwd });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd });
    const { stdout: headOut } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
    const head = headOut.trim();
    const handlers = createMcpToolHandlers({ cwd });

    const dryRun = await handlers.repo_write_file_dry_run({
      path: "notes.md",
      content: "new\n",
      expected_head: head
    });
    const receipt = JSON.parse(await readFile(path.join(cwd, ".bridge", "receipts", `${dryRun.receipt.id}.json`), "utf8")) as {
      metadata?: { new_content?: unknown; new_content_artifact?: unknown };
    };
    if (Object.hasOwn(receipt.metadata ?? {}, "new_content")) {
      throw new Error("dry-run receipt contains inline write payload");
    }
    if (typeof receipt.metadata?.new_content_artifact !== "string") {
      throw new Error("dry-run receipt is missing write payload artifact");
    }

    const applied = await handlers.repo_write_file_apply({
      receipt_id: dryRun.receipt.id,
      expected_head: head,
      preimage_sha256: dryRun.preimage_sha256
    });
    const staged = await handlers.repo_stage_reviewed_paths({
      receipt_ids: [applied.receipt.id],
      expected_head: head
    });
    const { stdout: stagedOut } = await execFileAsync("git", ["diff", "--cached", "--name-only"], { cwd });
    const stagedName = stagedOut.trim();
    if (stagedName !== "notes.md" || staged.paths.join(",") !== "notes.md") {
      throw new Error(`unexpected staged paths: ${stagedName || "<none>"}`);
    }
    return { path: "notes.md", receipt_payload: "artifact", staged: stagedName };
  } catch (error) {
    smokeFailed = true;
    throw error;
  } finally {
    try {
      await rm(cwd, { recursive: true, force: true });
    } catch (error) {
      if (!smokeFailed) throw error;
    }
  }
}

















async function listConsults(store: BridgeStore, options: { readOnly?: boolean } = {}): Promise<ConsultRecord[]> {
  const [tasks, results] = options.readOnly
    ? await Promise.all([listTasksForInspection(store), listRawResultsForInspection(store)])
    : await Promise.all([store.listTasks(), store.listResults()]);
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  assertNoMissingTerminalConsultResults(tasks, results);
  assertNoOrphanConsultResults(tasksById, results);
  const records = results
    .map((result) => {
      const task = tasksById.get(result.task_id);
      return task ? { task, result } : undefined;
    })
    .filter((record): record is ConsultRecord => Boolean(record && isConsultRecord(record)))
    .sort((a, b) => b.result.created_at.localeCompare(a.result.created_at));
  const finalized: ConsultRecord[] = [];
  for (const record of records) {
    finalized.push({ ...record, result: await store.getFinalizedResultReadOnly(record.result.task_id) });
  }
  return finalized;
}














































function resolveOptionalPathFlag(defaultCwd: string, args: string[], flag: string): string | undefined {
  const value = readFlag(args, flag);
  return value ? resolveExistingPathFlag(defaultCwd, value, flag) : undefined;
}








function readRequiredLeadingArgument(args: string[], command: string, placeholder: string): string {
  const value = args[0];
  if (!value || value.startsWith("-")) throw new Error(`${command} requires ${placeholder}`);
  return value;
}
























function isDirectCliInvocation(): boolean {
  if (!process.argv[1]) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(process.argv[1]) === realpathSync(modulePath);
  } catch {
    return path.resolve(process.argv[1]) === modulePath;
  }
}

if (isDirectCliInvocation()) {
  runCli(process.argv.slice(2))
    .then((code) => {
      if (code !== 0) process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
