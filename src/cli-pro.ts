import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildDryRunBundle } from "./bundle.js";
import {
  type ChatGptBrowserLaunch,
  type SendChatGptProgressEvent,
  DEFAULT_CDP_PORT,
  resolveCdpPort,
  chatGptVisibilityBlocker,
  defaultChatGptProfileDir,
  formatDurationMs,
  getChatGptBrowserStatus,
  listChatGptModelOptions,
  listChatGptSidebarProjects,
  normalizeChatGptTargetUrl,
  openChatGptBrowser,
  parseProMode,
  parseReasoningEffort,
  readLastBrowserLoginLaunch,
  recordBrowserLoginLaunch,
  recoverChatGptAnswerFromThread,
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
  formatCliCommand,
  hasAskProDryRunMode,
  hasAskProMode,
  hasAskProSendMode,
  isHelpSubcommand,
  parseAskProArgs,
  printHelpIfRequested,
  readFlag,
  readPortFlag,
  readPositionalsWithOptions,
  readNonNegativeIntegerFlag,
  readPositiveIntegerFlag,
  readRepeatedFlag,
  resolveCwdFlag,
  resolveOptionalFileFlag,
  unknownSubcommandError
} from "./cli-args.js";
import { printProBrowserHelp, printProHelp } from "./cli-help.js";
import { listRawResultsForInspection, listTasksForInspection } from "./cli-ledger.js";
import { formatBrowserDefaults, redactServerUrl } from "./cli-server.js";
import {
  type BrowserCommandOptions,
  errorMessage,
  firstLine,
  formatBlockedConsultRecordedMessage,
  formatProLatestCommand,
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
import { withBrowserSendLock } from "./browser-send-lock.js";
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
        port: resolveCdpPort(readPortFlag(chatgptArgs, "--port")),
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
      const status = await getChatGptBrowserStatus({ port: resolveCdpPort(readPortFlag(chatgptArgs, "--port")) });
      io.stdout(JSON.stringify(status, null, 2));
      return 0;
    }
    if (subcommand === "smoke") {
      assertOnlyOptions(chatgptArgs, "chatgpt smoke", ["--cwd", "--port", "--timeout-ms", "--source-cli"]);
      const targetCwd = resolveCwdFlag(io.cwd, chatgptArgs);
      const targetStore = new BridgeStore(targetCwd);
      const sourceCli = resolveOptionalFileFlag(io.cwd, chatgptArgs, "--source-cli");
      const port = resolveCdpPort(readPortFlag(chatgptArgs, "--port"));
      const timeoutMs = readPositiveIntegerFlag(chatgptArgs, "--timeout-ms") ?? 90000;
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
        result = await withBrowserSendLock(0, (detail) => io.stderr(`progress: ${detail}`), () =>
          sendChatGptPrompt({
            port,
            prompt: smokePrompt,
            timeoutMs,
            onProgress: createBrowserSendProgressPrinter(io.stderr)
          })
        );
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
      // Send-only flags have no effect on the dry-run bundle (which uses only the
      // prompt, --file, and --cwd) and their values were not even validated.
      // Reject them with guidance instead of silently ignoring them.
      const straySendFlag = [
        "--port",
        "--timeout-ms",
        "--busy-wait-ms",
        "--target-url",
        "--confirm-target",
        "--project",
        "--project-new",
        "--model",
        "--pro-mode",
        "--effort",
        "--new-chat",
        "--auto-login",
        "--no-auto-login"
      ].find((flag) => proArgs.includes(flag));
      if (straySendFlag) {
        throw new Error(`${straySendFlag} only applies when sending; \`prodex pro ask\` is a dry-run preview. Use \`prodex pro browser ask\` (or \`prodex ask\`) to send.`);
      }
      const hasDryRun = hasAskProDryRunMode(proArgs);
      try {
        return await runCliFn(["ask-pro", ...(hasDryRun ? [] : ["--dry-run"]), ...proArgs], io);
      } catch (error) {
        // Validation errors from the internal dispatch name ask-pro; present
        // them as the `pro ask` the user actually typed.
        if (error instanceof Error && /\bask-pro\b/.test(error.message)) {
          throw new Error(error.message.replace(/\bask-pro\b/g, "pro ask"), { cause: error });
        }
        throw error;
      }
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
            valueFlags: ["--cwd", "--profile-dir", "--port", "--url", "--source-cli", "--launch-timeout-ms", "--wait-timeout-ms"],
            booleanFlags: ["--dry-run", "--wait", "--no-wait"]
          })
        ) {
          return 0;
        }
        assertOnlyOptions(
          browserArgs,
          "pro browser login",
          ["--cwd", "--profile-dir", "--port", "--url", "--source-cli", "--launch-timeout-ms", "--wait-timeout-ms"],
          ["--dry-run", "--wait", "--no-wait"]
        );
        if (browserArgs.includes("--wait") && browserArgs.includes("--no-wait")) {
          throw new Error("pro browser login cannot combine --wait and --no-wait");
        }
        const loginUrl = readChatGptBrowserUrlFlag(browserArgs);
        const sourceCli = resolveOptionalFileFlag(io.cwd, browserArgs, "--source-cli");
        const targetCwd = readFlag(browserArgs, "--cwd") ? resolveCwdFlag(io.cwd, browserArgs) : undefined;
        const profileDir = readFlag(browserArgs, "--profile-dir");
        const port = resolveCdpPort(readPortFlag(browserArgs, "--port"));
        const launchTimeoutMs = readPositiveIntegerFlag(browserArgs, "--launch-timeout-ms");
        const commandOptions = {
          ...(targetCwd ? { cwd: targetCwd } : {}),
          ...(profileDir ? { profileDir } : {}),
          ...(port !== DEFAULT_CDP_PORT ? { port } : {}),
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
        // If the dedicated Chrome is already reachable on this port, do NOT spawn
        // again: Chrome's singleton would just open ANOTHER window (the recurring
        // "extra windows" problem, which then blocks sends as
        // ambiguous_chatgpt_tabs). Reuse the running instance instead.
        const alreadyRunning = (await getChatGptBrowserStatus({ port })).reachable;
        const opened: Pick<ChatGptBrowserLaunch, "profileDir" | "port"> = alreadyRunning
          ? { profileDir: profileDir ?? defaultChatGptProfileDir(), port }
          : openChatGptBrowser({ port, profileDir, url: loginUrl });
        if (!alreadyRunning) {
          await assertBrowserLaunchStayedAlive(opened as ChatGptBrowserLaunch, launchTimeoutMs);
        }
        // Remember this launch so ask auto-recovery reuses the same profile.
        await recordBrowserLoginLaunch({ profile_dir: opened.profileDir, port: opened.port });
        printBrowserLoginGuide(io.stdout, {
          opened: !alreadyRunning,
          reused: alreadyRunning,
          loginUrl,
          profileDir: opened.profileDir,
          port: opened.port,
          sourceCli,
          commandOptions
        });
        // Guided wait: interactive terminals walk the user to a verified READY
        // state instead of returning while login is still unfinished. Scripts
        // and agents (non-TTY) keep the immediate return unless --wait is
        // passed; --no-wait always skips.
        const shouldWaitForReady =
          !browserArgs.includes("--no-wait") && (browserArgs.includes("--wait") || io.isInteractive === true);
        if (!shouldWaitForReady) return 0;
        const waitTimeoutMs = readPositiveIntegerFlag(browserArgs, "--wait-timeout-ms") ?? 300_000;
        const ready = await waitForChatGptLoginReady(io.stderr, { port: opened.port, timeoutMs: waitTimeoutMs });
        return ready ? 0 : 1;
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
        try {
          return await runCliFn(["ask-pro", ...(hasMode ? [] : ["--send"]), ...browserArgs], { ...io, allowAskProBrowserSend: true });
        } catch (error) {
          // Validation errors from the internal dispatch name ask-pro, which
          // the user never typed - present them as pro browser ask.
          if (error instanceof Error && /\bask-pro\b/.test(error.message)) {
            throw new Error(error.message.replace(/\bask-pro\b/g, "pro browser ask"), { cause: error });
          }
          throw error;
        }
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
        readPositiveIntegerFlag(browserArgs, "--timeout-ms");
        const healthy = await printProductCheck(new BridgeStore(targetCwd), io, browserArgs, targetCwd);
        return healthy ? 0 : 1;
      }
      if (browserSubcommand === "models") {
        // --cwd is accepted (and ignored) for uniformity with the other pro
        // browser subcommands: an agent that passes --cwd on every prodex call
        // should not get "Unknown option" on a repo-independent sidebar read.
        if (printProBrowserHelpIfRequested(browserArgs, "pro browser models", io, { valueFlags: ["--cwd", "--port", "--timeout-ms", "--source-cli"] })) return 0;
        assertOnlyOptions(browserArgs, "pro browser models", ["--cwd", "--port", "--timeout-ms", "--source-cli"]);
        const modelsSourceCli = resolveOptionalFileFlag(io.cwd, browserArgs, "--source-cli");
        // Parse flags OUTSIDE the browser-error adapter: a flag-validation
        // error is a usage error, not a browser blocker.
        const modelsPort = readPortFlag(browserArgs, "--port");
        const modelsTimeoutMs = readPositiveIntegerFlag(browserArgs, "--timeout-ms");
        // Port-awareness must reflect the RESOLVED port (PRODEX_CDP_PORT env
        // included), not just the raw --port flag.
        const modelsResolvedPort = resolveCdpPort(modelsPort);
        let listed: Awaited<ReturnType<typeof listChatGptModelOptions>>;
        try {
          listed = await listChatGptModelOptions({
            port: modelsPort,
            timeoutMs: modelsTimeoutMs
          });
        } catch (error) {
          // Keep the next step actionable for a custom port: the raw blocker
          // suggests the default-port login command, which would not fix a
          // 9444-style setup.
          const blocker = sourceAwareBrowserBlocker(browserSendBlockerFromError(error), modelsSourceCli, {
            ...(modelsResolvedPort !== DEFAULT_CDP_PORT ? { port: modelsResolvedPort } : {})
          });
          throw new Error(blocker.next_step ? `${blocker.message} Next: ${blocker.next_step}` : errorMessage(error));
        }
        io.stdout("Model menu options in the visible ChatGPT tab (read-only; nothing was selected):");
        for (const option of listed.options) {
          const marker = option.checked ? "*" : " ";
          const suffix = option.kind === "submenu" ? "  (has sub-variants; not selectable via --model yet)" : "";
          io.stdout(`${marker} ${option.label}${suffix}`);
        }
        io.stdout("Use radio entries with `pro browser ask --model/--effort` (e.g. --model Pro).");
        return 0;
      }
      if (browserSubcommand === "projects") {
        // --cwd is accepted (and ignored) for uniformity with the other pro
        // browser subcommands (see models above).
        if (printProBrowserHelpIfRequested(browserArgs, "pro browser projects", io, { valueFlags: ["--cwd", "--port", "--timeout-ms", "--source-cli"] })) return 0;
        assertOnlyOptions(browserArgs, "pro browser projects", ["--cwd", "--port", "--timeout-ms", "--source-cli"]);
        const projectsSourceCli = resolveOptionalFileFlag(io.cwd, browserArgs, "--source-cli");
        const projectsPort = readPortFlag(browserArgs, "--port");
        const projectsTimeoutMs = readPositiveIntegerFlag(browserArgs, "--timeout-ms");
        const projectsResolvedPort = resolveCdpPort(projectsPort);
        let listed: Awaited<ReturnType<typeof listChatGptSidebarProjects>>;
        try {
          listed = await listChatGptSidebarProjects({ port: projectsPort, timeoutMs: projectsTimeoutMs });
        } catch (error) {
          const blocker = sourceAwareBrowserBlocker(browserSendBlockerFromError(error), projectsSourceCli, {
            ...(projectsResolvedPort !== DEFAULT_CDP_PORT ? { port: projectsResolvedPort } : {})
          });
          throw new Error(blocker.next_step ? `${blocker.message} Next: ${blocker.next_step}` : errorMessage(error));
        }
        if (listed.projects.length === 0) {
          io.stdout("No projects visible in the ChatGPT sidebar (read-only check).");
          io.stdout("If you expect projects, open the sidebar's Projects section once in the visible browser, then retry.");
          return 0;
        }
        io.stdout("ChatGPT sidebar projects (read-only; exact names as rendered):");
        for (const name of listed.projects) io.stdout(`  ${name}`);
        io.stdout("Use with `pro browser ask --project \"<name>\"` or pin one with `prodex setup --project \"<name>\"`.");
        return 0;
      }
      if (browserSubcommand === "recover") {
        if (printProBrowserHelpIfRequested(browserArgs, "pro browser recover", io, { valueFlags: ["--cwd", "--port", "--timeout-ms", "--target-url", "--source-cli"] })) return 0;
        assertOnlyOptions(browserArgs, "pro browser recover", ["--cwd", "--port", "--timeout-ms", "--target-url", "--source-cli"]);
        const recoverCwd = resolveCwdFlag(io.cwd, browserArgs);
        const recoverSourceCli = resolveOptionalFileFlag(io.cwd, browserArgs, "--source-cli");
        const targetUrl = readFlag(browserArgs, "--target-url");
        if (!targetUrl) {
          throw new Error(
            "pro browser recover requires --target-url <thread-url> - the ChatGPT conversation URL whose finished answer to recover (e.g. the thread from a send_timeout blocker)."
          );
        }
        const recoverPort = readPortFlag(browserArgs, "--port");
        const recoverTimeoutMs = readPositiveIntegerFlag(browserArgs, "--timeout-ms");
        const recoverResolvedPort = resolveCdpPort(recoverPort);
        let consult: Awaited<ReturnType<typeof recoverChatGptAnswerFromThread>>;
        try {
          consult = await recoverChatGptAnswerFromThread({ port: recoverPort, targetUrl, timeoutMs: recoverTimeoutMs });
        } catch (error) {
          const blocker = sourceAwareBrowserBlocker(browserSendBlockerFromError(error), recoverSourceCli, {
            ...(recoverResolvedPort !== DEFAULT_CDP_PORT ? { port: recoverResolvedPort } : {})
          });
          throw new Error(blocker.next_step ? `${blocker.message} Next: ${blocker.next_step}` : errorMessage(error));
        }
        // Record the recovered answer as a done consult so `pro latest` re-prints it.
        const recoverStore = new BridgeStore(recoverCwd);
        const recoveredTask = await recoverStore.createTask({
          source: "codex",
          title: "GPT Pro consult (recovered)",
          prompt: `Recovered answer from ${consult.url}`,
          repo_id: "default",
          files: [],
          provenance: { adapter: "chatgpt-control", thread: consult.url, warnings: [] }
        });
        const recoveredArtifactText = formatProConsultArtifact(consult);
        let recoveredArtifactPath: string | undefined;
        try {
          recoveredArtifactPath = await recoverStore.writeArtifactText(
            `.bridge/artifacts/pro-consults/${recoveredTask.id}.md`,
            recoveredArtifactText
          );
        } catch (error) {
          io.stderr(`answer_artifact_warning: ${errorMessage(error)}`);
        }
        await recoverStore.completeTask(recoveredTask.id, {
          status: "done",
          summary: consult.answer,
          artifacts: recoveredArtifactPath
            ? [{ path: recoveredArtifactPath, role: "result", bytes: Buffer.byteLength(recoveredArtifactText, "utf8") }]
            : [],
          commands: ["recovered ChatGPT answer from thread"],
          warnings: [],
          provenance: { thread: consult.url, warnings: [] }
        });
        io.stdout(`${recoveredTask.id}\tdone\t${consult.url}`);
        io.stdout("");
        io.stdout(consult.answer);
        io.stderr(`recovered: answer saved to .bridge; re-print with \`prodex pro latest --cwd ${recoverCwd}\``);
        return 0;
      }
      throw unknownSubcommandError("pro browser", browserSubcommand, ["login", "ask", "smoke", "check", "models", "projects", "recover"]);
    }
    if (subcommand === "open" || subcommand === "status" || subcommand === "smoke" || subcommand === "check" || subcommand === "doctor") {
      throw new Error(`Use \`prodex pro browser ${subcommand === "doctor" ? "check" : subcommand}\` for explicit browser automation.`);
    }
    if (subcommand === "list") {
      if (printHelpIfRequested(proArgs, "pro list", io.stdout, printProHelp, { valueFlags: ["--cwd", "--source-cli"] })) return 0;
      assertOnlyOptions(proArgs, "pro list", ["--cwd", "--source-cli"], ["--json"]);
      const targetCwd = resolveCwdFlag(io.cwd, proArgs);
      const targetStore = new BridgeStore(targetCwd);
      const sourceCli = resolveOptionalFileFlag(io.cwd, proArgs, "--source-cli");
      const answerOptions = { cwd: readFlag(proArgs, "--cwd") ? targetCwd : undefined };
      const consults = await listConsultListEntries(targetStore);
      if (proArgs.includes("--json")) {
        // Structured mirror of the human tab output, for agents (empty = valid []).
        const items = consults.map((entry) =>
          entry.kind === "untrusted"
            ? {
                task_id: entry.task.id,
                status: "untrusted",
                summary: sourceAwareResultMessage(errorMessage(entry.error), sourceCli, answerOptions)
              }
            : {
                task_id: entry.consult.task.id,
                status: entry.consult.result.status,
                summary: formatProListSummary(entry.consult, sourceCli, answerOptions)
              }
        );
        io.stdout(JSON.stringify(items, null, 2));
        return 0;
      }
      if (consults.length === 0) {
        io.stdout("No GPT Pro consults yet. Run `prodex ask \"...\"` to create one.");
        return 0;
      }
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
    if (subcommand === "debate-prompt") {
      if (
        printHelpIfRequested(proArgs, "pro debate-prompt", io.stdout, printProHelp, {
          valueFlags: ["--topic", "--rounds", "--source-cli"]
        })
      ) {
        return 0;
      }
      // debate-prompt only prints a prompt (no ledger access), so --cwd is
      // meaningless here - reject it rather than silently accepting it.
      assertOnlyOptions(proArgs, "pro debate-prompt", ["--topic", "--rounds", "--source-cli"]);
      const sourceCli = resolveOptionalFileFlag(io.cwd, proArgs, "--source-cli");
      const rounds = readPositiveIntegerFlag(proArgs, "--rounds") ?? 2;
      if (rounds > 5) {
        throw new Error("--rounds must be between 1 and 5: debates are bounded consults, not loops (keep Pro usage low-volume).");
      }
      io.stdout(formatDebatePrompt({ topic: readFlag(proArgs, "--topic"), rounds, sourceCli }));
      return 0;
    }
    throw unknownSubcommandError("pro", subcommand, ["ask", "browser", "debate-prompt", "list", "latest", "show"]);
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

const PROGRESS_PHASE_LABELS: Record<Exclude<SendChatGptProgressEvent["phase"], "waiting" | "answered">, string> = {
  connecting: "connecting to browser",
  tab_ready: "chatgpt tab ready",
  selecting: "applying selection",
  sent: "prompt sent, waiting for answer"
};

/**
 * Turns send progress events into stderr lines so multi-minute Pro consults do
 * not look frozen. Phase transitions print immediately; the per-poll waiting
 * heartbeat is throttled to one line per heartbeatMs.
 */
export function createBrowserSendProgressPrinter(
  write: (line: string) => void,
  heartbeatMs = 10_000
): (event: SendChatGptProgressEvent) => void {
  let lastWaitingElapsedMs: number | undefined;
  return (event) => {
    if (event.phase === "waiting") {
      if (lastWaitingElapsedMs !== undefined && event.elapsedMs - lastWaitingElapsedMs < heartbeatMs) return;
      lastWaitingElapsedMs = event.elapsedMs;
      write(`progress: waiting ${formatDurationMs(event.elapsedMs)}${event.detail ? ` (${event.detail})` : ""}`);
      return;
    }
    if (event.phase === "answered") {
      write(`progress: answer received after ${formatDurationMs(event.elapsedMs)}${event.detail ? ` (${event.detail})` : ""}`);
      return;
    }
    write(`progress: ${PROGRESS_PHASE_LABELS[event.phase]}${event.detail ? ` (${event.detail})` : ""}`);
  };
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
    const files = readRepeatedFlag(parsedAskPro.optionArgs, "--file").map((file) => {
      if (!path.isAbsolute(file)) return file;
      // Accept an absolute --file that points INSIDE the repo by converting it to
      // the repo-relative path the reader requires (agents naturally pass absolute
      // paths); reject one that escapes the repo so a file outside the project
      // (secrets, ~/.ssh, ...) is not attached to a consult by mistake.
      const rel = path.relative(targetCwd, path.resolve(file));
      if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new Error(
          `--file "${file}" is outside the repo root (${targetCwd}). Pass a path inside the repo (absolute or relative), or point --cwd at that repo.`
        );
      }
      return rel;
    });
    const targetUrl = readFlag(parsedAskPro.optionArgs, "--target-url");
    const normalizedTargetUrl = targetUrl ? normalizeChatGptTargetUrl(targetUrl) : undefined;
    if (!normalizedTargetUrl && parsedAskPro.optionArgs.includes("--confirm-target")) {
      throw new Error("--confirm-target requires --target-url so the visible browser target is explicit.");
    }
    if (normalizedTargetUrl && hasSendMode && !parsedAskPro.optionArgs.includes("--confirm-target")) {
      throw new Error("--target-url requires --confirm-target after you manually verify the visible ChatGPT tab is the intended Project/thread.");
    }
    const jsonOutput = parsedAskPro.optionArgs.includes("--json");
    if (jsonOutput && !hasSendMode) {
      throw new Error("--json applies to the visible-browser send output; the dry-run preview does not support it.");
    }
    const prompt = parsedAskPro.promptParts.join(" ").trim();
    const usingStdin = parsedAskPro.optionArgs.includes("--stdin");
    // A prompt is required UNLESS --stdin supplies one: `git diff | prodex ask
    // --stdin` (piped text is the whole prompt) is as valid as `... --stdin
    // "review this"` (positional instruction + piped data below it).
    if (!prompt && !usingStdin) {
      throw new Error('ask-pro requires a prompt. Example: prodex ask "Explain this stack trace" (or pipe input: git diff | prodex ask --stdin "review this diff").');
    }
    let promptText = prompt;
    if (usingStdin) {
      const piped = ((await io.readStdin?.()) ?? "").trim();
      if (!piped) {
        throw new Error("--stdin was set but no piped input was received on stdin (pipe something in, e.g. `git diff | prodex ask --stdin \"review\"`).");
      }
      const MAX_STDIN_CHARS = 200_000;
      if (piped.length > MAX_STDIN_CHARS) {
        throw new Error(`--stdin input is too large (${piped.length} chars > ${MAX_STDIN_CHARS}); attach a file with --file instead.`);
      }
      promptText = prompt ? `${prompt}\n\n--- piped input (stdin) ---\n${piped}` : piped;
    }
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
    const newChat = parsedAskPro.optionArgs.includes("--new-chat");
    if (newChat && normalizedTargetUrl) {
      throw new Error(
        "ask-pro cannot combine --new-chat with --target-url: --new-chat navigates to a fresh chat while --target-url pins the confirmed tab."
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
    // A persisted default project APPLIES under --new-chat: since 0.16.11 a
    // fresh chat inside the project is exactly what "--new-chat + project"
    // produces, and the whole point of pinning a default project is that
    // consults stop landing in the general chat list. Only --target-url
    // (pinned tab) and --project-new suppress it.
    const selectionProject =
      explicitProject ??
      (normalizedTargetUrl || selectionProjectNew !== undefined ? undefined : browserDefaults?.project);
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
    const browserPort = hasSendMode ? resolveCdpPort(readPortFlag(parsedAskPro.optionArgs, "--port")) : undefined;
    const busyWaitMs = readNonNegativeIntegerFlag(parsedAskPro.optionArgs, "--busy-wait-ms");
    // Pro extended can legitimately think for minutes, so its default timeout is
    // higher; an explicit --timeout-ms always wins.
    // Pro reasoning routinely runs for many minutes (a real consult measured
    // ~13 minutes). The elevated default used to be keyed to the removed
    // --pro-mode, so --model Pro sends fell back to 90s and chronically timed
    // out. Any effective Pro selection now defaults to 15 minutes.
    const effectiveProSelection = selectionProMode !== undefined || (selectionModel !== undefined && /pro/i.test(selectionModel));
    // Pro reasoning routinely runs 6-20 minutes; 15 min was still cutting long
    // answers off (field report), so a Pro selection defaults to 20 minutes.
    const defaultBrowserTimeoutMs = effectiveProSelection ? 1_200_000 : 90_000;
    const browserTimeoutMs = hasSendMode
      ? (readPositiveIntegerFlag(parsedAskPro.optionArgs, "--timeout-ms") ?? defaultBrowserTimeoutMs)
      : undefined;
    const sourceCli = resolveOptionalFileFlag(io.cwd, parsedAskPro.optionArgs, "--source-cli");
    const bundle = await buildDryRunBundle(targetCwd, { prompt: promptText, files });
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
      const sendOnce = () =>
        withBrowserSendLock(busyWaitMs ?? 0, (detail) => io.stderr(`progress: ${detail}`), () =>
        sendChatGptPrompt({
          port: browserPort,
          prompt: bundle.text,
          targetUrl: normalizedTargetUrl,
          timeoutMs: browserTimeoutMs,
          ...(newChat ? { newChat: true } : {}),
          ...(busyWaitMs !== undefined ? { busyWaitMs } : {}),
          project: selectionProject,
          projectNew: selectionProjectNew,
          model: selectionModel,
          proMode: selectionProMode,
          effort: selectionEffort,
          onProgress: createBrowserSendProgressPrinter(io.stderr)
        }));
      // One-command recovery: interactive terminals (or explicit --auto-login)
      // launch the dedicated browser and retry once when no browser runs.
      // Scripts and agents keep the plain blocker unless they opt in.
      const autoLoginAllowed =
        !parsedAskPro.optionArgs.includes("--no-auto-login") &&
        (parsedAskPro.optionArgs.includes("--auto-login") || io.isInteractive === true);
      let consult: Awaited<ReturnType<typeof sendChatGptPrompt>>;
      try {
        try {
          consult = await sendOnce();
        } catch (error) {
          const firstBlocker = browserSendBlockerFromError(error);
          if (firstBlocker.code !== "browser_unreachable" || !autoLoginAllowed) throw error;
          const recovered = await attemptBrowserAutoRecovery(io.stderr, {
            ...(browserPort !== undefined ? { port: browserPort } : {})
          });
          if (!recovered) throw error;
          consult = await sendOnce();
        }
      } catch (error) {
        const blocker = sourceAwareBrowserBlocker(browserSendBlockerFromError(error), sourceCli, browserCommandOptions);
        const message = blocker.next_step ? `${blocker.message} Next: ${blocker.next_step}` : errorMessage(error);
        // The blocker text can quote the requested/default project name (e.g. a
        // "project not found" error). Local stdout/stderr keep it (useful to the
        // operator), but the persisted task/session cross the MCP boundary, so
        // scrub the project name there the same way provenance.project is redacted.
        const redactProject = (text: string): string => {
          const name = selectionMetadata.project;
          return name ? text.split(name).join("<project>") : text;
        };
        const persistedBlocker = {
          ...blocker,
          message: redactProject(blocker.message),
          ...(blocker.next_step ? { next_step: redactProject(blocker.next_step) } : {})
        };
        try {
          await targetStore.completeTask(task.id, {
            status: "blocked",
            summary: redactProject(message),
            commands: ["visible ChatGPT browser consult"],
            blocker: persistedBlocker
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
              blocker: persistedBlocker,
              warnings: []
            },
            io
          );
        } catch (recordError) {
          throw new Error(`${message} (also failed to record blocked consult: ${errorMessage(recordError)})`);
        }
        // Keep stdout machine-parseable for --json consumers on the blocked
        // path too; the human-readable error still goes to stderr via throw.
        if (jsonOutput) {
          io.stdout(
            JSON.stringify(
              { task_id: task.id, status: "blocked", thread: normalizedTargetUrl ?? null, answer: null, warnings: [], blocker },
              null,
              2
            )
          );
        }
        throw new Error(formatBlockedConsultRecordedMessage(message, task.id, sourceCli, { cwd: targetCwd }));
      }
      const answerArtifactText = formatProConsultArtifact(consult);
      const persistenceWarnings = [...consult.warnings];
      // A send with no model selection at all (no per-ask flag, no saved
      // default) silently uses whatever the ChatGPT UI last had selected -
      // after the 2026-07 update reset that to Medium, consults meant for Pro
      // quietly ran on a mid-tier model. Warn loudly and record it.
      if (!selectionModel && !selectionProMode && !selectionEffort) {
        persistenceWarnings.push(
          "model_selection_warning: no model/effort was selected for this send (no per-ask flag, no saved default), so it used whatever the ChatGPT UI last had selected. Pin one with `prodex setup --model Pro` or pass --model/--effort."
        );
      }
      // In-project threads carry the project slug in their URL
      // (/g/g-p-<project>/c/<id>); a bare /c/<id> after requesting a project
      // means the thread landed at root - say so instead of leaving it to a
      // sidebar audit (field-verified failure mode).
      if ((selectionMetadata.project || selectionMetadata.project_new) && !/\/g\/g-p-/.test(consult.url ?? "")) {
        persistenceWarnings.push(
          "project_landing_warning: a project was requested but the answered thread URL is a root /c/ thread, so it likely landed OUTSIDE the project. Move it via the thread menu (Move to project) or re-run; list projects with `prodex pro browser projects`."
        );
      }
      // Truncation and other send warnings must be visible at runtime, not
      // only inside the persisted receipt: a caller who never opens .bridge
      // would otherwise treat a cut-off answer as complete.
      for (const warning of persistenceWarnings) io.stderr(warning);
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
      if (jsonOutput) {
        io.stdout(
          JSON.stringify(
            {
              task_id: result.task_id,
              status: result.status,
              thread: consult.url,
              answer: result.summary,
              warnings: persistenceWarnings
            },
            null,
            2
          )
        );
      } else {
        io.stdout(`${result.task_id}\t${result.status}\t${consult.url}`);
        io.stdout("");
        io.stdout(result.summary);
      }
      // Discoverability footer on stderr: the answer above is also persisted,
      // and `pro latest` re-prints it without a new browser send.
      const cwdForHints = readFlag(parsedAskPro.optionArgs, "--cwd") ? targetCwd : undefined;
      io.stderr(
        `${answerArtifactPath ? `saved: ${answerArtifactPath}` : "saved: task result (answer too large for a fetchable artifact)"} | re-print: ${formatProLatestCommand(sourceCli, { cwd: cwdForHints })}`
      );
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

/**
 * Paste-into-agent orchestration prompt for a structured debate between the
 * agent (Claude/Codex/...) and the user's ChatGPT Pro via pro_consult. The
 * reliability guidance (new_chat per round, generous timeout, no blocked-
 * consult retry loops) comes from live debate runs.
 */
export function formatDebatePrompt(options: { topic?: string; rounds: number; sourceCli?: string }): string {
  const topic = options.topic ?? "<fill in the debate topic>";
  const askFallback = `${formatCliCommand(options.sourceCli)} ask --new-chat --timeout-ms 240000 "<round prompt>"`;
  return `prodex debate orchestration

Topic: ${topic}

You are one side of a structured debate. Your opponent is the user's ChatGPT
(Pro), reached through the prodex MCP tool pro_consult (CLI fallback:
\`${askFallback}\`). Run exactly ${options.rounds} rounds.

Rules:
1. Open by stating your position on the topic in at most 5 bullets.
2. Each round:
   - Send the opponent ONE self-contained pro_consult prompt: restate the
     topic, quote your current argument verbatim, and ask for the strongest
     rebuttal in at most 3 bullets ("bullets only, no preamble").
   - Always pass new_chat: true (a fresh chat per round keeps sends
     reliable) and timeout_ms: 240000 (debate turns need thinking time).
   - Read the rebuttal, then defend or update your position in at most 3
     bullets before the next round.
3. Consults are auto-paced (about one per 10s). If a consult returns a
   blocker, report it and stop - never retry blocked consults in a loop.
4. In the final round's consult, ask the opponent for its final position in
   2 bullets plus one explicit concession.
5. Close with a synthesis: your final position, the strongest point you
   concede to the opponent, the decisive argument of the debate, and open
   questions. Cite the pro_consult task_id of every round so the receipts
   under .bridge/ back each quote.

Write the debate in the language of the topic.`;
}

export interface BrowserConsultInput {
  prompt: string;
  model?: string;
  pro_mode?: string;
  effort?: string;
  project?: string;
  timeout_ms?: number;
  files?: string[];
  /** Send into a fresh chat; recommended for agent loops and debates. */
  new_chat?: boolean;
}

export interface BrowserConsultOutcome {
  task_id: string;
  status: string;
  thread: string;
  answer: string;
  notes: string[];
}

/**
 * MCP-facing wrapper around the visible-browser ask flow. Reuses the full CLI
 * path (send pacing, task/session/receipt persistence, artifact save) by
 * invoking runAskProCommand with captured io, then returns structured fields
 * instead of printed lines. Registered only on the local stdio MCP server -
 * never on the HTTP MCP surface, which is exposed to ChatGPT itself.
 */
export async function performBrowserConsultForMcp(
  cwd: string,
  input: BrowserConsultInput,
  onProgress?: (message: string) => void
): Promise<BrowserConsultOutcome> {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const argv = [
    "--send",
    ...(input.model !== undefined ? ["--model", input.model] : []),
    ...(input.pro_mode !== undefined ? ["--pro-mode", input.pro_mode] : []),
    ...(input.effort !== undefined ? ["--effort", input.effort] : []),
    ...(input.project !== undefined ? ["--project", input.project] : []),
    ...(input.timeout_ms !== undefined ? ["--timeout-ms", String(input.timeout_ms)] : []),
    ...(input.files ?? []).flatMap((file) => ["--file", file]),
    ...(input.new_chat ? ["--new-chat"] : []),
    "--",
    input.prompt
  ];
  await runAskProCommand(argv, {
    cwd,
    stdout: (line) => stdoutLines.push(line),
    stderr: (line) => {
      stderrLines.push(line);
      if (onProgress && line.startsWith("progress:")) onProgress(line);
    },
    allowAskProBrowserSend: true
  });
  const header = stdoutLines[0] ?? "";
  const [taskId = "", status = "", thread = ""] = header.split("\t");
  return {
    task_id: taskId,
    status,
    thread,
    answer: stdoutLines.slice(2).join("\n"),
    notes: stderrLines.filter((line) => !line.startsWith("progress:"))
  };
}

/**
 * One-command recovery for interactive asks: when the send fails because no
 * browser is running, launch the dedicated browser, wait until the saved
 * session is READY, and let the caller retry once. Returns false (never
 * throws) when recovery does not reach readiness, so the original blocker
 * flow stays intact.
 */
export async function attemptBrowserAutoRecovery(stderr: (line: string) => void, options: { port?: number }): Promise<boolean> {
  stderr("recover: browser is not running - launching the dedicated ChatGPT browser (Ctrl+C aborts)...");
  try {
    // Reuse the profile the user last logged in with; launching the default
    // profile for a custom-profile user would wait on the wrong (logged-out)
    // profile or, worse, silently send to a different account.
    const lastLogin = await readLastBrowserLoginLaunch();
    const opened = openChatGptBrowser({
      ...(options.port !== undefined ? { port: options.port } : {}),
      ...(lastLogin?.profile_dir ? { profileDir: lastLogin.profile_dir } : {})
    });
    await assertBrowserLaunchStayedAlive(opened);
    const ready = await waitForChatGptLoginReady(stderr, { port: opened.port, timeoutMs: 120_000 });
    if (ready) stderr("recover: browser READY - retrying the send...");
    return ready;
  } catch (error) {
    stderr(`recover: failed - ${errorMessage(error)}`);
    return false;
  }
}

export interface LoginWaitDeps {
  statusFn?: typeof getChatGptBrowserStatus;
  sleepFn?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Guided login: poll the visible browser until a logged-in ChatGPT tab with a
 * usable composer appears, narrating each state change so the user knows what
 * manual step (login, challenge, opening a chat) is still missing.
 */
export async function waitForChatGptLoginReady(
  stderr: (line: string) => void,
  options: { port: number; timeoutMs?: number; pollMs?: number },
  deps: LoginWaitDeps = {}
): Promise<boolean> {
  const statusFn = deps.statusFn ?? getChatGptBrowserStatus;
  const sleepFn = deps.sleepFn ?? sleep;
  const now = deps.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 300_000;
  const pollMs = options.pollMs ?? 2_000;
  const startedAt = now();
  stderr("login: waiting for a logged-in ChatGPT tab (finish login in the opened window; Ctrl+C stops waiting)...");
  let lastState = "";
  while (now() - startedAt < timeoutMs) {
    const status = await statusFn({ port: options.port, timeoutMs: 1_500 });
    const state = !status.reachable
      ? "login: browser starting..."
      : status.blocker
        ? `login: blocked - ${status.blocker.message}`
        : !status.loggedInLikely
          ? "login: waiting for ChatGPT login in the opened window..."
          : !status.hasComposer
            ? "login: logged in; open a chat so the prompt composer is visible..."
            : "";
    if (state === "") {
      stderr(`login: READY - logged-in ChatGPT tab with composer detected (${Math.round((now() - startedAt) / 1000)}s).`);
      return true;
    }
    if (state !== lastState) {
      lastState = state;
      stderr(state);
    }
    const remainingMs = timeoutMs - (now() - startedAt);
    if (remainingMs <= 0) break;
    await sleepFn(Math.min(pollMs, Math.max(1, remainingMs)));
  }
  stderr(
    `login: not ready after ${Math.round(timeoutMs / 1000)}s. Finish login in the browser, then verify with \`prodex pro browser check\`.`
  );
  return false;
}

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
  if (/ChatGPT web UI may have changed/.test(message)) {
    return {
      code: "send_ui_changed",
      message,
      retryable: true,
      next_step: "Update prodex (npm i -g @youdie006/prodex@latest); if it persists, report it at https://github.com/youdie006/prodex/issues or paste the prompt manually in the visible browser."
    };
  }
  // Match the raw ms whether the message uses the old "after 90000ms" form or
  // the newer human-readable "after 20 min (1200000ms)" form.
  const timedOut = message.match(/Timed out after [\s\S]*?(\d+)\s*ms/);
  if (timedOut) {
    // Suggest a concrete doubled budget so the user can paste a rerun command
    // instead of guessing what "raise --timeout-ms" means in milliseconds.
    const usedMs = Number(timedOut[1]);
    const suggestedMs = Number.isFinite(usedMs) && usedMs > 0 ? usedMs * 2 : 600_000;
    return {
      code: "send_timeout",
      message,
      retryable: true,
      next_step: `Rerun with a bigger budget (${formatDurationMs(suggestedMs)}): \`prodex pro browser ask --timeout-ms ${suggestedMs} "<same prompt>"\`.`
    };
  }
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
  input: { opened: boolean; reused?: boolean; loginUrl: string; profileDir: string; port: number; sourceCli?: string; commandOptions?: BrowserCommandOptions }
): void {
  const windowAvailable = input.opened || input.reused === true;
  const loginCommand = formatBrowserLoginCommand(input.sourceCli, input.commandOptions);
  const runtimeCommandOptions = {
    ...(input.commandOptions?.cwd ? { cwd: input.commandOptions.cwd } : {}),
    ...(input.commandOptions?.port ? { port: input.commandOptions.port } : {})
  };
  const checkCommand = formatBrowserCheckCommand(input.sourceCli, runtimeCommandOptions);
  const smokeCommand = formatBrowserSmokeCommand(input.sourceCli, runtimeCommandOptions);
  stdout("ChatGPT Pro browser login");
  stdout(
    input.reused
      ? "Chrome is already running for ChatGPT - reusing it (no new window opened)."
      : input.opened
        ? "Opened the dedicated Chrome window for ChatGPT."
        : "Dry run: no browser was opened."
  );
  stdout("");
  stdout("Steps:");
  if (windowAvailable) {
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
  if (windowAvailable) {
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

  // Echo the saved send defaults next to the live model hints so users can
  // see what an ask will actually apply without opening the config file.
  try {
    const savedDefaults = await loadBrowserDefaults(configCwd);
    if (savedDefaults) io.stdout(`browser_defaults: ${formatBrowserDefaults(savedDefaults)}`);
  } catch {
    // config unreadable: already reported by the config line above
  }

  // Parse flags OUTSIDE the probe guard: an invalid --port / PRODEX_CDP_PORT /
  // --timeout-ms is a usage or config error, not a browser-check failure.
  const checkPort = resolveCdpPort(readPortFlag(args, "--port"));
  const checkTimeoutMs = readPositiveIntegerFlag(args, "--timeout-ms") ?? 1500;
  const browserCommandOptions = {
    cwd: setupHintCwd,
    port: checkPort !== DEFAULT_CDP_PORT ? checkPort : undefined
  };
  let browserStatus: Awaited<ReturnType<typeof getChatGptBrowserStatus>> | undefined;
  try {
    browserStatus = await getChatGptBrowserStatus({ port: checkPort, timeoutMs: checkTimeoutMs });
  } catch (error) {
    // A reachable-but-broken page (e.g. a failing in-page evaluate) must show
    // as a check failure like doctor does, not crash the whole check with an
    // internal error - and the rest of the check (latest_pro) still runs.
    io.stdout(`chatgpt: check failed - ${errorMessage(error)}`);
    const failedNext = productCheckBrowserNextStep(
      "Reload the ChatGPT tab in the dedicated browser (or rerun `prodex pro browser login`), then retry.",
      sourceCli,
      browserCommandOptions
    );
    if (failedNext) io.stdout(`next: ${failedNext}`);
  }
  let chatgptReady = false;
  if (browserStatus) {
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
  }

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
