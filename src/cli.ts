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
import { assertTokenNotExpired, getTokenExpiryStatus, loadLocalConfig, writeLocalConfig } from "./config.js";
import { startHttpMcpServer } from "./http-mcp.js";
import { createMcpToolHandlers } from "./mcp-tools.js";
import { runMcpServer } from "./mcp.js";
import { readVerifiedUtf8File, writeVerifiedUtf8File } from "./safe-file.js";
import { ReceiptKindSchema, TaskStatusSchema, type Receipt } from "./schema.js";
import { BridgeStore, MAX_FETCHABLE_RESULT_ARTIFACT_BYTES, type ListReceiptsInput } from "./store.js";

const execFileAsync = promisify(execFile);
const requirePackageJson = createRequire(import.meta.url);
const packageJson = requirePackageJson("../package.json") as { version?: string };
const CLI_VERSION = packageJson.version ?? "0.0.0";
const RESERVED_PACKAGE_NAMES = new Set(["node_modules", "favicon.ico"]);
const PRO_BROWSER_SMOKE_TOKEN = "GPTPROUSE_PRO_SMOKE_OK";

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
    assertOnlyOptions(rest, "init", ["--cwd"]);
    const targetCwd = resolveCwdFlag(io.cwd, rest);
    const targetStore = new BridgeStore(targetCwd);
    await targetStore.ensure();
    await ensureBridgeGitignore(targetCwd);
    io.stdout("Initialized .bridge receipt ledger.");
    return 0;
  }

  if (command === "setup") {
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
    assertOnlyOptions(rest, "start", ["--cwd"]);
    const targetCwd = resolveCwdFlag(io.cwd, rest);
    const config = await loadLocalConfigForCommand(targetCwd, "start");
    assertTokenNotExpired(config);
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
    assertOnlyOptions(rest, "status", ["--cwd"], ["--show-token", "--url-only", "--unsafe-show-non-expiring-token"]);
    const targetCwd = resolveCwdFlag(io.cwd, rest);
    const config = await loadLocalConfigForCommand(targetCwd, "status");
    const showToken = rest.includes("--show-token");
    const allowNonExpiringTokenReveal = rest.includes("--unsafe-show-non-expiring-token");
    const tokenStatus = getTokenExpiryStatus(config);
    if (showToken && tokenStatus.status === "non_expiring" && !allowNonExpiringTokenReveal) {
      throw new Error(
        "status --show-token requires a token with expiry. Run `gptprouse setup --token-ttl-hours <hours>` first, or pass --unsafe-show-non-expiring-token for local-only debugging."
      );
    }
    if (showToken && tokenStatus.status === "expired") {
      throw new Error(`token expired at ${tokenStatus.token_expires_at}. Run \`gptprouse setup --token-ttl-hours <hours>\`.`);
    }
    const serverUrl = formatServerUrlForOutput(config.server_url, { showToken });
    if (rest.includes("--url-only")) {
      io.stdout(serverUrl);
      return 0;
    }
    const warnings = tokenStatus.warning ? [tokenStatus.warning] : [];
    if (showToken && allowNonExpiringTokenReveal && tokenStatus.status === "non_expiring") {
      warnings.push(
        "Showing a non-expiring token. Keep this local-only and rotate it with `gptprouse setup --token-ttl-hours <hours>` before any tunnel or ChatGPT Project use."
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
    if (subcommand !== "url") throw new Error("tunnel requires url");
    assertOnlyOptions(tunnelArgs, "tunnel url", ["--cwd", "--public-url"], ["--show-token", "--url-only"]);
    const targetCwd = resolveCwdFlag(io.cwd, tunnelArgs);
    const config = await loadLocalConfigForCommand(targetCwd, "tunnel url");
    const tokenStatus = getTokenExpiryStatus(config);
    if (tokenStatus.status === "non_expiring") {
      throw new Error("tunnel url requires a short-lived token. Run `gptprouse setup --token-ttl-hours <hours>` first.");
    }
    if (tokenStatus.status === "expired") {
      throw new Error(`token expired at ${tokenStatus.token_expires_at}. Run \`gptprouse setup --token-ttl-hours <hours>\`.`);
    }
    const publicUrl = readFlag(tunnelArgs, "--public-url");
    if (!publicUrl) throw new Error("tunnel url requires --public-url <https-url>");
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
    assertOnlyOptions(rest, "doctor", ["--cwd"]);
    const targetCwd = resolveCwdFlag(io.cwd, rest);
    return runDoctor(new BridgeStore(targetCwd), { ...io, cwd: targetCwd });
  }

  if (command === "release") {
    const [subcommand, ...releaseArgs] = rest;
    if (subcommand !== "status") throw new Error("release requires status");
    assertOnlyOptions(releaseArgs, "release status", ["--cwd"]);
    const targetCwd = resolveCwdFlag(io.cwd, releaseArgs);
    io.stdout(await formatReleaseStatus(targetCwd));
    return 0;
  }

  if (command === "onboard") {
    assertOnlyOptions(rest, "onboard", ["--cwd"]);
    const targetCwd = resolveCwdFlag(io.cwd, rest);
    io.stdout(formatOnboardingGuide(targetCwd, await hasOnboardingReadme(targetCwd)));
    return 0;
  }

  if (command === "project") {
    const [subcommand, ...projectArgs] = rest;
    if (subcommand !== "prompt") throw new Error("project requires prompt");
    assertOnlyOptions(projectArgs, "project prompt", ["--cwd"]);
    io.stdout(formatProjectVerificationPrompt(resolveCwdFlag(io.cwd, projectArgs)));
    return 0;
  }

  if (command === "claude") {
    const [subcommand, ...claudeArgs] = rest;
    if (subcommand === "prompt") {
      assertOnlyOptions(claudeArgs, "claude prompt", ["--cwd"]);
      io.stdout(formatClaudeVerificationPrompt(resolveCwdFlag(io.cwd, claudeArgs)));
      return 0;
    }
    if (subcommand === "config") {
      assertOnlyOptions(claudeArgs, "claude config", ["--cwd", "--source-cli"]);
      io.stdout(formatClaudeConfig(resolveCwdFlag(io.cwd, claudeArgs), resolveOptionalFileFlag(io.cwd, claudeArgs, "--source-cli")));
      return 0;
    }
    throw new Error("claude requires prompt or config");
  }

  if (command === "chatgpt") {
    const [subcommand, ...chatgptArgs] = rest;
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
      assertOnlyOptions(chatgptArgs, "chatgpt smoke", ["--port", "--timeout-ms"]);
      const result = await sendChatGptPrompt({
        port: readPortFlag(chatgptArgs, "--port") ?? 9333,
        prompt: `This is a one-time gptprouse smoke test. Reply exactly: ${PRO_BROWSER_SMOKE_TOKEN}`,
        timeoutMs: readPositiveNumberFlag(chatgptArgs, "--timeout-ms") ?? 90000
      });
      if (result.answer.trim() !== PRO_BROWSER_SMOKE_TOKEN) {
        throw new Error(`Pro browser smoke returned an unexpected answer. Expected exactly ${PRO_BROWSER_SMOKE_TOKEN}.`);
      }
      io.stdout(JSON.stringify(result, null, 2));
      return 0;
    }
  }

  if (command === "tasks") {
    const [subcommand, ...taskArgs] = rest;
    if (subcommand === "create") {
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
      assertOnlyOptions(taskArgs, "tasks list", ["--status"]);
      const status = readTaskStatusFlag(taskArgs);
      const tasks = await listTasksForInspection(store, status);
      for (const task of tasks) {
        io.stdout(`${task.id}\t${task.status}\t${task.title}`);
      }
      return 0;
    }
    if (subcommand === "show") {
      const taskId = taskArgs[0];
      if (!taskId) throw new Error("tasks show requires <task-id|latest>");
      assertNoExtraArgs(taskArgs, "tasks show", 1);
      const task = taskId === "latest" ? await latestTask(store, { readOnly: true }) : await store.getTaskReadOnly(taskId);
      if (!task) throw new Error(taskId === "latest" ? "No tasks found" : `Task not found: ${taskId}`);
      io.stdout(JSON.stringify(task, null, 2));
      return 0;
    }
    if (subcommand === "claim") {
      const taskId = readRequiredLeadingArgument(taskArgs, "tasks claim", "<task-id>");
      assertOnlyOptions(taskArgs.slice(1), "tasks claim", ["--by"]);
      const task = await store.claimTask(taskId, readFlag(taskArgs, "--by") ?? "codex");
      io.stdout(`${task.id}\t${task.status}\t${task.claimed_by ?? ""}`);
      return 0;
    }
    if (subcommand === "complete") {
      const taskId = readRequiredLeadingArgument(taskArgs, "tasks complete", "<task-id>");
      assertOnlyOptions(taskArgs.slice(1), "tasks complete", ["--summary", "--command"]);
      const summary = readFlag(taskArgs, "--summary");
      if (!summary) throw new Error("tasks complete requires <task-id> --summary");
      const result = await store.completeTask(taskId, {
        status: "done",
        summary,
        commands: readRepeatedFlag(taskArgs, "--command")
      });
      io.stdout(`${result.task_id}\t${result.status}\t${result.summary}`);
      return 0;
    }
    if (subcommand === "block") {
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
  }

  if (command === "results") {
    const [subcommand, ...resultArgs] = rest;
    if (subcommand === "show") {
      const taskId = resultArgs[0];
      if (!taskId) throw new Error("results show requires <task-id|latest>");
      assertNoExtraArgs(resultArgs, "results show", 1);
      const resolvedTaskId = taskId === "latest" ? await latestResultTaskId(store, { readOnly: true }) : taskId;
      io.stdout(JSON.stringify(await store.getResultReadOnly(resolvedTaskId), null, 2));
      return 0;
    }
    if (subcommand === "artifact") {
      const taskId = resultArgs[0];
      if (!taskId) throw new Error("results artifact requires <task-id> [artifact-path]");
      assertNoExtraArgs(resultArgs, "results artifact", 2);
      const resolvedTaskId = taskId === "latest" ? await latestResultTaskId(store, { readOnly: true }) : taskId;
      const artifact = await store.readResultArtifactText(resolvedTaskId, resultArgs[1], { readOnly: true });
      io.stdout(artifact.content);
      return 0;
    }
  }

  if (command === "receipts") {
    const [subcommand, ...receiptArgs] = rest;
    if (subcommand === "list") {
      assertOnlyOptions(receiptArgs, "receipts list", ["--kind", "--task-id"]);
      const receipts = await listReceiptsForInspection(store, {
        kind: readReceiptKindFlag(receiptArgs),
        task_id: readFlag(receiptArgs, "--task-id")
      });
      for (const receipt of receipts) {
        io.stdout(`${receipt.id}\t${receipt.kind}\t${receipt.summary}${receiptInspectionListSuffix(receipt)}`);
      }
      return 0;
    }
    if (subcommand === "show") {
      const receiptId = receiptArgs[0];
      if (!receiptId) throw new Error("receipts show requires <receipt-id|latest>");
      assertNoExtraArgs(receiptArgs, "receipts show", 1);
      const receipt = receiptId === "latest" ? (await listReceiptsForInspection(store))[0] : await store.getReceiptForDisplayReadOnly(receiptId);
      if (!receipt) throw new Error(receiptId === "latest" ? "No receipts found" : `Receipt not found: ${receiptId}`);
      io.stdout(JSON.stringify(receipt, null, 2));
      return 0;
    }
  }

  if (command === "sessions") {
    const [subcommand, ...sessionArgs] = rest;
    if (subcommand === "list") {
      assertOnlyOptions(sessionArgs, "sessions list", ["--status"]);
      const status = readSessionStatusFlag(sessionArgs);
      const sessions = await listSessionsForInspection(store, status);
      for (const session of sessions) {
        io.stdout(`${session.id}\t${session.status}\t${session.backend}\t${session.direction}`);
      }
      return 0;
    }
    if (subcommand === "show") {
      const sessionId = sessionArgs[0];
      if (!sessionId) throw new Error("sessions show requires <session-id|latest>");
      assertNoExtraArgs(sessionArgs, "sessions show", 1);
      const session = sessionId === "latest" ? (await listSessionsForInspection(store))[0] : await store.getSessionReadOnly(sessionId);
      if (!session) throw new Error(sessionId === "latest" ? "No sessions found" : `Session not found: ${sessionId}`);
      io.stdout(formatSession(session));
      return 0;
    }
  }

  if (command === "pro") {
    const [subcommand, ...proArgs] = rest;
    if (subcommand === "ask") {
      if (hasAskProSendMode(proArgs)) {
        throw new Error("gptprouse pro ask is a dry-run preview. Use `gptprouse pro browser ask` for visible-browser sends.");
      }
      const hasDryRun = hasAskProDryRunMode(proArgs);
      return runCli(["ask-pro", ...(hasDryRun ? [] : ["--dry-run"]), ...proArgs], io);
    }
    if (subcommand === "browser") {
      const [browserSubcommand, ...browserArgs] = proArgs;
      if (!browserSubcommand || browserSubcommand === "help" || browserSubcommand === "--help" || browserSubcommand === "-h") {
        assertNoExtraArgs(browserArgs, "pro browser help", 0);
        printProBrowserHelp(io.stdout);
        return 0;
      }
      if (browserSubcommand === "login") {
        assertOnlyOptions(browserArgs, "pro browser login", ["--profile-dir", "--port", "--url"], ["--dry-run"]);
        const loginUrl = readChatGptBrowserUrlFlag(browserArgs);
        if (browserArgs.includes("--dry-run")) {
          printBrowserLoginGuide(io.stdout, {
            opened: false,
            profileDir: readFlag(browserArgs, "--profile-dir") ?? defaultChatGptProfileDir(),
            port: readPortFlag(browserArgs, "--port") ?? 9333
          });
          return 0;
        }
        const opened = openChatGptBrowser({
          port: readPortFlag(browserArgs, "--port") ?? 9333,
          profileDir: readFlag(browserArgs, "--profile-dir"),
          url: loginUrl
        });
        await assertBrowserLaunchStayedAlive(opened);
        printBrowserLoginGuide(io.stdout, {
          opened: true,
          profileDir: opened.profileDir,
          port: opened.port
        });
        return 0;
      }
      if (browserSubcommand === "ask") {
        const hasMode = hasAskProMode(browserArgs);
        return runCli(["ask-pro", ...(hasMode ? [] : ["--send"]), ...browserArgs], { ...io, allowAskProBrowserSend: true });
      }
      if (browserSubcommand === "open" || browserSubcommand === "status" || browserSubcommand === "doctor") {
        const replacement = browserSubcommand === "open" ? "login" : "check";
        throw new Error(`Use \`gptprouse pro browser ${replacement}\` for explicit browser automation.`);
      }
      if (browserSubcommand === "smoke") {
        return runCli(["chatgpt", browserSubcommand, ...browserArgs], io);
      }
      if (browserSubcommand === "check") {
        assertOnlyOptions(browserArgs, "pro browser check", ["--port", "--timeout-ms"]);
        readPortFlag(browserArgs, "--port");
        readPositiveNumberFlag(browserArgs, "--timeout-ms");
        await printProductCheck(store, io, browserArgs);
        return 0;
      }
      throw new Error("pro browser requires login|ask|smoke|check");
    }
    if (subcommand === "open" || subcommand === "status" || subcommand === "smoke" || subcommand === "check" || subcommand === "doctor") {
      throw new Error(`Use \`gptprouse pro browser ${subcommand === "doctor" ? "check" : subcommand}\` for explicit browser automation.`);
    }
    if (subcommand === "list") {
      assertNoExtraArgs(proArgs, "pro list", 0);
      const consults = await listConsults(store, { readOnly: true });
      for (const consult of consults) {
        io.stdout(`${consult.task.id}\t${consult.result.status}\t${firstLine(consult.result.summary)}`);
      }
      return 0;
    }
    if (subcommand === "latest") {
      assertNoExtraArgs(proArgs, "pro latest", 0);
      const consult = (await listConsults(store, { readOnly: true }))[0];
      if (!consult) throw new Error("No GPT Pro answers found");
      io.stdout(formatProAnswer(consult));
      return 0;
    }
    if (subcommand === "show") {
      const taskId = proArgs[0];
      if (!taskId) throw new Error("pro show requires <task-id|latest>");
      assertNoExtraArgs(proArgs, "pro show", 1);
      const consult = taskId === "latest" ? (await listConsults(store, { readOnly: true }))[0] : await getConsult(store, taskId, { readOnly: true });
      if (!consult) throw new Error(taskId === "latest" ? "No GPT Pro answers found" : `GPT Pro answer not found: ${taskId}`);
      io.stdout(formatProAnswer(consult));
      return 0;
    }
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
    if (normalizedTargetUrl && hasSendMode && !parsedAskPro.optionArgs.includes("--confirm-target")) {
      throw new Error("--target-url requires --confirm-target after you manually verify the visible ChatGPT tab is the intended Project/thread.");
    }
    const prompt = parsedAskPro.promptParts.join(" ").trim();
    if (!prompt) throw new Error("ask-pro requires a prompt");
    const browserPort = hasSendMode ? (readPortFlag(parsedAskPro.optionArgs, "--port") ?? 9333) : undefined;
    const browserTimeoutMs = hasSendMode ? (readPositiveNumberFlag(parsedAskPro.optionArgs, "--timeout-ms") ?? 90000) : undefined;
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
      await writeSessionBestEffort(
        store,
        {
          id: bundle.id,
          direction: "codex_to_chatgpt",
          backend: "chatgpt-control",
          task_id: task.id,
          thread: normalizedTargetUrl,
          status: "running",
          warnings: []
        },
        io
      );
      let consult: Awaited<ReturnType<typeof sendChatGptPrompt>>;
      try {
        consult = await sendChatGptPrompt({
          port: browserPort,
          prompt: bundle.text,
          targetUrl: normalizedTargetUrl,
          timeoutMs: browserTimeoutMs
        });
      } catch (error) {
        const message = errorMessage(error);
        const blocker = browserSendBlockerFromError(error);
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
        throw error;
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
    assertOnlyOptions(rest, "mcp", ["--cwd"]);
    await runMcpServer(resolveCwdFlag(io.cwd, rest));
    return 0;
  }

  throw new Error(`Unknown command: ${command}`);
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
  gptprouse doctor [--cwd /absolute/path/to/repo]
  gptprouse setup [--cwd /absolute/path/to/repo] [--host 127.0.0.1] [--port 8787] [--token-ttl-hours <hours>]
  gptprouse start [--cwd /absolute/path/to/repo]
  gptprouse status [--cwd /absolute/path/to/repo] [--show-token] [--url-only] [--unsafe-show-non-expiring-token]
  gptprouse tunnel url [--cwd /absolute/path/to/repo] --public-url https://... [--show-token] [--url-only]
  gptprouse release status [--cwd /absolute/path/to/repo]
  gptprouse onboard [--cwd /absolute/path/to/repo]
  gptprouse project prompt [--cwd /absolute/path/to/repo]
  gptprouse claude prompt [--cwd /absolute/path/to/repo]
  gptprouse claude config [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js]
  gptprouse pro ask [--dry-run] [--file path] "prompt"  # dry-run preview
  gptprouse pro browser login [--dry-run]  # preview/open visible browser login
  gptprouse pro browser help
  gptprouse pro browser check|smoke
  gptprouse pro browser ask [--target-url url --confirm-target] [--file path] "prompt"  # explicit visible-browser send
  gptprouse pro latest
  gptprouse pro list
  gptprouse pro show <task-id|latest>
  gptprouse tasks create --title "Title" --prompt "Prompt"
  gptprouse tasks list [--status new|claimed|done|blocked]
  gptprouse tasks show <task-id|latest>
  gptprouse tasks claim <task-id> [--by codex]
  gptprouse tasks complete <task-id> --summary "Summary" [--command "npm test"]
  gptprouse tasks block <task-id> --summary "Summary" [--code code] [--next-step "Next step"] [--retryable]
  gptprouse results show <task-id|latest>
  gptprouse results artifact <task-id|latest> [artifact-path]
  gptprouse receipts list [--kind kind] [--task-id task-id]
  gptprouse receipts show <receipt-id|latest>
  gptprouse sessions list [--status preview|running|done|blocked]
  gptprouse sessions show <session-id|latest>
  gptprouse mcp [--cwd /absolute/path/to/repo]`);
}

function formatProjectVerificationPrompt(cwd: string): string {
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

4. Reply with the task_id and whether all three MCP calls succeeded. Do not call repo_write_file_dry_run, repo_write_file_apply, repo_stage_reviewed_paths, or any write/stage tool for this verification.

Local follow-up after ChatGPT replies:

cd ${shellQuote(cwd)}
gptprouse tasks list --status new
gptprouse tasks show <task-id>`;
}

function formatOnboardingGuide(cwd: string, hasReadme: boolean): string {
  const quotedCwd = shellQuote(cwd);
  const proAskCommand = hasReadme ? 'gptprouse pro ask --file README.md "Review this repo"' : 'gptprouse pro ask "Review this repo"';
  const proBrowserAskCommand = hasReadme
    ? 'gptprouse pro browser ask --file README.md "Review this repo"'
    : 'gptprouse pro browser ask "Review this repo"';
  return `gptprouse onboarding

repo: ${cwd}

1. Prepare the local bridge:
   gptprouse init --cwd ${quotedCwd}
   gptprouse doctor --cwd ${quotedCwd}

2. Claude stdio MCP:
   gptprouse claude config --cwd ${quotedCwd}
   gptprouse claude prompt --cwd ${quotedCwd}

3. ChatGPT Project HTTP MCP:
   Note: HTTP MCP uses a short-lived token. Paste token-bearing URLs only into your own trusted private MCP client.
   gptprouse setup --cwd ${quotedCwd} --token-ttl-hours 24
   gptprouse start --cwd ${quotedCwd}
   Keep this terminal open while ChatGPT uses the bridge; run the next commands in a second terminal.
   gptprouse status --cwd ${quotedCwd} --show-token --url-only
   gptprouse project prompt --cwd ${quotedCwd}

4. Optional ChatGPT Pro consults:
   cd ${quotedCwd}
   ${proAskCommand}  # dry-run/manual preview
   gptprouse pro browser login --dry-run  # preview, no browser opens
   gptprouse pro browser login  # opens visible browser
   gptprouse pro browser help
   gptprouse pro browser check
   gptprouse pro browser smoke
   ${proBrowserAskCommand}  # visible-browser send

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

function formatClaudeVerificationPrompt(cwd: string): string {
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

4. Reply with the task_id and whether all three MCP calls succeeded. Do not call repo_write_file_dry_run, repo_write_file_apply, repo_stage_reviewed_paths, or any write/stage tool for this verification.

Local follow-up after Claude replies:

cd ${shellQuote(cwd)}
gptprouse tasks list --status new
gptprouse tasks show <task-id>`;
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

async function formatReleaseStatus(cwd: string): Promise<string> {
  const packageJsonPath = path.join(cwd, "package.json");
  const raw = await readReleasePackageJson(packageJsonPath).catch(async (error) => {
    if (!isMissingFileError(error)) throw error;
    return undefined;
  });
  if (raw === undefined) {
    const lines = ["gptprouse release status", "package: <missing package.json>"];
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
    const lines = ["gptprouse release status", "package: <invalid package.json>"];
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
  const lines = ["gptprouse release status", `package: ${name}@${version}`];
  const license = typeof packageJson.license === "string" ? packageJson.license.trim() : "";
  const identityError = packageIdentityError(packageJson);
  let metadataNext = "run `npm run release:check` before publishing";
  let metadataReady = false;
  let packCheckEligible = false;

  if (identityError) {
    lines.push(`metadata: blocked ${identityError.message}`);
    metadataNext = identityError.next;
  } else if (packageJson.private === true) {
    lines.push("metadata: blocked package.json private: true prevents npm publish");
    metadataNext = "remove `private: true` before public publishing, then run `npm run release:check`";
  } else {
    packCheckEligible = true;
    if (!license) {
      lines.push("metadata: blocked package.json must include an explicit license before publishing");
      metadataNext = "choose a license, add LICENSE, then run `npm run release:check`";
    } else if (license === "UNLICENSED") {
      lines.push('metadata: blocked license "UNLICENSED" is not publishable');
      metadataNext = "choose a public license and add LICENSE, then run `npm run release:check`";
    } else {
      const licenseFile = await readLicenseFileStatus(path.join(cwd, "LICENSE"));
      if (licenseFile.status === "missing") {
        lines.push(`metadata: blocked license=${license} license_file=missing`);
        metadataNext = "add LICENSE, then run `npm run release:check`";
      } else if (licenseFile.status === "invalid") {
        lines.push(`metadata: blocked license=${license} license_file=invalid - LICENSE must be a regular file and must not be a symlink`);
        metadataNext = "replace LICENSE with a regular file, then run `npm run release:check`";
      } else if (licenseFile.status === "hardlinked") {
        lines.push(`metadata: blocked license=${license} license_file=invalid - LICENSE must not have hard links`);
        metadataNext = "replace LICENSE with a non-hard-linked regular file, then run `npm run release:check`";
      } else {
        lines.push(`metadata: ok license=${license} license_file=present`);
        metadataReady = true;
      }
    }
  }
  if (packCheckEligible) {
    const packStatus = await readReleasePackStatus(cwd, packageJson);
    lines.push(packStatus.line);
    if (packStatus.next) {
      if (metadataReady) {
        metadataNext = packStatus.next;
      } else {
        lines.push(`pack_next: ${packStatus.next}`);
      }
    }
  }
  const gitStatus = await readReleaseGitStatus(cwd);
  lines.push(gitStatus.line);
  if (gitStatus.next) lines.push(`git_next: ${gitStatus.next}`);
  lines.push(`next: ${metadataNext}`);
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

async function readReleasePackStatus(cwd: string, packageJson: { bin?: unknown }): Promise<ReleasePackStatus> {
  try {
    const { stdout } = await execFileAsync(commandForPlatform("npm"), ["pack", "--json", "--dry-run", "--ignore-scripts"], {
      cwd,
      timeout: 120_000,
      maxBuffer: 20 * 1024 * 1024
    });
    const files = parsePackedFiles(stdout);
    const invalid = findExecutableNonBinPackedFiles(files, packageJson);
    if (invalid.length > 0) {
      return {
        line: `pack: blocked packed files have unexpected executable modes outside package bin entries: ${formatPathList(invalid)}`,
        next:
          "fix file modes or publish from a filesystem that preserves executable bits, then run `npm run release:check`; on WSL/Windows mounts, create a sanitized tarball with `npm run release:pack -- --pack-destination <dir>` after `npm run release:verify`"
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
  const entries = JSON.parse(stdout) as Array<{ files?: unknown }>;
  const files = entries?.[0]?.files;
  if (!Array.isArray(files)) return [];
  return files.filter(isPackedFile);
}

function isPackedFile(value: unknown): value is PackedFile {
  return (
    typeof value === "object" &&
    value !== null &&
    "path" in value &&
    "mode" in value &&
    typeof value.path === "string" &&
    typeof value.mode === "number"
  );
}

function findExecutableNonBinPackedFiles(files: PackedFile[], packageJson: { bin?: unknown }): string[] {
  const binPaths = packageBinPaths(packageJson.bin);
  return files
    .filter((file) => (file.mode & 0o111) !== 0)
    .map((file) => normalizePackagePath(file.path))
    .filter((filePath) => !binPaths.has(filePath));
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

function commandForPlatform(command: string): string {
  return process.platform === "win32" && command === "npm" ? "npm.cmd" : command;
}

function firstErrorLine(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "stderr" in error &&
    typeof (error as { stderr?: unknown }).stderr === "string" &&
    (error as { stderr: string }).stderr.trim()
  ) {
    return (error as { stderr: string }).stderr.trim().split(/\r?\n/)[0];
  }
  return errorMessage(error).split(/\r?\n/)[0];
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
      next: "add a git remote before public release"
    };
  }

  if (!upstream) {
    return {
      line: `git: blocked no upstream configured ${gitContext} remote=${remoteText}`,
      next: "push the branch with upstream tracking before public release"
    };
  }

  const relation = parseGitBranchRelation(branchStatusOutput);
  if (relation.gone) {
    return {
      line: `git: blocked upstream is gone ${gitContext} remote=${remoteText} upstream=${upstream}`,
      next: "restore upstream tracking before public release"
    };
  }
  if (relation.ahead > 0 && relation.behind > 0) {
    return {
      line: `git: blocked branch diverged ahead=${relation.ahead} behind=${relation.behind} ${gitContext} remote=${remoteText} upstream=${upstream}`,
      next: "sync the branch with upstream before public release"
    };
  }
  if (relation.ahead > 0) {
    return {
      line: `git: blocked branch has unpushed commits ahead=${relation.ahead} ${gitContext} remote=${remoteText} upstream=${upstream}`,
      next: "push local commits before public release"
    };
  }
  if (relation.behind > 0) {
    return {
      line: `git: blocked branch is behind upstream behind=${relation.behind} ${gitContext} remote=${remoteText} upstream=${upstream}`,
      next: "sync the branch with upstream before public release"
    };
  }

  return {
    line: `git: ok ${gitContext} remote=${remoteText} upstream=${upstream}`
  };
}

function parseGitBranchRelation(statusOutput: string): { ahead: number; behind: number; gone: boolean } {
  const branchLine = statusOutput.split(/\r?\n/).find((line) => line.startsWith("## ")) ?? "";
  const relationText = /\[([^\]]+)\]/.exec(branchLine)?.[1] ?? "";
  const ahead = Number(/\bahead (\d+)\b/.exec(relationText)?.[1] ?? 0);
  const behind = Number(/\bbehind (\d+)\b/.exec(relationText)?.[1] ?? 0);
  return { ahead, behind, gone: /\bgone\b/.test(relationText) };
}

async function gitStdout(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

async function readLicenseFileStatus(filePath: string): Promise<{ status: "present" | "missing" | "invalid" | "hardlinked" }> {
  try {
    const stat = await lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) return { status: "invalid" };
    if (stat.nlink > 1) return { status: "hardlinked" };
    return { status: "present" };
  } catch (error) {
    if (isMissingFileError(error)) return { status: "missing" };
    throw error;
  }
}

async function runDoctor(store: BridgeStore, io: CliIO): Promise<number> {
  let ok = true;
  io.stdout("gptprouse doctor");

  try {
    const bridgeReady = await store.hasReadyBridgeStorageReadOnly();
    io.stdout(
      bridgeReady
        ? "bridge: ok (.bridge)"
        : "bridge: missing/incomplete (.bridge) - run `gptprouse init` when you need local task/result storage"
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
      io.stdout(`config: failed token expired at ${tokenStatus.token_expires_at} - run \`gptprouse setup\``);
    } else {
      io.stdout(`config: ok ${redactServerUrl(config.server_url)} token_status=${tokenStatus.status}`);
    }
  } catch (error) {
    if (isMissingFileError(error)) {
      io.stdout("config: missing - run `gptprouse setup`");
    } else {
      ok = false;
      io.stdout(`config: failed ${errorMessage(error)}`);
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
  input: { opened: boolean; profileDir: string; port: number }
): void {
  stdout("ChatGPT Pro browser login");
  stdout(input.opened ? "Opened the dedicated Chrome window for ChatGPT." : "Dry run: no browser was opened.");
  stdout("");
  stdout("Steps:");
  if (input.opened) {
    stdout("1. Log in manually at https://chatgpt.com/ in the dedicated Chrome window.");
    stdout("2. If ChatGPT asks for captcha, Cloudflare/human verification, permission, account verification, or usage limit handling, complete it in the browser.");
    stdout("3. Select the Pro/Thinking model you want in the ChatGPT UI.");
    stdout("4. Run `gptprouse pro browser check` to confirm the session is reachable.");
    stdout("5. Run `gptprouse pro browser smoke` to verify a real Pro response path.");
  } else {
    stdout("1. Run `gptprouse pro browser login` without `--dry-run` to open the dedicated Chrome window.");
    stdout("2. Log in manually at https://chatgpt.com/ in that Chrome window.");
    stdout("3. If ChatGPT asks for captcha, Cloudflare/human verification, permission, account verification, or usage limit handling, complete it in the browser.");
    stdout("4. Select the Pro/Thinking model you want in the ChatGPT UI.");
    stdout("5. Run `gptprouse pro browser check` to confirm the session is reachable.");
    stdout("6. Run `gptprouse pro browser smoke` to verify a real Pro response path.");
  }
  stdout("");
  stdout(`Profile: ${input.profileDir}`);
  stdout(`Debug: http://127.0.0.1:${input.port}`);
  if (input.opened) {
    stdout("You can close this Chrome window after login. The dedicated profile is reused next time.");
  } else {
    stdout("The dedicated profile path above will be reused by the real login command.");
  }
}

function printProBrowserHelp(stdout: (line: string) => void): void {
  stdout(`gptprouse pro browser

Commands:
  gptprouse pro browser login [--dry-run] [--profile-dir path] [--port 9333] [--url https://chatgpt.com/...]
  gptprouse pro browser check [--port 9333] [--timeout-ms 1500]
  gptprouse pro browser smoke [--port 9333] [--timeout-ms 30000]
  gptprouse pro browser ask [--port 9333] [--timeout-ms 90000] [--target-url url --confirm-target] [--file path] "prompt"

Visible-browser sends require a manual browser session and stop on login, captcha, Cloudflare, permission, rate-limit, or usage-limit blockers.`);
}

async function assertBrowserLaunchStayedAlive(opened: ChatGptBrowserLaunch): Promise<void> {
  const outcome = await waitForBrowserLaunchReady(opened);
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

async function printProductCheck(store: BridgeStore, io: CliIO, args: string[]): Promise<void> {
  io.stdout("gptprouse product check");
  let bridgeReady = false;
  try {
    bridgeReady = await store.hasReadyBridgeStorageReadOnly();
    io.stdout(bridgeReady ? "bridge: ok (.bridge)" : "bridge: missing (.bridge) - run `gptprouse init` when you need local task/result storage");
  } catch (error) {
    io.stdout(`bridge: blocked - ${errorMessage(error)}`);
  }

  try {
    const config = await loadLocalConfig(io.cwd);
    const tokenStatus = getTokenExpiryStatus(config);
    if (tokenStatus.status === "expired") {
      io.stdout(`config: expired - run \`gptprouse setup\``);
    } else {
      io.stdout(`config: ok ${redactServerUrl(config.server_url)} token_status=${tokenStatus.status}`);
    }
  } catch (error) {
    if (isMissingFileError(error)) {
      io.stdout("config: missing - run `gptprouse setup`");
    } else {
      io.stdout(`config: failed ${errorMessage(error)}`);
    }
  }

  const browserStatus = await getChatGptBrowserStatus({
    port: readPortFlag(args, "--port") ?? 9333,
    timeoutMs: readPositiveNumberFlag(args, "--timeout-ms") ?? 1500
  });
  const visibilityBlocker = chatGptVisibilityBlocker(browserStatus.visibilityState, browserStatus.url);
  if (!browserStatus.reachable) {
    io.stdout(`chatgpt: ${browserStatus.blocker?.code ?? "unreachable"} - ${browserStatus.blocker?.message ?? "browser is not reachable"}`);
    if (browserStatus.blocker?.next_step) io.stdout(`next: ${browserStatus.blocker.next_step}`);
  } else if (browserStatus.blocker) {
    const visibilityText =
      browserStatus.blocker.code === "tab_not_visible" ? ` visibility=${browserStatus.visibilityState ?? "unknown"}` : "";
    io.stdout(`chatgpt: blocked ${browserStatus.blocker.code}${visibilityText} - ${browserStatus.blocker.message}`);
    if (browserStatus.blocker.next_step) io.stdout(`next: ${browserStatus.blocker.next_step}`);
  } else if (visibilityBlocker) {
    io.stdout(`chatgpt: blocked ${visibilityBlocker.code} visibility=${browserStatus.visibilityState ?? "unknown"} - ${visibilityBlocker.message}`);
    if (visibilityBlocker.next_step) io.stdout(`next: ${visibilityBlocker.next_step}`);
  } else if (browserStatus.loggedInLikely && browserStatus.hasComposer) {
    io.stdout(`chatgpt: ok logged_in=true composer=true${browserStatus.url ? ` url=${browserStatus.url}` : ""}`);
  } else {
    io.stdout(`chatgpt: blocked logged_in=${browserStatus.loggedInLikely} composer=${browserStatus.hasComposer}`);
    io.stdout(`next: ${browserReadinessNextStep(browserStatus)}`);
  }
  const modelHints = formatBrowserModelHints(browserStatus.modelHints);
  if (modelHints) io.stdout(`model_hints: ${modelHints}`);

  const latest = bridgeReady ? (await listConsults(store))[0] : undefined;
  if (latest) {
    const latestLabel = latest.result.status === "blocked" ? "blocked" : "ok";
    io.stdout(`latest_pro: ${latestLabel} ${latest.task.id} ${latest.result.status} ${latest.result.created_at}`);
  } else {
    io.stdout("latest_pro: missing");
  }
}

type ConsultRecord = {
  task: Awaited<ReturnType<BridgeStore["listTasks"]>>[number];
  result: Awaited<ReturnType<BridgeStore["listResults"]>>[number];
};

async function listTasksForInspection(
  store: BridgeStore,
  status?: Parameters<BridgeStore["listTasks"]>[0]
): Promise<Awaited<ReturnType<BridgeStore["listTasks"]>>> {
  return store.listTasksReadOnly(status);
}

async function listResultsForInspection(store: BridgeStore): Promise<Awaited<ReturnType<BridgeStore["listResults"]>>> {
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
    ? await Promise.all([listTasksForInspection(store), listResultsForInspection(store)])
    : await Promise.all([store.listTasks(), store.listResults()]);
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  return results
    .map((result) => {
      const task = tasksById.get(result.task_id);
      return task ? { task, result } : undefined;
    })
    .filter((record): record is ConsultRecord => Boolean(record && isConsultRecord(record)))
    .sort((a, b) => b.result.created_at.localeCompare(a.result.created_at));
}

async function latestResultTaskId(store: BridgeStore, options: { readOnly?: boolean } = {}): Promise<string> {
  const results = options.readOnly ? await listResultsForInspection(store) : await store.listResults();
  const result = results.at(-1);
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

async function getConsult(store: BridgeStore, taskId: string, options: { readOnly?: boolean } = {}): Promise<ConsultRecord | undefined> {
  let task: Awaited<ReturnType<BridgeStore["getTask"]>>;
  let result: Awaited<ReturnType<BridgeStore["getResult"]>>;
  try {
    [task, result] = await Promise.all(
      options.readOnly ? [store.getTaskReadOnly(taskId), store.getResultReadOnly(taskId)] : [store.getTask(taskId), store.getResult(taskId)]
    );
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
  if (!task || !result) return undefined;
  const record = { task, result };
  return isConsultRecord(record) ? record : undefined;
}

function isConsultRecord(record: ConsultRecord): boolean {
  return (
    record.task.provenance.adapter === "chatgpt-control" ||
    record.task.title.toLowerCase() === "gpt pro consult" ||
    record.result.commands.includes("visible ChatGPT browser consult")
  );
}

function formatProAnswer(consult: ConsultRecord): string {
  const lines = [
    `task_id: ${consult.task.id}`,
    `status: ${consult.result.status}`,
    consult.task.provenance.thread ? `thread: ${consult.task.provenance.thread}` : undefined,
    `created_at: ${consult.result.created_at}`,
    "",
    consult.result.summary
  ].filter((line): line is string => line !== undefined);
  if (consult.result.blocker) {
    lines.push("", "blocker:", `- code: ${consult.result.blocker.code}`, `- retryable: ${consult.result.blocker.retryable}`);
    if (consult.result.blocker.next_step) lines.push(`- next_step: ${consult.result.blocker.next_step}`);
  }
  if (consult.result.warnings.length > 0) {
    lines.push("", "warnings:");
    for (const warning of consult.result.warnings) lines.push(`- ${warning}`);
  }
  return lines.join("\n");
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

async function loadLocalConfigForCommand(cwd: string, command: "start" | "status" | "tunnel url") {
  return loadLocalConfig(cwd).catch(async (error) => {
    if (isMissingFileError(error)) {
      throw new Error(
        `${command} requires local MCP setup. Run \`gptprouse setup\` first. Add \`--token-ttl-hours <hours>\` before revealing token URLs, using tunnels, or connecting ChatGPT Projects.`
      );
    }
    throw error;
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
  url.username = "";
  url.password = "";
  url.pathname = "/mcp";
  url.search = "";
  url.hash = "";
  url.searchParams.set("gptprouse_token", token);
  return url.toString();
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
      throw new Error(`Unknown option for ${command}: ${arg}`);
    }
    throw new Error(`Unexpected argument for ${command}: ${arg}`);
  }
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
const ASK_PRO_VALUE_FLAGS = new Set(["--file", "--port", "--timeout-ms", "--target-url"]);

function parseAskProArgs(args: string[]): { optionArgs: string[]; promptParts: string[] } {
  const delimiterIndex = args.indexOf("--");
  const optionArgs = delimiterIndex === -1 ? args : args.slice(0, delimiterIndex);
  const promptTail = delimiterIndex === -1 ? [] : args.slice(delimiterIndex + 1);
  const positionalPromptParts: string[] = [];

  for (let index = 0; index < optionArgs.length; index += 1) {
    const arg = optionArgs[index];
    if (!arg.startsWith("--")) {
      if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
      positionalPromptParts.push(arg);
      continue;
    }
    if (ASK_PRO_BOOLEAN_FLAGS.has(arg)) continue;
    if (ASK_PRO_VALUE_FLAGS.has(arg)) {
      readFlagValue(optionArgs, index, arg);
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
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
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
