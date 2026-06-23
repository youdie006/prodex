#!/usr/bin/env node
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildDryRunBundle } from "./bundle.js";
import { defaultChatGptProfileDir, getChatGptBrowserStatus, normalizeChatGptTargetUrl, openChatGptBrowser, sendChatGptPrompt } from "./chatgpt-browser.js";
import { assertTokenNotExpired, getTokenExpiryStatus, loadLocalConfig, writeLocalConfig } from "./config.js";
import { startHttpMcpServer } from "./http-mcp.js";
import { createMcpToolHandlers } from "./mcp-tools.js";
import { runMcpServer } from "./mcp.js";
import { readVerifiedUtf8File, writeVerifiedUtf8File } from "./safe-file.js";
import { ReceiptKindSchema, TaskStatusSchema } from "./schema.js";
import { BridgeStore, type ListReceiptsInput } from "./store.js";

const execFileAsync = promisify(execFile);
const requirePackageJson = createRequire(import.meta.url);
const packageJson = requirePackageJson("../package.json") as { version?: string };
const CLI_VERSION = packageJson.version ?? "0.0.0";

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
    await store.ensure();
    await ensureBridgeGitignore(io.cwd);
    io.stdout("Initialized .bridge receipt ledger.");
    return 0;
  }

  if (command === "setup") {
    const config = await writeLocalConfig(io.cwd, {
      host: readFlag(rest, "--host") ?? "127.0.0.1",
      port: readNumberFlag(rest, "--port") ?? 8787,
      token: readFlag(rest, "--token"),
      tokenTtlHours: readNumberFlag(rest, "--token-ttl-hours")
    });
    io.stdout("Saved local ChatGPT Developer Mode MCP profile.");
    io.stdout(`Server URL: ${redactServerUrl(config.server_url)}`);
    io.stdout(formatTokenExpiryLine(config));
    io.stdout("Full URL is stored in .bridge/config.local.json.");
    return 0;
  }

  if (command === "start") {
    const config = await loadLocalConfig(io.cwd).catch(async (error) => {
      if (isMissingFileError(error)) {
        throw new Error("start requires local MCP setup. Run `gptprouse setup --token-ttl-hours <hours>` first.");
      }
      throw error;
    });
    const overrideToken = readFlag(rest, "--token");
    if (!overrideToken) assertTokenNotExpired(config);
    const running = await startHttpMcpServer({
      cwd: io.cwd,
      host: readFlag(rest, "--host") ?? config.host,
      port: readNumberFlag(rest, "--port") ?? config.port,
      token: overrideToken ?? config.token,
      tokenExpiresAt: overrideToken ? undefined : config.token_expires_at
    });
    io.stdout(`gptprouse HTTP MCP listening on ${redactServerUrl(running.mcp_url)}`);
    io.stdout(formatTokenExpiryLine(overrideToken ? {} : config));
    await waitForShutdown(async () => running.close());
    return 0;
  }

  if (command === "status") {
    const config = await loadLocalConfig(io.cwd);
    const showToken = rest.includes("--show-token");
    const serverUrl = showToken ? config.server_url : redactServerUrl(config.server_url);
    if (rest.includes("--url-only")) {
      io.stdout(serverUrl);
      return 0;
    }
    const tokenStatus = getTokenExpiryStatus(config);
    io.stdout(
      JSON.stringify(
        {
          server_url: serverUrl,
          config_path: ".bridge/config.local.json",
          token_status: tokenStatus.status,
          token_expires_at: tokenStatus.token_expires_at ?? null,
          warnings: tokenStatus.warning ? [tokenStatus.warning] : []
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
    const config = await loadLocalConfig(io.cwd);
    const tokenStatus = getTokenExpiryStatus(config);
    if (tokenStatus.status === "none") {
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
    return runDoctor(store, io);
  }

  if (command === "chatgpt") {
    const [subcommand, ...chatgptArgs] = rest;
    if (subcommand === "open") {
      const opened = openChatGptBrowser({
        port: readNumberFlag(chatgptArgs, "--port") ?? 9333,
        profileDir: readFlag(chatgptArgs, "--profile-dir"),
        url: readFlag(chatgptArgs, "--url") ?? "https://chatgpt.com/"
      });
      io.stdout(`Opened ChatGPT browser via ${opened.command}.`);
      io.stdout(`Profile: ${opened.profileDir}`);
      io.stdout(`Debug: http://127.0.0.1:${opened.port}`);
      return 0;
    }
    if (subcommand === "status") {
      const status = await getChatGptBrowserStatus({ port: readNumberFlag(chatgptArgs, "--port") ?? 9333 });
      io.stdout(JSON.stringify(status, null, 2));
      return 0;
    }
    if (subcommand === "smoke") {
      const result = await sendChatGptPrompt({
        port: readNumberFlag(chatgptArgs, "--port") ?? 9333,
        prompt: "This is a one-time gptprouse smoke test. Reply exactly: GPTPROUSE_PRO_SMOKE_OK",
        timeoutMs: readNumberFlag(chatgptArgs, "--timeout-ms") ?? 90000
      });
      io.stdout(JSON.stringify(result, null, 2));
      return 0;
    }
  }

  if (command === "tasks") {
    const [subcommand, ...taskArgs] = rest;
    if (subcommand === "create") {
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
      const status = readTaskStatusFlag(taskArgs);
      const tasks = await store.listTasks(status);
      for (const task of tasks) {
        io.stdout(`${task.id}\t${task.status}\t${task.title}`);
      }
      return 0;
    }
    if (subcommand === "show") {
      const taskId = taskArgs[0];
      if (!taskId) throw new Error("tasks show requires <task-id|latest>");
      const task = taskId === "latest" ? await latestTask(store) : await store.getTask(taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);
      io.stdout(JSON.stringify(task, null, 2));
      return 0;
    }
    if (subcommand === "claim") {
      const taskId = taskArgs[0];
      if (!taskId) throw new Error("tasks claim requires <task-id>");
      const task = await store.claimTask(taskId, readFlag(taskArgs, "--by") ?? "codex");
      io.stdout(`${task.id}\t${task.status}\t${task.claimed_by ?? ""}`);
      return 0;
    }
    if (subcommand === "complete") {
      const taskId = taskArgs[0];
      const summary = readFlag(taskArgs, "--summary");
      if (!taskId || !summary) throw new Error("tasks complete requires <task-id> --summary");
      const result = await store.completeTask(taskId, {
        status: "done",
        summary,
        commands: readRepeatedFlag(taskArgs, "--command")
      });
      io.stdout(`${result.task_id}\t${result.status}\t${result.summary}`);
      return 0;
    }
    if (subcommand === "block") {
      const taskId = taskArgs[0];
      const summary = readFlag(taskArgs, "--summary");
      if (!taskId || !summary) throw new Error("tasks block requires <task-id> --summary");
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
      const resolvedTaskId = taskId === "latest" ? await latestResultTaskId(store) : taskId;
      io.stdout(JSON.stringify(await store.getResult(resolvedTaskId), null, 2));
      return 0;
    }
    if (subcommand === "artifact") {
      const taskId = resultArgs[0];
      if (!taskId) throw new Error("results artifact requires <task-id> [artifact-path]");
      const resolvedTaskId = taskId === "latest" ? await latestResultTaskId(store) : taskId;
      const artifact = await store.readResultArtifactText(resolvedTaskId, resultArgs[1]);
      io.stdout(artifact.content);
      return 0;
    }
  }

  if (command === "receipts") {
    const [subcommand, ...receiptArgs] = rest;
    if (subcommand === "list") {
      const receipts = await store.listReceipts({
        kind: readReceiptKindFlag(receiptArgs),
        task_id: readFlag(receiptArgs, "--task-id")
      });
      for (const receipt of receipts) {
        io.stdout(`${receipt.id}\t${receipt.kind}\t${receipt.summary}`);
      }
      return 0;
    }
    if (subcommand === "show") {
      const receiptId = receiptArgs[0];
      if (!receiptId) throw new Error("receipts show requires <receipt-id|latest>");
      const receipt = receiptId === "latest" ? (await store.listReceipts())[0] : await store.getReceiptForDisplay(receiptId);
      if (!receipt) throw new Error(`Receipt not found: ${receiptId}`);
      io.stdout(JSON.stringify(receipt, null, 2));
      return 0;
    }
  }

  if (command === "sessions") {
    const [subcommand, ...sessionArgs] = rest;
    if (subcommand === "list") {
      const status = readSessionStatusFlag(sessionArgs);
      const sessions = await store.listSessions(status);
      for (const session of sessions) {
        io.stdout(`${session.id}\t${session.status}\t${session.backend}\t${session.direction}`);
      }
      return 0;
    }
    if (subcommand === "show") {
      const sessionId = sessionArgs[0];
      if (!sessionId) throw new Error("sessions show requires <session-id|latest>");
      const session = sessionId === "latest" ? (await store.listSessions())[0] : await store.getSession(sessionId);
      if (!session) throw new Error(`Session not found: ${sessionId}`);
      io.stdout(formatSession(session));
      return 0;
    }
  }

  if (command === "pro") {
    const [subcommand, ...proArgs] = rest;
    if (subcommand === "ask") {
      const hasMode = hasAskProMode(proArgs);
      return runCli(["ask-pro", ...(hasMode ? [] : ["--dry-run"]), ...proArgs], io);
    }
    if (subcommand === "browser") {
      const [browserSubcommand, ...browserArgs] = proArgs;
      if (browserSubcommand === "login") {
        if (browserArgs.includes("--dry-run")) {
          printBrowserLoginGuide(io.stdout, {
            opened: false,
            profileDir: readFlag(browserArgs, "--profile-dir") ?? defaultChatGptProfileDir(),
            port: readNumberFlag(browserArgs, "--port") ?? 9333
          });
          return 0;
        }
        const opened = openChatGptBrowser({
          port: readNumberFlag(browserArgs, "--port") ?? 9333,
          profileDir: readFlag(browserArgs, "--profile-dir"),
          url: readFlag(browserArgs, "--url") ?? "https://chatgpt.com/"
        });
        printBrowserLoginGuide(io.stdout, {
          opened: true,
          profileDir: opened.profileDir,
          port: opened.port
        });
        return 0;
      }
      if (browserSubcommand === "ask") {
        const hasMode = hasAskProMode(browserArgs);
        return runCli(["ask-pro", ...(hasMode ? [] : ["--send"]), ...browserArgs], io);
      }
      if (browserSubcommand === "open" || browserSubcommand === "status" || browserSubcommand === "smoke") {
        return runCli(["chatgpt", browserSubcommand, ...browserArgs], io);
      }
      if (browserSubcommand === "check" || browserSubcommand === "doctor") {
        await printProductCheck(store, io, browserArgs);
        return 0;
      }
      throw new Error("pro browser requires login|ask|open|status|smoke|check");
    }
    if (subcommand === "open" || subcommand === "status" || subcommand === "smoke" || subcommand === "check" || subcommand === "doctor") {
      throw new Error(`Use \`gptprouse pro browser ${subcommand === "doctor" ? "check" : subcommand}\` for explicit browser automation.`);
    }
    if (subcommand === "list") {
      const consults = await listConsults(store);
      for (const consult of consults) {
        io.stdout(`${consult.task.id}\t${consult.result.status}\t${firstLine(consult.result.summary)}`);
      }
      return 0;
    }
    if (subcommand === "latest") {
      const consult = (await listConsults(store))[0];
      if (!consult) throw new Error("No GPT Pro answers found");
      io.stdout(formatProAnswer(consult));
      return 0;
    }
    if (subcommand === "show") {
      const taskId = proArgs[0];
      if (!taskId) throw new Error("pro show requires <task-id|latest>");
      const consult = taskId === "latest" ? (await listConsults(store))[0] : await getConsult(store, taskId);
      if (!consult) throw new Error(`GPT Pro answer not found: ${taskId}`);
      io.stdout(formatProAnswer(consult));
      return 0;
    }
  }

  if (command === "consults") {
    const [subcommand, ...consultArgs] = rest;
    if (subcommand === "list") {
      const consults = await listConsults(store);
      for (const consult of consults) {
        io.stdout(`${consult.task.id}\t${consult.result.status}\t${firstLine(consult.result.summary)}`);
      }
      return 0;
    }
    if (subcommand === "latest") {
      const consult = (await listConsults(store))[0];
      if (!consult) throw new Error("No consult results found");
      io.stdout(formatConsult(consult));
      return 0;
    }
    if (subcommand === "show") {
      const taskId = consultArgs[0];
      if (!taskId) throw new Error("consults show requires <task-id|latest>");
      const consult = taskId === "latest" ? (await listConsults(store))[0] : await getConsult(store, taskId);
      if (!consult) throw new Error(`Consult not found: ${taskId}`);
      io.stdout(formatConsult(consult));
      return 0;
    }
  }

  if (command === "ask-pro") {
    const parsedAskPro = parseAskProArgs(rest);
    if (!parsedAskPro.optionArgs.includes("--dry-run") && !parsedAskPro.optionArgs.includes("--send")) {
      throw new Error("ask-pro requires --dry-run or --send");
    }
    const files = readRepeatedFlag(parsedAskPro.optionArgs, "--file");
    const targetUrl = readFlag(parsedAskPro.optionArgs, "--target-url");
    const normalizedTargetUrl = targetUrl ? normalizeChatGptTargetUrl(targetUrl) : undefined;
    if (normalizedTargetUrl && parsedAskPro.optionArgs.includes("--send") && !parsedAskPro.optionArgs.includes("--confirm-target")) {
      throw new Error("--target-url requires --confirm-target after you manually verify the visible ChatGPT tab is the intended Project/thread.");
    }
    const prompt = parsedAskPro.promptParts.join(" ").trim();
    if (!prompt) throw new Error("ask-pro requires a prompt");
    const bundle = await buildDryRunBundle(io.cwd, { prompt, files });
    if (parsedAskPro.optionArgs.includes("--send")) {
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
          port: readNumberFlag(parsedAskPro.optionArgs, "--port") ?? 9333,
          prompt: bundle.text,
          targetUrl: normalizedTargetUrl,
          timeoutMs: readNumberFlag(parsedAskPro.optionArgs, "--timeout-ms") ?? 90000
        });
      } catch (error) {
        const message = errorMessage(error);
        try {
          await store.completeTask(task.id, {
            status: "blocked",
            summary: message,
            commands: ["visible ChatGPT browser consult"],
            blocker: {
              code: "browser_send_failed",
              message,
              retryable: true,
              next_step: "Resolve the visible browser issue manually, then rerun the consult if needed."
            }
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
              blocker: {
                code: "browser_send_failed",
                message,
                retryable: true,
                next_step: "Resolve the visible browser issue manually, then rerun the consult if needed."
              },
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
      const answerArtifactPath = await store.writeArtifactText(`.bridge/artifacts/pro-consults/${task.id}.md`, answerArtifactText);
      await store.writeReceipt({
        kind: "consult_answer_saved",
        task_id: task.id,
        session_id: bundle.id,
        summary: `Saved ChatGPT answer for ${task.id}`,
        metadata: {
          artifact_path: answerArtifactPath,
          thread: consult.url,
          warnings: consult.warnings
        }
      });
      const result = await store.completeTask(task.id, {
        status: "done",
        summary: consult.answer,
        artifacts: [{ path: answerArtifactPath, role: "result", bytes: Buffer.byteLength(answerArtifactText, "utf8") }],
        commands: ["visible ChatGPT browser consult"],
        warnings: consult.warnings,
        provenance: {
          thread: consult.url,
          warnings: consult.warnings
        }
      });
      await writeSessionBestEffort(
        store,
        {
          id: bundle.id,
          direction: "codex_to_chatgpt",
          backend: "chatgpt-control",
          task_id: task.id,
          thread: consult.url,
          status: "done",
          warnings: consult.warnings
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
    await runMcpServer(io.cwd);
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
  gptprouse init
  gptprouse doctor
  gptprouse setup [--host 127.0.0.1] [--port 8787] [--token-ttl-hours <hours>]
  gptprouse start
  gptprouse status [--show-token] [--url-only]
  gptprouse tunnel url --public-url https://... [--show-token] [--url-only]
  gptprouse ask-pro --dry-run|--send [--file path] "prompt"
  gptprouse pro ask [--file path] "prompt"  # dry-run preview
  gptprouse pro browser login
  gptprouse pro browser check|smoke
  gptprouse pro browser ask [--target-url url --confirm-target] [--file path] "prompt"  # explicit visible-browser send
  gptprouse pro latest|list|show <task-id|latest>
  gptprouse pro browser open|status
  gptprouse chatgpt open|status|smoke  # low-level alias
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
  gptprouse mcp`);
}

async function runDoctor(store: BridgeStore, io: CliIO): Promise<number> {
  let ok = true;
  io.stdout("gptprouse doctor");

  try {
    await store.ensure();
    io.stdout("bridge: ok (.bridge)");
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
    io.stdout(`http_mcp_smoke: ok task_flow=${smoke.taskFlow} finalizers=${smoke.finalizers} tools=${smoke.tools.join(",")}`);
  } catch (error) {
    ok = false;
    io.stdout(`http_mcp_smoke: failed ${errorMessage(error)}`);
  }

  return ok ? 0 : 1;
}

async function runHttpMcpCatalogSmoke(): Promise<{ tools: string[]; taskFlow: "ok"; finalizers: "ok" }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-http-doctor-"));
  let running: Awaited<ReturnType<typeof startHttpMcpServer>> | undefined;
  let client: Client | undefined;
  let smokeFailed = false;
  try {
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
    await runHttpMcpFinalizerSmoke(client);
    return { tools: [...DOCTOR_REQUIRED_MCP_TOOLS], taskFlow: "ok", finalizers: "ok" };
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
  stdout("1. Log in manually at https://chatgpt.com/ in the dedicated Chrome window.");
  stdout("2. If ChatGPT asks for captcha, permission, or account verification, complete it in the browser.");
  stdout("3. Select the Pro/Thinking model you want in the ChatGPT UI.");
  stdout("4. Run `gptprouse pro browser check` to confirm the session is reachable.");
  stdout("5. Run `gptprouse pro browser smoke` to verify a real Pro response path.");
  stdout("");
  stdout(`Profile: ${input.profileDir}`);
  stdout(`Debug: http://127.0.0.1:${input.port}`);
  stdout("You can close this Chrome window after login. The dedicated profile is reused next time.");
}

async function printProductCheck(store: BridgeStore, io: CliIO, args: string[]): Promise<void> {
  await store.ensure();
  io.stdout("gptprouse product check");
  io.stdout("bridge: ok (.bridge)");

  try {
    const config = await loadLocalConfig(io.cwd);
    const tokenStatus = getTokenExpiryStatus(config);
    if (tokenStatus.status === "expired") {
      io.stdout(`config: expired - run \`gptprouse setup\``);
    } else {
      io.stdout(`config: ok ${redactServerUrl(config.server_url)} token_status=${tokenStatus.status}`);
    }
  } catch {
    io.stdout("config: missing - run `gptprouse setup`");
  }

  const browserStatus = await getChatGptBrowserStatus({
    port: readNumberFlag(args, "--port") ?? 9333,
    timeoutMs: readNumberFlag(args, "--timeout-ms") ?? 1500
  });
  if (!browserStatus.reachable) {
    io.stdout(`chatgpt: ${browserStatus.blocker?.code ?? "unreachable"} - ${browserStatus.blocker?.message ?? "browser is not reachable"}`);
    if (browserStatus.blocker?.next_step) io.stdout(`next: ${browserStatus.blocker.next_step}`);
  } else if (browserStatus.loggedInLikely && browserStatus.hasComposer) {
    io.stdout(`chatgpt: ok logged_in=true composer=true${browserStatus.url ? ` url=${browserStatus.url}` : ""}`);
  } else {
    io.stdout(`chatgpt: blocked logged_in=${browserStatus.loggedInLikely} composer=${browserStatus.hasComposer}`);
    if (browserStatus.blocker?.next_step) io.stdout(`next: ${browserStatus.blocker.next_step}`);
  }

  const latest = (await listConsults(store))[0];
  if (latest) {
    io.stdout(`latest_pro: ok ${latest.task.id} ${latest.result.status} ${latest.result.created_at}`);
  } else {
    io.stdout("latest_pro: missing");
  }
}

type ConsultRecord = {
  task: Awaited<ReturnType<BridgeStore["listTasks"]>>[number];
  result: Awaited<ReturnType<BridgeStore["listResults"]>>[number];
};

async function listConsults(store: BridgeStore): Promise<ConsultRecord[]> {
  const [tasks, results] = await Promise.all([store.listTasks(), store.listResults()]);
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  return results
    .map((result) => {
      const task = tasksById.get(result.task_id);
      return task ? { task, result } : undefined;
    })
    .filter((record): record is ConsultRecord => Boolean(record && isConsultRecord(record)))
    .sort((a, b) => b.result.created_at.localeCompare(a.result.created_at));
}

async function latestResultTaskId(store: BridgeStore): Promise<string> {
  const result = (await store.listResults()).at(-1);
  if (!result) throw new Error("No results found");
  return result.task_id;
}

async function latestTask(store: BridgeStore): Promise<Awaited<ReturnType<BridgeStore["listTasks"]>>[number] | undefined> {
  return (await store.listTasks()).sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))[0];
}

async function getConsult(store: BridgeStore, taskId: string): Promise<ConsultRecord | undefined> {
  const [task, result] = await Promise.all([store.getTask(taskId), store.getResult(taskId)]).catch(() => [undefined, undefined] as const);
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

function formatConsult(consult: ConsultRecord): string {
  return JSON.stringify(
    {
      task_id: consult.task.id,
      status: consult.result.status,
      thread: consult.task.provenance.thread,
      created_at: consult.result.created_at,
      summary: consult.result.summary,
      warnings: consult.result.warnings
    },
    null,
    2
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
  if (consult.result.warnings.length > 0) {
    lines.push("", "warnings:");
    for (const warning of consult.result.warnings) lines.push(`- ${warning}`);
  }
  return lines.join("\n");
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

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function redactServerUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.searchParams.has("gptprouse_token")) url.searchParams.set("gptprouse_token", "***");
    return url.toString();
  } catch {
    return value.replace(/([?&]gptprouse_token=)[^&]+/g, "$1***");
  }
}

function makeTunnelMcpUrl(publicUrl: string, token: string): string {
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    throw new Error("--public-url must be a valid URL");
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

function hasAskProMode(args: string[]): boolean {
  const delimiterIndex = args.indexOf("--");
  const optionArgs = delimiterIndex === -1 ? args : args.slice(0, delimiterIndex);
  return optionArgs.includes("--send") || optionArgs.includes("--dry-run");
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
    ["tasks/*.json", "results/*.json", "sessions/*.json", "receipts/*.json", "artifacts/*", "config.local.json", "!.gitignore", ""].join("\n"),
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
