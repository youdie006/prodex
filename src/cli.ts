#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildDryRunBundle } from "./bundle.js";
import { defaultChatGptProfileDir, getChatGptBrowserStatus, openChatGptBrowser, sendChatGptPrompt } from "./chatgpt-browser.js";
import { loadLocalConfig, writeLocalConfig } from "./config.js";
import { startHttpMcpServer } from "./http-mcp.js";
import { createMcpToolHandlers } from "./mcp-tools.js";
import { runMcpServer } from "./mcp.js";
import { BridgeStore } from "./store.js";

const execFileAsync = promisify(execFile);

export interface CliIO {
  cwd: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export async function runCli(args: string[], io: CliIO = defaultIo()): Promise<number> {
  const [command, ...rest] = args;
  const store = new BridgeStore(io.cwd);

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
      token: readFlag(rest, "--token")
    });
    io.stdout("Saved local ChatGPT Developer Mode MCP profile.");
    io.stdout(`Server URL: ${redactServerUrl(config.server_url)}`);
    io.stdout("Full URL is stored in .bridge/config.local.json.");
    return 0;
  }

  if (command === "start") {
    const config = await loadLocalConfig(io.cwd).catch(async () => writeLocalConfig(io.cwd));
    const running = await startHttpMcpServer({
      cwd: io.cwd,
      host: readFlag(rest, "--host") ?? config.host,
      port: Number(readFlag(rest, "--port") ?? String(config.port)),
      token: readFlag(rest, "--token") ?? config.token
    });
    io.stdout(`gptprouse HTTP MCP listening on ${redactServerUrl(running.mcp_url)}`);
    await waitForShutdown(async () => running.close());
    return 0;
  }

  if (command === "status") {
    const config = await loadLocalConfig(io.cwd);
    const showToken = rest.includes("--show-token");
    io.stdout(JSON.stringify({ server_url: showToken ? config.server_url : redactServerUrl(config.server_url), config_path: ".bridge/config.local.json" }, null, 2));
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
    const prompt = rest.filter((arg, index) => {
      const prev = rest[index - 1];
      return (
        arg !== "--dry-run" &&
        arg !== "--send" &&
        arg !== "--file" &&
        arg !== "--port" &&
        arg !== "--timeout-ms" &&
        prev !== "--file" &&
        prev !== "--port" &&
        prev !== "--timeout-ms"
      );
    }).join(" ").trim();
    if (!prompt) throw new Error("ask-pro requires a prompt");
    const bundle = await buildDryRunBundle(io.cwd, { prompt, files });
    if (rest.includes("--send")) {
      const consult = await sendChatGptPrompt({
        port: Number(readFlag(rest, "--port") ?? "9333"),
        prompt: bundle.text,
        timeoutMs: Number(readFlag(rest, "--timeout-ms") ?? "90000")
      });
      const task = await store.createTask({
        source: "codex",
        title: "GPT Pro consult",
        prompt: bundle.text,
        repo_id: "default",
        files: files.map((file) => ({ path: file, role: "context" as const })),
        provenance: {
          adapter: "chatgpt-control",
          session_id: bundle.id,
          thread: consult.url,
          warnings: consult.warnings
        }
      });
      await store.claimTask(task.id, "chatgpt-pro");
      const result = await store.completeTask(task.id, {
        status: "done",
        summary: consult.answer,
        commands: ["visible ChatGPT browser consult"],
        warnings: consult.warnings
      });
      io.stdout(`${result.task_id}\t${result.status}\t${consult.url}`);
      io.stdout("");
      io.stdout(result.summary);
    } else {
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
  stdout(`gptprouse v0.2

Commands:
  gptprouse init
  gptprouse doctor
  gptprouse setup [--host 127.0.0.1] [--port 8787]
  gptprouse start
  gptprouse status [--show-token]
  gptprouse ask-pro --dry-run|--send [--file path] "prompt"
  gptprouse pro ask [--file path] "prompt"
  gptprouse pro browser login
  gptprouse pro browser check|smoke
  gptprouse pro browser ask [--file path] "prompt"
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
    io.stdout(`config: ok ${redactServerUrl(config.server_url)}`);
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

  return ok ? 0 : 1;
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
  stdout("4. Run `node dist/cli.js pro browser check` to confirm the session is reachable.");
  stdout("5. Run `node dist/cli.js pro browser smoke` to verify a real Pro response path.");
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
    io.stdout(`config: ok ${redactServerUrl(config.server_url)}`);
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

function readFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
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
  if (!current.includes("node_modules/")) {
    await writeFile(rootIgnorePath, `${current}${current && !current.endsWith("\n") ? "\n" : ""}node_modules/\ndist/\n`, "utf8");
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

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
