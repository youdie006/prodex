#!/usr/bin/env node
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
import { BridgeStore } from "./store.js";

const execFileAsync = promisify(execFile);
const requirePackageJson = createRequire(import.meta.url);
const packageJson = requirePackageJson("../package.json") as { version?: string };
const CLI_VERSION = packageJson.version ?? "0.0.0";

const DOCTOR_REQUIRED_MCP_TOOLS = [
  "bridge_create_task",
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
      port: Number(readFlag(rest, "--port") ?? "8787"),
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
      port: Number(readFlag(rest, "--port") ?? String(config.port)),
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
        port: Number(readFlag(chatgptArgs, "--port") ?? "9333"),
        profileDir: readFlag(chatgptArgs, "--profile-dir"),
        url: readFlag(chatgptArgs, "--url") ?? "https://chatgpt.com/"
      });
      io.stdout(`Opened ChatGPT browser via ${opened.command}.`);
      io.stdout(`Profile: ${opened.profileDir}`);
      io.stdout(`Debug: http://127.0.0.1:${opened.port}`);
      return 0;
    }
    if (subcommand === "status") {
      const status = await getChatGptBrowserStatus({ port: Number(readFlag(chatgptArgs, "--port") ?? "9333") });
      io.stdout(JSON.stringify(status, null, 2));
      return 0;
    }
    if (subcommand === "smoke") {
      const result = await sendChatGptPrompt({
        port: Number(readFlag(chatgptArgs, "--port") ?? "9333"),
        prompt: "This is a one-time gptprouse smoke test. Reply exactly: GPTPROUSE_PRO_SMOKE_OK",
        timeoutMs: Number(readFlag(chatgptArgs, "--timeout-ms") ?? "90000")
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
      const status = readFlag(taskArgs, "--status") as Parameters<typeof store.listTasks>[0];
      const tasks = await store.listTasks(status);
      for (const task of tasks) {
        io.stdout(`${task.id}\t${task.status}\t${task.title}`);
      }
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
  }

  if (command === "results") {
    const [subcommand, ...resultArgs] = rest;
    if (subcommand === "show") {
      const taskId = resultArgs[0];
      if (!taskId) throw new Error("results show requires <task-id>");
      io.stdout(JSON.stringify(await store.getResult(taskId), null, 2));
      return 0;
    }
  }

  if (command === "pro") {
    const [subcommand, ...proArgs] = rest;
    if (subcommand === "ask") {
      const hasMode = proArgs.includes("--send") || proArgs.includes("--dry-run");
      return runCli(["ask-pro", ...(hasMode ? [] : ["--dry-run"]), ...proArgs], io);
    }
    if (subcommand === "browser") {
      const [browserSubcommand, ...browserArgs] = proArgs;
      if (browserSubcommand === "login") {
        if (browserArgs.includes("--dry-run")) {
          printBrowserLoginGuide(io.stdout, {
            opened: false,
            profileDir: readFlag(browserArgs, "--profile-dir") ?? defaultChatGptProfileDir(),
            port: Number(readFlag(browserArgs, "--port") ?? "9333")
          });
          return 0;
        }
        const opened = openChatGptBrowser({
          port: Number(readFlag(browserArgs, "--port") ?? "9333"),
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
        const hasMode = browserArgs.includes("--send") || browserArgs.includes("--dry-run");
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
    if (!rest.includes("--dry-run") && !rest.includes("--send")) {
      throw new Error("ask-pro requires --dry-run or --send");
    }
    const files = readRepeatedFlag(rest, "--file");
    const targetUrl = readFlag(rest, "--target-url");
    const normalizedTargetUrl = targetUrl ? normalizeChatGptTargetUrl(targetUrl) : undefined;
    if (normalizedTargetUrl && rest.includes("--send") && !rest.includes("--confirm-target")) {
      throw new Error("--target-url requires --confirm-target after you manually verify the visible ChatGPT tab is the intended Project/thread.");
    }
    const prompt = rest.filter((arg, index) => {
      const prev = rest[index - 1];
      return (
        arg !== "--dry-run" &&
        arg !== "--send" &&
        arg !== "--file" &&
        arg !== "--port" &&
        arg !== "--timeout-ms" &&
        arg !== "--target-url" &&
        arg !== "--confirm-target" &&
        prev !== "--file" &&
        prev !== "--port" &&
        prev !== "--timeout-ms" &&
        prev !== "--target-url"
      );
    }).join(" ").trim();
    if (!prompt) throw new Error("ask-pro requires a prompt");
    const bundle = await buildDryRunBundle(io.cwd, { prompt, files });
    if (rest.includes("--send")) {
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
          port: Number(readFlag(rest, "--port") ?? "9333"),
          prompt: bundle.text,
          targetUrl: normalizedTargetUrl,
          timeoutMs: Number(readFlag(rest, "--timeout-ms") ?? "90000")
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
  gptprouse tasks claim <task-id> [--by codex]
  gptprouse tasks complete <task-id> --summary "Summary" [--command "npm test"]
  gptprouse results show <task-id>
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
    const smoke = await runHttpMcpCatalogSmoke(io.cwd);
    io.stdout(`http_mcp_smoke: ok tools=${smoke.tools.join(",")}`);
  } catch (error) {
    ok = false;
    io.stdout(`http_mcp_smoke: failed ${errorMessage(error)}`);
  }

  return ok ? 0 : 1;
}

async function runHttpMcpCatalogSmoke(cwd: string): Promise<{ tools: string[] }> {
  const running = await startHttpMcpServer({
    cwd,
    host: "127.0.0.1",
    port: 0,
    token: "doctor-token"
  });
  let client: Client | undefined;
  try {
    client = new Client({ name: "gptprouse-doctor", version: "0.2.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(running.mcp_url)));
    const result = await client.listTools();
    const names = result.tools.map((tool) => tool.name);
    const missing = DOCTOR_REQUIRED_MCP_TOOLS.filter((tool) => !names.includes(tool));
    if (missing.length > 0) throw new Error(`missing MCP tools: ${missing.join(",")}`);
    return { tools: [...DOCTOR_REQUIRED_MCP_TOOLS] };
  } finally {
    await client?.close().catch(() => undefined);
    await running.close();
  }
}

async function runMcpWriteSmoke(): Promise<{ path: string; receipt_payload: "artifact"; staged: string }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-doctor-"));
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
    port: Number(readFlag(args, "--port") ?? "9333"),
    timeoutMs: Number(readFlag(args, "--timeout-ms") ?? "1500")
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
  return args[index + 1];
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
    if (args[index] === flag && args[index + 1]) {
      values.push(args[index + 1]);
      index += 1;
    }
  }
  return values;
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
  await writeFile(
    bridgeIgnorePath,
    ["tasks/*.json", "results/*.json", "sessions/*.json", "receipts/*.json", "artifacts/*", "config.local.json", "!.gitignore", ""].join("\n"),
    "utf8"
  );
  const rootIgnorePath = path.join(cwd, ".gitignore");
  let current = "";
  try {
    current = await readFile(rootIgnorePath, "utf8");
  } catch {
    // ignore missing .gitignore
  }
  const ignored = new Set(current.split(/\r?\n/).filter(Boolean));
  const additions = ["node_modules/", "dist/"].filter((line) => !ignored.has(line));
  if (additions.length > 0) {
    await writeFile(rootIgnorePath, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${additions.join("\n")}\n`, "utf8");
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
