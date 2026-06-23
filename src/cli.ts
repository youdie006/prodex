#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildDryRunBundle } from "./bundle.js";
import { getChatGptBrowserStatus, openChatGptBrowser, sendChatGptPrompt } from "./chatgpt-browser.js";
import { loadLocalConfig, writeLocalConfig } from "./config.js";
import { startHttpMcpServer } from "./http-mcp.js";
import { runMcpServer } from "./mcp.js";
import { BridgeStore } from "./store.js";

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
    io.stdout(`Server URL: ${config.server_url}`);
    io.stdout("Paste this URL into ChatGPT Settings -> Apps -> Advanced settings -> Create app.");
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
    io.stdout(`gptprouse HTTP MCP listening on ${running.mcp_url}`);
    await waitForShutdown(async () => running.close());
    return 0;
  }

  if (command === "status") {
    const config = await loadLocalConfig(io.cwd);
    io.stdout(JSON.stringify({ server_url: config.server_url, config_path: ".bridge/config.local.json" }, null, 2));
    return 0;
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
  gptprouse setup [--host 127.0.0.1] [--port 8787]
  gptprouse start
  gptprouse status
  gptprouse ask-pro --dry-run|--send [--file path] "prompt"
  gptprouse chatgpt open|status|smoke
  gptprouse tasks create --title "Title" --prompt "Prompt"
  gptprouse tasks list [--status new|claimed|done|blocked]
  gptprouse tasks claim <task-id> [--by codex]
  gptprouse tasks complete <task-id> --summary "Summary" [--command "npm test"]
  gptprouse results show <task-id>
  gptprouse mcp`);
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
