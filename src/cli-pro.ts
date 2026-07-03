import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildDryRunBundle } from "./bundle.js";
import {
  type ChatGptBrowserLaunch,
  chatGptVisibilityBlocker,
  defaultChatGptProfileDir,
  getChatGptBrowserStatus,
  listChatGptModelOptions,
  normalizeChatGptTargetUrl,
  openChatGptBrowser,
  parseProMode,
  parseReasoningEffort,
  sendChatGptPrompt
} from "./chatgpt-browser.js";
import {
  ASK_PRO_BOOLEAN_FLAGS,
  ASK_PRO_PREVIEW_VALUE_FLAGS,
  ASK_PRO_VALUE_FLAGS,
  type HelpRequestOptions,
  assertHelpRequestArgs,
  assertNoExtraArgs,
  assertOnlyOptions,
  findHelpFlagIndexBeforePromptDelimiter,
  hasAskProDryRunMode,
  hasAskProMode,
  hasAskProSendMode,
  isHelpSubcommand,
  parseAskProArgs,
  printHelpIfRequested,
  readFlag,
  readPortFlag,
  readPositionalsWithOptions,
  readPositiveNumberFlag,
  readRepeatedFlag,
  resolveCwdFlag,
  resolveOptionalFileFlag,
  unknownSubcommandError
} from "./cli-args.js";
import { printProBrowserHelp, printProHelp } from "./cli-help.js";
import { listRawResultsForInspection, listTasksForInspection } from "./cli-ledger.js";
import { redactServerUrl } from "./cli-server.js";
import {
  type BrowserCommandOptions,
  errorMessage,
  firstLine,
  formatBlockedConsultRecordedMessage,
  formatBrowserCheckCommand,
  formatBrowserLoginCommand,
  formatBrowserSmokeCommand,
  formatBrowserTargetAskCommand,
  formatInitCommand,
  formatSetupCommand,
  isMissingFileError,
  computeSendPacingWaitMs,
  isUntrustedResultError,
  resolveMinSendIntervalMs,
  sourceAwareBrowserBlocker,
  sourceAwareBrowserNextStep,
  sourceAwareResultError,
  sourceAwareResultMessage,
  sourceAwareSetupMessage
} from "./cli-shared.js";
import { getTokenExpiryStatus, loadBrowserDefaults, loadLocalConfig } from "./config.js";
import { BridgeStore, MAX_FETCHABLE_RESULT_ARTIFACT_BYTES } from "./store.js";
import type { CliIO } from "./cli.js";

export type RunCliFn = (args: string[], io: CliIO) => Promise<number>;

export async function runChatgptCommand(rest: string[], io: CliIO): Promise<number> {
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

export async function runProCommand(rest: string[], io: CliIO, runCliFn: RunCliFn): Promise<number> {
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
      return runCliFn(["ask-pro", ...(hasDryRun ? [] : ["--dry-run"]), ...proArgs], io);
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
        return runCliFn(["ask-pro", ...(hasMode ? [] : ["--send"]), ...browserArgs], { ...io, allowAskProBrowserSend: true });
      }
      if (browserSubcommand === "open" || browserSubcommand === "status" || browserSubcommand === "doctor") {
        const replacement = browserSubcommand === "open" ? "login" : "check";
        throw new Error(`Use \`prodex pro browser ${replacement}\` for explicit browser automation.`);
      }
      if (browserSubcommand === "smoke") {
        if (printProBrowserHelpIfRequested(browserArgs, "pro browser smoke", io, { valueFlags: ["--cwd", "--port", "--timeout-ms", "--source-cli"] })) return 0;
        return runCliFn(["chatgpt", browserSubcommand, ...browserArgs], io);
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

export async function runConsultsCommand(rest: string[], io: CliIO): Promise<number> {
    throw new Error("The legacy `consults` alias is retired. Use `prodex pro list`, `prodex pro latest`, or `prodex pro show <task-id|latest>`.");
}

// File marker + human-pacing gate for visible-browser sends. Reads the previous
// send's start time from .bridge/last-browser-send, waits out any remaining
// minimum interval (auto-throttle, not an error), then stamps the new send.
async function enforceVisibleBrowserSendPacing(cwd: string, stderr: (line: string) => void): Promise<void> {
  const intervalMs = resolveMinSendIntervalMs();
  const markerPath = path.join(cwd, ".bridge", "last-browser-send");
  let lastSendAtMs: number | undefined;
  try {
    const parsed = Date.parse((await readFile(markerPath, "utf8")).trim());
    if (Number.isFinite(parsed)) lastSendAtMs = parsed;
  } catch {
    // no marker yet (first send) or unreadable: treat as no prior send
  }
  const waitMs = computeSendPacingWaitMs(lastSendAtMs, Date.now(), intervalMs);
  if (waitMs > 0) {
    stderr(`send_pacing: waiting ${Math.ceil(waitMs / 1000)}s to keep visible-browser sends at human pace (override with PRODEX_MIN_SEND_INTERVAL_MS).`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  try {
    await mkdir(path.dirname(markerPath), { recursive: true, mode: 0o700 });
    await writeFile(markerPath, `${new Date().toISOString()}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // best effort: pacing must never block a legitimate send on a write failure
  }
}

export async function runAskProCommand(rest: string[], io: CliIO): Promise<number> {
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
      await enforceVisibleBrowserSendPacing(targetCwd, io.stderr);
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

export const PRO_BROWSER_SMOKE_TOKEN = "PRODEX_PRO_SMOKE_OK";

export async function assertBrowserLaunchStayedAlive(opened: ChatGptBrowserLaunch, timeoutMs?: number): Promise<void> {
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

export function browserSendBlockerFromError(error: unknown): { code: string; message: string; retryable: boolean; next_step?: string } {
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

export function formatProAnswer(consult: ConsultRecord, sourceCli?: string, options: BrowserCommandOptions = {}): string {
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

export function formatProConsultArtifact(consult: Awaited<ReturnType<typeof sendChatGptPrompt>>): string {
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

export function formatProListSummary(consult: ConsultRecord, sourceCli?: string, options: BrowserCommandOptions = {}): string {
  const blocker = sourceAwareProAnswerBlocker(consult, sourceCli, options);
  return firstLine(sourceAwareProAnswerSummary(consult.result.summary, consult.result.blocker, blocker));
}

export async function getConsult(store: BridgeStore, taskId: string, options: { readOnly?: boolean } = {}): Promise<ConsultRecord | undefined> {
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

export async function latestTrustedConsult(store: BridgeStore, options: { readOnly?: boolean } = { readOnly: true }): Promise<ConsultRecord | undefined> {
  const entries = await listConsultListEntries(store, options);
  const trusted = entries.find((entry) => entry.kind === "trusted");
  if (trusted) return trusted.consult;
  const untrusted = entries.find((entry) => entry.kind === "untrusted");
  if (untrusted) throw untrusted.error;
  return undefined;
}

export function legacyChatGptNamespaceError(subcommand?: string): Error {
  const prefix = subcommand ? `Unknown legacy chatgpt subcommand: ${subcommand}.` : "The legacy `chatgpt` namespace is hidden.";
  return new Error(`${prefix} Use \`prodex pro browser help\` for visible-browser commands.`);
}

export async function listConsultListEntries(store: BridgeStore, options: { readOnly?: boolean } = { readOnly: true }): Promise<ConsultListEntry[]> {
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

export function printBrowserLoginGuide(
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

export function printProBrowserHelpIfRequested(args: string[], command: string, io: CliIO, options: HelpRequestOptions): boolean {
  const helpIndex = findHelpFlagIndexBeforePromptDelimiter(args);
  if (helpIndex === -1) return false;
  assertHelpRequestArgs(args, command, options);
  printProBrowserHelp(io.stdout, resolveOptionalFileFlag(io.cwd, args, "--source-cli"));
  return true;
}

export async function printProductCheck(store: BridgeStore, io: CliIO, args: string[], configCwd = io.cwd): Promise<boolean> {
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

export function readChatGptBrowserUrlFlag(args: string[]): string {
  return normalizeChatGptTargetUrl(readFlag(args, "--url") ?? "https://chatgpt.com/");
}

export async function writeSessionBeforeBrowserSend(store: BridgeStore, input: Parameters<BridgeStore["writeSession"]>[0]): Promise<void> {
  try {
    await store.writeSession(input);
  } catch (error) {
    throw new Error(`failed to record running consult session before browser send: ${errorMessage(error)}`);
  }
}

export async function writeSessionBestEffort(
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

export type ConsultListEntry =
  | { kind: "trusted"; consult: ConsultRecord }
  | {
      kind: "untrusted";
      task: ConsultRecord["task"];
      result: ConsultRecord["result"];
      error: Error & { code: "EUNTRUSTED_RESULT"; taskId: string };
    };

export type ConsultRecord = {
  task: Awaited<ReturnType<BridgeStore["listTasks"]>>[number];
  result: Awaited<ReturnType<BridgeStore["listResults"]>>[number];
};

export function assertNoMissingTerminalConsultResults(
  tasks: Awaited<ReturnType<BridgeStore["listTasks"]>>,
  results: Awaited<ReturnType<BridgeStore["listResults"]>>
): void {
  const resultTaskIds = new Set(results.map((result) => result.task_id));
  const missing = tasks
    .filter((task) => isTerminalTask(task) && isConsultTask(task) && !resultTaskIds.has(task.id))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id.localeCompare(a.id))[0];
  if (missing) throw missingConsultResultError(missing);
}

export function assertNoOrphanConsultResults(
  tasksById: Map<string, Awaited<ReturnType<BridgeStore["listTasks"]>>[number]>,
  results: Awaited<ReturnType<BridgeStore["listResults"]>>
): void {
  const orphan = results
    .filter((result) => !tasksById.has(result.task_id) && isConsultResult(result))
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.task_id.localeCompare(a.task_id))[0];
  if (orphan) throw orphanConsultResultError(orphan.task_id);
}

export function browserReadinessNextStep(input: { loggedInLikely: boolean; hasComposer: boolean }): string {
  if (!input.loggedInLikely) {
    return "Log in manually in the visible ChatGPT browser, then retry.";
  }
  if (!input.hasComposer) {
    return "Open a normal ChatGPT chat or Project thread, select the Pro/Thinking model, and retry.";
  }
  return "Review the visible ChatGPT browser state, then retry.";
}

export function formatBrowserEarlyExit(exit: Awaited<ReturnType<ChatGptBrowserLaunch["waitForEarlyExit"]>>): string {
  if (!exit) return "no exit details";
  return exit.error ?? `exit code ${exit.code ?? "null"}${exit.signal ? ` signal ${exit.signal}` : ""}`;
}

export function formatBrowserModelHints(modelHints: string[]): string | undefined {
  const modelish = /\b(?:ChatGPT|GPT(?:-[\w.]+)?|Pro|Plus|Team|Enterprise|Thinking|Extra High|Auto)\b/i;
  const hints = [...new Set(modelHints.map((hint) => hint.trim()).filter((hint) => modelish.test(hint)))]
    .map((hint) => (hint.length > 80 ? `${hint.slice(0, 77)}...` : hint))
    .slice(0, 6);
  return hints.length > 0 ? hints.join(" | ") : undefined;
}

export function formatConfigWarningLine(tokenStatus: { warning?: string }, sourceCli?: string, setupHintCwd?: string): string | undefined {
  return tokenStatus.warning ? `config_warning: ${sourceAwareSetupMessage(tokenStatus.warning, sourceCli, { cwd: setupHintCwd })}` : undefined;
}

export function formatProductCheckLatestProLines(consult: ConsultRecord, sourceCli?: string, options: BrowserCommandOptions = {}): string[] {
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

export function isConsultRecord(record: ConsultRecord): boolean {
  return isConsultTask(record.task);
}

export function isConsultTask(task: Awaited<ReturnType<BridgeStore["listTasks"]>>[number]): boolean {
  return task.provenance.adapter === "chatgpt-control";
}

export function isTerminalTask(task: Awaited<ReturnType<BridgeStore["listTasks"]>>[number]): boolean {
  return task.status === "done" || task.status === "blocked";
}

export function missingConsultResultError(task: Awaited<ReturnType<BridgeStore["listTasks"]>>[number]): Error {
  return new Error(
    `GPT Pro answer is corrupt: task ${task.id} is ${task.status} but .bridge/results/${task.id}.json is missing. Restore the result file, retry the completion path, or move the task record aside, then retry.`
  );
}

export function productCheckBrowserNextStep(nextStep: string | undefined, sourceCli?: string, options: BrowserCommandOptions = {}): string | undefined {
  const sourceAware = sourceAwareBrowserNextStep(nextStep, sourceCli, options);
  if (!sourceAware) return sourceAware;
  if (sourceAware.includes("`")) return sourceAware;
  if (sourceAware.includes("pass --target-url with --confirm-target")) {
    return sourceAware.replace("pass --target-url with --confirm-target", `run \`${formatBrowserTargetAskCommand(sourceCli, options)}\``);
  }
  return sourceAware.replace(/(?:and|then) retry\.$/, `then run \`${formatBrowserSmokeCommand(sourceCli, options)}\`.`);
}

export function sourceAwareProAnswerBlocker(
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

export function sourceAwareProAnswerSummary(
  summary: string,
  originalBlocker: ConsultRecord["result"]["blocker"],
  displayedBlocker: ConsultRecord["result"]["blocker"]
): string {
  const originalNextStep = originalBlocker?.next_step;
  const displayedNextStep = displayedBlocker?.next_step;
  if (!originalNextStep || !displayedNextStep || originalNextStep === displayedNextStep) return summary;
  return summary.replaceAll(originalNextStep, displayedNextStep);
}

export async function waitForBrowserLaunchReady(
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

export function isConsultResult(result: Awaited<ReturnType<BridgeStore["listResults"]>>[number]): boolean {
  return result.commands.some((command) => /chatgpt|gpt pro|visible ChatGPT/i.test(command));
}

export function isSmokeConsultRecord(consult: ConsultRecord): boolean {
  return consult.task.title === "GPT Pro smoke" || consult.result.commands.includes("visible ChatGPT browser smoke");
}

export function orphanConsultResultError(taskId: string): Error {
  return new Error(
    `GPT Pro answer is corrupt: result .bridge/results/${taskId}.json exists but .bridge/tasks/${taskId}.json is missing. Restore the task file or move the orphan result record aside, then retry.`
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
