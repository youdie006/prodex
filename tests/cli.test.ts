import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { setSafeFileTestHooks } from "../src/safe-file.js";
import { BridgeStore } from "../src/store.js";

const requireFromTest = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

describe("runCli", () => {
  afterEach(() => {
    setSafeFileTestHooks({});
  });

  it("prints the package version from version commands and help", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const packageJson = JSON.parse(await readFile(path.resolve(import.meta.dirname, "..", "package.json"), "utf8")) as {
      version: string;
    };
    const versionOut: string[] = [];
    const aliasOut: string[] = [];
    const helpOut: string[] = [];

    await runCli(["--version"], { cwd, stdout: (line) => versionOut.push(line), stderr: () => {} });
    await runCli(["version"], { cwd, stdout: (line) => aliasOut.push(line), stderr: () => {} });
    await runCli(["help"], { cwd, stdout: (line) => helpOut.push(line), stderr: () => {} });

    expect(versionOut).toEqual([packageJson.version]);
    expect(aliasOut).toEqual([packageJson.version]);
    expect(helpOut.join("\n")).toContain(`gptprouse v${packageJson.version}`);
  });

  it("creates and lists tasks", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const out: string[] = [];

    await runCli(["init"], { cwd, stdout: (line) => out.push(line), stderr: () => {} });
    await runCli(
      ["tasks", "create", "--title", "Review", "--prompt", "Review the plan"],
      { cwd, stdout: (line) => out.push(line), stderr: () => {} }
    );
    await runCli(["tasks", "list"], { cwd, stdout: (line) => out.push(line), stderr: () => {} });

    expect(out.join("\n")).toContain("task_");
    expect(out.join("\n")).toContain("Review");
  });

  it("shows task details by id or latest", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    await writeFile(path.join(cwd, "plan.md"), "plan\n", "utf8");
    const createOut: string[] = [];

    await runCli(["tasks", "create", "--title", "First", "--prompt", "First prompt"], {
      cwd,
      stdout: () => {},
      stderr: () => {}
    });
    await runCli(["tasks", "create", "--title", "Inspect", "--prompt", "Inspect this task", "--file", "plan.md"], {
      cwd,
      stdout: (line) => createOut.push(line),
      stderr: () => {}
    });
    const taskId = createOut[0].split("\t")[0];
    const byIdOut: string[] = [];
    const latestOut: string[] = [];

    await runCli(["tasks", "show", taskId], {
      cwd,
      stdout: (line) => byIdOut.push(line),
      stderr: () => {}
    });
    await runCli(["tasks", "show", "latest"], {
      cwd,
      stdout: (line) => latestOut.push(line),
      stderr: () => {}
    });

    const byId = JSON.parse(byIdOut.join("\n")) as { id?: string; prompt?: string; files?: Array<{ path?: string }> };
    const latest = JSON.parse(latestOut.join("\n")) as { id?: string; prompt?: string };
    expect(byId.id).toBe(taskId);
    expect(byId.prompt).toBe("Inspect this task");
    expect(byId.files).toEqual([expect.objectContaining({ path: "plan.md" })]);
    expect(latest.id).toBe(taskId);
  });

  it("uses task ids as the latest tie-breaker when showing latest task details", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const store = new BridgeStore(cwd);
    await store.ensure();
    const lowerId = {
      schema_version: 1,
      id: "task_20990101_000000_a-task",
      source: "codex",
      status: "new",
      title: "Lower",
      prompt: "Lower prompt",
      repo_id: "default",
      files: [],
      provenance: { adapter: "cli", warnings: [] },
      created_at: "2099-01-01T00:00:00.000Z",
      updated_at: "2099-01-01T00:00:00.000Z"
    };
    const higherId = {
      ...lowerId,
      id: "task_20990101_000000_z-task",
      title: "Higher",
      prompt: "Higher prompt"
    };
    await writeFile(path.join(cwd, ".bridge", "tasks", `${lowerId.id}.json`), `${JSON.stringify(lowerId, null, 2)}\n`, "utf8");
    await writeFile(path.join(cwd, ".bridge", "tasks", `${higherId.id}.json`), `${JSON.stringify(higherId, null, 2)}\n`, "utf8");
    const out: string[] = [];

    await runCli(["tasks", "show", "latest"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const shown = JSON.parse(out.join("\n")) as { id?: string; prompt?: string };
    expect(shown.id).toBe(higherId.id);
    expect(shown.prompt).toBe("Higher prompt");
  });

  it("blocks tasks with a durable blocker result", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const createOut: string[] = [];
    const blockOut: string[] = [];

    await runCli(["tasks", "create", "--title", "Needs browser", "--prompt", "Use ChatGPT Project"], {
      cwd,
      stdout: (line) => createOut.push(line),
      stderr: () => {}
    });
    const taskId = createOut[0].split("\t")[0];

    await runCli(
      [
        "tasks",
        "block",
        taskId,
        "--summary",
        "Visible browser login is required.",
        "--code",
        "browser_login_required",
        "--next-step",
        "Run gptprouse pro browser login.",
        "--retryable"
      ],
      {
        cwd,
        stdout: (line) => blockOut.push(line),
        stderr: () => {}
      }
    );

    const store = new BridgeStore(cwd);
    const task = await store.getTask(taskId);
    const result = await store.getResult(taskId);

    expect(blockOut).toEqual([`${taskId}\tblocked\tVisible browser login is required.`]);
    expect(task.status).toBe("blocked");
    expect(result.status).toBe("blocked");
    expect(result.summary).toBe("Visible browser login is required.");
    expect(result.blocker).toEqual({
      code: "browser_login_required",
      message: "Visible browser login is required.",
      retryable: true,
      next_step: "Run gptprouse pro browser login."
    });
  });

  it("rejects invalid task status filters", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));

    await expect(
      runCli(["tasks", "list", "--status", "claimeed"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow("--status must be one of new, claimed, done, blocked");
  });

  it("rejects unknown task list options", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));

    await expect(
      runCli(["tasks", "list", "--stauts", "blocked"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow("Unknown option for tasks list: --stauts");
  });

  it("rejects unknown options and extra arguments for task mutation commands", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const createOut: string[] = [];
    await runCli(["tasks", "create", "--title", "Review", "--prompt", "Review the plan"], {
      cwd,
      stdout: (line) => createOut.push(line),
      stderr: () => {}
    });
    const taskId = createOut[0].split("\t")[0];

    await expect(
      runCli(["tasks", "create", "--titl", "Review", "--prompt", "Review the plan"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow("Unknown option for tasks create: --titl");
    await expect(
      runCli(["tasks", "create", "--title", "Review", "--prompt", "Review the plan", "extra"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow("Unexpected argument for tasks create: extra");
    await expect(
      runCli(["tasks", "claim", taskId, "extra"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow("Unexpected argument for tasks claim: extra");
    await expect(
      runCli(["tasks", "complete", taskId, "--summry", "Done"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow("Unknown option for tasks complete: --summry");
    await expect(
      runCli(["tasks", "block", taskId, "--summary", "Blocked", "--nextstep", "Retry"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow("Unknown option for tasks block: --nextstep");
  });

  it("rejects unknown setup, start, status, and browser options", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));

    await expect(
      runCli(["setup", "--token-ttl-hour", "24"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow("Unknown option for setup: --token-ttl-hour");
    await expect(
      runCli(["start", "--porrt", "8789"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow("Unknown option for start: --porrt");
    await expect(
      runCli(["status", "--show-tokn", "--url-only"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow("Unknown option for status: --show-tokn");
    await expect(
      runCli(["onboard", "--cwdd", cwd], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow("Unknown option for onboard: --cwdd");
    await expect(
      runCli(["pro", "browser", "login", "--dry-run", "--profile-dri", "profile"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow("Unknown option for pro browser login: --profile-dri");
    await expect(
      runCli(["pro", "browser", "check", "--porrt", "65534"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow("Unknown option for pro browser check: --porrt");
  });

  it("rejects extra arguments for show commands", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const store = new BridgeStore(cwd);
    const task = await store.createTask({
      source: "codex",
      title: "Show strictness",
      prompt: "Reject extra show arguments.",
      repo_id: "default",
      files: [],
      provenance: { adapter: "cli", warnings: [] }
    });
    await store.completeTask(task.id, { status: "done", summary: "Show result." });
    await store.writeSession({
      id: "sess_20990101_000000_show-strictness",
      direction: "codex_to_chatgpt",
      backend: "manual",
      status: "preview"
    });
    await store.writeReceipt({ kind: "consult_preview", summary: "Show receipt" });

    for (const args of [
      ["tasks", "show", "latest", "extra"],
      ["results", "show", "latest", "extra"],
      ["receipts", "show", "latest", "extra"],
      ["sessions", "show", "latest", "extra"]
    ]) {
      await expect(
        runCli(args, {
          cwd,
          stdout: () => {},
          stderr: () => {}
        })
      ).rejects.toThrow(`Unexpected argument for ${args[0]} show: extra`);
    }
  });

  it("runs stdio MCP against an explicit --cwd target instead of the process cwd", async () => {
    const launcherCwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-launcher-"));
    const targetCwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-target-"));
    const cliPath = path.resolve(import.meta.dirname, "..", "src", "cli.ts");
    const tsxLoader = requireFromTest.resolve("tsx");
    const client = new Client({ name: "gptprouse-cli-test", version: "0.2.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", tsxLoader, cliPath, "mcp", "--cwd", targetCwd],
      cwd: launcherCwd,
      stderr: "pipe"
    });

    try {
      await withTimeout(client.connect(transport), 20_000, "Timed out connecting to stdio MCP server");
      await callMcpJsonTool(client, "bridge_create_task", {
        title: "Explicit cwd",
        prompt: "Create this task in the explicit cwd."
      });
    } finally {
      await closeStdioClient(client, transport);
    }

    await expect(readdir(path.join(targetCwd, ".bridge", "tasks"))).resolves.toHaveLength(1);
    await expect(readdir(path.join(launcherCwd, ".bridge", "tasks"))).rejects.toThrow();
  }, 20_000);

  it("rejects flags that are missing required values", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));

    await expect(
      runCli(["tasks", "create", "--title", "--prompt", "Review the plan"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow("--title requires a value");
  });

  it("rejects numeric flags that are not finite numbers", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));

    await expect(
      runCli(["setup", "--port", "not-a-number"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow("--port requires a finite number");

    await expect(
      runCli(["pro", "browser", "check", "--timeout-ms", "not-a-number"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow("--timeout-ms requires a finite number");
  });

  it("adds missing build output ignores even when dependencies are already ignored", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    await writeFile(path.join(cwd, ".gitignore"), "node_modules/\n", "utf8");

    await runCli(["init"], { cwd, stdout: () => {}, stderr: () => {} });

    const gitignore = await readFile(path.join(cwd, ".gitignore"), "utf8");
    expect(gitignore).toContain("node_modules/");
    expect(gitignore).toContain("dist/");
  });

  it("uses an explicit --cwd target for init", async () => {
    const launcherCwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-launcher-"));
    const targetCwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-target-"));
    const out: string[] = [];

    await runCli(["init", "--cwd", targetCwd], {
      cwd: launcherCwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    expect(out).toEqual(["Initialized .bridge receipt ledger."]);
    await expect(readFile(path.join(targetCwd, ".bridge", ".gitignore"), "utf8")).resolves.toContain("tasks/*.json");
    await expect(readFile(path.join(launcherCwd, ".bridge", ".gitignore"), "utf8")).rejects.toThrow();
  });

  it("rejects init when the root gitignore is a symlink", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const outside = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-outside-"));
    const outsideGitignore = path.join(outside, ".gitignore");
    await writeFile(outsideGitignore, "outside\n", "utf8");
    await symlink(outsideGitignore, path.join(cwd, ".gitignore"));

    await expect(
      runCli(["init"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow(/gitignore|symlink/i);
    expect(await readFile(outsideGitignore, "utf8")).toBe("outside\n");
  });

  it("prints ask-pro dry-run bundles", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    await writeFile(path.join(cwd, "notes.md"), "hello\n", "utf8");
    const out: string[] = [];

    await runCli(
      ["ask-pro", "--dry-run", "--file", "notes.md", "Check this"],
      { cwd, stdout: (line) => out.push(line), stderr: () => {} }
    );

    expect(out.join("\n")).toContain("DRY RUN");
    expect(out.join("\n")).toContain("## File: notes.md");
  });

  it("rejects unknown ask-pro flags before they become prompt text", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));

    await expect(
      runCli(["ask-pro", "--dry-run", "--fil", "notes.md", "Check this"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow("Unknown option: --fil");
  });

  it("rejects unknown short ask-pro flags before they become prompt text", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));

    await expect(
      runCli(["ask-pro", "--dry-run", "-n", "Check this"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow("Unknown option: -n");
  });

  it("allows prompt text that looks like flags after a double dash", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const out: string[] = [];

    await runCli(["ask-pro", "--dry-run", "--", "Explain", "--strict", "mode"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(text).toContain("DRY RUN");
    expect(text).toContain("Explain --strict mode");
  });

  it("keeps pro ask dry-run mode when prompt text after double dash contains mode-like flags", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const out: string[] = [];

    await runCli(["pro", "ask", "--", "--send", "hello"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(text).toContain("DRY RUN");
    expect(text).toContain("--send hello");
  });

  it("records ask-pro dry-run previews as consult sessions", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const out: string[] = [];

    await runCli(["ask-pro", "--dry-run", "Check this"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const sessionId = out[0].match(/DRY RUN (sess_[^\s]+)/)?.[1];
    expect(sessionId).toBeDefined();
    const session = JSON.parse(await readFile(path.join(cwd, ".bridge", "sessions", `${sessionId}.json`), "utf8")) as {
      status: string;
      direction: string;
      backend: string;
    };
    expect(session).toEqual(
      expect.objectContaining({
        status: "preview",
        direction: "codex_to_chatgpt",
        backend: "manual"
      })
    );
  });

  it("lists and shows consult sessions", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const previewOut: string[] = [];

    await runCli(["ask-pro", "--dry-run", "Check this"], {
      cwd,
      stdout: (line) => previewOut.push(line),
      stderr: () => {}
    });
    const sessionId = previewOut[0].match(/DRY RUN (sess_[^\s]+)/)?.[1];
    expect(sessionId).toBeDefined();

    const listOut: string[] = [];
    const latestOut: string[] = [];
    const showOut: string[] = [];
    await runCli(["sessions", "list"], {
      cwd,
      stdout: (line) => listOut.push(line),
      stderr: () => {}
    });
    await runCli(["sessions", "show", "latest"], {
      cwd,
      stdout: (line) => latestOut.push(line),
      stderr: () => {}
    });
    await runCli(["sessions", "show", sessionId ?? ""], {
      cwd,
      stdout: (line) => showOut.push(line),
      stderr: () => {}
    });

    const text = listOut.join("\n");
    expect(text).toContain(`${sessionId}\tpreview\tmanual\tcodex_to_chatgpt`);
    const latest = JSON.parse(latestOut.join("\n")) as { id?: string };
    const shown = JSON.parse(showOut.join("\n")) as {
      id?: string;
      status?: string;
      direction?: string;
      backend?: string;
    };
    expect(latest.id).toBe(sessionId);
    expect(shown).toEqual(
      expect.objectContaining({
        id: sessionId,
        status: "preview",
        direction: "codex_to_chatgpt",
        backend: "manual"
      })
    );
  });

  it("lists and shows receipts with legacy inline write content redacted", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const store = new BridgeStore(cwd);
    await store.writeReceipt({
      task_id: "task_20990101_000000_other",
      kind: "repo_write_dry_run",
      summary: "Other dry-run write"
    });
    const receipt = await store.writeReceipt({
      task_id: "task_20990101_000000_target",
      kind: "repo_write_dry_run",
      summary: "Legacy dry-run write",
      metadata: {
        path: "notes.md",
        diff: "--- a/notes.md\n+++ b/notes.md\n-legacy secret before\n+safe after",
        new_content: "sensitive replacement payload",
        new_sha256: "abc123"
      }
    });
    const listOut: string[] = [];
    const taskListOut: string[] = [];
    const showOut: string[] = [];

    await runCli(["receipts", "list", "--kind", "repo_write_dry_run"], {
      cwd,
      stdout: (line) => listOut.push(line),
      stderr: () => {}
    });
    await runCli(["receipts", "list", "--kind", "repo_write_dry_run", "--task-id", "task_20990101_000000_target"], {
      cwd,
      stdout: (line) => taskListOut.push(line),
      stderr: () => {}
    });
    await runCli(["receipts", "show", "latest"], {
      cwd,
      stdout: (line) => showOut.push(line),
      stderr: () => {}
    });

    expect(listOut.join("\n")).toContain(`${receipt.id}\trepo_write_dry_run\tLegacy dry-run write`);
    expect(taskListOut).toEqual([`${receipt.id}\trepo_write_dry_run\tLegacy dry-run write`]);
    const shown = JSON.parse(showOut.join("\n")) as { id?: string; metadata?: Record<string, unknown> };
    expect(shown.id).toBe(receipt.id);
    expect(showOut.join("\n")).not.toContain("sensitive replacement payload");
    expect(showOut.join("\n")).not.toContain("legacy secret before");
    expect(shown.metadata?.new_content).toBeUndefined();
    expect(shown.metadata?.new_content_redacted).toEqual(
      expect.objectContaining({ reason: "legacy inline replacement content" })
    );
    expect(shown.metadata?.diff).toBeUndefined();
    expect(shown.metadata?.diff_redacted).toEqual(expect.objectContaining({ reason: "write preview diff" }));
  });

  it("rejects invalid receipt kind filters", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));

    await expect(
      runCli(["receipts", "list", "--kind", "not_a_receipt"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow("--kind must be one of");
  });

  it("rejects unknown receipt list options", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));

    await expect(
      runCli(["receipts", "list", "--kinnd", "repo_write_dry_run"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow("Unknown option for receipts list: --kinnd");
  });

  it("filters listed sessions by status", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const previewOut: string[] = [];
    const blockedOut: string[] = [];

    await runCli(["ask-pro", "--dry-run", "Preview this"], {
      cwd,
      stdout: (line) => previewOut.push(line),
      stderr: () => {}
    });
    await runCli(["tasks", "create", "--title", "GPT Pro consult", "--prompt", "Ask Pro"], {
      cwd,
      stdout: (line) => blockedOut.push(line),
      stderr: () => {}
    });
    const taskId = blockedOut[0].split("\t")[0];
    const store = new BridgeStore(cwd);
    await store.writeSession({
      id: "sess_20990101_000000_blocked-consult",
      direction: "codex_to_chatgpt",
      backend: "chatgpt-control",
      task_id: taskId,
      status: "blocked"
    });

    const out: string[] = [];
    await runCli(["sessions", "list", "--status", "blocked"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(text).toContain("sess_20990101_000000_blocked-consult\tblocked\tchatgpt-control\tcodex_to_chatgpt");
    expect(text).not.toContain("preview\tmanual");
    expect(previewOut[0]).toContain("DRY RUN sess_");
  });

  it("rejects invalid session status filters", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));

    await expect(
      runCli(["sessions", "list", "--status", "runnning"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow(/preview, running, done, blocked/);
  });

  it("rejects unknown session list options", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));

    await expect(
      runCli(["sessions", "list", "--stats", "blocked"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow("Unknown option for sessions list: --stats");
  });

  it("ignores legacy invalid session filenames when listing sessions", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const previewOut: string[] = [];

    await runCli(["ask-pro", "--dry-run", "Check this"], {
      cwd,
      stdout: (line) => previewOut.push(line),
      stderr: () => {}
    });
    const sessionId = previewOut[0].match(/DRY RUN (sess_[^\s]+)/)?.[1];
    expect(sessionId).toBeDefined();
    await writeFile(path.join(cwd, ".bridge", "sessions", "chatgpt-pro-browser.json"), "{}\n", "utf8");

    const out: string[] = [];
    await runCli(["sessions", "list"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    expect(out.join("\n")).toContain(`${sessionId}\tpreview\tmanual\tcodex_to_chatgpt`);
  });

  it("prints ask-pro dry-run bundles when optional session recording fails", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    setSafeFileTestHooks({
      beforeOpen: (filePath, operation) => {
        if (operation === "write" && filePath.includes(`${path.sep}.sess_`)) {
          throw new Error("forced session write failure");
        }
      }
    });
    const out: string[] = [];
    const err: string[] = [];

    await runCli(["ask-pro", "--dry-run", "Check this"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line)
    });

    expect(out.join("\n")).toContain("DRY RUN");
    expect(out.join("\n")).toContain("This preview was not sent anywhere.");
    expect(err.join("\n")).toContain("session_record_warning");
    const receiptFiles = await readdir(path.join(cwd, ".bridge", "receipts"));
    const receipts = await Promise.all(
      receiptFiles.map(async (file) => JSON.parse(await readFile(path.join(cwd, ".bridge", "receipts", file), "utf8")) as { kind: string })
    );
    expect(receipts).toContainEqual(expect.objectContaining({ kind: "consult_preview" }));
  });

  it("lists and shows GPT Pro answers with the short pro command", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const out: string[] = [];

    const createOut: string[] = [];
    await runCli(
      ["tasks", "create", "--title", "GPT Pro consult", "--prompt", "Ask Pro"],
      { cwd, stdout: (line) => createOut.push(line), stderr: () => {} }
    );
    const taskId = createOut[0].split("\t")[0];
    await runCli(["tasks", "claim", taskId, "--by", "chatgpt-pro"], { cwd, stdout: () => {}, stderr: () => {} });
    await runCli(
      ["tasks", "complete", taskId, "--summary", "Use receipt-gated writes next.", "--command", "visible ChatGPT browser consult"],
      { cwd, stdout: () => {}, stderr: () => {} }
    );

    await runCli(["pro", "list"], { cwd, stdout: (line) => out.push(line), stderr: () => {} });
    await runCli(["pro", "latest"], { cwd, stdout: (line) => out.push(line), stderr: () => {} });
    await runCli(["pro", "show", "latest"], { cwd, stdout: (line) => out.push(line), stderr: () => {} });

    expect(out.join("\n")).toContain(taskId);
    expect(out.join("\n")).toContain("task_id:");
    expect(out.join("\n")).toContain("Use receipt-gated writes next.");
  });

  it("prints result artifact content only from result records", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const store = new BridgeStore(cwd);
    const task = await store.createTask({
      source: "codex",
      title: "GPT Pro consult",
      prompt: "Ask Pro",
      provenance: { adapter: "cli", warnings: [] }
    });
    const artifactPath = await store.writeArtifactText(".bridge/artifacts/pro-consults/answer.md", "artifact answer");
    await store.completeTask(task.id, {
      status: "done",
      summary: "See artifact.",
      artifacts: [{ path: artifactPath, role: "result", bytes: "artifact answer".length }]
    });
    const out: string[] = [];

    await runCli(["results", "artifact", task.id], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    expect(out).toEqual(["artifact answer"]);
  });

  it("prints the latest result artifact content", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const store = new BridgeStore(cwd);
    const task = await store.createTask({
      source: "codex",
      title: "GPT Pro consult",
      prompt: "Ask Pro",
      provenance: { adapter: "cli", warnings: [] }
    });
    const artifactPath = await store.writeArtifactText(".bridge/artifacts/pro-consults/latest-answer.md", "latest artifact answer");
    await store.completeTask(task.id, {
      status: "done",
      summary: "See artifact.",
      artifacts: [{ path: artifactPath, role: "result", bytes: "latest artifact answer".length }]
    });
    const out: string[] = [];

    await runCli(["results", "artifact", "latest"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    expect(out).toEqual(["latest artifact answer"]);
  });

  it("shows result details by id or latest", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const firstCreateOut: string[] = [];
    const byIdOut: string[] = [];
    const latestShowOut: string[] = [];

    await runCli(["tasks", "create", "--title", "First consult", "--prompt", "First prompt"], {
      cwd,
      stdout: (line) => firstCreateOut.push(line),
      stderr: () => {}
    });
    const firstTaskId = firstCreateOut[0].split("\t")[0];
    await runCli(["tasks", "complete", firstTaskId, "--summary", "First answer"], {
      cwd,
      stdout: () => {},
      stderr: () => {}
    });

    const secondOut: string[] = [];
    await runCli(["tasks", "create", "--title", "Latest consult", "--prompt", "Latest prompt"], {
      cwd,
      stdout: (line) => secondOut.push(line),
      stderr: () => {}
    });
    const latestTaskId = secondOut[0].split("\t")[0];
    await runCli(["tasks", "complete", latestTaskId, "--summary", "Latest answer", "--command", "visible consult"], {
      cwd,
      stdout: () => {},
      stderr: () => {}
    });

    await runCli(["results", "show", firstTaskId], {
      cwd,
      stdout: (line) => byIdOut.push(line),
      stderr: () => {}
    });
    await runCli(["results", "show", "latest"], {
      cwd,
      stdout: (line) => latestShowOut.push(line),
      stderr: () => {}
    });

    const byId = JSON.parse(byIdOut.join("\n")) as { task_id?: string; summary?: string };
    const latest = JSON.parse(latestShowOut.join("\n")) as { task_id?: string; summary?: string; commands?: string[] };
    expect(byId.task_id).toBe(firstTaskId);
    expect(byId.summary).toBe("First answer");
    expect(latest.task_id).toBe(latestTaskId);
    expect(latest.summary).toBe("Latest answer");
    expect(latest.commands).toEqual(["visible consult"]);
  });

  it("keeps pro ask as a dry-run preview unless browser send is explicit", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    await writeFile(path.join(cwd, "notes.md"), "manual bridge first\n", "utf8");
    const out: string[] = [];

    await runCli(["pro", "ask", "--file", "notes.md", "Review this"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(text).toContain("DRY RUN");
    expect(text).toContain("## File: notes.md");
    expect(text).toContain("manual bridge first");
  });

  it("labels pro ask as a dry-run preview in help", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const out: string[] = [];

    await runCli(["help"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(text).toContain('gptprouse pro ask [--file path] "prompt"  # dry-run preview');
    expect(text).toContain("gptprouse pro browser login [--dry-run]  # preview/open visible browser login");
    expect(text).toContain('gptprouse pro browser ask [--target-url url --confirm-target] [--file path] "prompt"  # explicit visible-browser send');
  });

  it("lists task blocking command in help", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const out: string[] = [];

    await runCli(["help"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    expect(out.join("\n")).toContain(
      'gptprouse tasks block <task-id> --summary "Summary" [--code code] [--next-step "Next step"] [--retryable]'
    );
  });

  it("lists task inspection command in help", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const out: string[] = [];

    await runCli(["help"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    expect(out.join("\n")).toContain("gptprouse tasks show <task-id|latest>");
  });

  it("lists session inspection commands in help", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const out: string[] = [];

    await runCli(["help"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(text).toContain("gptprouse sessions list [--status preview|running|done|blocked]");
    expect(text).toContain("gptprouse sessions show <session-id|latest>");
  });

  it("lists result inspection commands in help", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const out: string[] = [];

    await runCli(["help"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(text).toContain("gptprouse results show <task-id|latest>");
    expect(text).toContain("gptprouse results artifact <task-id|latest> [artifact-path]");
  });

  it("lists receipt inspection commands in help", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const out: string[] = [];

    await runCli(["help"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(text).toContain("gptprouse receipts list [--kind kind] [--task-id task-id]");
    expect(text).toContain("gptprouse receipts show <receipt-id|latest>");
  });

  it("documents explicit MCP cwd selection in help", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const out: string[] = [];

    await runCli(["help"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(text).toContain("gptprouse setup [--cwd /absolute/path/to/repo]");
    expect(text).toContain("gptprouse start [--cwd /absolute/path/to/repo]");
    expect(text).toContain("gptprouse status [--cwd /absolute/path/to/repo]");
    expect(text).toContain("gptprouse tunnel url [--cwd /absolute/path/to/repo]");
    expect(text).toContain("gptprouse doctor [--cwd /absolute/path/to/repo]");
    expect(text).toContain("gptprouse onboard [--cwd /absolute/path/to/repo]");
    expect(text).toContain("gptprouse mcp [--cwd /absolute/path/to/repo]");
  });

  it("lists the project prompt command in help", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const out: string[] = [];

    await runCli(["help"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    expect(out.join("\n")).toContain("gptprouse project prompt [--cwd /absolute/path/to/repo]");
    expect(out.join("\n")).toContain("gptprouse claude prompt [--cwd /absolute/path/to/repo]");
    expect(out.join("\n")).toContain(
      "gptprouse claude config [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js]"
    );
  });

  it("project prompt prints a paste-ready ChatGPT Project MCP verification prompt", async () => {
    const launcherCwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-launcher-"));
    const targetCwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-target-"));
    const out: string[] = [];

    await runCli(["project", "prompt", "--cwd", targetCwd], {
      cwd: launcherCwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(text).toContain("ChatGPT Project MCP verification prompt");
    expect(text).toContain("Paste this into the ChatGPT Project after adding the gptprouse MCP server URL.");
    expect(text).toContain("bridge_create_task");
    expect(text).toContain("bridge_list_tasks");
    expect(text).toContain("bridge_get_task");
    expect(text).toContain(`cd ${targetCwd}`);
    expect(text).toContain("gptprouse tasks list --status new");
    expect(text).toContain(targetCwd);
    expect(text).not.toContain("gptprouse_token=");
  });

  it("project prompt rejects unknown ChatGPT Project helper subcommands", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));

    await expect(
      runCli(["project", "verify"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow("project requires prompt");
  });

  it("claude prompt prints a paste-ready Claude MCP verification prompt", async () => {
    const launcherCwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-launcher-"));
    const targetCwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-target-"));
    const out: string[] = [];

    await runCli(["claude", "prompt", "--cwd", targetCwd], {
      cwd: launcherCwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(text).toContain("Claude MCP verification prompt");
    expect(text).toContain("Paste this into Claude after adding the gptprouse stdio MCP server.");
    expect(text).toContain("bridge_create_task");
    expect(text).toContain("bridge_list_tasks");
    expect(text).toContain("bridge_get_task");
    expect(text).toContain(`cd ${targetCwd}`);
    expect(text).toContain("gptprouse tasks list --status new");
    expect(text).toContain(targetCwd);
    expect(text).not.toContain("gptprouse_token=");
  });

  it("claude prompt rejects unknown Claude helper subcommands", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));

    await expect(
      runCli(["claude", "verify"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow("claude requires prompt or config");
  });

  it("claude config prints installed-package Claude MCP JSON", async () => {
    const launcherCwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-launcher-"));
    const targetCwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-target-"));
    const out: string[] = [];

    await runCli(["claude", "config", "--cwd", targetCwd], {
      cwd: launcherCwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const parsed = JSON.parse(out.join("\n")) as {
      mcpServers?: { gptprouse?: { command?: string; args?: string[] } };
    };
    expect(parsed.mcpServers?.gptprouse?.command).toBe("gptprouse");
    expect(parsed.mcpServers?.gptprouse?.args).toEqual(["mcp", "--cwd", targetCwd]);
    expect(out.join("\n")).not.toContain("gptprouse_token=");
  });

  it("claude config can print source-checkout Claude MCP JSON", async () => {
    const launcherCwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-launcher-"));
    const targetCwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-target-"));
    const sourceCli = path.join(launcherCwd, "dist", "cli.js");
    await mkdir(path.dirname(sourceCli), { recursive: true });
    await writeFile(sourceCli, "#!/usr/bin/env node\n", "utf8");
    const out: string[] = [];

    await runCli(["claude", "config", "--cwd", targetCwd, "--source-cli", sourceCli], {
      cwd: launcherCwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const parsed = JSON.parse(out.join("\n")) as {
      mcpServers?: { gptprouse?: { command?: string; args?: string[] } };
    };
    expect(parsed.mcpServers?.gptprouse?.command).toBe("node");
    expect(parsed.mcpServers?.gptprouse?.args).toEqual([sourceCli, "mcp", "--cwd", targetCwd]);
    expect(out.join("\n")).not.toContain("gptprouse_token=");
  });

  it("onboard prints first-run commands without exposing tokens or changing state", async () => {
    const launcherCwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-launcher-"));
    const targetCwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-target-"));
    const out: string[] = [];

    await runCli(["onboard", "--cwd", targetCwd], {
      cwd: launcherCwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(text).toContain("gptprouse onboarding");
    expect(text).toContain(`repo: ${targetCwd}`);
    expect(text).toContain(`gptprouse init --cwd ${targetCwd}`);
    expect(text).toContain(`gptprouse doctor --cwd ${targetCwd}`);
    expect(text).toContain(`gptprouse claude config --cwd ${targetCwd}`);
    expect(text).toContain(`gptprouse claude prompt --cwd ${targetCwd}`);
    expect(text).toContain(`gptprouse setup --cwd ${targetCwd} --token-ttl-hours 24`);
    expect(text).toContain(`gptprouse start --cwd ${targetCwd}`);
    expect(text).toContain(`gptprouse status --cwd ${targetCwd} --show-token --url-only`);
    expect(text).toContain(`gptprouse project prompt --cwd ${targetCwd}`);
    expect(text.indexOf("HTTP MCP uses a short-lived token")).toBeLessThan(
      text.indexOf(`gptprouse status --cwd ${targetCwd} --show-token --url-only`)
    );
    expect(text).toContain('gptprouse pro ask --file README.md "Review this repo"  # dry-run/manual preview');
    expect(text).toContain("gptprouse pro browser login --dry-run  # preview, no browser opens");
    expect(text).toContain("gptprouse pro browser login  # opens visible browser");
    expect(text).toContain("gptprouse pro browser check");
    expect(text).toContain("gptprouse pro browser smoke");
    expect(text).toContain('gptprouse pro browser ask --file README.md "Review this repo"  # visible-browser send');
    expect(text).toContain("manual, visible browser");
    expect(text).toContain("Cloudflare");
    expect(text).not.toContain("gptprouse_token=");
    await expect(readFile(path.join(targetCwd, ".bridge", "config.local.json"), "utf8")).rejects.toThrow();
  });

  it("describes token TTL as an explicit help placeholder", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const out: string[] = [];

    await runCli(["help"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(text).toContain("gptprouse setup [--cwd /absolute/path/to/repo] [--host 127.0.0.1] [--port 8787] [--token-ttl-hours <hours>]");
    expect(text).not.toContain("[--token-ttl-hours 24]");
  });

  it("keeps low-level browser aliases out of primary help", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const out: string[] = [];

    await runCli(["help"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(text).toContain("gptprouse pro ask [--file path]");
    expect(text).toContain("gptprouse pro browser login [--dry-run]");
    expect(text).toContain("gptprouse pro browser check|smoke");
    expect(text).toContain("gptprouse pro browser ask");
    expect(text).not.toContain("gptprouse pro browser open|status");
    expect(text).not.toContain("gptprouse chatgpt open|status|smoke");
  });

  it("lists the release status command in help", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const out: string[] = [];

    await runCli(["help"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    expect(out.join("\n")).toContain("gptprouse release status [--cwd /absolute/path/to/repo]");
  });

  it("release status reports the missing public license blocker", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-release-"));
    await writeFile(
      path.join(cwd, "package.json"),
      `${JSON.stringify({ name: "demo", version: "1.0.0", private: false }, null, 2)}\n`,
      "utf8"
    );
    const out: string[] = [];

    await runCli(["release", "status", "--cwd", cwd], {
      cwd: "/tmp",
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(text).toContain("gptprouse release status");
    expect(text).toContain("package: demo@1.0.0");
    expect(text).toContain("metadata: blocked");
    expect(text).toContain("package.json must include an explicit license");
    expect(text).toContain("git: blocked not a git worktree");
    expect(text).toContain("next: choose a license, add LICENSE, then run `npm run release:check`");
    expect(text).not.toContain("metadata: ok");
  });

  it("release status reports a missing package.json as a release blocker", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-release-missing-"));
    const out: string[] = [];

    await runCli(["release", "status", "--cwd", cwd], {
      cwd: "/tmp",
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(text).toContain("gptprouse release status");
    expect(text).toContain("metadata: blocked");
    expect(text).toContain("package.json not found");
    expect(text).toContain("git: blocked");
    expect(text).not.toContain("ENOENT");
  });

  it("release status reports publish metadata readiness when license files are explicit", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-release-"));
    await writeFile(
      path.join(cwd, "package.json"),
      `${JSON.stringify({ name: "demo", version: "1.0.0", license: "MIT" }, null, 2)}\n`,
      "utf8"
    );
    await writeFile(path.join(cwd, "LICENSE"), "MIT License\n", "utf8");
    const out: string[] = [];

    await runCli(["release", "status", "--cwd", cwd], {
      cwd: "/tmp",
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(text).toContain("package: demo@1.0.0");
    expect(text).toContain("metadata: ok license=MIT license_file=present");
    expect(text).toContain("next: run `npm run release:check` before publishing");
  });

  it("release status reports private packages as not publishable", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-release-"));
    await writeFile(
      path.join(cwd, "package.json"),
      `${JSON.stringify({ name: "demo", version: "1.0.0", license: "MIT", private: true }, null, 2)}\n`,
      "utf8"
    );
    await writeFile(path.join(cwd, "LICENSE"), "MIT License\n", "utf8");
    const out: string[] = [];

    await runCli(["release", "status", "--cwd", cwd], {
      cwd: "/tmp",
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(text).toContain("metadata: blocked");
    expect(text).toContain("private: true");
    expect(text).toContain("remove `private: true` before public publishing");
    expect(text).not.toContain("metadata: ok");
  });

  it("release status reports unlicensed packages as not publishable", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-release-"));
    await writeFile(
      path.join(cwd, "package.json"),
      `${JSON.stringify({ name: "demo", version: "1.0.0", license: "UNLICENSED" }, null, 2)}\n`,
      "utf8"
    );
    const out: string[] = [];

    await runCli(["release", "status", "--cwd", cwd], {
      cwd: "/tmp",
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(text).toContain('metadata: blocked license "UNLICENSED" is not publishable');
    expect(text).toContain("choose a public license");
    expect(text).not.toContain("set `private: true`");
    expect(text).not.toContain("metadata: ok");
  });

  it("release status reports a clean git worktree without a remote as blocked", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-release-"));
    await writeFile(
      path.join(cwd, "package.json"),
      `${JSON.stringify({ name: "demo", version: "1.0.0", license: "MIT" }, null, 2)}\n`,
      "utf8"
    );
    await writeFile(path.join(cwd, "LICENSE"), "MIT License\n", "utf8");
    await execFileAsync("git", ["init"], { cwd });
    await execFileAsync("git", ["config", "user.email", "release@example.com"], { cwd });
    await execFileAsync("git", ["config", "user.name", "Release Test"], { cwd });
    await execFileAsync("git", ["add", "package.json", "LICENSE"], { cwd });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd });
    const branch = (await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd })).stdout.trim();
    const commit = (await execFileAsync("git", ["rev-parse", "--short", "HEAD"], { cwd })).stdout.trim();
    const out: string[] = [];

    await runCli(["release", "status", "--cwd", cwd], {
      cwd: "/tmp",
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(text).toContain("metadata: ok license=MIT license_file=present");
    expect(text).toContain(`git: blocked no remote configured branch=${branch} commit=${commit}`);
    expect(text).toContain("git_next: add a git remote before public release");
  });

  it("release status reports dirty git worktrees before release", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-release-"));
    await writeFile(
      path.join(cwd, "package.json"),
      `${JSON.stringify({ name: "demo", version: "1.0.0", license: "MIT" }, null, 2)}\n`,
      "utf8"
    );
    await writeFile(path.join(cwd, "LICENSE"), "MIT License\n", "utf8");
    await execFileAsync("git", ["init"], { cwd });
    await execFileAsync("git", ["config", "user.email", "release@example.com"], { cwd });
    await execFileAsync("git", ["config", "user.name", "Release Test"], { cwd });
    await execFileAsync("git", ["add", "package.json", "LICENSE"], { cwd });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd });
    await execFileAsync("git", ["remote", "add", "origin", "https://example.com/demo.git"], { cwd });
    const branch = (await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd })).stdout.trim();
    const commit = (await execFileAsync("git", ["rev-parse", "--short", "HEAD"], { cwd })).stdout.trim();
    await writeFile(path.join(cwd, "README.md"), "dirty\n", "utf8");
    const out: string[] = [];

    await runCli(["release", "status", "--cwd", cwd], {
      cwd: "/tmp",
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(text).toContain("git: blocked worktree has uncommitted changes");
    expect(text).toContain("files=1");
    expect(text).toContain(`branch=${branch}`);
    expect(text).toContain(`commit=${commit}`);
    expect(text).toContain("remote=origin");
    expect(text).toContain("git_next: commit or stash local changes before release");
  });

  it("release status reports git readiness when worktree and remote are ready", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-release-"));
    await writeFile(
      path.join(cwd, "package.json"),
      `${JSON.stringify({ name: "demo", version: "1.0.0", license: "MIT" }, null, 2)}\n`,
      "utf8"
    );
    await writeFile(path.join(cwd, "LICENSE"), "MIT License\n", "utf8");
    await execFileAsync("git", ["init"], { cwd });
    await execFileAsync("git", ["config", "user.email", "release@example.com"], { cwd });
    await execFileAsync("git", ["config", "user.name", "Release Test"], { cwd });
    await execFileAsync("git", ["add", "package.json", "LICENSE"], { cwd });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd });
    await execFileAsync("git", ["remote", "add", "origin", "https://example.com/demo.git"], { cwd });
    const branch = (await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd })).stdout.trim();
    const commit = (await execFileAsync("git", ["rev-parse", "--short", "HEAD"], { cwd })).stdout.trim();
    const out: string[] = [];

    await runCli(["release", "status", "--cwd", cwd], {
      cwd: "/tmp",
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    expect(out.join("\n")).toContain(`git: ok branch=${branch} commit=${commit} remote=origin`);
  });

  it("release status rejects unknown release helper subcommands", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));

    await expect(
      runCli(["release", "publish"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow("release requires status");
  });

  it("requires explicit browser namespace for browser product checks", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const out: string[] = [];

    await runCli(["pro", "browser", "check", "--port", "65534", "--timeout-ms", "10"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    expect(out.join("\n")).toContain("chatgpt: browser_unreachable");
  });

  it("prints a friendly browser login guide without opening Chrome in dry-run mode", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const out: string[] = [];

    await runCli(["pro", "browser", "login", "--dry-run"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(text).toContain("ChatGPT Pro browser login");
    expect(text).toContain("Log in manually");
    expect(text).toContain("gptprouse pro browser check");
    expect(text).toContain("gptprouse pro browser smoke");
    expect(text).not.toContain("node dist/cli.js");
    expect(text).toContain("You can close this Chrome window after login");
  });

  it("fails browser login cleanly before printing the guide when Chrome cannot be launched", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const out: string[] = [];
    const previousChrome = process.env.GPTPROUSE_CHROME;
    process.env.GPTPROUSE_CHROME = "/definitely/not/present";
    try {
      await expect(
        runCli(["pro", "browser", "login"], {
          cwd,
          stdout: (line) => out.push(line),
          stderr: () => {}
        })
      ).rejects.toThrow(/GPTPROUSE_CHROME|Chrome|Chromium/i);
    } finally {
      if (previousChrome === undefined) delete process.env.GPTPROUSE_CHROME;
      else process.env.GPTPROUSE_CHROME = previousChrome;
    }

    expect(out.join("\n")).not.toContain("ChatGPT Pro browser login");
  });

  it("rejects a browser command path that points to a directory", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const out: string[] = [];
    const previousChrome = process.env.GPTPROUSE_CHROME;
    process.env.GPTPROUSE_CHROME = tmpdir();
    try {
      await expect(
        runCli(["pro", "browser", "login"], {
          cwd,
          stdout: (line) => out.push(line),
          stderr: () => {}
        })
      ).rejects.toThrow(/executable browser/i);
    } finally {
      if (previousChrome === undefined) delete process.env.GPTPROUSE_CHROME;
      else process.env.GPTPROUSE_CHROME = previousChrome;
    }

    expect(out.join("\n")).not.toContain("ChatGPT Pro browser login");
  });

  it("rejects an executable browser command that is not Chrome-compatible", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const out: string[] = [];
    const previousChrome = process.env.GPTPROUSE_CHROME;
    process.env.GPTPROUSE_CHROME = "/bin/true";
    try {
      await expect(
        runCli(["pro", "browser", "login"], {
          cwd,
          stdout: (line) => out.push(line),
          stderr: () => {}
        })
      ).rejects.toThrow(/Chrome|Chromium/i);
    } finally {
      if (previousChrome === undefined) delete process.env.GPTPROUSE_CHROME;
      else process.env.GPTPROUSE_CHROME = previousChrome;
    }

    expect(out.join("\n")).not.toContain("ChatGPT Pro browser login");
  });

  it("fails browser login before printing the guide when Chrome exits immediately", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const fakeChrome = path.join(cwd, "fake-chrome");
    const out: string[] = [];
    const previousChrome = process.env.GPTPROUSE_CHROME;
    await writeFile(
      fakeChrome,
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then',
        '  echo "Google Chrome 123.0.0.0"',
        "  exit 0",
        "fi",
        "exit 42",
        ""
      ].join("\n"),
      "utf8"
    );
    await chmod(fakeChrome, 0o755);
    process.env.GPTPROUSE_CHROME = fakeChrome;
    try {
      await expect(
        runCli(["pro", "browser", "login", "--profile-dir", path.join(cwd, "profile"), "--port", "65529"], {
          cwd,
          stdout: (line) => out.push(line),
          stderr: () => {}
        })
      ).rejects.toThrow(/exited immediately|Chrome|browser/i);
    } finally {
      if (previousChrome === undefined) delete process.env.GPTPROUSE_CHROME;
      else process.env.GPTPROUSE_CHROME = previousChrome;
    }

    expect(out.join("\n")).not.toContain("ChatGPT Pro browser login");
    expect(out.join("\n")).not.toContain("Opened the dedicated Chrome window");
  });

  it("fails browser login before printing the guide when Chrome exits after the initial grace window", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const fakeChrome = path.join(cwd, "fake-chrome");
    const out: string[] = [];
    const previousChrome = process.env.GPTPROUSE_CHROME;
    await writeFile(
      fakeChrome,
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then',
        '  echo "Google Chrome 123.0.0.0"',
        "  exit 0",
        "fi",
        "sleep 1.2",
        "exit 42",
        ""
      ].join("\n"),
      "utf8"
    );
    await chmod(fakeChrome, 0o755);
    process.env.GPTPROUSE_CHROME = fakeChrome;
    try {
      await expect(
        runCli(["pro", "browser", "login", "--profile-dir", path.join(cwd, "profile"), "--port", "65527"], {
          cwd,
          stdout: (line) => out.push(line),
          stderr: () => {}
        })
      ).rejects.toThrow(/exited|DevTools|Chrome|browser/i);
    } finally {
      if (previousChrome === undefined) delete process.env.GPTPROUSE_CHROME;
      else process.env.GPTPROUSE_CHROME = previousChrome;
    }

    expect(out.join("\n")).not.toContain("ChatGPT Pro browser login");
    expect(out.join("\n")).not.toContain("Opened the dedicated Chrome window");
  });

  it("allows browser login handoff when DevTools is already reachable", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const fakeChrome = path.join(cwd, "fake-chrome");
    const out: string[] = [];
    const previousChrome = process.env.GPTPROUSE_CHROME;
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(request.url === "/json/list" ? "[]" : "{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    await writeFile(
      fakeChrome,
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then',
        '  echo "Google Chrome 123.0.0.0"',
        "  exit 0",
        "fi",
        "exit 0",
        ""
      ].join("\n"),
      "utf8"
    );
    await chmod(fakeChrome, 0o755);
    process.env.GPTPROUSE_CHROME = fakeChrome;
    try {
      await expect(
        runCli(["pro", "browser", "login", "--profile-dir", path.join(cwd, "profile"), "--port", String(port)], {
          cwd,
          stdout: (line) => out.push(line),
          stderr: () => {}
        })
      ).resolves.toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (previousChrome === undefined) delete process.env.GPTPROUSE_CHROME;
      else process.env.GPTPROUSE_CHROME = previousChrome;
    }

    expect(out.join("\n")).toContain("ChatGPT Pro browser login");
    expect(out.join("\n")).toContain("Opened the dedicated Chrome window");
  });

  it("allows browser login handoff when DevTools becomes reachable shortly after Chrome exits", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const fakeChrome = path.join(cwd, "fake-chrome");
    const out: string[] = [];
    const previousChrome = process.env.GPTPROUSE_CHROME;
    let devtoolsRequests = 0;
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/json/list" && ++devtoolsRequests < 3) {
        response.statusCode = 503;
        response.end("{}");
        return;
      }
      response.end(request.url === "/json/list" ? "[]" : "{}");
    });
    await writeFile(
      fakeChrome,
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then',
        '  echo "Google Chrome 123.0.0.0"',
        "  exit 0",
        "fi",
        "exit 0",
        ""
      ].join("\n"),
      "utf8"
    );
    await chmod(fakeChrome, 0o755);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    process.env.GPTPROUSE_CHROME = fakeChrome;
    try {
      await expect(
        runCli(["pro", "browser", "login", "--profile-dir", path.join(cwd, "profile"), "--port", String(port)], {
          cwd,
          stdout: (line) => out.push(line),
          stderr: () => {}
        })
      ).resolves.toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (previousChrome === undefined) delete process.env.GPTPROUSE_CHROME;
      else process.env.GPTPROUSE_CHROME = previousChrome;
    }

    expect(out.join("\n")).toContain("ChatGPT Pro browser login");
    expect(out.join("\n")).toContain("Opened the dedicated Chrome window");
  });

  it("fails legacy browser open before printing success when Chrome exits immediately", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const fakeChrome = path.join(cwd, "fake-chrome");
    const out: string[] = [];
    const previousChrome = process.env.GPTPROUSE_CHROME;
    await writeFile(
      fakeChrome,
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then',
        '  echo "Google Chrome 123.0.0.0"',
        "  exit 0",
        "fi",
        "exit 42",
        ""
      ].join("\n"),
      "utf8"
    );
    await chmod(fakeChrome, 0o755);
    process.env.GPTPROUSE_CHROME = fakeChrome;
    try {
      await expect(
        runCli(["chatgpt", "open", "--profile-dir", path.join(cwd, "profile"), "--port", "65528"], {
          cwd,
          stdout: (line) => out.push(line),
          stderr: () => {}
        })
      ).rejects.toThrow(/exited immediately|Chrome|browser/i);
    } finally {
      if (previousChrome === undefined) delete process.env.GPTPROUSE_CHROME;
      else process.env.GPTPROUSE_CHROME = previousChrome;
    }

    expect(out.join("\n")).not.toContain("Opened ChatGPT browser");
  });

  it("rejects fake Chrome-compatible commands found on PATH", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const binDir = await mkdtemp(path.join(tmpdir(), "gptprouse-fake-browser-"));
    const out: string[] = [];
    const previousPath = process.env.PATH;
    const previousChrome = process.env.GPTPROUSE_CHROME;
    for (const command of ["google-chrome", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"]) {
      const fake = path.join(binDir, command);
      await writeFile(fake, "#!/bin/sh\nexit 0\n", "utf8");
      await chmod(fake, 0o755);
    }
    process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
    delete process.env.GPTPROUSE_CHROME;
    try {
      await expect(
        runCli(["pro", "browser", "login"], {
          cwd,
          stdout: (line) => out.push(line),
          stderr: () => {}
        })
      ).rejects.toThrow(/Chrome|Chromium/i);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousChrome === undefined) delete process.env.GPTPROUSE_CHROME;
      else process.env.GPTPROUSE_CHROME = previousChrome;
    }

    expect(out.join("\n")).not.toContain("ChatGPT Pro browser login");
  });

  it("points unreachable browser checks at the login flow", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const out: string[] = [];

    await runCli(["pro", "browser", "check", "--port", "65534", "--timeout-ms", "10"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    expect(out.join("\n")).toContain("pro browser login");
  });

  it("does not keep old pro browser aliases at the top level", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));

    await expect(
      runCli(["pro", "status", "--port", "65534", "--timeout-ms", "10"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow(/pro browser/);
  });

  it("requires explicit confirmation before using a ChatGPT target URL", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));

    await expect(
      runCli(["pro", "browser", "ask", "--target-url", "https://chatgpt.com/c/abc", "Review this"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow(/--confirm-target/);
  });

  it("prints a product check instead of failing when setup pieces are missing", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const out: string[] = [];

    await runCli(["pro", "browser", "check", "--port", "65534", "--timeout-ms", "10"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(text).toContain("bridge: ok");
    expect(text).toContain("config: missing");
    expect(text).toContain("chatgpt: browser_unreachable");
    expect(text).toContain("latest_pro: missing");
  });

  it("redacts the local MCP token in product checks", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    await runCli(["setup", "--port", "8789", "--token", "super-secret-token"], {
      cwd,
      stdout: () => {},
      stderr: () => {}
    });
    const out: string[] = [];

    await runCli(["pro", "browser", "check", "--port", "65534", "--timeout-ms", "10"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(text).toContain("gptprouse_token=***");
    expect(text).not.toContain("super-secret-token");
  });

  it("redacts local MCP tokens from setup, start, and status output by default", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const setupOut: string[] = [];

    await runCli(["setup", "--port", "8789", "--token", "super-secret-token"], {
      cwd,
      stdout: (line) => setupOut.push(line),
      stderr: () => {}
    });
    const statusOut: string[] = [];
    await runCli(["status"], {
      cwd,
      stdout: (line) => statusOut.push(line),
      stderr: () => {}
    });

    const text = [...setupOut, ...statusOut].join("\n");
    expect(text).toContain("gptprouse_token=***");
    expect(text).not.toContain("super-secret-token");
  });

  it("uses an explicit --cwd target for local HTTP MCP setup, status, and tunnel URLs", async () => {
    const launcherCwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-launcher-"));
    const targetCwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-target-"));

    await runCli(["setup", "--cwd", targetCwd, "--port", "8789", "--token", "super-secret-token", "--token-ttl-hours", "1"], {
      cwd: launcherCwd,
      stdout: () => {},
      stderr: () => {}
    });

    await expect(readFile(path.join(targetCwd, ".bridge", "config.local.json"), "utf8")).resolves.toContain("super-secret-token");
    await expect(readFile(path.join(launcherCwd, ".bridge", "config.local.json"), "utf8")).rejects.toThrow();

    const statusOut: string[] = [];
    await runCli(["status", "--cwd", targetCwd, "--show-token", "--url-only"], {
      cwd: launcherCwd,
      stdout: (line) => statusOut.push(line),
      stderr: () => {}
    });

    expect(statusOut).toEqual(["http://127.0.0.1:8789/mcp?gptprouse_token=super-secret-token"]);

    const tunnelOut: string[] = [];
    await runCli(["tunnel", "url", "--cwd", targetCwd, "--public-url", "https://example.trycloudflare.com", "--show-token", "--url-only"], {
      cwd: launcherCwd,
      stdout: (line) => tunnelOut.push(line),
      stderr: () => {}
    });

    expect(tunnelOut).toEqual(["https://example.trycloudflare.com/mcp?gptprouse_token=super-secret-token"]);
  });

  it("uses an explicit --cwd target for local HTTP MCP start", async () => {
    const launcherCwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-launcher-"));
    const targetCwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-target-"));
    await runCli(["setup", "--cwd", targetCwd, "--port", "8789", "--token", "super-secret-token", "--token-ttl-hours", "1"], {
      cwd: launcherCwd,
      stdout: () => {},
      stderr: () => {}
    });
    const out: string[] = [];

    const start = runCli(["start", "--cwd", targetCwd, "--port", "0"], {
      cwd: launcherCwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });
    const stop = setTimeout(() => process.emit("SIGTERM"), 50);

    await expect(start).resolves.toBe(0);
    clearTimeout(stop);
    expect(out.join("\n")).toContain("gptprouse_token=***");
    expect(out.join("\n")).not.toContain("super-secret-token");
  });

  it("uses an explicit --cwd target for doctor checks", async () => {
    const launcherCwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-launcher-"));
    const targetCwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-target-"));
    await runCli(["setup", "--cwd", targetCwd, "--port", "8789", "--token", "super-secret-token"], {
      cwd: launcherCwd,
      stdout: () => {},
      stderr: () => {}
    });
    const out: string[] = [];

    const code = await runCli(["doctor", "--cwd", targetCwd], {
      cwd: launcherCwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(code).toBe(0);
    expect(text).toContain("config: ok");
    expect(text).toContain("http_mcp_smoke: ok");
    expect(text).not.toContain("super-secret-token");
    await expect(readFile(path.join(launcherCwd, ".bridge", "config.local.json"), "utf8")).rejects.toThrow();
  });

  it("refuses to reveal a non-expiring local MCP token by default", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    await runCli(["setup", "--port", "8789", "--token", "super-secret-token"], {
      cwd,
      stdout: () => {},
      stderr: () => {}
    });
    const out: string[] = [];

    await expect(
      runCli(["status", "--show-token"], {
        cwd,
        stdout: (line) => out.push(line),
        stderr: () => {}
      })
    ).rejects.toThrow("status --show-token requires a token with expiry");

    expect(out.join("\n")).not.toContain("super-secret-token");
  });

  it("refuses url-only token reveal for non-expiring local MCP tokens by default", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    await runCli(["setup", "--port", "8789", "--token", "super-secret-token"], {
      cwd,
      stdout: () => {},
      stderr: () => {}
    });
    const out: string[] = [];

    await expect(
      runCli(["status", "--show-token", "--url-only"], {
        cwd,
        stdout: (line) => out.push(line),
        stderr: () => {}
      })
    ).rejects.toThrow("status --show-token requires a token with expiry");

    expect(out).toEqual([]);
  });

  it("reveals a non-expiring token only with the unsafe local-debug override", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    await runCli(["setup", "--port", "8789", "--token", "super-secret-token"], {
      cwd,
      stdout: () => {},
      stderr: () => {}
    });
    const out: string[] = [];

    await runCli(["status", "--show-token", "--unsafe-show-non-expiring-token", "--url-only"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    expect(out).toEqual(["http://127.0.0.1:8789/mcp?gptprouse_token=super-secret-token"]);
  });

  it("prints a paste-ready local MCP URL when url-only is requested", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    await runCli(["setup", "--port", "8789", "--token", "super-secret-token", "--token-ttl-hours", "1"], {
      cwd,
      stdout: () => {},
      stderr: () => {}
    });
    const out: string[] = [];

    await runCli(["status", "--show-token", "--url-only"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    expect(out).toEqual(["http://127.0.0.1:8789/mcp?gptprouse_token=super-secret-token"]);
  });

  it("refuses to reveal expired local MCP tokens", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    await mkdir(path.join(cwd, ".bridge"), { recursive: true });
    await writeFile(
      path.join(cwd, ".bridge", "config.local.json"),
      `${JSON.stringify(
        {
          schema_version: 1,
          host: "127.0.0.1",
          port: 8789,
          token: "expired-secret-token",
          server_url: "http://127.0.0.1:8789/mcp?gptprouse_token=expired-secret-token",
          token_expires_at: new Date(Date.now() - 1000).toISOString(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    const out: string[] = [];

    await expect(
      runCli(["status", "--show-token", "--url-only"], {
        cwd,
        stdout: (line) => out.push(line),
        stderr: () => {}
      })
    ).rejects.toThrow(/token expired/i);

    expect(out.join("\n")).not.toContain("expired-secret-token");
  });

  it("prints token expiry status when setup uses a TTL", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    await runCli(["setup", "--port", "8789", "--token", "super-secret-token", "--token-ttl-hours", "1"], {
      cwd,
      stdout: () => {},
      stderr: () => {}
    });
    const out: string[] = [];

    await runCli(["status"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const status = JSON.parse(out.join("\n")) as { token_status?: string; token_expires_at?: string; server_url?: string };
    expect(status.token_status).toBe("valid");
    expect(Date.parse(status.token_expires_at ?? "")).toBeGreaterThan(Date.now());
    expect(status.server_url).toContain("gptprouse_token=***");
    expect(out.join("\n")).not.toContain("super-secret-token");
  });

  it("strips URL userinfo from status output while preserving token redaction controls", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    await mkdir(path.join(cwd, ".bridge"), { recursive: true });
    await writeFile(
      path.join(cwd, ".bridge", "config.local.json"),
      `${JSON.stringify(
        {
          schema_version: 1,
          host: "127.0.0.1",
          port: 8787,
          token: "secret-token",
          server_url: "http://user:pass@127.0.0.1:8787/mcp?gptprouse_token=secret-token",
          token_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    const redactedOut: string[] = [];
    const tokenOut: string[] = [];

    await runCli(["status"], {
      cwd,
      stdout: (line) => redactedOut.push(line),
      stderr: () => {}
    });
    await runCli(["status", "--show-token", "--url-only"], {
      cwd,
      stdout: (line) => tokenOut.push(line),
      stderr: () => {}
    });

    expect(redactedOut.join("\n")).not.toContain("user:pass");
    expect(redactedOut.join("\n")).toContain("gptprouse_token=***");
    expect(redactedOut.join("\n")).not.toContain("secret-token");
    expect(tokenOut).toEqual(["http://127.0.0.1:8787/mcp?gptprouse_token=secret-token"]);
  });

  it("keeps status url-only output limited to the MCP URL when token expiry exists", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    await runCli(["setup", "--port", "8789", "--token", "super-secret-token", "--token-ttl-hours", "1"], {
      cwd,
      stdout: () => {},
      stderr: () => {}
    });
    const out: string[] = [];

    await runCli(["status", "--show-token", "--url-only"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    expect(out).toEqual(["http://127.0.0.1:8789/mcp?gptprouse_token=super-secret-token"]);
  });

  it("prints a setup hint instead of a raw missing-file error before status", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));

    await expect(
      runCli(["status"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow("status requires local MCP setup. Run `gptprouse setup --token-ttl-hours <hours>` first.");
  });

  it("refuses to start with an expired configured token", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    await writeExpiredLocalConfig(cwd);

    const start = runCli(["start"], {
      cwd,
      stdout: () => {},
      stderr: () => {}
    });
    const stop = setTimeout(() => process.emit("SIGTERM"), 50);

    await expect(start).rejects.toThrow(/token expired/i);
    clearTimeout(stop);
  });

  it("requires setup before start creates a persisted local MCP config", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));

    const start = runCli(["start"], {
      cwd,
      stdout: () => {},
      stderr: () => {}
    });
    const stop = setTimeout(() => process.emit("SIGTERM"), 50);

    await expect(start).rejects.toThrow(/setup/i);
    clearTimeout(stop);
    await expect(readFile(path.join(cwd, ".bridge", "config.local.json"), "utf8")).rejects.toThrow();
  });

  it("does not replace corrupt local MCP config when starting", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    await mkdir(path.join(cwd, ".bridge"), { recursive: true });
    await writeFile(path.join(cwd, ".bridge", "config.local.json"), "{not json", "utf8");

    const start = runCli(["start"], {
      cwd,
      stdout: () => {},
      stderr: () => {}
    });
    const stop = setTimeout(() => process.emit("SIGTERM"), 50);

    await expect(start).rejects.toThrow();
    clearTimeout(stop);
  });

  it("runs a local doctor smoke for bridge storage and MCP writes", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const out: string[] = [];

    const code = await runCli(["doctor"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(code).toBe(0);
    expect(text).toContain("gptprouse doctor");
    expect(text).toContain("bridge: ok");
    expect(text).toContain("config: missing");
    expect(text).toContain("mcp_write_smoke: ok");
    expect(text).toContain("receipt_payload=artifact");
    expect(text).toContain("staged=notes.md");
    expect(text).toContain("http_mcp_smoke: ok");
    expect(text).toContain("task_flow=ok");
    expect(text).toContain("finalizers=ok");
    expect(text).toContain("search=ok");
    expect(text).toContain("bridge_create_task");
    expect(text).toContain("bridge_list_tasks");
    expect(text).toContain("bridge_get_task");
    expect(text).toContain("bridge_claim_task");
    expect(text).toContain("bridge_complete_task");
    expect(text).toContain("bridge_block_task");
    expect(text).toContain("bridge_list_results");
    expect(text).toContain("bridge_fetch_result");
    expect(text).toContain("bridge_list_sessions");
    expect(text).toContain("bridge_get_session");
    expect(text).toContain("bridge_fetch_result_artifact");
    expect(text).toContain("bridge_list_receipts");
    expect(text).toContain("bridge_get_receipt");
    expect(text).toContain("repo_stage_reviewed_paths");
  });

  it("redacts local MCP tokens from doctor output", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    await runCli(["setup", "--port", "8789", "--token", "super-secret-token"], {
      cwd,
      stdout: () => {},
      stderr: () => {}
    });
    const out: string[] = [];

    await runCli(["doctor"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(text).toContain("gptprouse_token=***");
    expect(text).not.toContain("super-secret-token");
  });

  it("reports corrupt local MCP config as a doctor failure", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    await mkdir(path.join(cwd, ".bridge"), { recursive: true });
    await writeFile(path.join(cwd, ".bridge", "config.local.json"), "{not json", "utf8");
    const out: string[] = [];

    const code = await runCli(["doctor"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(code).toBe(1);
    expect(text).toContain("config: failed");
    expect(text).not.toContain("config: missing");
    expect(text).toContain("mcp_write_smoke: ok");
  });

  it("reports expired local MCP config as a doctor failure", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    await writeExpiredLocalConfig(cwd);
    const out: string[] = [];

    const code = await runCli(["doctor"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(code).toBe(1);
    expect(text).toContain("config: failed token expired");
    expect(text).not.toContain("expired-secret-token");
    expect(text).toContain("mcp_write_smoke: ok");
  });

  it("prints a paste-ready public tunnel MCP URL only with an explicit token reveal", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    await runCli(["setup", "--port", "8789", "--token", "super-secret-token", "--token-ttl-hours", "1"], {
      cwd,
      stdout: () => {},
      stderr: () => {}
    });
    const out: string[] = [];

    await runCli(["tunnel", "url", "--public-url", "https://example.trycloudflare.com/path?ignored=1", "--show-token", "--url-only"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    expect(out).toEqual(["https://example.trycloudflare.com/mcp?gptprouse_token=super-secret-token"]);
  });

  it("redacts public tunnel MCP URL tokens by default", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    await runCli(["setup", "--port", "8789", "--token", "super-secret-token", "--token-ttl-hours", "1"], {
      cwd,
      stdout: () => {},
      stderr: () => {}
    });
    const out: string[] = [];

    await runCli(["tunnel", "url", "--public-url", "https://example.trycloudflare.com"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    const payload = JSON.parse(text) as { mcp_url?: string; token_status?: string; warnings?: string[] };
    expect(payload.mcp_url).toBe("https://example.trycloudflare.com/mcp?gptprouse_token=***");
    expect(payload.token_status).toBe("valid");
    expect(payload.warnings?.join("\n")).toContain("does not create a tunnel");
    expect(text).not.toContain("super-secret-token");
  });

  it("redacts public tunnel MCP URL tokens in url-only output unless explicitly revealed", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    await runCli(["setup", "--port", "8789", "--token", "super-secret-token", "--token-ttl-hours", "1"], {
      cwd,
      stdout: () => {},
      stderr: () => {}
    });
    const out: string[] = [];

    await runCli(["tunnel", "url", "--public-url", "https://example.trycloudflare.com", "--url-only"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    expect(out).toEqual(["https://example.trycloudflare.com/mcp?gptprouse_token=***"]);
  });

  it("requires a short-lived token before printing a public tunnel MCP URL", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    await runCli(["setup", "--port", "8789", "--token", "super-secret-token"], {
      cwd,
      stdout: () => {},
      stderr: () => {}
    });

    await expect(
      runCli(["tunnel", "url", "--public-url", "https://example.trycloudflare.com"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow(/token-ttl-hours/);
  });

  it("rejects public tunnel MCP URLs for expired tokens", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    await writeExpiredLocalConfig(cwd);

    await expect(
      runCli(["tunnel", "url", "--public-url", "https://example.trycloudflare.com"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow(/token expired/i);
  });

  it("rejects non-HTTPS public tunnel URLs", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    await runCli(["setup", "--port", "8789", "--token", "super-secret-token", "--token-ttl-hours", "1"], {
      cwd,
      stdout: () => {},
      stderr: () => {}
    });

    await expect(
      runCli(["tunnel", "url", "--public-url", "http://example.com"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow(/https/i);
  });

  it("strips userinfo from public tunnel URLs", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    await runCli(["setup", "--port", "8789", "--token", "super-secret-token", "--token-ttl-hours", "1"], {
      cwd,
      stdout: () => {},
      stderr: () => {}
    });
    const out: string[] = [];

    await runCli(["tunnel", "url", "--public-url", "https://user:pass@example.trycloudflare.com", "--show-token", "--url-only"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    expect(out).toEqual(["https://example.trycloudflare.com/mcp?gptprouse_token=super-secret-token"]);
  });

  it("allows non-HTTPS loopback tunnel URL formatting for local diagnostics", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    await runCli(["setup", "--port", "8789", "--token", "super-secret-token", "--token-ttl-hours", "1"], {
      cwd,
      stdout: () => {},
      stderr: () => {}
    });
    const out: string[] = [];

    await runCli(["tunnel", "url", "--public-url", "http://localhost:7777/dev", "--show-token", "--url-only"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    expect(out).toEqual(["http://localhost:7777/mcp?gptprouse_token=super-secret-token"]);
  });
});

async function writeExpiredLocalConfig(cwd: string): Promise<void> {
  await mkdir(path.join(cwd, ".bridge"), { recursive: true });
  await writeFile(
    path.join(cwd, ".bridge", "config.local.json"),
    `${JSON.stringify(
      {
        schema_version: 1,
        host: "127.0.0.1",
        port: 8789,
        token: "expired-secret-token",
        server_url: "http://127.0.0.1:8789/mcp?gptprouse_token=expired-secret-token",
        token_expires_at: new Date(Date.now() - 1000).toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

async function callMcpJsonTool(client: Client, name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await withTimeout(client.callTool({ name, arguments: args }), 20_000, `Timed out calling ${name}`);
  const text = result.content.find((item) => item.type === "text")?.text;
  if (!text) throw new Error(`Tool ${name} did not return text content`);
  return JSON.parse(text);
}

async function closeStdioClient(client: Client, transport: StdioClientTransport): Promise<void> {
  const processRef = captureStdioTransportProcess(transport);
  const closePromise = client.close();
  closePromise.catch(() => undefined);
  try {
    await withTimeout(closePromise, 10_000, "Timed out closing stdio MCP client");
  } catch (error) {
    forceKillStdioProcess(processRef);
    await waitForStdioProcessExit(processRef, 2_000).catch(() => undefined);
    throw error;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

type CapturedStdioProcess = {
  child?: {
    exitCode: number | null;
    signalCode: string | null;
    kill(signal: string): void;
    once(event: "exit", listener: () => void): void;
  };
  pid?: number;
};

function captureStdioTransportProcess(transport: StdioClientTransport): CapturedStdioProcess {
  const raw = transport as unknown as { _process?: CapturedStdioProcess["child"]; pid?: number };
  return { child: raw._process, pid: raw.pid };
}

function forceKillStdioProcess(processRef: CapturedStdioProcess): void {
  const child = processRef.child;
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    return;
  }
  if (processRef.pid) {
    try {
      process.kill(processRef.pid, "SIGKILL");
    } catch {
      // Process already exited.
    }
  }
}

async function waitForStdioProcessExit(processRef: CapturedStdioProcess, timeoutMs: number): Promise<void> {
  const child = processRef.child;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await withTimeout(
    new Promise<void>((resolve) => child.once("exit", resolve)),
    timeoutMs,
    "Timed out waiting for killed stdio MCP process"
  );
}
