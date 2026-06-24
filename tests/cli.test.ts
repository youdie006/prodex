import { chmod, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { setSafeFileTestHooks } from "../src/safe-file.js";
import { BridgeStore } from "../src/store.js";

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
    expect(shown.metadata?.new_content).toBeUndefined();
    expect(shown.metadata?.new_content_redacted).toEqual(
      expect.objectContaining({ reason: "legacy inline replacement content" })
    );
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

  it("describes token TTL as an explicit help placeholder", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const out: string[] = [];

    await runCli(["help"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(text).toContain("gptprouse setup [--host 127.0.0.1] [--port 8787] [--token-ttl-hours <hours>]");
    expect(text).not.toContain("[--token-ttl-hours 24]");
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

  it("prints the local MCP URL token only when explicitly requested", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    await runCli(["setup", "--port", "8789", "--token", "super-secret-token"], {
      cwd,
      stdout: () => {},
      stderr: () => {}
    });
    const out: string[] = [];

    await runCli(["status", "--show-token"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    expect(out.join("\n")).toContain("super-secret-token");
  });

  it("prints a paste-ready local MCP URL when url-only is requested", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    await runCli(["setup", "--port", "8789", "--token", "super-secret-token"], {
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
