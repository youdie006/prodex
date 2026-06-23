import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpToolHandlers } from "../src/mcp-tools.js";
import { setRepoWriteTestHooks } from "../src/repo-write.js";
import { setSafeFileTestHooks } from "../src/safe-file.js";
import { BridgeStore } from "../src/store.js";

const execFileAsync = promisify(execFile);

describe("MCP tool handlers", () => {
  afterEach(() => {
    setSafeFileTestHooks({});
    setRepoWriteTestHooks({});
  });

  it("creates tasks and fetches results through Claude-compatible handlers", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    const handlers = createMcpToolHandlers({ cwd });

    const created = await handlers.bridge_create_task({
      title: "From Claude",
      prompt: "Please hand this to Codex.",
      repo_id: "default",
      files: []
    });

    expect(created.task.id).toContain("task_");

    const listed = await handlers.bridge_list_tasks({});
    expect(listed.tasks.map((task) => task.title)).toContain("From Claude");
  });

  it("completes and blocks bridge tasks through MCP handlers", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    const handlers = createMcpToolHandlers({ cwd });
    const doneTask = await handlers.bridge_create_task({
      title: "Done through MCP",
      prompt: "Finish this task"
    });
    const blockedTask = await handlers.bridge_create_task({
      title: "Blocked through MCP",
      prompt: "Report why this cannot continue"
    });

    const completed = await handlers.bridge_complete_task({
      task_id: doneTask.task.id,
      summary: "Finished from MCP",
      commands: ["npm test -- tests/mcp-tools.test.ts"]
    });
    const blocked = await handlers.bridge_block_task({
      task_id: blockedTask.task.id,
      summary: "Needs local browser login",
      code: "browser_login_required",
      next_step: "Run gptprouse pro browser login.",
      retryable: true,
      commands: ["gptprouse pro browser check"]
    });

    const store = new BridgeStore(cwd);
    await expect(store.getTask(doneTask.task.id)).resolves.toEqual(expect.objectContaining({ status: "done" }));
    await expect(store.getTask(blockedTask.task.id)).resolves.toEqual(
      expect.objectContaining({
        status: "blocked",
        blocker: expect.objectContaining({ code: "browser_login_required", retryable: true })
      })
    );
    expect(completed.result).toEqual(
      expect.objectContaining({
        task_id: doneTask.task.id,
        status: "done",
        summary: "Finished from MCP",
        commands: ["npm test -- tests/mcp-tools.test.ts"]
      })
    );
    expect(blocked.result).toEqual(
      expect.objectContaining({
        task_id: blockedTask.task.id,
        status: "blocked",
        summary: "Needs local browser login",
        commands: ["gptprouse pro browser check"],
        blocker: {
          code: "browser_login_required",
          message: "Needs local browser login",
          retryable: true,
          next_step: "Run gptprouse pro browser login."
        }
      })
    );
  });

  it("normalizes MCP completion artifacts to fetchable result artifacts", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    const store = new BridgeStore(cwd);
    const handlers = createMcpToolHandlers({ cwd });
    const task = await handlers.bridge_create_task({
      title: "Artifact role",
      prompt: "Attach an answer artifact"
    });
    const artifactPath = await store.writeArtifactText(".bridge/artifacts/pro-consults/mcp-answer.md", "answer\n");

    const completed = await handlers.bridge_complete_task({
      task_id: task.task.id,
      summary: "See answer artifact.",
      artifacts: [{ path: artifactPath, role: "context", bytes: "answer\n".length }]
    });
    const fetched = await handlers.bridge_fetch_result_artifact({ task_id: task.task.id });

    expect(completed.result.artifacts).toEqual([expect.objectContaining({ path: artifactPath, role: "result" })]);
    expect(fetched.content).toBe("answer\n");
  });

  it("lists and fetches consult sessions through bridge handlers", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    const store = new BridgeStore(cwd);
    const session = await store.writeSession({
      id: "sess_20990101_000000_mcp-session",
      direction: "codex_to_chatgpt",
      backend: "manual",
      status: "preview"
    });
    const handlers = createMcpToolHandlers({ cwd });

    const listed = await handlers.bridge_list_sessions({ status: "preview" });
    const fetched = await handlers.bridge_get_session({ session_id: session.id });

    expect(listed.sessions.map((item) => item.id)).toEqual([session.id]);
    expect(fetched.session).toEqual(expect.objectContaining({ id: session.id, status: "preview" }));
  });

  it("lists and fetches receipts with legacy inline write content redacted", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    const store = new BridgeStore(cwd);
    const receipt = await store.writeReceipt({
      kind: "repo_write_dry_run",
      summary: "Legacy dry-run write",
      metadata: {
        path: "notes.md",
        new_content: "sensitive replacement payload",
        new_sha256: "abc123"
      }
    });
    const handlers = createMcpToolHandlers({ cwd });

    const listed = await handlers.bridge_list_receipts({ kind: "repo_write_dry_run" });
    const fetched = await handlers.bridge_get_receipt({ receipt_id: receipt.id });

    expect(listed.receipts.map((item) => item.id)).toEqual([receipt.id]);
    expect(JSON.stringify(fetched)).not.toContain("sensitive replacement payload");
    expect(fetched.receipt.metadata.new_content).toBeUndefined();
    expect(fetched.receipt.metadata.new_content_redacted).toEqual(
      expect.objectContaining({ reason: "legacy inline replacement content" })
    );
  });

  it("fetches only result-listed artifacts through bridge handlers", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    const store = new BridgeStore(cwd);
    const task = await store.createTask({
      source: "codex",
      title: "GPT Pro consult",
      prompt: "Ask Pro",
      provenance: { adapter: "cli", warnings: [] }
    });
    const resultArtifact = await store.writeArtifactText(".bridge/artifacts/pro-consults/answer.md", "artifact answer");
    const repoWriteArtifact = await store.writeArtifactText(".bridge/artifacts/repo-writes/payload.txt", "replacement payload");
    await store.completeTask(task.id, {
      status: "done",
      summary: "See artifact.",
      artifacts: [{ path: resultArtifact, role: "result", bytes: "artifact answer".length }]
    });
    const handlers = createMcpToolHandlers({ cwd });

    const fetched = await handlers.bridge_fetch_result_artifact({ task_id: task.id });

    expect(fetched).toEqual({
      artifact: expect.objectContaining({ path: resultArtifact, role: "result" }),
      content: "artifact answer"
    });
    await expect(
      handlers.bridge_fetch_result_artifact({ task_id: task.id, path: repoWriteArtifact })
    ).rejects.toThrow(/Result artifact not found/);
  });

  it("rejects repo-write artifacts even when a result record lists them as result artifacts", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    const store = new BridgeStore(cwd);
    const task = await store.createTask({
      source: "codex",
      title: "GPT Pro consult",
      prompt: "Ask Pro",
      provenance: { adapter: "cli", warnings: [] }
    });
    const repoWriteArtifact = await store.writeArtifactText(".bridge/artifacts/repo-writes/payload.txt", "replacement payload");
    await store.completeTask(task.id, {
      status: "done",
      summary: "Tampered artifact list.",
      artifacts: [{ path: repoWriteArtifact, role: "result", bytes: "replacement payload".length }]
    });
    const handlers = createMcpToolHandlers({ cwd });

    await expect(handlers.bridge_fetch_result_artifact({ task_id: task.id })).rejects.toThrow(/not a fetchable result artifact/);
  });

  it("rejects result artifact paths that traverse out of the pro consult namespace", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    const store = new BridgeStore(cwd);
    const task = await store.createTask({
      source: "codex",
      title: "GPT Pro consult",
      prompt: "Ask Pro",
      provenance: { adapter: "cli", warnings: [] }
    });
    await store.writeArtifactText(".bridge/artifacts/repo-writes/payload.txt", "replacement payload");
    await store.completeTask(task.id, {
      status: "done",
      summary: "Tampered artifact list.",
      artifacts: [
        {
          path: ".bridge/artifacts/pro-consults/../repo-writes/payload.txt",
          role: "result",
          bytes: "replacement payload".length
        }
      ]
    });
    const handlers = createMcpToolHandlers({ cwd });

    await expect(handlers.bridge_fetch_result_artifact({ task_id: task.id })).rejects.toThrow(/not a fetchable result artifact/);
  });

  it("exposes read-only repo file access", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    await writeFile(path.join(cwd, "README.md"), "alpha\nbeta\n", "utf8");
    const handlers = createMcpToolHandlers({ cwd });

    const result = await handlers.repo_read_file({ path: "README.md", start_line: 2, max_lines: 1 });

    expect(result.content).toBe("beta");
  });

  it("creates a write dry-run receipt and applies it only with matching head and preimage", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    await writeFile(path.join(cwd, "notes.md"), "old\n", "utf8");
    const head = await initGitRepo(cwd);
    const handlers = createMcpToolHandlers({ cwd });

    const dryRun = await handlers.repo_write_file_dry_run({
      path: "notes.md",
      content: "new\n",
      expected_head: head
    });

    expect(await readFile(path.join(cwd, "notes.md"), "utf8")).toBe("old\n");
    expect(dryRun.receipt.kind).toBe("repo_write_dry_run");
    expect(dryRun.path).toBe("notes.md");
    expect(dryRun.diff).toContain("-old");
    expect(dryRun.diff).toContain("+new");

    const applied = await handlers.repo_write_file_apply({
      receipt_id: dryRun.receipt.id,
      expected_head: head,
      preimage_sha256: dryRun.preimage_sha256
    });

    expect(applied.receipt.kind).toBe("repo_write_applied");
    expect(await readFile(path.join(cwd, "notes.md"), "utf8")).toBe("new\n");
  });

  it("stores write dry-run replacement content as an artifact instead of receipt metadata", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    await writeFile(path.join(cwd, "notes.md"), "old\n", "utf8");
    const head = await initGitRepo(cwd);
    const handlers = createMcpToolHandlers({ cwd });

    const dryRun = await handlers.repo_write_file_dry_run({
      path: "notes.md",
      content: "new\n",
      expected_head: head
    });
    const storedReceipt = JSON.parse(
      await readFile(path.join(cwd, ".bridge", "receipts", `${dryRun.receipt.id}.json`), "utf8")
    );

    expect(storedReceipt.metadata.new_content).toBeUndefined();
    expect(storedReceipt.metadata.new_content_artifact).toMatch(/^\.bridge\/artifacts\/repo-writes\/[a-f0-9]{64}\.txt$/);
    expect(await readFile(path.join(cwd, storedReceipt.metadata.new_content_artifact), "utf8")).toBe("new\n");
  });

  it("rejects write apply when the stored payload artifact was changed", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    await writeFile(path.join(cwd, "notes.md"), "old\n", "utf8");
    const head = await initGitRepo(cwd);
    const handlers = createMcpToolHandlers({ cwd });
    const dryRun = await handlers.repo_write_file_dry_run({
      path: "notes.md",
      content: "new\n",
      expected_head: head
    });
    const storedReceipt = JSON.parse(
      await readFile(path.join(cwd, ".bridge", "receipts", `${dryRun.receipt.id}.json`), "utf8")
    );
    await writeFile(path.join(cwd, storedReceipt.metadata.new_content_artifact), "tampered\n", "utf8");

    await expect(
      handlers.repo_write_file_apply({
        receipt_id: dryRun.receipt.id,
        expected_head: head,
        preimage_sha256: dryRun.preimage_sha256
      })
    ).rejects.toThrow(/artifact content/);
  });

  it("applies legacy dry-run receipts that stored replacement content inline", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    await writeFile(path.join(cwd, "notes.md"), "old\n", "utf8");
    const head = await initGitRepo(cwd);
    const store = new BridgeStore(cwd);
    const legacyReceipt = await store.writeReceipt({
      kind: "repo_write_dry_run",
      summary: "Legacy dry-run write for notes.md",
      metadata: {
        path: "notes.md",
        expected_head: head,
        preimage_sha256: sha256("old\n"),
        new_sha256: sha256("legacy\n"),
        diff: "--- a/notes.md\n+++ b/notes.md\n-old\n+legacy",
        new_content: "legacy\n"
      }
    });
    const handlers = createMcpToolHandlers({ cwd });

    await handlers.repo_write_file_apply({
      receipt_id: legacyReceipt.id,
      expected_head: head,
      preimage_sha256: sha256("old\n")
    });

    expect(await readFile(path.join(cwd, "notes.md"), "utf8")).toBe("legacy\n");
  });

  it("rejects write apply when the file preimage changed after dry-run", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    await writeFile(path.join(cwd, "notes.md"), "old\n", "utf8");
    const head = await initGitRepo(cwd);
    const handlers = createMcpToolHandlers({ cwd });
    const dryRun = await handlers.repo_write_file_dry_run({
      path: "notes.md",
      content: "new\n",
      expected_head: head
    });
    await writeFile(path.join(cwd, "notes.md"), "changed\n", "utf8");

    await expect(
      handlers.repo_write_file_apply({
        receipt_id: dryRun.receipt.id,
        expected_head: head,
        preimage_sha256: dryRun.preimage_sha256
      })
    ).rejects.toThrow(/preimage/);
  });

  it("rejects write apply when the target is swapped to a symlink before write", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    const outside = await mkdtemp(path.join(tmpdir(), "gptprouse-outside-"));
    const outsideFile = path.join(outside, "secret.txt");
    const repoFile = path.join(cwd, "notes.md");
    await writeFile(outsideFile, "outside\n", "utf8");
    await writeFile(repoFile, "old\n", "utf8");
    const head = await initGitRepo(cwd);
    const handlers = createMcpToolHandlers({ cwd });
    const dryRun = await handlers.repo_write_file_dry_run({
      path: "notes.md",
      content: "new\n",
      expected_head: head
    });
    let swapped = false;
    setSafeFileTestHooks({
      beforeOpen: async (filePath) => {
        if (!swapped && filePath === repoFile) {
          swapped = true;
          await rm(repoFile);
          await symlink(outsideFile, repoFile);
        }
      }
    });

    await expect(
      handlers.repo_write_file_apply({
        receipt_id: dryRun.receipt.id,
        expected_head: head,
        preimage_sha256: dryRun.preimage_sha256
      })
    ).rejects.toThrow(/symlink|changed|escapes/i);
    expect(await readFile(outsideFile, "utf8")).toBe("outside\n");
  });

  it("rejects write apply when the target content changes after preimage validation", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    const repoFile = path.join(cwd, "notes.md");
    await writeFile(repoFile, "old\n", "utf8");
    const head = await initGitRepo(cwd);
    const handlers = createMcpToolHandlers({ cwd });
    const dryRun = await handlers.repo_write_file_dry_run({
      path: "notes.md",
      content: "new\n",
      expected_head: head
    });
    let changed = false;
    setSafeFileTestHooks({
      beforeOpen: async (filePath, operation) => {
        if (!changed && operation === "write" && filePath === repoFile) {
          changed = true;
          await writeFile(repoFile, "raced\n", "utf8");
        }
      }
    });

    await expect(
      handlers.repo_write_file_apply({
        receipt_id: dryRun.receipt.id,
        expected_head: head,
        preimage_sha256: dryRun.preimage_sha256
      })
    ).rejects.toThrow(/preimage|changed/i);
    expect(await readFile(repoFile, "utf8")).toBe("raced\n");
  });

  it("rejects write apply when the target content changes immediately before replacement", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    const repoFile = path.join(cwd, "notes.md");
    await writeFile(repoFile, "old\n", "utf8");
    const head = await initGitRepo(cwd);
    const handlers = createMcpToolHandlers({ cwd });
    const dryRun = await handlers.repo_write_file_dry_run({
      path: "notes.md",
      content: "new\n",
      expected_head: head
    });
    let changed = false;
    setSafeFileTestHooks({
      beforeReplace: async (filePath) => {
        if (!changed && filePath === repoFile) {
          changed = true;
          await writeFile(repoFile, "raced immediately\n", "utf8");
        }
      }
    });

    await expect(
      handlers.repo_write_file_apply({
        receipt_id: dryRun.receipt.id,
        expected_head: head,
        preimage_sha256: dryRun.preimage_sha256
      })
    ).rejects.toThrow(/preimage|changed/i);
    expect(await readFile(repoFile, "utf8")).toBe("raced immediately\n");
  });

  it("rejects write dry-runs when git HEAD does not match", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    await writeFile(path.join(cwd, "notes.md"), "old\n", "utf8");
    await initGitRepo(cwd);
    const handlers = createMcpToolHandlers({ cwd });

    await expect(
      handlers.repo_write_file_dry_run({
        path: "notes.md",
        content: "new\n",
        expected_head: "not-the-current-head"
      })
    ).rejects.toThrow(/HEAD mismatch/);
  });

  it("rejects write dry-runs for sensitive local bridge paths", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    await writeFile(path.join(cwd, "notes.md"), "old\n", "utf8");
    const head = await initGitRepo(cwd);
    const handlers = createMcpToolHandlers({ cwd });

    await expect(
      handlers.repo_write_file_dry_run({
        path: ".bridge/config.local.json",
        content: "{}\n",
        expected_head: head
      })
    ).rejects.toThrow(/sensitive/);
  });

  it("rejects write dry-runs for nested git metadata paths", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    await writeFile(path.join(cwd, "notes.md"), "old\n", "utf8");
    const head = await initGitRepo(cwd);
    await mkdir(path.join(cwd, "services", "api", ".git"), { recursive: true });
    await writeFile(path.join(cwd, "services", "api", ".git", "config"), "old\n", "utf8");
    const handlers = createMcpToolHandlers({ cwd });

    await expect(
      handlers.repo_write_file_dry_run({
        path: "services/api/.git/config",
        content: "new\n",
        expected_head: head
      })
    ).rejects.toThrow(/sensitive/);
  });

  it("rejects write dry-runs for nested bridge paths", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    await writeFile(path.join(cwd, "notes.md"), "old\n", "utf8");
    const head = await initGitRepo(cwd);
    await mkdir(path.join(cwd, "services", "api", ".bridge"), { recursive: true });
    await writeFile(path.join(cwd, "services", "api", ".bridge", "config.local.json"), "old\n", "utf8");
    const handlers = createMcpToolHandlers({ cwd });

    await expect(
      handlers.repo_write_file_dry_run({
        path: "services/api/.bridge/config.local.json",
        content: "new\n",
        expected_head: head
      })
    ).rejects.toThrow(/sensitive/);
  });

  it("rejects forged write receipts reached through receipt id traversal", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    await writeFile(path.join(cwd, "notes.md"), "old\n", "utf8");
    const head = await initGitRepo(cwd);
    await mkdir(path.join(cwd, ".bridge"), { recursive: true });
    await writeFile(
      path.join(cwd, ".bridge", "forged.json"),
      `${JSON.stringify(
        {
          schema_version: 1,
          id: "receipt_20260623_000000_forged",
          kind: "repo_write_dry_run",
          summary: "Forged dry-run write for notes.md",
          metadata: {
            path: "notes.md",
            expected_head: head,
            preimage_sha256: sha256("old\n"),
            new_sha256: sha256("forged\n"),
            diff: "--- a/notes.md\n+++ b/notes.md\n-old\n+forged",
            new_content: "forged\n"
          },
          created_at: "2026-06-23T00:00:00.000Z"
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    const handlers = createMcpToolHandlers({ cwd });

    await expect(
      handlers.repo_write_file_apply({
        receipt_id: "../forged",
        expected_head: head,
        preimage_sha256: sha256("old\n")
      })
    ).rejects.toThrow(/record id|receipt/i);
    expect(await readFile(path.join(cwd, "notes.md"), "utf8")).toBe("old\n");
  });

  it("rejects forged write receipts reached through symlinked receipt files", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    const outside = await mkdtemp(path.join(tmpdir(), "gptprouse-outside-"));
    await writeFile(path.join(cwd, "notes.md"), "old\n", "utf8");
    const head = await initGitRepo(cwd);
    await mkdir(path.join(cwd, ".bridge", "receipts"), { recursive: true });
    const forgedReceiptId = "receipt_20260623_000000_forged";
    await writeFile(
      path.join(outside, `${forgedReceiptId}.json`),
      `${JSON.stringify(
        {
          schema_version: 1,
          id: forgedReceiptId,
          kind: "repo_write_dry_run",
          summary: "Forged dry-run write for notes.md",
          metadata: {
            path: "notes.md",
            expected_head: head,
            preimage_sha256: sha256("old\n"),
            new_sha256: sha256("forged\n"),
            diff: "--- a/notes.md\n+++ b/notes.md\n-old\n+forged",
            new_content: "forged\n"
          },
          created_at: "2026-06-23T00:00:00.000Z"
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await symlink(
      path.join(outside, `${forgedReceiptId}.json`),
      path.join(cwd, ".bridge", "receipts", `${forgedReceiptId}.json`)
    );
    const handlers = createMcpToolHandlers({ cwd });

    await expect(
      handlers.repo_write_file_apply({
        receipt_id: forgedReceiptId,
        expected_head: head,
        preimage_sha256: sha256("old\n")
      })
    ).rejects.toThrow(/record path|symlink/i);
    expect(await readFile(path.join(cwd, "notes.md"), "utf8")).toBe("old\n");
  });

  it("stages only paths backed by matching applied write receipts", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    await writeFile(path.join(cwd, "notes.md"), "old\n", "utf8");
    const head = await initGitRepo(cwd);
    const handlers = createMcpToolHandlers({ cwd });
    const dryRun = await handlers.repo_write_file_dry_run({
      path: "notes.md",
      content: "new\n",
      expected_head: head
    });
    const applied = await handlers.repo_write_file_apply({
      receipt_id: dryRun.receipt.id,
      expected_head: head,
      preimage_sha256: dryRun.preimage_sha256
    });

    const staged = await handlers.repo_stage_reviewed_paths({
      receipt_ids: [applied.receipt.id],
      expected_head: head
    });
    const { stdout } = await execFileAsync("git", ["diff", "--cached", "--name-only"], { cwd });

    expect(staged.receipt.kind).toBe("repo_stage_reviewed_paths");
    expect(staged.paths).toEqual(["notes.md"]);
    expect(stdout.trim()).toBe("notes.md");
  });

  it("stages reviewed paths when git normalizes the worktree bytes", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    await writeFile(path.join(cwd, ".gitattributes"), "*.md text eol=lf\n", "utf8");
    await writeFile(path.join(cwd, "notes.md"), "old\r\n", "utf8");
    await execFileAsync("git", ["init"], { cwd });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd });
    await execFileAsync("git", ["config", "user.name", "Test User"], { cwd });
    await execFileAsync("git", ["add", ".gitattributes", "notes.md"], { cwd });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd });
    const { stdout: headOut } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
    const head = headOut.trim();
    const handlers = createMcpToolHandlers({ cwd });
    const dryRun = await handlers.repo_write_file_dry_run({
      path: "notes.md",
      content: "new\r\n",
      expected_head: head
    });
    const applied = await handlers.repo_write_file_apply({
      receipt_id: dryRun.receipt.id,
      expected_head: head,
      preimage_sha256: dryRun.preimage_sha256
    });

    const staged = await handlers.repo_stage_reviewed_paths({
      receipt_ids: [applied.receipt.id],
      expected_head: head
    });

    expect(staged.paths).toEqual(["notes.md"]);
  });

  it("rejects staging when applied receipt content changed again", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    await writeFile(path.join(cwd, "notes.md"), "old\n", "utf8");
    const head = await initGitRepo(cwd);
    const handlers = createMcpToolHandlers({ cwd });
    const dryRun = await handlers.repo_write_file_dry_run({
      path: "notes.md",
      content: "new\n",
      expected_head: head
    });
    const applied = await handlers.repo_write_file_apply({
      receipt_id: dryRun.receipt.id,
      expected_head: head,
      preimage_sha256: dryRun.preimage_sha256
    });
    await writeFile(path.join(cwd, "notes.md"), "changed again\n", "utf8");

    await expect(
      handlers.repo_stage_reviewed_paths({
        receipt_ids: [applied.receipt.id],
        expected_head: head
      })
    ).rejects.toThrow(/content changed/);
  });

  it("rejects staging when content changes after validation but before git add", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    const repoFile = path.join(cwd, "notes.md");
    await writeFile(repoFile, "old\n", "utf8");
    const head = await initGitRepo(cwd);
    const handlers = createMcpToolHandlers({ cwd });
    const dryRun = await handlers.repo_write_file_dry_run({
      path: "notes.md",
      content: "new\n",
      expected_head: head
    });
    const applied = await handlers.repo_write_file_apply({
      receipt_id: dryRun.receipt.id,
      expected_head: head,
      preimage_sha256: dryRun.preimage_sha256
    });
    setRepoWriteTestHooks({
      beforeGitAdd: async () => {
        await writeFile(repoFile, "raced before add\n", "utf8");
      }
    });

    await expect(
      handlers.repo_stage_reviewed_paths({
        receipt_ids: [applied.receipt.id],
        expected_head: head
      })
    ).rejects.toThrow(/staged content|content changed/i);
    const { stdout } = await execFileAsync("git", ["diff", "--cached", "--name-only"], { cwd });
    expect(stdout.trim()).toBe("");
  });

  it("rejects staging when git HEAD moved after apply", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    await writeFile(path.join(cwd, "notes.md"), "old\n", "utf8");
    const head = await initGitRepo(cwd);
    const handlers = createMcpToolHandlers({ cwd });
    const dryRun = await handlers.repo_write_file_dry_run({
      path: "notes.md",
      content: "new\n",
      expected_head: head
    });
    const applied = await handlers.repo_write_file_apply({
      receipt_id: dryRun.receipt.id,
      expected_head: head,
      preimage_sha256: dryRun.preimage_sha256
    });
    await execFileAsync("git", ["add", "notes.md"], { cwd });
    await execFileAsync("git", ["commit", "-m", "move head"], { cwd });

    await expect(
      handlers.repo_stage_reviewed_paths({
        receipt_ids: [applied.receipt.id],
        expected_head: head
      })
    ).rejects.toThrow(/HEAD mismatch/);
  });
});

async function initGitRepo(cwd: string): Promise<string> {
  await execFileAsync("git", ["init"], { cwd });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd });
  await execFileAsync("git", ["add", "notes.md"], { cwd });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd });
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
  return stdout.trim();
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
