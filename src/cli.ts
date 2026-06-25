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
import { buildDryRunBundle } from "./bundle.js";
import {
  chatGptVisibilityBlocker,
  defaultChatGptProfileDir,
  getChatGptBrowserStatus,
  normalizeChatGptTargetUrl,
  type ChatGptBrowserLaunch,
  openChatGptBrowser,
  sendChatGptPrompt
} from "./chatgpt-browser.js";
import { getTokenExpiryStatus, loadLocalConfig, writeLocalConfig, type LocalConfig } from "./config.js";
import { startHttpMcpServer } from "./http-mcp.js";
import { createMcpToolHandlers } from "./mcp-tools.js";
import { runMcpServer } from "./mcp.js";
import { readVerifiedUtf8File, writeVerifiedUtf8File } from "./safe-file.js";
import { ReceiptKindSchema, TaskStatusSchema, type BridgeFile, type Receipt } from "./schema.js";
import { BridgeStore, MAX_FETCHABLE_RESULT_ARTIFACT_BYTES, type ListReceiptsInput } from "./store.js";

const execFileAsync = promisify(execFile);
const requirePackageJson = createRequire(import.meta.url);
const packageJson = requirePackageJson("../package.json") as { version?: string };
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_VERSION = packageJson.version ?? "0.0.0";
const RESERVED_PACKAGE_NAMES = new Set(["node_modules", "favicon.ico"]);
const PRO_BROWSER_SMOKE_TOKEN = "GPTPROUSE_PRO_SMOKE_OK";
const TOP_LEVEL_COMMANDS = [
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
}

export async function runCli(args: string[], io: CliIO = defaultIo()): Promise<number> {
  const [command, ...rest] = args;
  const store = new BridgeStore(io.cwd);

  if (command === "--version" || command === "-v" || command === "version") {
    io.stdout(CLI_VERSION);
    return 0;
  }

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp(io.stdout);
    return 0;
  }

  if (command === "init") {
    if (printHelpIfRequested(rest, "init", io.stdout, printInitHelp, { valueFlags: ["--cwd"] })) return 0;
    assertOnlyOptions(rest, "init", ["--cwd"]);
    const targetCwd = resolveCwdFlag(io.cwd, rest);
    const targetStore = new BridgeStore(targetCwd);
    await targetStore.ensure();
    await ensureBridgeGitignore(targetCwd);
    io.stdout("Initialized .bridge receipt ledger.");
    return 0;
  }

  if (command === "setup") {
    if (printHelpIfRequested(rest, "setup", io.stdout, printSetupHelp, { valueFlags: ["--cwd", "--host", "--port", "--token", "--token-ttl-hours"] })) return 0;
    assertOnlyOptions(rest, "setup", ["--cwd", "--host", "--port", "--token", "--token-ttl-hours"]);
    const targetCwd = resolveCwdFlag(io.cwd, rest);
    const config = await writeLocalConfig(targetCwd, {
      host: readFlag(rest, "--host") ?? "127.0.0.1",
      port: readPortFlag(rest, "--port") ?? 8787,
      token: readFlag(rest, "--token"),
      tokenTtlHours: readPositiveNumberFlag(rest, "--token-ttl-hours")
    });
    io.stdout("Saved local ChatGPT Developer Mode MCP profile.");
    io.stdout(`Server URL: ${redactServerUrl(config.server_url)}`);
    io.stdout(formatTokenExpiryLine(config));
    io.stdout("Full URL is stored in .bridge/config.local.json.");
    return 0;
  }

  if (command === "start") {
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
    io.stdout(`gptprouse HTTP MCP listening on ${redactServerUrl(running.mcp_url)}`);
    io.stdout(formatTokenExpiryLine(config));
    await waitForShutdown(async () => running.close());
    return 0;
  }

  if (command === "status") {
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
          "status --show-token requires a token with expiry. Run `gptprouse setup --token-ttl-hours <hours>` first, or pass --unsafe-show-non-expiring-token for local-only debugging.",
          sourceCli,
          { cwd: setupHintCwd }
        )
      );
    }
    if (showToken && tokenStatus.status === "expired") {
      throw new Error(
        sourceAwareSetupMessage(`token expired at ${tokenStatus.token_expires_at}. Run \`gptprouse setup --token-ttl-hours <hours>\`.`, sourceCli, {
          cwd: setupHintCwd
        })
      );
    }
    const serverUrl = formatServerUrlForOutput(config.server_url, { showToken });
    if (rest.includes("--url-only")) {
      io.stdout(serverUrl);
      return 0;
    }
    const warnings = tokenStatus.warning ? [sourceAwareSetupMessage(tokenStatus.warning, sourceCli, { cwd: setupHintCwd })] : [];
    if (showToken && allowNonExpiringTokenReveal && tokenStatus.status === "non_expiring") {
      warnings.push(
        sourceAwareSetupMessage(
          "Showing a non-expiring token. Keep this local-only and rotate it with `gptprouse setup --token-ttl-hours <hours>` before any tunnel or ChatGPT Project use.",
          sourceCli,
          { cwd: setupHintCwd }
        )
      );
    }
    io.stdout(
      JSON.stringify(
        {
          server_url: serverUrl,
          config_path: ".bridge/config.local.json",
          token_status: tokenStatus.status,
          token_expires_at: tokenStatus.token_expires_at ?? null,
          warnings
        },
        null,
        2
      )
    );
    return 0;
  }

  if (command === "tunnel") {
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
        sourceAwareSetupMessage("tunnel url requires a short-lived token. Run `gptprouse setup --token-ttl-hours <hours>` first.", sourceCli, {
          cwd: setupHintCwd
        })
      );
    }
    if (tokenStatus.status === "expired") {
      throw new Error(
        sourceAwareSetupMessage(`token expired at ${tokenStatus.token_expires_at}. Run \`gptprouse setup --token-ttl-hours <hours>\`.`, sourceCli, {
          cwd: setupHintCwd
        })
      );
    }
    const mcpUrl = makeTunnelMcpUrl(publicUrl, config.token);
    const showToken = tunnelArgs.includes("--show-token");
    const outputUrl = showToken ? mcpUrl : redactServerUrl(mcpUrl);
    if (tunnelArgs.includes("--url-only")) {
      io.stdout(outputUrl);
      return 0;
    }
    io.stdout(
      JSON.stringify(
        {
          mcp_url: outputUrl,
          token_status: tokenStatus.status,
          token_expires_at: tokenStatus.token_expires_at,
          warnings: [
            "This command does not create a tunnel. Keep `gptprouse start` running behind your own tunnel.",
            "Only paste the token-bearing URL into a trusted private MCP client."
          ]
        },
        null,
        2
      )
    );
    return 0;
  }

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
      assertOnlyOptions(chatgptArgs, "chatgpt smoke", ["--port", "--timeout-ms", "--source-cli"]);
      const sourceCli = resolveOptionalFileFlag(io.cwd, chatgptArgs, "--source-cli");
      const smokePrompt = `This is a one-time gptprouse smoke test. Reply exactly: ${PRO_BROWSER_SMOKE_TOKEN}`;
      const recordBlockedSmoke = async (
        summary: string,
        blocker: { code: string; message: string; retryable: boolean; next_step?: string },
        thread?: string
      ) => {
        const bundle = await buildDryRunBundle(io.cwd, { prompt: smokePrompt, files: [] });
        const task = await store.createTask({
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
        await store.claimTask(task.id, "chatgpt-pro");
        await store.completeTask(task.id, {
          status: "blocked",
          summary,
          commands: ["visible ChatGPT browser smoke"],
          blocker
        });
        await writeSessionBestEffort(
          store,
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
      };
      let result: Awaited<ReturnType<typeof sendChatGptPrompt>>;
      try {
        result = await sendChatGptPrompt({
          port: readPortFlag(chatgptArgs, "--port") ?? 9333,
          prompt: smokePrompt,
          timeoutMs: readPositiveNumberFlag(chatgptArgs, "--timeout-ms") ?? 90000
        });
      } catch (error) {
        const blocker = sourceAwareBrowserBlocker(browserSendBlockerFromError(error), sourceCli);
        const message = sourceCli && blocker.next_step ? `${blocker.message} Next: ${blocker.next_step}` : errorMessage(error);
        try {
          await recordBlockedSmoke(message, blocker);
        } catch (recordError) {
          throw new Error(`${message} (also failed to record blocked smoke: ${errorMessage(recordError)})`);
        }
        if (sourceCli) throw new Error(message);
        throw error;
      }
      if (result.answer.trim() !== PRO_BROWSER_SMOKE_TOKEN) {
        const message = `Pro browser smoke returned an unexpected answer. Expected exactly ${PRO_BROWSER_SMOKE_TOKEN}. Actual: ${firstLine(result.answer)}`;
        const blocker = {
          code: "smoke_token_mismatch",
          message,
          retryable: true,
          next_step: `Retry \`${formatBrowserSmokeCommand(sourceCli)}\` after selecting the intended Pro model, or inspect the visible ChatGPT answer.`
        };
        try {
          await recordBlockedSmoke(message, blocker, result.url);
        } catch (recordError) {
          throw new Error(`${message} (also failed to record blocked smoke: ${errorMessage(recordError)})`);
        }
        throw new Error(message);
      }
      io.stdout(JSON.stringify(result, null, 2));
      return 0;
    }
    throw legacyChatGptNamespaceError(subcommand);
  }

  if (command === "tasks") {
    const [subcommand, ...taskArgs] = rest;
    if (!subcommand || isHelpSubcommand(subcommand)) {
      assertNoExtraArgs(taskArgs, "tasks help", 0);
      printTasksHelp(io.stdout);
      return 0;
    }
    if (subcommand === "create") {
      if (printHelpIfRequested(taskArgs, "tasks create", io.stdout, printTasksHelp, { valueFlags: ["--title", "--prompt", "--repo-id", "--file"] })) return 0;
      assertOnlyOptions(taskArgs, "tasks create", ["--title", "--prompt", "--repo-id", "--file"]);
      const title = readFlag(taskArgs, "--title");
      const prompt = readFlag(taskArgs, "--prompt");
      if (!title || !prompt) throw new Error("tasks create requires --title and --prompt");
      const task = await store.createTask({
        source: "codex",
        title,
        prompt,
        repo_id: readFlag(taskArgs, "--repo-id") ?? "default",
        files: readRepeatedFlag(taskArgs, "--file").map((file) => ({ path: file, role: "context" as const })),
        provenance: { adapter: "cli", warnings: [] }
      });
      io.stdout(`${task.id}\t${task.status}\t${task.title}`);
      return 0;
    }
    if (subcommand === "list") {
      if (printHelpIfRequested(taskArgs, "tasks list", io.stdout, printTasksHelp, { valueFlags: ["--cwd", "--status"] })) return 0;
      assertOnlyOptions(taskArgs, "tasks list", ["--cwd", "--status"]);
      const targetStore = new BridgeStore(resolveCwdFlag(io.cwd, taskArgs));
      const status = readTaskStatusFlag(taskArgs);
      const tasks = await listTasksForInspection(targetStore, status);
      for (const task of tasks) {
        io.stdout(`${task.id}\t${task.status}\t${task.title}`);
      }
      return 0;
    }
    if (subcommand === "show") {
      if (printHelpIfRequested(taskArgs, "tasks show", io.stdout, printTasksHelp, { valueFlags: ["--cwd"], maxPositionals: 1 })) return 0;
      const [taskId] = readPositionalsWithOptions(taskArgs, "tasks show", 1, ["--cwd"]);
      if (!taskId) throw new Error("tasks show requires <task-id|latest>");
      const targetStore = new BridgeStore(resolveCwdFlag(io.cwd, taskArgs));
      const task = taskId === "latest" ? await latestTask(targetStore, { readOnly: true }) : await targetStore.getTaskReadOnly(taskId);
      if (!task) throw new Error(taskId === "latest" ? "No tasks found" : `Task not found: ${taskId}`);
      io.stdout(JSON.stringify(task, null, 2));
      return 0;
    }
    if (subcommand === "claim") {
      if (printHelpIfRequested(taskArgs, "tasks claim", io.stdout, printTasksHelp, { valueFlags: ["--by"], maxPositionals: 1 })) return 0;
      const taskId = readRequiredLeadingArgument(taskArgs, "tasks claim", "<task-id>");
      assertOnlyOptions(taskArgs.slice(1), "tasks claim", ["--by"]);
      const task = await store.claimTask(taskId, readFlag(taskArgs, "--by") ?? "codex");
      io.stdout(`${task.id}\t${task.status}\t${task.claimed_by ?? ""}`);
      return 0;
    }
    if (subcommand === "complete") {
      if (printHelpIfRequested(taskArgs, "tasks complete", io.stdout, printTasksHelp, { valueFlags: ["--summary", "--command", "--artifact"], maxPositionals: 1 })) return 0;
      const taskId = readRequiredLeadingArgument(taskArgs, "tasks complete", "<task-id>");
      assertOnlyOptions(taskArgs.slice(1), "tasks complete", ["--summary", "--command", "--artifact"]);
      const summary = readFlag(taskArgs, "--summary");
      if (!summary) throw new Error("tasks complete requires <task-id> --summary");
      const result = await store.completeTask(taskId, {
        status: "done",
        summary,
        commands: readRepeatedFlag(taskArgs, "--command"),
        artifacts: await writeTaskCompleteArtifacts(store, readRepeatedFlag(taskArgs, "--artifact"))
      });
      io.stdout(`${result.task_id}\t${result.status}\t${result.summary}`);
      return 0;
    }
    if (subcommand === "block") {
      if (
        printHelpIfRequested(taskArgs, "tasks block", io.stdout, printTasksHelp, {
          valueFlags: ["--summary", "--code", "--next-step", "--command"],
          booleanFlags: ["--retryable"],
          maxPositionals: 1
        })
      ) {
        return 0;
      }
      const taskId = readRequiredLeadingArgument(taskArgs, "tasks block", "<task-id>");
      assertOnlyOptions(taskArgs.slice(1), "tasks block", ["--summary", "--code", "--next-step", "--command"], ["--retryable"]);
      const summary = readFlag(taskArgs, "--summary");
      if (!summary) throw new Error("tasks block requires <task-id> --summary");
      const result = await store.completeTask(taskId, {
        status: "blocked",
        summary,
        blocker: {
          code: readFlag(taskArgs, "--code") ?? "manual_blocker",
          message: summary,
          retryable: taskArgs.includes("--retryable"),
          next_step: readFlag(taskArgs, "--next-step")
        },
        commands: readRepeatedFlag(taskArgs, "--command")
      });
      io.stdout(`${result.task_id}\t${result.status}\t${result.summary}`);
      return 0;
    }
    throw unknownSubcommandError("tasks", subcommand, ["create", "list", "show", "claim", "complete", "block"]);
  }

  if (command === "results") {
    const [subcommand, ...resultArgs] = rest;
    if (!subcommand || isHelpSubcommand(subcommand)) {
      assertNoExtraArgs(resultArgs, "results help", 0);
      printResultsHelp(io.stdout);
      return 0;
    }
    if (subcommand === "show") {
      if (printHelpIfRequested(resultArgs, "results show", io.stdout, printResultsHelp, { valueFlags: ["--cwd"], maxPositionals: 1 })) return 0;
      const [taskId] = readPositionalsWithOptions(resultArgs, "results show", 1, ["--cwd"]);
      if (!taskId) throw new Error("results show requires <task-id|latest>");
      const targetStore = new BridgeStore(resolveCwdFlag(io.cwd, resultArgs));
      const resolvedTaskId = taskId === "latest" ? await latestResultTaskId(targetStore, { readOnly: true }) : taskId;
      io.stdout(JSON.stringify(await targetStore.getFinalizedResultReadOnly(resolvedTaskId), null, 2));
      return 0;
    }
    if (subcommand === "artifact") {
      if (printHelpIfRequested(resultArgs, "results artifact", io.stdout, printResultsHelp, { valueFlags: ["--cwd"], maxPositionals: 2 })) return 0;
      const [taskId, artifactPath] = readPositionalsWithOptions(resultArgs, "results artifact", 2, ["--cwd"]);
      if (!taskId) throw new Error("results artifact requires <task-id> [artifact-path]");
      const targetStore = new BridgeStore(resolveCwdFlag(io.cwd, resultArgs));
      const resolvedTaskId = taskId === "latest" ? await latestResultTaskId(targetStore, { readOnly: true }) : taskId;
      const artifact = await targetStore.readFinalizedResultArtifactText(resolvedTaskId, artifactPath);
      io.stdout(artifact.content);
      return 0;
    }
    if (subcommand === "reseal") {
      if (
        printHelpIfRequested(resultArgs, "results reseal", io.stdout, printResultsHelp, {
          valueFlags: ["--cwd"],
          booleanFlags: ["--confirm-current-result"],
          maxPositionals: 1
        })
      ) {
        return 0;
      }
      const [taskId] = readPositionalsWithOptions(resultArgs, "results reseal", 1, ["--cwd"], ["--confirm-current-result"]);
      if (!taskId) throw new Error("results reseal requires <task-id|latest> --confirm-current-result");
      if (!resultArgs.includes("--confirm-current-result")) {
        throw new Error("results reseal requires --confirm-current-result after you review the current .bridge/results/<task-id>.json payload locally.");
      }
      const targetStore = new BridgeStore(resolveCwdFlag(io.cwd, resultArgs));
      const resolvedTaskId = taskId === "latest" ? await latestRawResultTaskId(targetStore) : taskId;
      const resealed = await targetStore.resealResult(resolvedTaskId);
      io.stdout(`${resealed.result.task_id}\tresealed\t${resealed.receipt.id}\tresult_sha256=${resealed.receipt.metadata.result_sha256}`);
      return 0;
    }
    throw unknownSubcommandError("results", subcommand, ["show", "artifact", "reseal"]);
  }

  if (command === "receipts") {
    const [subcommand, ...receiptArgs] = rest;
    if (!subcommand || isHelpSubcommand(subcommand)) {
      assertNoExtraArgs(receiptArgs, "receipts help", 0);
      printReceiptsHelp(io.stdout);
      return 0;
    }
    if (subcommand === "list") {
      if (printHelpIfRequested(receiptArgs, "receipts list", io.stdout, printReceiptsHelp, { valueFlags: ["--cwd", "--kind", "--task-id"] })) return 0;
      assertOnlyOptions(receiptArgs, "receipts list", ["--cwd", "--kind", "--task-id"]);
      const targetStore = new BridgeStore(resolveCwdFlag(io.cwd, receiptArgs));
      const receipts = await listReceiptsForInspection(targetStore, {
        kind: readReceiptKindFlag(receiptArgs),
        task_id: readFlag(receiptArgs, "--task-id")
      });
      for (const receipt of receipts) {
        io.stdout(`${receipt.id}\t${receipt.kind}\t${receipt.summary}${receiptInspectionListSuffix(receipt)}`);
      }
      return 0;
    }
    if (subcommand === "show") {
      if (printHelpIfRequested(receiptArgs, "receipts show", io.stdout, printReceiptsHelp, { valueFlags: ["--cwd"], maxPositionals: 1 })) return 0;
      const [receiptId] = readPositionalsWithOptions(receiptArgs, "receipts show", 1, ["--cwd"]);
      if (!receiptId) throw new Error("receipts show requires <receipt-id|latest>");
      const targetStore = new BridgeStore(resolveCwdFlag(io.cwd, receiptArgs));
      const receipt =
        receiptId === "latest" ? (await listReceiptsForInspection(targetStore))[0] : await targetStore.getReceiptForDisplayReadOnly(receiptId);
      if (!receipt) throw new Error(receiptId === "latest" ? "No receipts found" : `Receipt not found: ${receiptId}`);
      io.stdout(JSON.stringify(receipt, null, 2));
      return 0;
    }
    throw unknownSubcommandError("receipts", subcommand, ["list", "show"]);
  }

  if (command === "sessions") {
    const [subcommand, ...sessionArgs] = rest;
    if (!subcommand || isHelpSubcommand(subcommand)) {
      assertNoExtraArgs(sessionArgs, "sessions help", 0);
      printSessionsHelp(io.stdout);
      return 0;
    }
    if (subcommand === "list") {
      if (printHelpIfRequested(sessionArgs, "sessions list", io.stdout, printSessionsHelp, { valueFlags: ["--cwd", "--status"] })) return 0;
      assertOnlyOptions(sessionArgs, "sessions list", ["--cwd", "--status"]);
      const targetStore = new BridgeStore(resolveCwdFlag(io.cwd, sessionArgs));
      const status = readSessionStatusFlag(sessionArgs);
      const sessions = await listSessionsForInspection(targetStore, status);
      for (const session of sessions) {
        io.stdout(`${session.id}\t${session.status}\t${session.backend}\t${session.direction}`);
      }
      return 0;
    }
    if (subcommand === "show") {
      if (printHelpIfRequested(sessionArgs, "sessions show", io.stdout, printSessionsHelp, { valueFlags: ["--cwd"], maxPositionals: 1 })) return 0;
      const [sessionId] = readPositionalsWithOptions(sessionArgs, "sessions show", 1, ["--cwd"]);
      if (!sessionId) throw new Error("sessions show requires <session-id|latest>");
      const targetStore = new BridgeStore(resolveCwdFlag(io.cwd, sessionArgs));
      const session = sessionId === "latest" ? (await listSessionsForInspection(targetStore))[0] : await targetStore.getSessionReadOnly(sessionId);
      if (!session) throw new Error(sessionId === "latest" ? "No sessions found" : `Session not found: ${sessionId}`);
      io.stdout(formatSession(session));
      return 0;
    }
    throw unknownSubcommandError("sessions", subcommand, ["list", "show"]);
  }

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
        throw new Error("gptprouse pro ask is a dry-run preview. Use `gptprouse pro browser ask` for visible-browser sends.");
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
            valueFlags: ["--profile-dir", "--port", "--url", "--source-cli", "--launch-timeout-ms"],
            booleanFlags: ["--dry-run"]
          })
        ) {
          return 0;
        }
        assertOnlyOptions(browserArgs, "pro browser login", ["--profile-dir", "--port", "--url", "--source-cli", "--launch-timeout-ms"], ["--dry-run"]);
        const loginUrl = readChatGptBrowserUrlFlag(browserArgs);
        const sourceCli = resolveOptionalFileFlag(io.cwd, browserArgs, "--source-cli");
        const profileDir = readFlag(browserArgs, "--profile-dir");
        const port = readPortFlag(browserArgs, "--port") ?? 9333;
        const launchTimeoutMs = readPositiveNumberFlag(browserArgs, "--launch-timeout-ms");
        const commandOptions = {
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
          throw new Error("gptprouse pro browser ask is an explicit visible-browser send. Use `gptprouse pro ask` for dry-run previews.");
        }
        const hasMode = hasAskProMode(browserArgs);
        return runCli(["ask-pro", ...(hasMode ? [] : ["--send"]), ...browserArgs], { ...io, allowAskProBrowserSend: true });
      }
      if (browserSubcommand === "open" || browserSubcommand === "status" || browserSubcommand === "doctor") {
        const replacement = browserSubcommand === "open" ? "login" : "check";
        throw new Error(`Use \`gptprouse pro browser ${replacement}\` for explicit browser automation.`);
      }
      if (browserSubcommand === "smoke") {
        if (printProBrowserHelpIfRequested(browserArgs, "pro browser smoke", io, { valueFlags: ["--port", "--timeout-ms", "--source-cli"] })) return 0;
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
      throw unknownSubcommandError("pro browser", browserSubcommand, ["login", "ask", "smoke", "check"]);
    }
    if (subcommand === "open" || subcommand === "status" || subcommand === "smoke" || subcommand === "check" || subcommand === "doctor") {
      throw new Error(`Use \`gptprouse pro browser ${subcommand === "doctor" ? "check" : subcommand}\` for explicit browser automation.`);
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
          io.stdout(`${entry.task.id}\tuntrusted\t${errorMessage(entry.error)}`);
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
      const consult = await latestTrustedConsult(targetStore);
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
      const consult =
        taskId === "latest" ? await latestTrustedConsult(targetStore) : await getConsult(targetStore, taskId, { readOnly: true });
      if (!consult) throw new Error(taskId === "latest" ? "No GPT Pro answers found" : `GPT Pro answer not found: ${taskId}`);
      io.stdout(formatProAnswer(consult, sourceCli, answerOptions));
      return 0;
    }
    throw unknownSubcommandError("pro", subcommand, ["ask", "browser", "list", "latest", "show"]);
  }

  if (command === "consults") {
    throw new Error("The legacy `consults` alias is retired. Use `gptprouse pro list`, `gptprouse pro latest`, or `gptprouse pro show <task-id|latest>`.");
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
      throw new Error("Direct ask-pro --send is disabled. Use `gptprouse pro browser ask` for explicit visible-browser sends.");
    }
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
    const browserPort = hasSendMode ? (readPortFlag(parsedAskPro.optionArgs, "--port") ?? 9333) : undefined;
    const browserTimeoutMs = hasSendMode ? (readPositiveNumberFlag(parsedAskPro.optionArgs, "--timeout-ms") ?? 90000) : undefined;
    const sourceCli = resolveOptionalFileFlag(io.cwd, parsedAskPro.optionArgs, "--source-cli");
    const bundle = await buildDryRunBundle(io.cwd, { prompt, files });
    if (hasSendMode) {
      const task = await store.createTask({
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
      await store.claimTask(task.id, "chatgpt-pro");
      try {
        await writeSessionBeforeBrowserSend(
          store,
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
          await store.completeTask(task.id, {
            status: "blocked",
            summary: blocker.message,
            commands: ["visible ChatGPT browser consult"],
            blocker
          });
        } catch (recordError) {
          throw new Error(`${blocker.message} (also failed to record blocked consult: ${errorMessage(recordError)})`);
        }
        throw new Error(formatBlockedConsultRecordedMessage(blocker.message, task.id, sourceCli, { cwd: io.cwd }));
      }
      let consult: Awaited<ReturnType<typeof sendChatGptPrompt>>;
      try {
        consult = await sendChatGptPrompt({
          port: browserPort,
          prompt: bundle.text,
          targetUrl: normalizedTargetUrl,
          timeoutMs: browserTimeoutMs
        });
      } catch (error) {
        const blocker = sourceAwareBrowserBlocker(browserSendBlockerFromError(error), sourceCli, {
          port: parsedAskPro.optionArgs.includes("--port") ? browserPort : undefined
        });
        const message = sourceCli && blocker.next_step ? `${blocker.message} Next: ${blocker.next_step}` : errorMessage(error);
        try {
          await store.completeTask(task.id, {
            status: "blocked",
            summary: message,
            commands: ["visible ChatGPT browser consult"],
            blocker
          });
          await writeSessionBestEffort(
            store,
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
        throw new Error(formatBlockedConsultRecordedMessage(message, task.id, sourceCli, { cwd: io.cwd }));
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
          answerArtifactPath = await store.writeArtifactText(`.bridge/artifacts/pro-consults/${task.id}.md`, answerArtifactText);
        } catch (error) {
          const warning = `answer_artifact_warning: ${errorMessage(error)}`;
          persistenceWarnings.push(warning);
          io.stderr(warning);
        }
      }
      try {
        await store.writeReceipt({
          kind: "consult_answer_saved",
          task_id: task.id,
          session_id: bundle.id,
          summary: `Recorded ChatGPT answer for ${task.id}`,
          metadata: {
            ...(answerArtifactPath ? { artifact_path: answerArtifactPath } : {}),
            thread: consult.url,
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
        result = await store.completeTask(task.id, {
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
        store,
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
        store,
        {
          id: bundle.id,
          direction: "codex_to_chatgpt",
          backend: "manual",
          status: "preview",
          warnings: []
        },
        io
      );
      await store.writeReceipt({
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

function printHelp(stdout: (line: string) => void): void {
  stdout(`gptprouse v${CLI_VERSION}

Commands:
  gptprouse --version
  gptprouse init [--cwd /absolute/path/to/repo]
  gptprouse doctor [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js]
  gptprouse setup [--cwd /absolute/path/to/repo] [--host 127.0.0.1] [--port 8787] [--token-ttl-hours <hours>]
  gptprouse start [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js]
  gptprouse status [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js] [--show-token] [--url-only] [--unsafe-show-non-expiring-token]
  gptprouse tunnel url [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js] --public-url https://... [--show-token] [--url-only]
  gptprouse release status [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js]
  gptprouse release pack [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js] --pack-destination /absolute/path [--keep-workdir]
  gptprouse onboard [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js]
  gptprouse project prompt [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js]
  gptprouse claude prompt [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js]
  gptprouse claude config [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js]
  gptprouse pro ask [--dry-run] [--file path] "prompt"  # dry-run preview
  gptprouse pro browser login [--dry-run] [--source-cli /absolute/path/to/dist/cli.js] [--launch-timeout-ms 5000]  # preview/open visible browser login
  gptprouse pro browser help [--source-cli /absolute/path/to/dist/cli.js]
  gptprouse pro browser check [--source-cli /absolute/path/to/dist/cli.js] [--cwd /absolute/path/to/repo]
  gptprouse pro browser smoke [--source-cli /absolute/path/to/dist/cli.js]
  gptprouse pro browser ask [--source-cli /absolute/path/to/dist/cli.js] [--target-url url --confirm-target] [--file path] "prompt"  # explicit visible-browser send
  gptprouse pro latest [--source-cli /absolute/path/to/dist/cli.js] [--cwd /absolute/path/to/repo]
  gptprouse pro list [--source-cli /absolute/path/to/dist/cli.js] [--cwd /absolute/path/to/repo]
  gptprouse pro show <task-id|latest> [--source-cli /absolute/path/to/dist/cli.js] [--cwd /absolute/path/to/repo]
  gptprouse tasks create --title "Title" --prompt "Prompt"
  gptprouse tasks list [--status new|claimed|done|blocked] [--cwd /absolute/path/to/repo]
  gptprouse tasks show <task-id|latest> [--cwd /absolute/path/to/repo]
  gptprouse tasks claim <task-id> [--by codex]
  gptprouse tasks complete <task-id> --summary "Summary" [--command "npm test"] [--artifact .bridge/artifacts/results/name.md=text]
  gptprouse tasks block <task-id> --summary "Summary" [--code code] [--next-step "Next step"] [--retryable]
  gptprouse results show <task-id|latest> [--cwd /absolute/path/to/repo]
  gptprouse results artifact <task-id|latest> [artifact-path] [--cwd /absolute/path/to/repo]
  gptprouse results reseal <task-id|latest> --confirm-current-result [--cwd /absolute/path/to/repo]
  gptprouse receipts list [--kind kind] [--task-id task-id] [--cwd /absolute/path/to/repo]
  gptprouse receipts show <receipt-id|latest> [--cwd /absolute/path/to/repo]
  gptprouse sessions list [--status preview|running|done|blocked] [--cwd /absolute/path/to/repo]
  gptprouse sessions show <session-id|latest> [--cwd /absolute/path/to/repo]
  gptprouse mcp [--cwd /absolute/path/to/repo]`);
}

function printInitHelp(stdout: (line: string) => void): void {
  stdout(`gptprouse init

Commands:
  gptprouse init [--cwd /absolute/path/to/repo]

Initialize the local .bridge receipt ledger and bridge .gitignore entries.`);
}

function printSetupHelp(stdout: (line: string) => void): void {
  stdout(`gptprouse setup

Commands:
  gptprouse setup [--cwd /absolute/path/to/repo] [--host 127.0.0.1] [--port 8787] [--token-ttl-hours <hours>]

Save a loopback-only HTTP MCP profile in .bridge/config.local.json. Use --token-ttl-hours before tunnels or ChatGPT Project use.`);
}

function printStartHelp(stdout: (line: string) => void): void {
  stdout(`gptprouse start

Commands:
  gptprouse start [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js]

Start the local loopback HTTP MCP server from the saved setup profile.`);
}

function printStatusHelp(stdout: (line: string) => void): void {
  stdout(`gptprouse status

Commands:
  gptprouse status [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js] [--show-token] [--url-only] [--unsafe-show-non-expiring-token]

Show the saved local MCP URL with tokens redacted by default.`);
}

function printTunnelHelp(stdout: (line: string) => void): void {
  stdout(`gptprouse tunnel

Commands:
  gptprouse tunnel url [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js] --public-url https://... [--show-token] [--url-only]

Format a public tunnel MCP URL from an existing local setup. This command does not create a tunnel.`);
}

function printTunnelUrlHelp(stdout: (line: string) => void): void {
  stdout(`gptprouse tunnel url

Commands:
  gptprouse tunnel url [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js] --public-url https://... [--show-token] [--url-only]

This command does not create a tunnel. It only formats your supplied public URL with the saved short-lived MCP token.`);
}

function printDoctorHelp(stdout: (line: string) => void): void {
  stdout(`gptprouse doctor

Commands:
  gptprouse doctor [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js]

Run local bridge, MCP, write/apply/stage, and HTTP MCP smoke checks without opening ChatGPT.`);
}

function printOnboardHelp(stdout: (line: string) => void): void {
  stdout(`gptprouse onboard

Commands:
  gptprouse onboard [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js]

Print a local-first setup guide for Codex, ChatGPT Projects, Claude, and visible-browser Pro consults.`);
}

function printMcpHelp(stdout: (line: string) => void): void {
  stdout(`gptprouse mcp

Commands:
  gptprouse mcp [--cwd /absolute/path/to/repo]

Run the stdio MCP server for local clients such as Claude. This does not reveal HTTP MCP URL tokens.`);
}

function printReleaseHelp(stdout: (line: string) => void): void {
  stdout(`gptprouse release

Commands:
  gptprouse release status [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js]
  gptprouse release pack [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js] --pack-destination /absolute/path [--keep-workdir]

Release commands are local checks and package preparation helpers; they do not publish or push.`);
}

function printProHelp(stdout: (line: string) => void): void {
  stdout(`gptprouse pro

Commands:
  gptprouse pro ask [--dry-run] [--file path] "prompt"
  gptprouse pro browser help [--source-cli /absolute/path/to/dist/cli.js]
  gptprouse pro browser login [--dry-run] [--source-cli /absolute/path/to/dist/cli.js] [--launch-timeout-ms 5000]
  gptprouse pro browser check [--source-cli /absolute/path/to/dist/cli.js] [--cwd /absolute/path/to/repo]
  gptprouse pro browser smoke [--source-cli /absolute/path/to/dist/cli.js]
  gptprouse pro browser ask [--source-cli /absolute/path/to/dist/cli.js] [--target-url url --confirm-target] [--file path] "prompt"
  gptprouse pro latest [--source-cli /absolute/path/to/dist/cli.js] [--cwd /absolute/path/to/repo]
  gptprouse pro list [--source-cli /absolute/path/to/dist/cli.js] [--cwd /absolute/path/to/repo]
  gptprouse pro show <task-id|latest> [--source-cli /absolute/path/to/dist/cli.js] [--cwd /absolute/path/to/repo]

Use \`gptprouse pro ask\` for dry-run/manual previews.
Use \`gptprouse pro browser ask\` only when you want an explicit visible-browser send.`);
}

function printProjectHelp(stdout: (line: string) => void): void {
  stdout(`gptprouse project

Commands:
  gptprouse project prompt [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js]

Print a ChatGPT Project MCP verification prompt. The prompt asks for read/task handoff verification only.`);
}

function printClaudeHelp(stdout: (line: string) => void): void {
  stdout(`gptprouse claude

Commands:
  gptprouse claude prompt [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js]
  gptprouse claude config [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js]

Print Claude MCP setup and verification helpers. These commands do not start MCP or reveal HTTP tokens.`);
}

function printTasksHelp(stdout: (line: string) => void): void {
  stdout(`gptprouse tasks

Commands:
  gptprouse tasks create --title "Title" --prompt "Prompt"
  gptprouse tasks list [--status new|claimed|done|blocked] [--cwd /absolute/path/to/repo]
  gptprouse tasks show <task-id|latest> [--cwd /absolute/path/to/repo]
  gptprouse tasks claim <task-id> [--by codex]
  gptprouse tasks complete <task-id> --summary "Summary" [--command "npm test"] [--artifact .bridge/artifacts/results/name.md=text]
  gptprouse tasks block <task-id> --summary "Summary" [--code code] [--next-step "Next step"] [--retryable]`);
}

function printResultsHelp(stdout: (line: string) => void): void {
  stdout(`gptprouse results

Commands:
  gptprouse results show <task-id|latest> [--cwd /absolute/path/to/repo]
  gptprouse results artifact <task-id|latest> [artifact-path] [--cwd /absolute/path/to/repo]
  gptprouse results reseal <task-id|latest> --confirm-current-result [--cwd /absolute/path/to/repo]`);
}

function printReceiptsHelp(stdout: (line: string) => void): void {
  stdout(`gptprouse receipts

Commands:
  gptprouse receipts list [--kind kind] [--task-id task-id] [--cwd /absolute/path/to/repo]
  gptprouse receipts show <receipt-id|latest> [--cwd /absolute/path/to/repo]`);
}

function printSessionsHelp(stdout: (line: string) => void): void {
  stdout(`gptprouse sessions

Commands:
  gptprouse sessions list [--status preview|running|done|blocked] [--cwd /absolute/path/to/repo]
  gptprouse sessions show <session-id|latest> [--cwd /absolute/path/to/repo]`);
}

function isHelpSubcommand(value: string): boolean {
  return value === "help" || value === "--help" || value === "-h";
}

function isHelpArgs(args: string[]): boolean {
  return args.length > 0 && isHelpSubcommand(args[0]);
}

interface HelpRequestOptions {
  valueFlags?: readonly string[];
  booleanFlags?: readonly string[];
  maxPositionals?: number;
}

function printHelpIfRequested(
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

function printProBrowserHelpIfRequested(args: string[], command: string, io: CliIO, options: HelpRequestOptions): boolean {
  const helpIndex = findHelpFlagIndexBeforePromptDelimiter(args);
  if (helpIndex === -1) return false;
  assertHelpRequestArgs(args, command, options);
  printProBrowserHelp(io.stdout, resolveOptionalFileFlag(io.cwd, args, "--source-cli"));
  return true;
}

function findHelpFlagIndexBeforePromptDelimiter(args: string[]): number {
  const delimiterIndex = args.indexOf("--");
  const limit = delimiterIndex === -1 ? args.length : delimiterIndex;
  return args.findIndex((arg, index) => index < limit && isHelpSubcommand(arg));
}

function assertHelpRequestArgs(args: string[], command: string, options: HelpRequestOptions): void {
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

function unknownSubcommandError(command: string, subcommand: string, expected: readonly string[]): Error {
  const suggestion = closestSuggestion(subcommand, expected);
  const suggestionText = suggestion ? ` Did you mean \`gptprouse ${command} ${suggestion}\`?` : "";
  return new Error(`Unknown ${command} subcommand: ${subcommand}.${suggestionText} Expected one of: ${expected.join(", ")}. Run \`gptprouse ${command} --help\`.`);
}

function unknownTopLevelCommandError(command: string): Error {
  const suggestion = closestSuggestion(command, TOP_LEVEL_COMMANDS);
  const suggestionText = suggestion ? ` Did you mean \`gptprouse ${suggestion}\`?` : "";
  return new Error(`Unknown command: ${command}.${suggestionText} Run \`gptprouse help\`.`);
}

function unknownOptionError(option: string, command: string | undefined, candidates: readonly string[]): Error {
  const suggestion = closestSuggestion(option, candidates);
  const suggestionText = suggestion ? `. Did you mean \`${suggestion}\`?` : "";
  const context = command ? ` for ${command}` : "";
  return new Error(`Unknown option${context}: ${option}${suggestionText}`);
}

function closestSuggestion<T extends string>(value: string, candidates: readonly T[]): T | undefined {
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

function isUsefulPrefixSuggestion(value: string, candidate: string): boolean {
  return value.length >= 5 && candidate.startsWith(value);
}

function editDistance(left: string, right: string): number {
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

function legacyChatGptNamespaceError(subcommand?: string): Error {
  const prefix = subcommand ? `Unknown legacy chatgpt subcommand: ${subcommand}.` : "The legacy `chatgpt` namespace is hidden.";
  return new Error(`${prefix} Use \`gptprouse pro browser help\` for visible-browser commands.`);
}

function formatProjectVerificationPrompt(cwd: string, sourceCli?: string): string {
  const cli = formatCliCommand(sourceCli);
  const quotedCwd = shellQuote(cwd);
  const sourceCliOption = formatSourceCliOption(sourceCli);
  return `ChatGPT Project MCP verification prompt

Paste this into the ChatGPT Project after adding the gptprouse MCP server URL.

Please verify the gptprouse MCP bridge for this private project:

1. Call the MCP tool \`bridge_create_task\` with:

   {
     "title": "gptprouse MCP verification",
     "prompt": "Verify that this ChatGPT Project can create tasks through the local gptprouse MCP bridge.",
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
${cli} tasks list --status new
${cli} tasks show <task-id>
${cli} tasks complete <task-id> --summary "gptprouse MCP verification result" --artifact .bridge/artifacts/results/mcp-verification.md="gptprouse MCP verification artifact"

Then reply to ChatGPT with:

local completion done

If ChatGPT cannot see or call the MCP tools, keep the server terminal running and check locally:

${cli} status --cwd ${quotedCwd}${sourceCliOption}
${cli} doctor --cwd ${quotedCwd}${sourceCliOption}`;
}

function formatOnboardingGuide(cwd: string, hasReadme: boolean, sourceCli?: string): string {
  const quotedCwd = shellQuote(cwd);
  const cli = sourceCli ? `node ${shellQuote(sourceCli)}` : "gptprouse";
  const sourceCliOption = sourceCli ? ` --source-cli ${shellQuote(sourceCli)}` : "";
  const proAskCommand = hasReadme ? `${cli} pro ask --file README.md "Review this repo"` : `${cli} pro ask "Review this repo"`;
  const proBrowserAskCommand = hasReadme
    ? `${cli} pro browser ask${sourceCliOption} --file README.md "Review this repo"`
    : `${cli} pro browser ask${sourceCliOption} "Review this repo"`;
  return `gptprouse onboarding

repo: ${cwd}

1. Prepare the local bridge:
   ${cli} init --cwd ${quotedCwd}
   ${cli} doctor --cwd ${quotedCwd}${sourceCliOption}

2. Claude stdio MCP:
   ${cli} claude config --cwd ${quotedCwd}${sourceCliOption}
   ${cli} claude prompt --cwd ${quotedCwd}${sourceCliOption}

3. ChatGPT Project HTTP MCP:
   Note: HTTP MCP uses a short-lived token. Paste token-bearing URLs only into your own trusted private MCP client.
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
   ${cli} pro browser check${sourceCliOption}
   ${cli} pro browser smoke${sourceCliOption}
   ${proBrowserAskCommand}  # visible-browser send
   ${cli} pro list${sourceCliOption}
   ${cli} pro latest${sourceCliOption}
   ${cli} results show latest
   ${cli} results artifact latest
   ${cli} results reseal <task-id> --confirm-current-result  # only after reviewing .bridge/results/<task-id>.json

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

Paste this into Claude after adding the gptprouse stdio MCP server.

Please verify the gptprouse MCP bridge for this private repo:

1. Call the MCP tool \`bridge_create_task\` with:

   {
     "title": "gptprouse Claude MCP verification",
     "prompt": "Verify that Claude can create tasks through the local gptprouse MCP bridge.",
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
${cli} tasks list --status new
${cli} tasks show <task-id>
${cli} tasks complete <task-id> --summary "gptprouse Claude MCP verification result" --artifact .bridge/artifacts/results/claude-verification.md="gptprouse Claude MCP verification artifact"

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
        gptprouse: sourceCli
          ? { command: "node", args: [sourceCli, "mcp", "--cwd", cwd] }
          : { command: "gptprouse", args: ["mcp", "--cwd", cwd] }
      }
    },
    null,
    2
  );
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function formatCliCommand(sourceCli?: string): string {
  return sourceCli ? `node ${shellQuote(sourceCli)}` : "gptprouse";
}

function formatInitCommand(sourceCli?: string, options: { cwd?: string } = {}): string {
  return [`${formatCliCommand(sourceCli)} init`, options.cwd ? `--cwd ${shellQuote(options.cwd)}` : undefined].filter(Boolean).join(" ");
}

function formatSetupCommand(sourceCli?: string, options: { cwd?: string } = {}): string {
  return [`${formatCliCommand(sourceCli)} setup`, options.cwd ? `--cwd ${shellQuote(options.cwd)}` : undefined].filter(Boolean).join(" ");
}

function formatSourceCliOption(sourceCli?: string): string {
  return sourceCli ? ` --source-cli ${shellQuote(sourceCli)}` : "";
}

type BrowserCommandOptions = {
  cwd?: string;
  profileDir?: string;
  port?: number;
  targetUrl?: string;
  url?: string;
  launchTimeoutMs?: number;
};

function formatBrowserLoginCommand(sourceCli?: string, options: BrowserCommandOptions = {}): string {
  return [
    `${formatCliCommand(sourceCli)} pro browser login${formatSourceCliOption(sourceCli)}`,
    options.profileDir ? `--profile-dir ${shellQuote(options.profileDir)}` : undefined,
    options.port ? `--port ${options.port}` : undefined,
    options.url ? `--url ${shellQuote(options.url)}` : undefined,
    options.launchTimeoutMs ? `--launch-timeout-ms ${options.launchTimeoutMs}` : undefined
  ]
    .filter(Boolean)
    .join(" ");
}

function formatBrowserSmokeCommand(sourceCli?: string, options: BrowserCommandOptions = {}): string {
  const command = [`${formatCliCommand(sourceCli)} pro browser smoke${formatSourceCliOption(sourceCli)}`, options.port ? `--port ${options.port}` : undefined]
    .filter(Boolean)
    .join(" ");
  return formatCommandInCwd(command, options.cwd);
}

function formatBrowserCheckCommand(sourceCli?: string, options: BrowserCommandOptions = {}): string {
  return [`${formatCliCommand(sourceCli)} pro browser check${formatSourceCliOption(sourceCli)}`, options.port ? `--port ${options.port}` : undefined]
    .filter(Boolean)
    .join(" ");
}

function formatBrowserTargetAskCommand(sourceCli?: string, options: BrowserCommandOptions = {}): string {
  const command = [
    `${formatCliCommand(sourceCli)} pro browser ask${formatSourceCliOption(sourceCli)}`,
    options.port ? `--port ${options.port}` : undefined,
    `--target-url ${options.targetUrl ? shellQuote(options.targetUrl) : "<chatgpt-url>"} --confirm-target "prompt"`
  ]
    .filter(Boolean)
    .join(" ");
  return formatCommandInCwd(command, options.cwd);
}

function formatCommandInCwd(command: string, cwd?: string): string {
  return cwd ? `cd ${shellQuote(cwd)} && ${command}` : command;
}

function formatProShowCommand(taskId: string, sourceCli?: string, options: { cwd?: string } = {}): string {
  return [`${formatCliCommand(sourceCli)} pro show ${shellQuote(taskId)}${formatSourceCliOption(sourceCli)}`, options.cwd ? `--cwd ${shellQuote(options.cwd)}` : undefined]
    .filter(Boolean)
    .join(" ");
}

function formatProLatestCommand(sourceCli?: string, options: { cwd?: string } = {}): string {
  return [`${formatCliCommand(sourceCli)} pro latest${formatSourceCliOption(sourceCli)}`, options.cwd ? `--cwd ${shellQuote(options.cwd)}` : undefined]
    .filter(Boolean)
    .join(" ");
}

function formatBlockedConsultRecordedMessage(message: string, taskId: string, sourceCli?: string, options: { cwd?: string } = {}): string {
  return `${message}\nblocked consult recorded: ${taskId}; inspect with \`${formatProShowCommand(taskId, sourceCli, options)}\` or \`${formatProLatestCommand(sourceCli, options)}\`.`;
}

function formatReleaseStatusCommand(sourceCli?: string, options: { cwd?: string } = {}): string {
  return [`${formatCliCommand(sourceCli)} release status${formatSourceCliOption(sourceCli)}`, options.cwd ? `--cwd ${shellQuote(options.cwd)}` : undefined]
    .filter(Boolean)
    .join(" ");
}

function formatReleasePackCommand(sourceCli?: string, options: { cwd?: string } = {}): string {
  return [
    `${formatCliCommand(sourceCli)} release pack${formatSourceCliOption(sourceCli)}`,
    options.cwd ? `--cwd ${shellQuote(options.cwd)}` : undefined,
    "--pack-destination <dir>"
  ]
    .filter(Boolean)
    .join(" ");
}

function formatGitPushUpstreamCommand(branch: string): string {
  return `git push -u origin ${shellQuote(branch)}`;
}

function sourceAwareBrowserNextStep(nextStep: string | undefined, sourceCli?: string, options: BrowserCommandOptions = {}): string | undefined {
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
    .replaceAll("`gptprouse pro browser login`", `\`${formatBrowserLoginCommand(sourceCli, options)}\``)
    .replaceAll("`gptprouse pro browser smoke`", `\`${formatBrowserSmokeCommand(sourceCli, options)}\``)
    .replaceAll("pass --target-url with --confirm-target", `run \`${formatBrowserTargetAskCommand(sourceCli, options)}\``);
}

function productCheckBrowserNextStep(nextStep: string | undefined, sourceCli?: string, options: BrowserCommandOptions = {}): string | undefined {
  const sourceAware = sourceAwareBrowserNextStep(nextStep, sourceCli, options);
  if (!sourceAware) return sourceAware;
  if (sourceAware.includes("`")) return sourceAware;
  if (sourceAware.includes("pass --target-url with --confirm-target")) {
    return sourceAware.replace("pass --target-url with --confirm-target", `run \`${formatBrowserTargetAskCommand(sourceCli, options)}\``);
  }
  return sourceAware.replace(/then retry\.$/, `then run \`${formatBrowserSmokeCommand(sourceCli, options)}\`.`);
}

function sourceAwareBrowserBlocker<T extends { next_step?: string }>(blocker: T, sourceCli?: string, options: BrowserCommandOptions = {}): T {
  const nextStep = sourceAwareBrowserNextStep(blocker.next_step, sourceCli, options);
  return nextStep === blocker.next_step ? blocker : { ...blocker, next_step: nextStep };
}

function sourceAwareSetupMessage(message: string, sourceCli?: string, options: { cwd?: string } = {}): string {
  if (!sourceCli && !options.cwd) return message;
  const setupCommand = formatSetupCommand(sourceCli, options);
  return message
    .replaceAll("`gptprouse setup --token-ttl-hours <hours>`", `\`${setupCommand} --token-ttl-hours <hours>\``)
    .replaceAll("`gptprouse setup`", `\`${setupCommand}\``);
}

function sourceAwareReleaseMessage(message: string, sourceCli?: string, options: { cwd?: string } = {}): string {
  if (!sourceCli && !options.cwd) return message;
  return message
    .replaceAll("`gptprouse release pack --pack-destination <dir>`", `\`${formatReleasePackCommand(sourceCli, options)}\``)
    .replaceAll("`gptprouse release status`", `\`${formatReleaseStatusCommand(sourceCli, options)}\``);
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
    metadataNext = "run `gptprouse release pack --pack-destination <dir>`, then run the printed release_pack_verify dry-run before npm publish";
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
          "fix file modes or publish from a filesystem that preserves executable bits, then run `npm run release:check`; on WSL/Windows mounts, create a sanitized tarball with `gptprouse release pack --pack-destination <dir>` after `npm run release:verify`; release pack prints `npm publish --dry-run <tarball>` and warns that tarball publish bypasses prepublishOnly before printing `npm publish <tarball>`",
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
  io.stdout("gptprouse doctor");

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
  const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-http-doctor-"));
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
    client = new Client({ name: "gptprouse-doctor", version: "0.2.0" });
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
  const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-doctor-"));
  let smokeFailed = false;
  try {
    await writeFile(path.join(cwd, "notes.md"), "old\n", "utf8");
    await execFileAsync("git", ["init"], { cwd });
    await execFileAsync("git", ["config", "user.email", "doctor@example.com"], { cwd });
    await execFileAsync("git", ["config", "user.name", "GPTProUse Doctor"], { cwd });
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
  const runtimeCommandOptions = input.commandOptions?.port ? { port: input.commandOptions.port } : {};
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

function printProBrowserHelp(stdout: (line: string) => void, sourceCli?: string): void {
  const cli = formatCliCommand(sourceCli);
  const sourceCliOption = formatSourceCliOption(sourceCli);
  const loginUsage = sourceCli
    ? `${cli} pro browser login${sourceCliOption} [--dry-run] [--profile-dir path] [--port 9333] [--url https://chatgpt.com/...] [--launch-timeout-ms 5000]`
    : "gptprouse pro browser login [--dry-run] [--source-cli /absolute/path/to/dist/cli.js] [--profile-dir path] [--port 9333] [--url https://chatgpt.com/...] [--launch-timeout-ms 5000]";
  const checkUsage = sourceCli
    ? `${cli} pro browser check${sourceCliOption} [--cwd /absolute/path/to/repo] [--port 9333] [--timeout-ms 1500]`
    : "gptprouse pro browser check [--source-cli /absolute/path/to/dist/cli.js] [--cwd /absolute/path/to/repo] [--port 9333] [--timeout-ms 1500]";
  const smokeUsage = sourceCli
    ? `${cli} pro browser smoke${sourceCliOption} [--port 9333] [--timeout-ms 30000]`
    : "gptprouse pro browser smoke [--source-cli /absolute/path/to/dist/cli.js] [--port 9333] [--timeout-ms 30000]";
  const askUsage = sourceCli
    ? `${cli} pro browser ask${sourceCliOption} [--port 9333] [--timeout-ms 90000] [--target-url url --confirm-target] [--file path] "prompt"`
    : 'gptprouse pro browser ask [--source-cli /absolute/path/to/dist/cli.js] [--port 9333] [--timeout-ms 90000] [--target-url url --confirm-target] [--file path] "prompt"';
  stdout(`${cli} pro browser

Commands:
  ${loginUsage}
  ${checkUsage}
  ${smokeUsage}
  ${askUsage}

Visible-browser sends require a manual browser session and stop on login, captcha, Cloudflare, permission, rate-limit, or usage-limit blockers.
Use \`${cli} pro ask\` for dry-run/manual previews.
\`${cli} pro browser ask${sourceCliOption}\` always attempts an explicit visible-browser send.`);
}

async function assertBrowserLaunchStayedAlive(opened: ChatGptBrowserLaunch, timeoutMs?: number): Promise<void> {
  const outcome = await waitForBrowserLaunchReady(opened, timeoutMs);
  if (outcome.reachable) return;
  if (outcome.earlyExit) {
    const detail = formatBrowserEarlyExit(outcome.earlyExit);
    throw new Error(
      `Chrome/Chromium exited before DevTools became reachable (${detail}). Check the visible browser environment, profile lock, display access, or GPTPROUSE_CHROME, then retry.`
    );
  }
  throw new Error(
    `Chrome/Chromium did not expose a reachable DevTools endpoint after launch. Check the visible browser environment, profile lock, display access, or GPTPROUSE_CHROME, then retry.`
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
  io.stdout("gptprouse product check");
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
    io.stdout(`next: ${browserReadinessNextStep(browserStatus)}`);
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
        io.stdout(`latest_pro: untrusted ${error.taskId} ${errorMessage(error)}`);
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

async function listTasksForInspection(
  store: BridgeStore,
  status?: Parameters<BridgeStore["listTasks"]>[0]
): Promise<Awaited<ReturnType<BridgeStore["listTasks"]>>> {
  return store.listTasksReadOnly(status);
}

async function listResultsForInspection(store: BridgeStore): Promise<Awaited<ReturnType<BridgeStore["listResults"]>>> {
  return store.listFinalizedResultsReadOnly();
}

async function listRawResultsForInspection(store: BridgeStore): Promise<Awaited<ReturnType<BridgeStore["listResults"]>>> {
  return store.listResultsReadOnly();
}

async function listReceiptsForInspection(store: BridgeStore, input: ListReceiptsInput = {}): Promise<Awaited<ReturnType<BridgeStore["listReceipts"]>>> {
  return store.listReceiptsReadOnly(input);
}

async function listSessionsForInspection(
  store: BridgeStore,
  status?: Parameters<BridgeStore["listSessions"]>[0]
): Promise<Awaited<ReturnType<BridgeStore["listSessions"]>>> {
  return store.listSessionsReadOnly(status);
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

async function latestResultTaskId(store: BridgeStore, options: { readOnly?: boolean } = {}): Promise<string> {
  const results = options.readOnly ? await listResultsForInspection(store) : await store.listResults();
  const result = results.at(-1);
  if (!result) throw new Error("No results found");
  return result.task_id;
}

async function latestRawResultTaskId(store: BridgeStore): Promise<string> {
  const result = (await store.listResults()).at(-1);
  if (!result) throw new Error("No results found");
  return result.task_id;
}

async function latestTask(
  store: BridgeStore,
  options: { readOnly?: boolean } = {}
): Promise<Awaited<ReturnType<BridgeStore["listTasks"]>>[number] | undefined> {
  const tasks = options.readOnly ? await listTasksForInspection(store) : await store.listTasks();
  return tasks.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))[0];
}

async function writeTaskCompleteArtifacts(store: BridgeStore, values: string[]): Promise<BridgeFile[]> {
  const artifacts: BridgeFile[] = [];
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator <= 0) {
      throw new Error("tasks complete --artifact requires path=text");
    }
    const artifactPath = value.slice(0, separator);
    const content = value.slice(separator + 1);
    if (!artifactPath.trim()) {
      throw new Error("tasks complete --artifact requires path=text");
    }
    const storedPath = await store.writeArtifactText(artifactPath, content);
    artifacts.push({ path: storedPath, role: "result" });
  }
  return artifacts;
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

function receiptInspectionListSuffix(receipt: Receipt): string {
  const status = receipt.metadata.integrity_status;
  if (
    typeof status === "object" &&
    status !== null &&
    "trusted" in status &&
    (status as { trusted?: unknown }).trusted === false
  ) {
    return "\tintegrity=untrusted";
  }
  return "";
}

function formatSession(session: Awaited<ReturnType<BridgeStore["getSession"]>>): string {
  return JSON.stringify(
    {
      id: session.id,
      status: session.status,
      direction: session.direction,
      backend: session.backend,
      project: session.project,
      thread: session.thread,
      task_id: session.task_id,
      blocker: session.blocker,
      warnings: session.warnings,
      created_at: session.created_at,
      last_used_at: session.last_used_at
    },
    null,
    2
  );
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function isUntrustedResultError(error: unknown): error is Error & { code: "EUNTRUSTED_RESULT"; taskId: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "taskId" in error &&
    (error as { code?: unknown }).code === "EUNTRUSTED_RESULT" &&
    typeof (error as { taskId?: unknown }).taskId === "string"
  );
}

function assertTokenNotExpiredForCommand(config: LocalConfig, sourceCli?: string, setupHintCwd?: string): void {
  const tokenStatus = getTokenExpiryStatus(config);
  if (tokenStatus.status === "expired") {
    throw new Error(sourceAwareSetupMessage(tokenStatus.warning.toLowerCase(), sourceCli, { cwd: setupHintCwd }));
  }
}

async function loadLocalConfigForCommand(cwd: string, command: "start" | "status" | "tunnel url", sourceCli?: string, setupHintCwd?: string) {
  return loadLocalConfig(cwd).catch(async (error) => {
    if (isMissingFileError(error)) {
      throw new Error(
        sourceAwareSetupMessage(
          `${command} requires local MCP setup. Run \`gptprouse setup\` first. Add \`--token-ttl-hours <hours>\` before revealing token URLs, using tunnels, or connecting ChatGPT Projects.`,
          sourceCli,
          { cwd: setupHintCwd }
        )
      );
    }
    throw new Error(sourceAwareSetupMessage(errorMessage(error), sourceCli, { cwd: setupHintCwd }));
  });
}

function redactServerUrl(value: string): string {
  return formatServerUrlForOutput(value, { showToken: false });
}

function formatServerUrlForOutput(value: string, options: { showToken: boolean }): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    if (!options.showToken && url.searchParams.has("gptprouse_token")) url.searchParams.set("gptprouse_token", "***");
    return url.toString();
  } catch {
    const withoutUserinfo = value.replace(/\/\/[^/@\s]+@/g, "//");
    return options.showToken ? withoutUserinfo : withoutUserinfo.replace(/([?&]gptprouse_token=)[^&]+/g, "$1***");
  }
}

function makeTunnelMcpUrl(publicUrl: string, token: string): string {
  const url = parseTunnelPublicUrl(publicUrl);
  url.username = "";
  url.password = "";
  url.pathname = "/mcp";
  url.search = "";
  url.hash = "";
  url.searchParams.set("gptprouse_token", token);
  return url.toString();
}

function parseTunnelPublicUrl(publicUrl: string): URL {
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

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function readFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return readFlagValue(args, index, flag);
}

function readNumberFlag(args: string[], flag: string): number | undefined {
  const raw = readFlag(args, flag);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${flag} requires a finite number`);
  return value;
}

function readPositiveNumberFlag(args: string[], flag: string): number | undefined {
  const value = readNumberFlag(args, flag);
  if (value === undefined) return undefined;
  if (value <= 0) throw new Error(`${flag} must be greater than 0`);
  return value;
}

function readPortFlag(args: string[], flag: string): number | undefined {
  const value = readNumberFlag(args, flag);
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${flag} must be an integer from 1 to 65535`);
  }
  return value;
}

function readChatGptBrowserUrlFlag(args: string[]): string {
  return normalizeChatGptTargetUrl(readFlag(args, "--url") ?? "https://chatgpt.com/");
}

function readRepeatedFlag(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) {
      values.push(readFlagValue(args, index, flag));
      index += 1;
    }
  }
  return values;
}

function resolveCwdFlag(defaultCwd: string, args: string[]): string {
  const cwd = readFlag(args, "--cwd");
  if (!cwd) return defaultCwd;
  return resolveExistingDirectoryFlag(defaultCwd, cwd, "--cwd");
}

function resolveOptionalPathFlag(defaultCwd: string, args: string[], flag: string): string | undefined {
  const value = readFlag(args, flag);
  return value ? resolveExistingPathFlag(defaultCwd, value, flag) : undefined;
}

function resolveOptionalFileFlag(defaultCwd: string, args: string[], flag: string): string | undefined {
  const value = readFlag(args, flag);
  return value ? resolveExistingFileFlag(defaultCwd, value, flag) : undefined;
}

function resolveExistingPathFlag(defaultCwd: string, value: string, flag: string): string {
  const resolved = path.resolve(defaultCwd, value);
  try {
    return realpathSync(resolved);
  } catch {
    throw new Error(`${flag} does not exist or is not accessible: ${resolved}`);
  }
}

function resolveExistingFileFlag(defaultCwd: string, value: string, flag: string): string {
  const resolved = resolveExistingPathFlag(defaultCwd, value, flag);
  if (!statSync(resolved).isFile()) {
    throw new Error(`${flag} must be a file: ${resolved}`);
  }
  return resolved;
}

function resolveExistingDirectoryFlag(defaultCwd: string, value: string, flag: string): string {
  const resolved = resolveExistingPathFlag(defaultCwd, value, flag);
  if (!statSync(resolved).isDirectory()) {
    throw new Error(`${flag} must be a directory: ${resolved}`);
  }
  return resolved;
}

function assertOnlyOptions(args: string[], command: string, valueFlags: readonly string[], booleanFlags: readonly string[] = []): void {
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

function readPositionalsWithOptions(
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

function assertNoExtraArgs(args: string[], command: string, maxPositionals: number): void {
  for (const arg of args.slice(maxPositionals)) {
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option for ${command}: ${arg}`);
    }
    throw new Error(`Unexpected argument for ${command}: ${arg}`);
  }
}

function readRequiredLeadingArgument(args: string[], command: string, placeholder: string): string {
  const value = args[0];
  if (!value || value.startsWith("-")) throw new Error(`${command} requires ${placeholder}`);
  return value;
}

const ASK_PRO_BOOLEAN_FLAGS = new Set(["--dry-run", "--send", "--confirm-target"]);
const ASK_PRO_VALUE_FLAGS = new Set(["--file", "--port", "--timeout-ms", "--target-url", "--source-cli"]);
const ASK_PRO_PREVIEW_VALUE_FLAGS = new Set(["--file", "--port", "--timeout-ms", "--target-url"]);

function parseAskProArgs(args: string[], valueFlags = ASK_PRO_VALUE_FLAGS): { optionArgs: string[]; promptParts: string[] } {
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

function askProOptionArgs(args: string[]): string[] {
  const delimiterIndex = args.indexOf("--");
  return delimiterIndex === -1 ? args : args.slice(0, delimiterIndex);
}

function hasAskProMode(args: string[]): boolean {
  const optionArgs = askProOptionArgs(args);
  return optionArgs.includes("--send") || optionArgs.includes("--dry-run");
}

function hasAskProSendMode(args: string[]): boolean {
  return askProOptionArgs(args).includes("--send");
}

function hasAskProDryRunMode(args: string[]): boolean {
  return askProOptionArgs(args).includes("--dry-run");
}

function readFlagValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function readSessionStatusFlag(args: string[]): Parameters<BridgeStore["listSessions"]>[0] {
  const value = readFlag(args, "--status");
  if (value === undefined) return undefined;
  if (value === "preview" || value === "running" || value === "done" || value === "blocked") return value;
  throw new Error("--status must be one of preview, running, done, blocked");
}

const TASK_STATUSES = TaskStatusSchema.options satisfies readonly NonNullable<Parameters<BridgeStore["listTasks"]>[0]>[];

function readTaskStatusFlag(args: string[]): Parameters<BridgeStore["listTasks"]>[0] {
  const value = readFlag(args, "--status");
  if (value === undefined) return undefined;
  if (TaskStatusSchema.safeParse(value).success) return value as Parameters<BridgeStore["listTasks"]>[0];
  throw new Error(`--status must be one of ${TASK_STATUSES.join(", ")}`);
}

const RECEIPT_KINDS = ReceiptKindSchema.options satisfies readonly NonNullable<ListReceiptsInput["kind"]>[];

function readReceiptKindFlag(args: string[]): ListReceiptsInput["kind"] {
  const value = readFlag(args, "--kind");
  if (value === undefined) return undefined;
  if (ReceiptKindSchema.safeParse(value).success) return value as ListReceiptsInput["kind"];
  throw new Error(`--kind must be one of ${RECEIPT_KINDS.join(", ")}`);
}

function formatTokenExpiryLine(config: { token_expires_at?: string }): string {
  const tokenStatus = getTokenExpiryStatus(config);
  if (tokenStatus.status === "valid") return `Token expires: ${tokenStatus.token_expires_at}`;
  if (tokenStatus.status === "expired") return `Token expired: ${tokenStatus.token_expires_at}`;
  return "Token expires: never (local-only; use --token-ttl-hours before exposing through a tunnel).";
}

function formatConfigWarningLine(tokenStatus: { warning?: string }, sourceCli?: string, setupHintCwd?: string): string | undefined {
  return tokenStatus.warning ? `config_warning: ${sourceAwareSetupMessage(tokenStatus.warning, sourceCli, { cwd: setupHintCwd })}` : undefined;
}

async function ensureBridgeGitignore(cwd: string): Promise<void> {
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

async function assertGitignoreTargetSafe(filePath: string): Promise<void> {
  try {
    const stat = await lstat(filePath);
    if (stat.isSymbolicLink()) throw new Error(`${filePath} must not be a symlink`);
    if (!stat.isFile()) throw new Error(`${filePath} must be a regular file`);
  } catch (error) {
    if (isMissingFileError(error)) return;
    throw error;
  }
}

async function waitForShutdown(close: () => Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => {
    const shutdown = () => resolve();
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
  await close();
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
