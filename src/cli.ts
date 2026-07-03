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
const PRO_BROWSER_SMOKE_TOKEN = "PRODEX_PRO_SMOKE_OK";

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

  if (command === "chatgpt") {
    const [subcommand, ...chatgptArgs] = rest;
    if (!subcommand || isHelpSubcommand(subcommand)) {
      throw legacyChatGptNamespaceError();
    }
    if (subcommand === "open") {
      assertOnlyOptions(chatgptArgs, "chatgpt open", ["--port", "--profile-dir", "--url"]);
      const opened = openChatGptBrowser({
        port: readPortFlag(chatgptArgs, "--port") ?? 9333,
        profileDir: readFlag(chatgptArgs, "--profile-dir"),
        url: readChatGptBrowserUrlFlag(chatgptArgs)
      });
      await assertBrowserLaunchStayedAlive(opened);
      io.stdout(`Opened ChatGPT browser via ${opened.command}.`);
      io.stdout(`Profile: ${opened.profileDir}`);
      io.stdout(`Debug: http://127.0.0.1:${opened.port}`);
      return 0;
    }
    if (subcommand === "status") {
      assertOnlyOptions(chatgptArgs, "chatgpt status", ["--port"]);
      const status = await getChatGptBrowserStatus({ port: readPortFlag(chatgptArgs, "--port") ?? 9333 });
      io.stdout(JSON.stringify(status, null, 2));
      return 0;
    }
    if (subcommand === "smoke") {
      assertOnlyOptions(chatgptArgs, "chatgpt smoke", ["--cwd", "--port", "--timeout-ms", "--source-cli"]);
      const targetCwd = resolveCwdFlag(io.cwd, chatgptArgs);
      const targetStore = new BridgeStore(targetCwd);
      const sourceCli = resolveOptionalFileFlag(io.cwd, chatgptArgs, "--source-cli");
      const port = readPortFlag(chatgptArgs, "--port") ?? 9333;
      const timeoutMs = readPositiveNumberFlag(chatgptArgs, "--timeout-ms") ?? 90000;
      const commandOptions = {
        ...(readFlag(chatgptArgs, "--cwd") ? { cwd: targetCwd } : {}),
        ...(readFlag(chatgptArgs, "--port") ? { port } : {})
      };
      const smokePrompt = `This is a one-time prodex smoke test. Reply exactly: ${PRO_BROWSER_SMOKE_TOKEN}`;
      const recordBlockedSmoke = async (
        summary: string,
        blocker: { code: string; message: string; retryable: boolean; next_step?: string },
        thread?: string
      ): Promise<string> => {
        const bundle = await buildDryRunBundle(targetCwd, { prompt: smokePrompt, files: [] });
        const task = await targetStore.createTask({
          source: "codex",
          title: "GPT Pro smoke",
          prompt: bundle.text,
          repo_id: "default",
          provenance: {
            adapter: "chatgpt-control",
            session_id: bundle.id,
            thread,
            warnings: []
          }
        });
        await targetStore.claimTask(task.id, "chatgpt-pro");
        await targetStore.completeTask(task.id, {
          status: "blocked",
          summary,
          commands: ["visible ChatGPT browser smoke"],
          blocker
        });
        await writeSessionBestEffort(
          targetStore,
          {
            id: bundle.id,
            direction: "codex_to_chatgpt",
            backend: "chatgpt-control",
            task_id: task.id,
            thread,
            status: "blocked",
            blocker,
            warnings: []
          },
          io
        );
        return task.id;
      };
      let result: Awaited<ReturnType<typeof sendChatGptPrompt>>;
      try {
        result = await sendChatGptPrompt({
          port,
          prompt: smokePrompt,
          timeoutMs
        });
      } catch (error) {
        const blocker = sourceAwareBrowserBlocker(browserSendBlockerFromError(error), sourceCli, commandOptions);
        const message = blocker.next_step ? `${blocker.message} Next: ${blocker.next_step}` : errorMessage(error);
        let taskId: string;
        try {
          taskId = await recordBlockedSmoke(message, blocker);
        } catch (recordError) {
          throw new Error(`${message} (also failed to record blocked smoke: ${errorMessage(recordError)})`);
        }
        throw new Error(formatBlockedConsultRecordedMessage(message, taskId, sourceCli, { cwd: targetCwd }));
      }
      if (result.answer.trim() !== PRO_BROWSER_SMOKE_TOKEN) {
        const message = `Pro browser smoke returned an unexpected answer. Expected exactly ${PRO_BROWSER_SMOKE_TOKEN}. Actual: ${firstLine(result.answer)}`;
        const blocker = {
          code: "smoke_token_mismatch",
          message,
          retryable: true,
          next_step: `Retry \`${formatBrowserSmokeCommand(sourceCli, commandOptions)}\` after selecting the intended Pro model, or inspect the visible ChatGPT answer.`
        };
        let taskId: string;
        try {
          taskId = await recordBlockedSmoke(message, blocker, result.url);
        } catch (recordError) {
          throw new Error(`${message} (also failed to record blocked smoke: ${errorMessage(recordError)})`);
        }
        throw new Error(formatBlockedConsultRecordedMessage(message, taskId, sourceCli, { cwd: targetCwd }));
      }
      io.stdout(JSON.stringify(result, null, 2));
      return 0;
    }
    throw legacyChatGptNamespaceError(subcommand);
  }

  if (command === "tasks") return runTasksCommand(rest, io);

  if (command === "results") return runResultsCommand(rest, io);

  if (command === "receipts") return runReceiptsCommand(rest, io);

  if (command === "sessions") return runSessionsCommand(rest, io);

  if (command === "pro") {
    const [subcommand, ...proArgs] = rest;
    if (!subcommand || isHelpSubcommand(subcommand)) {
      assertNoExtraArgs(proArgs, "pro help", 0);
      printProHelp(io.stdout);
      return 0;
    }
    if (subcommand === "ask") {
      if (
        printHelpIfRequested(proArgs, "pro ask", io.stdout, printProHelp, {
          valueFlags: [...ASK_PRO_PREVIEW_VALUE_FLAGS],
          booleanFlags: [...ASK_PRO_BOOLEAN_FLAGS]
        })
      ) {
        return 0;
      }
      parseAskProArgs(proArgs, ASK_PRO_PREVIEW_VALUE_FLAGS);
      if (hasAskProSendMode(proArgs)) {
        throw new Error("prodex pro ask is a dry-run preview. Use `prodex pro browser ask` for visible-browser sends.");
      }
      const hasDryRun = hasAskProDryRunMode(proArgs);
      return runCli(["ask-pro", ...(hasDryRun ? [] : ["--dry-run"]), ...proArgs], io);
    }
    if (subcommand === "browser") {
      const [browserSubcommand, ...browserArgs] = proArgs;
      if (!browserSubcommand || isHelpSubcommand(browserSubcommand)) {
        assertOnlyOptions(browserArgs, "pro browser help", ["--source-cli"]);
        const sourceCli = resolveOptionalFileFlag(io.cwd, browserArgs, "--source-cli");
        printProBrowserHelp(io.stdout, sourceCli);
        return 0;
      }
      if (browserSubcommand === "login") {
        if (
          printProBrowserHelpIfRequested(browserArgs, "pro browser login", io, {
            valueFlags: ["--cwd", "--profile-dir", "--port", "--url", "--source-cli", "--launch-timeout-ms"],
            booleanFlags: ["--dry-run"]
          })
        ) {
          return 0;
        }
        assertOnlyOptions(browserArgs, "pro browser login", ["--cwd", "--profile-dir", "--port", "--url", "--source-cli", "--launch-timeout-ms"], ["--dry-run"]);
        const loginUrl = readChatGptBrowserUrlFlag(browserArgs);
        const sourceCli = resolveOptionalFileFlag(io.cwd, browserArgs, "--source-cli");
        const targetCwd = readFlag(browserArgs, "--cwd") ? resolveCwdFlag(io.cwd, browserArgs) : undefined;
        const profileDir = readFlag(browserArgs, "--profile-dir");
        const port = readPortFlag(browserArgs, "--port") ?? 9333;
        const launchTimeoutMs = readPositiveNumberFlag(browserArgs, "--launch-timeout-ms");
        const commandOptions = {
          ...(targetCwd ? { cwd: targetCwd } : {}),
          ...(profileDir ? { profileDir } : {}),
          ...(port !== 9333 ? { port } : {}),
          ...(readFlag(browserArgs, "--url") ? { url: loginUrl } : {}),
          ...(launchTimeoutMs !== undefined ? { launchTimeoutMs } : {})
        };
        if (browserArgs.includes("--dry-run")) {
          printBrowserLoginGuide(io.stdout, {
            opened: false,
            loginUrl,
            profileDir: profileDir ?? defaultChatGptProfileDir(),
            port,
            sourceCli,
            commandOptions
          });
          return 0;
        }
        const opened = openChatGptBrowser({
          port,
          profileDir,
          url: loginUrl
        });
        await assertBrowserLaunchStayedAlive(opened, launchTimeoutMs);
        printBrowserLoginGuide(io.stdout, {
          opened: true,
          loginUrl,
          profileDir: opened.profileDir,
          port: opened.port,
          sourceCli,
          commandOptions
        });
        return 0;
      }
      if (browserSubcommand === "ask") {
        if (
          printProBrowserHelpIfRequested(browserArgs, "pro browser ask", io, {
            valueFlags: [...ASK_PRO_VALUE_FLAGS],
            booleanFlags: [...ASK_PRO_BOOLEAN_FLAGS]
          })
        ) {
          return 0;
        }
        if (hasAskProDryRunMode(browserArgs) && hasAskProSendMode(browserArgs)) {
          throw new Error("ask-pro cannot combine --dry-run and --send");
        }
        if (hasAskProDryRunMode(browserArgs)) {
          throw new Error("prodex pro browser ask is an explicit visible-browser send. Use `prodex pro ask` for dry-run previews.");
        }
        const hasMode = hasAskProMode(browserArgs);
        return runCli(["ask-pro", ...(hasMode ? [] : ["--send"]), ...browserArgs], { ...io, allowAskProBrowserSend: true });
      }
      if (browserSubcommand === "open" || browserSubcommand === "status" || browserSubcommand === "doctor") {
        const replacement = browserSubcommand === "open" ? "login" : "check";
        throw new Error(`Use \`prodex pro browser ${replacement}\` for explicit browser automation.`);
      }
      if (browserSubcommand === "smoke") {
        if (printProBrowserHelpIfRequested(browserArgs, "pro browser smoke", io, { valueFlags: ["--cwd", "--port", "--timeout-ms", "--source-cli"] })) return 0;
        return runCli(["chatgpt", browserSubcommand, ...browserArgs], io);
      }
      if (browserSubcommand === "check") {
        if (printProBrowserHelpIfRequested(browserArgs, "pro browser check", io, { valueFlags: ["--cwd", "--port", "--timeout-ms", "--source-cli"] })) return 0;
        assertOnlyOptions(browserArgs, "pro browser check", ["--cwd", "--port", "--timeout-ms", "--source-cli"]);
        const targetCwd = resolveCwdFlag(io.cwd, browserArgs);
        readPortFlag(browserArgs, "--port");
        readPositiveNumberFlag(browserArgs, "--timeout-ms");
        const healthy = await printProductCheck(new BridgeStore(targetCwd), io, browserArgs, targetCwd);
        return healthy ? 0 : 1;
      }
      if (browserSubcommand === "models") {
        if (printProBrowserHelpIfRequested(browserArgs, "pro browser models", io, { valueFlags: ["--port", "--timeout-ms", "--source-cli"] })) return 0;
        assertOnlyOptions(browserArgs, "pro browser models", ["--port", "--timeout-ms", "--source-cli"]);
        const listed = await listChatGptModelOptions({
          port: readPortFlag(browserArgs, "--port"),
          timeoutMs: readPositiveNumberFlag(browserArgs, "--timeout-ms")
        });
        io.stdout("Model menu options in the visible ChatGPT tab (read-only; nothing was selected):");
        for (const option of listed.options) {
          const marker = option.checked ? "*" : " ";
          const suffix = option.kind === "submenu" ? "  (has sub-variants; not selectable via --model yet)" : "";
          io.stdout(`${marker} ${option.label}${suffix}`);
        }
        io.stdout("Use radio entries with `pro browser ask --model/--effort`; Pro sub-modes via --pro-mode 기본|확장.");
        return 0;
      }
      throw unknownSubcommandError("pro browser", browserSubcommand, ["login", "ask", "smoke", "check", "models"]);
    }
    if (subcommand === "open" || subcommand === "status" || subcommand === "smoke" || subcommand === "check" || subcommand === "doctor") {
      throw new Error(`Use \`prodex pro browser ${subcommand === "doctor" ? "check" : subcommand}\` for explicit browser automation.`);
    }
    if (subcommand === "list") {
      if (printHelpIfRequested(proArgs, "pro list", io.stdout, printProHelp, { valueFlags: ["--cwd", "--source-cli"] })) return 0;
      assertOnlyOptions(proArgs, "pro list", ["--cwd", "--source-cli"]);
      const targetCwd = resolveCwdFlag(io.cwd, proArgs);
      const targetStore = new BridgeStore(targetCwd);
      const sourceCli = resolveOptionalFileFlag(io.cwd, proArgs, "--source-cli");
      const answerOptions = { cwd: readFlag(proArgs, "--cwd") ? targetCwd : undefined };
      const consults = await listConsultListEntries(targetStore);
      for (const entry of consults) {
        if (entry.kind === "untrusted") {
          io.stdout(`${entry.task.id}\tuntrusted\t${sourceAwareResultMessage(errorMessage(entry.error), sourceCli, answerOptions)}`);
        } else {
          io.stdout(`${entry.consult.task.id}\t${entry.consult.result.status}\t${formatProListSummary(entry.consult, sourceCli, answerOptions)}`);
        }
      }
      return 0;
    }
    if (subcommand === "latest") {
      if (printHelpIfRequested(proArgs, "pro latest", io.stdout, printProHelp, { valueFlags: ["--cwd", "--source-cli"] })) return 0;
      assertOnlyOptions(proArgs, "pro latest", ["--cwd", "--source-cli"]);
      const targetCwd = resolveCwdFlag(io.cwd, proArgs);
      const targetStore = new BridgeStore(targetCwd);
      const sourceCli = resolveOptionalFileFlag(io.cwd, proArgs, "--source-cli");
      const answerOptions = { cwd: readFlag(proArgs, "--cwd") ? targetCwd : undefined };
      let consult: Awaited<ReturnType<typeof latestTrustedConsult>>;
      try {
        consult = await latestTrustedConsult(targetStore);
      } catch (error) {
        throw sourceAwareResultError(error, sourceCli, answerOptions);
      }
      if (!consult) throw new Error("No GPT Pro answers found");
      io.stdout(formatProAnswer(consult, sourceCli, answerOptions));
      return 0;
    }
    if (subcommand === "show") {
      if (printHelpIfRequested(proArgs, "pro show", io.stdout, printProHelp, { valueFlags: ["--cwd", "--source-cli"], maxPositionals: 1 })) return 0;
      const [taskId] = readPositionalsWithOptions(proArgs, "pro show", 1, ["--cwd", "--source-cli"]);
      if (!taskId) throw new Error("pro show requires <task-id|latest>");
      const targetCwd = resolveCwdFlag(io.cwd, proArgs);
      const targetStore = new BridgeStore(targetCwd);
      const sourceCli = resolveOptionalFileFlag(io.cwd, proArgs, "--source-cli");
      const answerOptions = { cwd: readFlag(proArgs, "--cwd") ? targetCwd : undefined };
      let consult: Awaited<ReturnType<typeof getConsult>>;
      try {
        consult = taskId === "latest" ? await latestTrustedConsult(targetStore) : await getConsult(targetStore, taskId, { readOnly: true });
      } catch (error) {
        throw sourceAwareResultError(error, sourceCli, answerOptions);
      }
      if (!consult) throw new Error(taskId === "latest" ? "No GPT Pro answers found" : `GPT Pro answer not found: ${taskId}`);
      io.stdout(formatProAnswer(consult, sourceCli, answerOptions));
      return 0;
    }
    throw unknownSubcommandError("pro", subcommand, ["ask", "browser", "list", "latest", "show"]);
  }

  if (command === "consults") {
    throw new Error("The legacy `consults` alias is retired. Use `prodex pro list`, `prodex pro latest`, or `prodex pro show <task-id|latest>`.");
  }

  if (command === "ask-pro") {
    const parsedAskPro = parseAskProArgs(rest);
    const hasDryRunMode = parsedAskPro.optionArgs.includes("--dry-run");
    const hasSendMode = parsedAskPro.optionArgs.includes("--send");
    if (!hasDryRunMode && !hasSendMode) {
      throw new Error("ask-pro requires --dry-run or --send");
    }
    if (hasDryRunMode && hasSendMode) {
      throw new Error("ask-pro cannot combine --dry-run and --send");
    }
    if (hasSendMode && !io.allowAskProBrowserSend) {
      throw new Error("Direct ask-pro --send is disabled. Use `prodex pro browser ask` for explicit visible-browser sends.");
    }
    const targetCwd = resolveCwdFlag(io.cwd, parsedAskPro.optionArgs);
    const targetStore = new BridgeStore(targetCwd);
    const files = readRepeatedFlag(parsedAskPro.optionArgs, "--file");
    const targetUrl = readFlag(parsedAskPro.optionArgs, "--target-url");
    const normalizedTargetUrl = targetUrl ? normalizeChatGptTargetUrl(targetUrl) : undefined;
    if (!normalizedTargetUrl && parsedAskPro.optionArgs.includes("--confirm-target")) {
      throw new Error("--confirm-target requires --target-url so the visible browser target is explicit.");
    }
    if (normalizedTargetUrl && hasSendMode && !parsedAskPro.optionArgs.includes("--confirm-target")) {
      throw new Error("--target-url requires --confirm-target after you manually verify the visible ChatGPT tab is the intended Project/thread.");
    }
    const prompt = parsedAskPro.promptParts.join(" ").trim();
    if (!prompt) throw new Error("ask-pro requires a prompt");
    const browserDefaults = await loadBrowserDefaults(targetCwd);
    const explicitProject = readFlag(parsedAskPro.optionArgs, "--project");
    const explicitProjectNew = readFlag(parsedAskPro.optionArgs, "--project-new");
    if (explicitProject !== undefined && explicitProjectNew !== undefined) {
      throw new Error("ask-pro cannot combine --project and --project-new; pick an existing project or create one.");
    }
    if (normalizedTargetUrl && (explicitProject !== undefined || explicitProjectNew !== undefined)) {
      throw new Error(
        "ask-pro cannot combine --target-url with --project/--project-new: --target-url pins the confirmed tab while the project step navigates the sidebar away from it. Open the project thread in the browser and pass its URL as --target-url instead."
      );
    }
    const explicitModel = readFlag(parsedAskPro.optionArgs, "--model");
    const explicitProModeRaw = readFlag(parsedAskPro.optionArgs, "--pro-mode");
    const explicitEffortRaw = readFlag(parsedAskPro.optionArgs, "--effort");
    if (explicitProModeRaw !== undefined && explicitEffortRaw !== undefined) {
      throw new Error("ask-pro cannot combine --pro-mode and --effort; Pro sub-modes and reasoning effort are different model axes.");
    }
    const explicitProMode = explicitProModeRaw === undefined ? undefined : parseProMode(explicitProModeRaw);
    const explicitEffort = explicitEffortRaw === undefined ? undefined : parseReasoningEffort(explicitEffortRaw);
    // Explicit per-ask flags override persisted defaults. Choosing either
    // reasoning axis explicitly suppresses the default for the other axis, and
    // pinning --target-url suppresses a default project (it would navigate away
    // from the confirmed tab).
    const selectionModel = explicitModel ?? browserDefaults?.model;
    const selectionProjectNew = explicitProjectNew;
    const selectionProject =
      explicitProject ?? (normalizedTargetUrl || selectionProjectNew !== undefined ? undefined : browserDefaults?.project);
    const reasoningAxisChosen = explicitProMode !== undefined || explicitEffort !== undefined;
    const selectionProMode = explicitProMode ?? (reasoningAxisChosen ? undefined : browserDefaults?.pro_mode);
    const selectionEffort = explicitEffort ?? (reasoningAxisChosen ? undefined : browserDefaults?.effort);
    const selectionMetadata: Record<string, string> = {
      ...(selectionProject ? { project: selectionProject } : {}),
      ...(selectionProjectNew ? { project_new: selectionProjectNew } : {}),
      ...(selectionModel ? { model: selectionModel } : {}),
      ...(selectionProMode ? { pro_mode: selectionProMode } : {}),
      ...(selectionEffort ? { effort: selectionEffort } : {})
    };
    const browserPort = hasSendMode ? (readPortFlag(parsedAskPro.optionArgs, "--port") ?? 9333) : undefined;
    // Pro extended can legitimately think for minutes, so its default timeout is
    // higher; an explicit --timeout-ms always wins.
    const defaultBrowserTimeoutMs = selectionProMode === "확장" ? 300_000 : 90_000;
    const browserTimeoutMs = hasSendMode
      ? (readPositiveNumberFlag(parsedAskPro.optionArgs, "--timeout-ms") ?? defaultBrowserTimeoutMs)
      : undefined;
    const sourceCli = resolveOptionalFileFlag(io.cwd, parsedAskPro.optionArgs, "--source-cli");
    const bundle = await buildDryRunBundle(targetCwd, { prompt, files });
    if (hasSendMode) {
      const browserCommandOptions = {
        cwd: targetCwd,
        port: parsedAskPro.optionArgs.includes("--port") ? browserPort : undefined
      };
      const task = await targetStore.createTask({
        source: "codex",
        title: "GPT Pro consult",
        prompt: bundle.text,
        repo_id: "default",
        files: files.map((file) => ({ path: file, role: "context" as const })),
        provenance: {
          adapter: "chatgpt-control",
          session_id: bundle.id,
          thread: normalizedTargetUrl,
          warnings: []
        }
      });
      await targetStore.claimTask(task.id, "chatgpt-pro");
      try {
        await writeSessionBeforeBrowserSend(
          targetStore,
          {
            id: bundle.id,
            direction: "codex_to_chatgpt",
            backend: "chatgpt-control",
            task_id: task.id,
            thread: normalizedTargetUrl,
            status: "running",
            warnings: []
          }
        );
      } catch (error) {
        const blocker = {
          code: "session_record_failed",
          message: `Could not record ChatGPT browser session before send: ${errorMessage(error)}`,
          retryable: true,
          next_step: "Fix local .bridge write permissions, then rerun the consult."
        };
        try {
          await targetStore.completeTask(task.id, {
            status: "blocked",
            summary: blocker.message,
            commands: ["visible ChatGPT browser consult"],
            blocker
          });
        } catch (recordError) {
          throw new Error(`${blocker.message} (also failed to record blocked consult: ${errorMessage(recordError)})`);
        }
        throw new Error(formatBlockedConsultRecordedMessage(blocker.message, task.id, sourceCli, { cwd: targetCwd }));
      }
      let consult: Awaited<ReturnType<typeof sendChatGptPrompt>>;
      try {
        consult = await sendChatGptPrompt({
          port: browserPort,
          prompt: bundle.text,
          targetUrl: normalizedTargetUrl,
          timeoutMs: browserTimeoutMs,
          project: selectionProject,
          projectNew: selectionProjectNew,
          model: selectionModel,
          proMode: selectionProMode,
          effort: selectionEffort
        });
      } catch (error) {
        const blocker = sourceAwareBrowserBlocker(browserSendBlockerFromError(error), sourceCli, browserCommandOptions);
        const message = blocker.next_step ? `${blocker.message} Next: ${blocker.next_step}` : errorMessage(error);
        try {
          await targetStore.completeTask(task.id, {
            status: "blocked",
            summary: message,
            commands: ["visible ChatGPT browser consult"],
            blocker
          });
          await writeSessionBestEffort(
            targetStore,
            {
              id: bundle.id,
              direction: "codex_to_chatgpt",
              backend: "chatgpt-control",
              task_id: task.id,
              thread: normalizedTargetUrl,
              status: "blocked",
              blocker,
              warnings: []
            },
            io
          );
        } catch (recordError) {
          throw new Error(`${message} (also failed to record blocked consult: ${errorMessage(recordError)})`);
        }
        throw new Error(formatBlockedConsultRecordedMessage(message, task.id, sourceCli, { cwd: targetCwd }));
      }
      const answerArtifactText = formatProConsultArtifact(consult);
      const persistenceWarnings = [...consult.warnings];
      let answerArtifactPath: string | undefined;
      const answerArtifactBytes = Buffer.byteLength(answerArtifactText, "utf8");
      if (answerArtifactBytes > MAX_FETCHABLE_RESULT_ARTIFACT_BYTES) {
        const warning = `answer_artifact_warning: answer artifact is too large for bridge_fetch_result_artifact (${answerArtifactBytes} bytes > ${MAX_FETCHABLE_RESULT_ARTIFACT_BYTES} bytes); saved answer in result summary only`;
        persistenceWarnings.push(warning);
        io.stderr(warning);
      } else {
        try {
          answerArtifactPath = await targetStore.writeArtifactText(`.bridge/artifacts/pro-consults/${task.id}.md`, answerArtifactText);
        } catch (error) {
          const warning = `answer_artifact_warning: ${errorMessage(error)}`;
          persistenceWarnings.push(warning);
          io.stderr(warning);
        }
      }
      try {
        await targetStore.writeReceipt({
          kind: "consult_answer_saved",
          task_id: task.id,
          session_id: bundle.id,
          summary: `Recorded ChatGPT answer for ${task.id}`,
          metadata: {
            ...(answerArtifactPath ? { artifact_path: answerArtifactPath } : {}),
            thread: consult.url,
            ...(Object.keys(selectionMetadata).length > 0 ? { selection: selectionMetadata } : {}),
            warnings: persistenceWarnings
          }
        });
      } catch (error) {
        const warning = `receipt_record_warning: ${errorMessage(error)}`;
        persistenceWarnings.push(warning);
        io.stderr(warning);
      }
      let result: Awaited<ReturnType<BridgeStore["completeTask"]>>;
      try {
        result = await targetStore.completeTask(task.id, {
          status: "done",
          summary: consult.answer,
          artifacts: answerArtifactPath ? [{ path: answerArtifactPath, role: "result", bytes: Buffer.byteLength(answerArtifactText, "utf8") }] : [],
          commands: ["visible ChatGPT browser consult"],
          warnings: persistenceWarnings,
          provenance: {
            thread: consult.url,
            warnings: persistenceWarnings
          }
        });
      } catch (error) {
        io.stdout(`consult_answer_received_but_not_saved: ${task.id} ${consult.url}`);
        io.stdout("");
        io.stdout(consult.answer);
        throw new Error(`ChatGPT answer was received but local persistence failed: ${errorMessage(error)}`);
      }
      await writeSessionBestEffort(
        targetStore,
        {
          id: bundle.id,
          direction: "codex_to_chatgpt",
          backend: "chatgpt-control",
          task_id: task.id,
          thread: consult.url,
          status: "done",
          warnings: persistenceWarnings
        },
        io
      );
      io.stdout(`${result.task_id}\t${result.status}\t${consult.url}`);
      io.stdout("");
      io.stdout(result.summary);
    } else {
      await writeSessionBestEffort(
        targetStore,
        {
          id: bundle.id,
          direction: "codex_to_chatgpt",
          backend: "manual",
          status: "preview",
          warnings: []
        },
        io
      );
      await targetStore.writeReceipt({
        kind: "consult_preview",
        session_id: bundle.id,
        summary: `Created dry-run consult preview ${bundle.id}`
      });
      io.stdout(`DRY RUN ${bundle.id}`);
      io.stdout(bundle.text);
    }
    return 0;
  }

  if (command === "mcp") {
    if (printHelpIfRequested(rest, "mcp", io.stdout, printMcpHelp, { valueFlags: ["--cwd"] })) return 0;
    assertOnlyOptions(rest, "mcp", ["--cwd"]);
    await runMcpServer(resolveCwdFlag(io.cwd, rest));
    return 0;
  }

  throw unknownTopLevelCommandError(command);
}

function defaultIo(): CliIO {
  return {
    cwd: process.cwd(),
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line)
  };
}




















function isHelpArgs(args: string[]): boolean {
  return args.length > 0 && isHelpSubcommand(args[0]);
}



function printProBrowserHelpIfRequested(args: string[], command: string, io: CliIO, options: HelpRequestOptions): boolean {
  const helpIndex = findHelpFlagIndexBeforePromptDelimiter(args);
  if (helpIndex === -1) return false;
  assertHelpRequestArgs(args, command, options);
  printProBrowserHelp(io.stdout, resolveOptionalFileFlag(io.cwd, args, "--source-cli"));
  return true;
}









function legacyChatGptNamespaceError(subcommand?: string): Error {
  const prefix = subcommand ? `Unknown legacy chatgpt subcommand: ${subcommand}.` : "The legacy `chatgpt` namespace is hidden.";
  return new Error(`${prefix} Use \`prodex pro browser help\` for visible-browser commands.`);
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

1. Prepare the local bridge:
   ${cli} init --cwd ${quotedCwd}
   ${cli} doctor --cwd ${quotedCwd}${sourceCliOption}

2. Claude stdio MCP:
   ${cli} claude config --cwd ${quotedCwd}${sourceCliOption}
   ${cli} claude prompt --cwd ${quotedCwd}${sourceCliOption}

3. ChatGPT Project HTTP MCP:
   Note: HTTP MCP uses a short-lived token. Paste token-bearing URLs only into your own trusted private MCP client.
   ${TOKEN_BEARING_MCP_URL_AUTHORITY_WARNING}
   ${cli} setup --cwd ${quotedCwd} --token-ttl-hours 24
   ${cli} start --cwd ${quotedCwd}${sourceCliOption}
   Keep this terminal open while ChatGPT uses the bridge; run the next commands in a second terminal.
   ${cli} status --cwd ${quotedCwd} --show-token --url-only${sourceCliOption}
   ${cli} project prompt --cwd ${quotedCwd}${sourceCliOption}

4. Optional ChatGPT Pro consults:
   cd ${quotedCwd}
   ${proAskCommand}  # dry-run/manual preview
   ${cli} pro browser login --dry-run${sourceCliOption}  # preview, no browser opens
   ${cli} pro browser login${sourceCliOption}  # opens visible browser
   ${cli} pro browser help${sourceCliOption}
   ${cli} pro browser check${sourceCliOption} --cwd ${quotedCwd}
   ${cli} pro browser smoke${sourceCliOption} --cwd ${quotedCwd}
   ${proBrowserAskCommand}  # visible-browser send
   ${cli} pro list${sourceCliOption} --cwd ${quotedCwd}
   ${cli} pro latest${sourceCliOption} --cwd ${quotedCwd}
   ${cli} results show latest --cwd ${quotedCwd}
   ${cli} results artifact latest --cwd ${quotedCwd}
   ${cli} results reseal <task-id> --confirm-current-result --cwd ${quotedCwd}  # only after reviewing .bridge/results/<task-id>.json

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



function productCheckBrowserNextStep(nextStep: string | undefined, sourceCli?: string, options: BrowserCommandOptions = {}): string | undefined {
  const sourceAware = sourceAwareBrowserNextStep(nextStep, sourceCli, options);
  if (!sourceAware) return sourceAware;
  if (sourceAware.includes("`")) return sourceAware;
  if (sourceAware.includes("pass --target-url with --confirm-target")) {
    return sourceAware.replace("pass --target-url with --confirm-target", `run \`${formatBrowserTargetAskCommand(sourceCli, options)}\``);
  }
  return sourceAware.replace(/(?:and|then) retry\.$/, `then run \`${formatBrowserSmokeCommand(sourceCli, options)}\`.`);
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

function printBrowserLoginGuide(
  stdout: (line: string) => void,
  input: { opened: boolean; loginUrl: string; profileDir: string; port: number; sourceCli?: string; commandOptions?: BrowserCommandOptions }
): void {
  const loginCommand = formatBrowserLoginCommand(input.sourceCli, input.commandOptions);
  const runtimeCommandOptions = {
    ...(input.commandOptions?.cwd ? { cwd: input.commandOptions.cwd } : {}),
    ...(input.commandOptions?.port ? { port: input.commandOptions.port } : {})
  };
  const checkCommand = formatBrowserCheckCommand(input.sourceCli, runtimeCommandOptions);
  const smokeCommand = formatBrowserSmokeCommand(input.sourceCli, runtimeCommandOptions);
  stdout("ChatGPT Pro browser login");
  stdout(input.opened ? "Opened the dedicated Chrome window for ChatGPT." : "Dry run: no browser was opened.");
  stdout("");
  stdout("Steps:");
  if (input.opened) {
    stdout(`1. Log in manually at ${input.loginUrl} in the dedicated Chrome window.`);
    stdout("2. If ChatGPT asks for captcha, Cloudflare/human verification, permission, or account verification, complete it in the browser.");
    stdout("3. For usage limit, message limit, model limit, or rate limit, wait for the reset or choose an available model in the browser.");
    stdout("4. Open a normal ChatGPT chat or the intended Project/thread so the prompt composer is visible.");
    stdout("5. Select the Pro/Thinking model you want in the ChatGPT UI.");
    stdout(`6. Run \`${checkCommand}\` to confirm the session is reachable.`);
    stdout(`7. Run \`${smokeCommand}\` to verify a real Pro response path.`);
  } else {
    stdout(`1. Run \`${loginCommand}\` without \`--dry-run\` to open the dedicated Chrome window.`);
    stdout(`2. Log in manually at ${input.loginUrl} in that Chrome window.`);
    stdout("3. If ChatGPT asks for captcha, Cloudflare/human verification, permission, or account verification, complete it in the browser.");
    stdout("4. For usage limit, message limit, model limit, or rate limit, wait for the reset or choose an available model in the browser.");
    stdout("5. Open a normal ChatGPT chat or the intended Project/thread so the prompt composer is visible.");
    stdout("6. Select the Pro/Thinking model you want in the ChatGPT UI.");
    stdout(`7. Run \`${checkCommand}\` to confirm the session is reachable.`);
    stdout(`8. Run \`${smokeCommand}\` to verify a real Pro response path.`);
  }
  stdout("");
  stdout(`Profile: ${input.profileDir}`);
  stdout(`Debug: http://127.0.0.1:${input.port}`);
  if (input.opened) {
    stdout("You can close this Chrome window after check/smoke or when you are done. The dedicated profile is reused next time.");
  } else {
    stdout("The dedicated profile path above will be reused by the real login command.");
  }
}


async function assertBrowserLaunchStayedAlive(opened: ChatGptBrowserLaunch, timeoutMs?: number): Promise<void> {
  const outcome = await waitForBrowserLaunchReady(opened, timeoutMs);
  if (outcome.reachable) return;
  if (outcome.earlyExit) {
    const detail = formatBrowserEarlyExit(outcome.earlyExit);
    throw new Error(
      `Chrome/Chromium exited before DevTools became reachable (${detail}). Check the visible browser environment, profile lock, display access, or PRODEX_CHROME, then retry.`
    );
  }
  throw new Error(
    `Chrome/Chromium did not expose a reachable DevTools endpoint after launch. Check the visible browser environment, profile lock, display access, or PRODEX_CHROME, then retry.`
  );
}

async function waitForBrowserLaunchReady(
  opened: ChatGptBrowserLaunch,
  timeoutMs = 5_000
): Promise<{ reachable: true } | { reachable: false; earlyExit?: Awaited<ReturnType<ChatGptBrowserLaunch["waitForEarlyExit"]>> }> {
  const deadline = Date.now() + timeoutMs;
  let earlyExit: Awaited<ReturnType<ChatGptBrowserLaunch["waitForEarlyExit"]>>;
  while (Date.now() <= deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    const status = await getChatGptBrowserStatus({ port: opened.port, timeoutMs: Math.min(250, remainingMs) });
    if (status.reachable) return { reachable: true };
    earlyExit ??= await opened.waitForEarlyExit(1);
    if (earlyExit && (earlyExit.code !== 0 || earlyExit.signal || earlyExit.error)) {
      return { reachable: false, earlyExit };
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
  }
  return { reachable: false, ...(earlyExit ? { earlyExit } : {}) };
}

function formatBrowserEarlyExit(exit: Awaited<ReturnType<ChatGptBrowserLaunch["waitForEarlyExit"]>>): string {
  if (!exit) return "no exit details";
  return exit.error ?? `exit code ${exit.code ?? "null"}${exit.signal ? ` signal ${exit.signal}` : ""}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatBrowserModelHints(modelHints: string[]): string | undefined {
  const modelish = /\b(?:ChatGPT|GPT(?:-[\w.]+)?|Pro|Plus|Team|Enterprise|Thinking|Extra High|Auto)\b/i;
  const hints = [...new Set(modelHints.map((hint) => hint.trim()).filter((hint) => modelish.test(hint)))]
    .map((hint) => (hint.length > 80 ? `${hint.slice(0, 77)}...` : hint))
    .slice(0, 6);
  return hints.length > 0 ? hints.join(" | ") : undefined;
}

function browserReadinessNextStep(input: { loggedInLikely: boolean; hasComposer: boolean }): string {
  if (!input.loggedInLikely) {
    return "Log in manually in the visible ChatGPT browser, then retry.";
  }
  if (!input.hasComposer) {
    return "Open a normal ChatGPT chat or Project thread, select the Pro/Thinking model, and retry.";
  }
  return "Review the visible ChatGPT browser state, then retry.";
}

async function printProductCheck(store: BridgeStore, io: CliIO, args: string[], configCwd = io.cwd): Promise<boolean> {
  const sourceCli = resolveOptionalFileFlag(io.cwd, args, "--source-cli");
  const setupHintCwd = readFlag(args, "--cwd") ? configCwd : undefined;
  io.stdout("prodex product check");
  let bridgeReady = false;
  try {
    bridgeReady = await store.hasReadyBridgeStorageReadOnly();
    io.stdout(
      bridgeReady
        ? "bridge: ok (.bridge)"
        : `bridge: missing (.bridge) - run \`${formatInitCommand(sourceCli, { cwd: setupHintCwd })}\` when you need local task/result storage`
    );
  } catch (error) {
    io.stdout(`bridge: blocked - ${errorMessage(error)}`);
  }

  let configReady = false;
  try {
    const config = await loadLocalConfig(configCwd);
    const tokenStatus = getTokenExpiryStatus(config);
    if (tokenStatus.status === "expired") {
      io.stdout(`config: expired - run \`${formatSetupCommand(sourceCli, { cwd: setupHintCwd })}\``);
    } else {
      io.stdout(`config: ok ${redactServerUrl(config.server_url)} token_status=${tokenStatus.status}`);
      const warningLine = formatConfigWarningLine(tokenStatus, sourceCli, setupHintCwd);
      if (warningLine) io.stdout(warningLine);
      configReady = true;
    }
  } catch (error) {
    if (isMissingFileError(error)) {
      io.stdout(`config: missing - run \`${formatSetupCommand(sourceCli, { cwd: setupHintCwd })}\``);
    } else {
      io.stdout(`config: failed ${sourceAwareSetupMessage(errorMessage(error), sourceCli, { cwd: setupHintCwd })}`);
    }
  }

  const browserStatus = await getChatGptBrowserStatus({
    port: readPortFlag(args, "--port") ?? 9333,
    timeoutMs: readPositiveNumberFlag(args, "--timeout-ms") ?? 1500
  });
  const browserCommandOptions = {
    cwd: setupHintCwd,
    port: readPortFlag(args, "--port") ?? undefined
  };
  let chatgptReady = false;
  const visibilityBlocker = chatGptVisibilityBlocker(browserStatus.visibilityState, browserStatus.url);
  if (!browserStatus.reachable) {
    io.stdout(`chatgpt: ${browserStatus.blocker?.code ?? "unreachable"} - ${browserStatus.blocker?.message ?? "browser is not reachable"}`);
    const nextStep = productCheckBrowserNextStep(browserStatus.blocker?.next_step, sourceCli, browserCommandOptions);
    if (nextStep) io.stdout(`next: ${nextStep}`);
  } else if (browserStatus.blocker) {
    const visibilityText =
      browserStatus.blocker.code === "tab_not_visible" ? ` visibility=${browserStatus.visibilityState ?? "unknown"}` : "";
    io.stdout(`chatgpt: blocked ${browserStatus.blocker.code}${visibilityText} - ${browserStatus.blocker.message}`);
    const nextStep = productCheckBrowserNextStep(browserStatus.blocker.next_step, sourceCli, browserCommandOptions);
    if (nextStep) io.stdout(`next: ${nextStep}`);
  } else if (visibilityBlocker) {
    io.stdout(`chatgpt: blocked ${visibilityBlocker.code} visibility=${browserStatus.visibilityState ?? "unknown"} - ${visibilityBlocker.message}`);
    const nextStep = productCheckBrowserNextStep(visibilityBlocker.next_step, sourceCli, browserCommandOptions);
    if (nextStep) io.stdout(`next: ${nextStep}`);
  } else if (browserStatus.loggedInLikely && browserStatus.hasComposer) {
    io.stdout(`chatgpt: ok logged_in=true composer=true${browserStatus.url ? ` url=${browserStatus.url}` : ""}`);
    chatgptReady = true;
  } else {
    io.stdout(`chatgpt: blocked logged_in=${browserStatus.loggedInLikely} composer=${browserStatus.hasComposer}`);
    const nextStep = productCheckBrowserNextStep(browserReadinessNextStep(browserStatus), sourceCli, browserCommandOptions);
    io.stdout(`next: ${nextStep}`);
  }
  const modelHints = formatBrowserModelHints(browserStatus.modelHints);
  if (modelHints) io.stdout(`model_hints: ${modelHints}`);

  if (bridgeReady) {
    try {
      const latest = await latestTrustedConsult(store, { readOnly: false });
      if (latest) {
        for (const line of formatProductCheckLatestProLines(latest, sourceCli, browserCommandOptions)) io.stdout(line);
      } else {
        io.stdout("latest_pro: missing");
      }
    } catch (error) {
      if (isUntrustedResultError(error)) {
        io.stdout(`latest_pro: untrusted ${error.taskId} ${sourceAwareResultMessage(errorMessage(error), sourceCli, browserCommandOptions)}`);
      } else {
        io.stdout(`latest_pro: unavailable ${firstLine(errorMessage(error))}`);
      }
    }
  } else {
    io.stdout("latest_pro: missing");
  }
  return bridgeReady && configReady && chatgptReady;
}

type ConsultRecord = {
  task: Awaited<ReturnType<BridgeStore["listTasks"]>>[number];
  result: Awaited<ReturnType<BridgeStore["listResults"]>>[number];
};

type ConsultListEntry =
  | { kind: "trusted"; consult: ConsultRecord }
  | {
      kind: "untrusted";
      task: ConsultRecord["task"];
      result: ConsultRecord["result"];
      error: Error & { code: "EUNTRUSTED_RESULT"; taskId: string };
    };






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

async function listConsultListEntries(store: BridgeStore, options: { readOnly?: boolean } = { readOnly: true }): Promise<ConsultListEntry[]> {
  const [tasks, results] = options.readOnly === false
    ? await Promise.all([store.listTasks(), store.listResults()])
    : await Promise.all([listTasksForInspection(store), listRawResultsForInspection(store)]);
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
  const entries: ConsultListEntry[] = [];
  for (const record of records) {
    try {
      entries.push({ kind: "trusted", consult: { ...record, result: await store.getFinalizedResultReadOnly(record.result.task_id) } });
    } catch (error) {
      if (isUntrustedResultError(error)) {
        entries.push({ kind: "untrusted", task: record.task, result: record.result, error });
        continue;
      }
      throw error;
    }
  }
  return entries;
}

async function latestTrustedConsult(store: BridgeStore, options: { readOnly?: boolean } = { readOnly: true }): Promise<ConsultRecord | undefined> {
  const entries = await listConsultListEntries(store, options);
  const trusted = entries.find((entry) => entry.kind === "trusted");
  if (trusted) return trusted.consult;
  const untrusted = entries.find((entry) => entry.kind === "untrusted");
  if (untrusted) throw untrusted.error;
  return undefined;
}

function assertNoOrphanConsultResults(
  tasksById: Map<string, Awaited<ReturnType<BridgeStore["listTasks"]>>[number]>,
  results: Awaited<ReturnType<BridgeStore["listResults"]>>
): void {
  const orphan = results
    .filter((result) => !tasksById.has(result.task_id) && isConsultResult(result))
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.task_id.localeCompare(a.task_id))[0];
  if (orphan) throw orphanConsultResultError(orphan.task_id);
}





async function getConsult(store: BridgeStore, taskId: string, options: { readOnly?: boolean } = {}): Promise<ConsultRecord | undefined> {
  let task: Awaited<ReturnType<BridgeStore["getTask"]>>;
  try {
    task = options.readOnly ? await store.getTaskReadOnly(taskId) : await store.getTask(taskId);
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
  if (!isConsultTask(task)) return undefined;
  let result: Awaited<ReturnType<BridgeStore["getResult"]>>;
  try {
    result = await store.getFinalizedResultReadOnly(taskId);
  } catch (error) {
    if (isMissingFileError(error)) {
      if (isTerminalTask(task) && isConsultTask(task)) throw missingConsultResultError(task);
      return undefined;
    }
    throw error;
  }
  if (!task || !result) return undefined;
  const record = { task, result };
  return isConsultRecord(record) ? record : undefined;
}

function assertNoMissingTerminalConsultResults(
  tasks: Awaited<ReturnType<BridgeStore["listTasks"]>>,
  results: Awaited<ReturnType<BridgeStore["listResults"]>>
): void {
  const resultTaskIds = new Set(results.map((result) => result.task_id));
  const missing = tasks
    .filter((task) => isTerminalTask(task) && isConsultTask(task) && !resultTaskIds.has(task.id))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id.localeCompare(a.id))[0];
  if (missing) throw missingConsultResultError(missing);
}

function isTerminalTask(task: Awaited<ReturnType<BridgeStore["listTasks"]>>[number]): boolean {
  return task.status === "done" || task.status === "blocked";
}

function isConsultTask(task: Awaited<ReturnType<BridgeStore["listTasks"]>>[number]): boolean {
  return task.provenance.adapter === "chatgpt-control";
}

function isConsultResult(result: Awaited<ReturnType<BridgeStore["listResults"]>>[number]): boolean {
  return result.commands.some((command) => /chatgpt|gpt pro|visible ChatGPT/i.test(command));
}

function missingConsultResultError(task: Awaited<ReturnType<BridgeStore["listTasks"]>>[number]): Error {
  return new Error(
    `GPT Pro answer is corrupt: task ${task.id} is ${task.status} but .bridge/results/${task.id}.json is missing. Restore the result file, retry the completion path, or move the task record aside, then retry.`
  );
}

function orphanConsultResultError(taskId: string): Error {
  return new Error(
    `GPT Pro answer is corrupt: result .bridge/results/${taskId}.json exists but .bridge/tasks/${taskId}.json is missing. Restore the task file or move the orphan result record aside, then retry.`
  );
}

function isConsultRecord(record: ConsultRecord): boolean {
  return isConsultTask(record.task);
}

function formatProAnswer(consult: ConsultRecord, sourceCli?: string, options: BrowserCommandOptions = {}): string {
  const blocker = sourceAwareProAnswerBlocker(consult, sourceCli, options);
  const summary = sourceAwareProAnswerSummary(consult.result.summary, consult.result.blocker, blocker);
  const lines = [
    `task_id: ${consult.task.id}`,
    `status: ${consult.result.status}`,
    consult.task.provenance.thread ? `thread: ${consult.task.provenance.thread}` : undefined,
    `created_at: ${consult.result.created_at}`,
    "",
    summary
  ].filter((line): line is string => line !== undefined);
  if (blocker) {
    lines.push("", "blocker:", `- code: ${blocker.code}`, `- retryable: ${blocker.retryable}`);
    if (blocker.next_step) lines.push(`- next_step: ${blocker.next_step}`);
  }
  if (consult.result.warnings.length > 0) {
    lines.push("", "warnings:");
    for (const warning of consult.result.warnings) lines.push(`- ${warning}`);
  }
  return lines.join("\n");
}

function formatProListSummary(consult: ConsultRecord, sourceCli?: string, options: BrowserCommandOptions = {}): string {
  const blocker = sourceAwareProAnswerBlocker(consult, sourceCli, options);
  return firstLine(sourceAwareProAnswerSummary(consult.result.summary, consult.result.blocker, blocker));
}

function formatProductCheckLatestProLines(consult: ConsultRecord, sourceCli?: string, options: BrowserCommandOptions = {}): string[] {
  if (consult.result.status === "blocked") {
    const blocker = sourceAwareProAnswerBlocker(consult, sourceCli, options);
    const code = blocker?.code ?? "unknown";
    const retryable = blocker?.retryable ?? false;
    const lines = [`latest_pro: blocked ${consult.task.id} code=${code} retryable=${retryable} ${consult.result.created_at}`];
    if (blocker?.next_step) lines.push(`latest_pro_next: ${blocker.next_step}`);
    return lines;
  }
  return [`latest_pro: ok ${consult.task.id} ${consult.result.status} ${consult.result.created_at}`];
}

function sourceAwareProAnswerBlocker(
  consult: ConsultRecord,
  sourceCli?: string,
  options: BrowserCommandOptions = {}
): ConsultRecord["result"]["blocker"] {
  if (!consult.result.blocker) return undefined;
  const browserAware = sourceAwareBrowserBlocker(consult.result.blocker, sourceCli, options);
  if ((!sourceCli && !options.cwd && !options.port) || !isSmokeConsultRecord(consult) || !browserAware.next_step) return browserAware;
  const nextStep = productCheckBrowserNextStep(browserAware.next_step, sourceCli, options);
  return nextStep === browserAware.next_step ? browserAware : { ...browserAware, next_step: nextStep };
}

function sourceAwareProAnswerSummary(
  summary: string,
  originalBlocker: ConsultRecord["result"]["blocker"],
  displayedBlocker: ConsultRecord["result"]["blocker"]
): string {
  const originalNextStep = originalBlocker?.next_step;
  const displayedNextStep = displayedBlocker?.next_step;
  if (!originalNextStep || !displayedNextStep || originalNextStep === displayedNextStep) return summary;
  return summary.replaceAll(originalNextStep, displayedNextStep);
}

function isSmokeConsultRecord(consult: ConsultRecord): boolean {
  return consult.task.title === "GPT Pro smoke" || consult.result.commands.includes("visible ChatGPT browser smoke");
}



function formatProConsultArtifact(consult: Awaited<ReturnType<typeof sendChatGptPrompt>>): string {
  const lines = [`# ChatGPT Pro Consult`, "", `Thread: ${consult.url}`, `Title: ${consult.title}`, ""];
  if (consult.modelHints.length > 0) {
    lines.push("Model hints:", ...consult.modelHints.map((hint) => `- ${hint}`), "");
  }
  if (consult.warnings.length > 0) {
    lines.push("Warnings:", ...consult.warnings.map((warning) => `- ${warning}`), "");
  }
  lines.push("## Answer", "", consult.answer.trim(), "");
  return lines.join("\n");
}

async function writeSessionBestEffort(
  store: BridgeStore,
  input: Parameters<BridgeStore["writeSession"]>[0],
  io: CliIO
): Promise<void> {
  try {
    await store.writeSession(input);
  } catch (error) {
    io.stderr(`session_record_warning: ${errorMessage(error)}`);
  }
}

async function writeSessionBeforeBrowserSend(store: BridgeStore, input: Parameters<BridgeStore["writeSession"]>[0]): Promise<void> {
  try {
    await store.writeSession(input);
  } catch (error) {
    throw new Error(`failed to record running consult session before browser send: ${errorMessage(error)}`);
  }
}

function firstLine(value: string): string {
  return value.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
}


function browserSendBlockerFromError(error: unknown): { code: string; message: string; retryable: boolean; next_step?: string } {
  const blocker = typeof error === "object" && error !== null && "blocker" in error ? (error as { blocker?: unknown }).blocker : undefined;
  if (
    typeof blocker === "object" &&
    blocker !== null &&
    "code" in blocker &&
    "message" in blocker &&
    "retryable" in blocker &&
    typeof blocker.code === "string" &&
    typeof blocker.message === "string" &&
    typeof blocker.retryable === "boolean"
  ) {
    return {
      code: blocker.code,
      message: blocker.message,
      retryable: blocker.retryable,
      ...("next_step" in blocker && typeof blocker.next_step === "string" ? { next_step: blocker.next_step } : {})
    };
  }
  const message = errorMessage(error);
  return {
    code: "browser_send_failed",
    message,
    retryable: true,
    next_step: "Resolve the visible browser issue manually, then rerun the consult if needed."
  };
}














function readChatGptBrowserUrlFlag(args: string[]): string {
  return normalizeChatGptTargetUrl(readFlag(args, "--url") ?? "https://chatgpt.com/");
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




















function formatConfigWarningLine(tokenStatus: { warning?: string }, sourceCli?: string, setupHintCwd?: string): string | undefined {
  return tokenStatus.warning ? `config_warning: ${sourceAwareSetupMessage(tokenStatus.warning, sourceCli, { cwd: setupHintCwd })}` : undefined;
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
