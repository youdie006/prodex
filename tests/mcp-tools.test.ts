import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpToolHandlers } from "../src/mcp-tools.js";
import { setRepoWriteTestHooks } from "../src/repo-write.js";
import { setSafeFileTestHooks } from "../src/safe-file.js";
import { BridgeStore, setBridgeStoreTestHooks } from "../src/store.js";

const execFileAsync = promisify(execFile);

describe("MCP tool handlers", () => {
  afterEach(() => {
    setSafeFileTestHooks({});
    setRepoWriteTestHooks({});
    setBridgeStoreTestHooks({});
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

  it("rejects oversized MCP task prompts before writing bridge records", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    const handlers = createMcpToolHandlers({ cwd });

    await expect(
      handlers.bridge_create_task({
        title: "Oversized prompt",
        prompt: "x".repeat(100_001)
      })
    ).rejects.toThrow(/too large|100000/i);
    await expect(readdir(path.join(cwd, ".bridge", "tasks"))).rejects.toThrow();
  });

  it("rejects oversized MCP result summaries before completion", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    const handlers = createMcpToolHandlers({ cwd });
    const created = await handlers.bridge_create_task({
      title: "Oversized result",
      prompt: "Complete this normally."
    });

    await expect(
      handlers.bridge_complete_task({
        task_id: created.task.id,
        summary: "x".repeat(100_001)
      })
    ).rejects.toThrow(/too large|100000/i);

    const store = new BridgeStore(cwd);
    await expect(store.getTask(created.task.id)).resolves.toEqual(expect.objectContaining({ status: "new" }));
    await expect(store.getResult(created.task.id)).rejects.toThrow();
  });

  it("rejects unsafe file paths when creating tasks through MCP handlers", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    const handlers = createMcpToolHandlers({ cwd });

    for (const unsafePath of ["/etc/passwd", "../escape.txt", ".bridge/config.local.json"]) {
      await expect(
        handlers.bridge_create_task({
          title: "Unsafe file path",
          prompt: "Reject unsafe task context paths.",
          files: [{ path: unsafePath }]
        })
      ).rejects.toThrow(/repo-relative|inside|sensitive/);
    }
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

  it("does not fetch raw result records without a trusted completion receipt", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    const store = new BridgeStore(cwd);
    const handlers = createMcpToolHandlers({ cwd });
    const task = await store.createTask({
      source: "codex",
      title: "Raw result",
      prompt: "Do not trust this result until finalization is receipted.",
      repo_id: "default",
      files: [],
      provenance: { adapter: "cli", warnings: [] }
    });
    await mkdir(path.join(cwd, ".bridge", "artifacts", "results"), { recursive: true });
    await writeFile(path.join(cwd, ".bridge", "artifacts", "results", "raw.md"), "raw answer\n", "utf8");
    await writeFile(
      path.join(cwd, ".bridge", "results", `${task.id}.json`),
      `${JSON.stringify(
        {
          schema_version: 1,
          task_id: task.id,
          status: "done",
          summary: "Raw unreceipted answer.",
          artifacts: [{ path: ".bridge/artifacts/results/raw.md", role: "result" }],
          commands: [],
          warnings: [],
          created_at: "2099-01-01T00:00:00.000Z"
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await expect(handlers.bridge_list_results()).rejects.toThrow(/Result record is untrusted: .*task_completed receipt/i);
    await expect(handlers.bridge_fetch_result({ task_id: task.id })).rejects.toThrow(/Result record is untrusted: .*task_completed receipt/i);
    await expect(handlers.bridge_fetch_result_artifact({ task_id: task.id })).rejects.toThrow(
      /Result record is untrusted: .*task_completed receipt/i
    );
  });

  it("surfaces repo search truncation metadata through MCP handlers", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    await writeFile(
      path.join(cwd, "README.md"),
      `${Array.from({ length: 101 }, (_, index) => `needle ${index + 1}`).join("\n")}\n`,
      "utf8"
    );
    const handlers = createMcpToolHandlers({ cwd });

    const result = await handlers.repo_search({ query: "needle" });

    expect(result.matches).toHaveLength(100);
    expect(result.truncated).toBe(true);
    expect(result.limit).toBe(100);
  });

  it("rejects MCP completion when a result record already exists for the task", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    const handlers = createMcpToolHandlers({ cwd });
    const task = await handlers.bridge_create_task({
      title: "Partial MCP result",
      prompt: "Recover from a partial result write"
    });
    await writeFile(
      path.join(cwd, ".bridge", "results", `${task.task.id}.json`),
      `${JSON.stringify(
        {
          schema_version: 1,
          task_id: task.task.id,
          status: "done",
          summary: "First MCP result.",
          artifacts: [],
          commands: [],
          warnings: [],
          created_at: "2099-01-01T00:00:00.000Z"
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await expect(
      handlers.bridge_complete_task({ task_id: task.task.id, summary: "Overwrite through MCP." })
    ).rejects.toThrow(/already has a result|cannot be finalized/i);
    const store = new BridgeStore(cwd);
    await expect(store.getTask(task.task.id)).resolves.toEqual(expect.objectContaining({ status: "new" }));
    await expect(store.getResult(task.task.id)).resolves.toEqual(expect.objectContaining({ summary: "First MCP result." }));
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

  it("fetches MCP completion artifacts from the generic result artifact namespace", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    const store = new BridgeStore(cwd);
    const handlers = createMcpToolHandlers({ cwd });
    const task = await handlers.bridge_create_task({
      title: "Generic result artifact",
      prompt: "Attach a result artifact"
    });
    const artifactPath = await store.writeArtifactText(".bridge/artifacts/results/mcp-answer.md", "generic answer\n");

    await handlers.bridge_complete_task({
      task_id: task.task.id,
      summary: "See generic result artifact.",
      artifacts: [{ path: artifactPath, bytes: "generic answer\n".length }]
    });
    const fetched = await handlers.bridge_fetch_result_artifact({ task_id: task.task.id });

    expect(fetched).toEqual({
      artifact: expect.objectContaining({ path: artifactPath, role: "result" }),
      content: "generic answer\n"
    });
  });

  it("records and verifies result artifact hashes before fetching", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    const store = new BridgeStore(cwd);
    const handlers = createMcpToolHandlers({ cwd });
    const task = await handlers.bridge_create_task({
      title: "Immutable result artifact",
      prompt: "Attach a result artifact"
    });
    const artifactPath = await store.writeArtifactText(".bridge/artifacts/results/immutable-answer.md", "original answer\n");

    const completed = await handlers.bridge_complete_task({
      task_id: task.task.id,
      summary: "See immutable artifact.",
      artifacts: [{ path: artifactPath, bytes: 1 }]
    });
    const fetched = await handlers.bridge_fetch_result_artifact({ task_id: task.task.id });

    expect(completed.result.artifacts[0]).toEqual(
      expect.objectContaining({
        path: artifactPath,
        role: "result",
        bytes: "original answer\n".length,
        sha256: "690b6029cb29446ae4b7e890b37e77ba1a4faefd66ec7be56d6cfad568eb3998"
      })
    );
    expect(fetched.artifact).toEqual(expect.objectContaining({ sha256: "690b6029cb29446ae4b7e890b37e77ba1a4faefd66ec7be56d6cfad568eb3998" }));
    expect(fetched.content).toBe("original answer\n");
  });

  it("rejects result artifacts that changed after task completion", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    const store = new BridgeStore(cwd);
    const handlers = createMcpToolHandlers({ cwd });
    const task = await handlers.bridge_create_task({
      title: "Tampered result artifact",
      prompt: "Attach a result artifact"
    });
    const artifactPath = await store.writeArtifactText(".bridge/artifacts/results/tampered-answer.md", "original answer\n");
    await handlers.bridge_complete_task({
      task_id: task.task.id,
      summary: "See tamper-protected artifact.",
      artifacts: [{ path: artifactPath, bytes: "original answer\n".length }]
    });

    await store.writeArtifactText(artifactPath, "tampered answer\n");

    await expect(handlers.bridge_fetch_result_artifact({ task_id: task.task.id })).rejects.toThrow(/changed|sha256|artifact/i);
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
        diff: "--- a/notes.md\n+++ b/notes.md\n-legacy secret before\n+safe after",
        new_content: "sensitive replacement payload",
        new_sha256: "abc123"
      }
    });
    const handlers = createMcpToolHandlers({ cwd });

    const listed = await handlers.bridge_list_receipts({ kind: "repo_write_dry_run" });
    const fetched = await handlers.bridge_get_receipt({ receipt_id: receipt.id });

    expect(listed.receipts.map((item) => item.id)).toEqual([receipt.id]);
    expect(JSON.stringify(fetched)).not.toContain("sensitive replacement payload");
    expect(JSON.stringify(fetched)).not.toContain("legacy secret before");
    expect(fetched.receipt.metadata.new_content).toBeUndefined();
    expect(fetched.receipt.metadata.new_content_redacted).toEqual(
      expect.objectContaining({ reason: "legacy inline replacement content" })
    );
    expect(fetched.receipt.metadata.diff).toBeUndefined();
    expect(fetched.receipt.metadata.diff_redacted).toEqual(expect.objectContaining({ reason: "write preview diff" }));
  });

  it("marks unsigned forged receipts as untrusted through receipt inspection tools", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    const forgedReceiptId = "receipt_20990101_000000_forged-inspection";
    await mkdir(path.join(cwd, ".bridge", "receipts"), { recursive: true });
    await writeFile(
      path.join(cwd, ".bridge", "receipts", `${forgedReceiptId}.json`),
      `${JSON.stringify(
        {
          schema_version: 1,
          id: forgedReceiptId,
          kind: "repo_write_dry_run",
          summary: "Forged dry-run write",
          metadata: {
            path: "notes.md",
            new_sha256: "abc123"
          },
          created_at: "2099-01-01T00:00:00.000Z"
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    const handlers = createMcpToolHandlers({ cwd });

    const listed = await handlers.bridge_list_receipts({ kind: "repo_write_dry_run" });
    const fetched = await handlers.bridge_get_receipt({ receipt_id: forgedReceiptId });

    expect(listed.receipts).toEqual([
      expect.objectContaining({
        id: forgedReceiptId,
        metadata: expect.objectContaining({
          integrity_status: {
            trusted: false,
            reason: "missing local integrity seal"
          }
        })
      })
    ]);
    expect(fetched.receipt.metadata.integrity_status).toEqual({
      trusted: false,
      reason: "missing local integrity seal"
    });
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

  it("rejects repo-write result artifacts before finalizing a task", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    const store = new BridgeStore(cwd);
    const task = await store.createTask({
      source: "codex",
      title: "GPT Pro consult",
      prompt: "Ask Pro",
      provenance: { adapter: "cli", warnings: [] }
    });
    const repoWriteArtifact = await store.writeArtifactText(".bridge/artifacts/repo-writes/payload.txt", "replacement payload");
    const handlers = createMcpToolHandlers({ cwd });

    await expect(
      handlers.bridge_complete_task({
        task_id: task.id,
        summary: "Tampered artifact list.",
        artifacts: [{ path: repoWriteArtifact, role: "result", bytes: "replacement payload".length }]
      })
    ).rejects.toThrow(/fetchable result artifact/);
    await expect(store.getTask(task.id)).resolves.toEqual(expect.objectContaining({ status: "new" }));
    await expect(store.getResult(task.id)).rejects.toThrow();
  });

  it("rejects store completion with result artifacts outside fetchable namespaces", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    const store = new BridgeStore(cwd);
    const task = await store.createTask({
      source: "codex",
      title: "GPT Pro consult",
      prompt: "Ask Pro",
      provenance: { adapter: "cli", warnings: [] }
    });
    const repoWriteArtifact = await store.writeArtifactText(".bridge/artifacts/repo-writes/payload.txt", "replacement payload");

    await expect(
      store.completeTask(task.id, {
        status: "done",
        summary: "Tampered artifact list.",
        artifacts: [{ path: repoWriteArtifact, role: "result", bytes: "replacement payload".length }]
      })
    ).rejects.toThrow(/fetchable result artifact/);
    await expect(store.getTask(task.id)).resolves.toEqual(expect.objectContaining({ status: "new" }));
    await expect(store.getResult(task.id)).rejects.toThrow();
  });

  it("rejects result artifact paths that traverse out of the pro consult namespace before finalizing", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    const store = new BridgeStore(cwd);
    const task = await store.createTask({
      source: "codex",
      title: "GPT Pro consult",
      prompt: "Ask Pro",
      provenance: { adapter: "cli", warnings: [] }
    });
    await store.writeArtifactText(".bridge/artifacts/repo-writes/payload.txt", "replacement payload");

    await expect(
      store.completeTask(task.id, {
        status: "done",
        summary: "Tampered artifact list.",
        artifacts: [
          {
            path: ".bridge/artifacts/pro-consults/../repo-writes/payload.txt",
            role: "result",
            bytes: "replacement payload".length
          }
        ]
      })
    ).rejects.toThrow(/fetchable result artifact/);
    await expect(store.getTask(task.id)).resolves.toEqual(expect.objectContaining({ status: "new" }));
    await expect(store.getResult(task.id)).rejects.toThrow();
  });

  it("rejects absolute result artifact paths before finalizing", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    const store = new BridgeStore(cwd);
    const task = await store.createTask({
      source: "codex",
      title: "GPT Pro consult",
      prompt: "Ask Pro",
      provenance: { adapter: "cli", warnings: [] }
    });

    await expect(
      store.completeTask(task.id, {
        status: "done",
        summary: "Tampered artifact list.",
        artifacts: [{ path: path.join(cwd, ".bridge", "artifacts", "pro-consults", "answer.md"), role: "result" }]
      })
    ).rejects.toThrow(/fetchable result artifact/);
    await expect(store.getTask(task.id)).resolves.toEqual(expect.objectContaining({ status: "new" }));
    await expect(store.getResult(task.id)).rejects.toThrow();
  });

  it("rejects legacy result records that list repo-write artifacts when fetched", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    const store = new BridgeStore(cwd);
    const task = await store.createTask({
      source: "codex",
      title: "GPT Pro consult",
      prompt: "Ask Pro",
      provenance: { adapter: "cli", warnings: [] }
    });
    const repoWriteArtifact = await store.writeArtifactText(".bridge/artifacts/repo-writes/payload.txt", "replacement payload");
    const resultRecord = {
      schema_version: 1,
      task_id: task.id,
      status: "done",
      summary: "Legacy bad artifact list.",
      artifacts: [{ path: repoWriteArtifact, role: "result", bytes: "replacement payload".length }],
      commands: [],
      warnings: [],
      created_at: "2099-01-01T00:00:00.000Z"
    };
    await writeFile(
      path.join(cwd, ".bridge", "results", `${task.id}.json`),
      `${JSON.stringify(resultRecord, null, 2)}\n`,
      "utf8"
    );
    await store.writeReceipt({
      kind: "task_completed",
      task_id: task.id,
      summary: `Completed task ${task.id}`,
      metadata: { result_sha256: resultDigestForTest(resultRecord) }
    });
    const handlers = createMcpToolHandlers({ cwd });

    await expect(handlers.bridge_fetch_result_artifact({ task_id: task.id })).rejects.toThrow(/not a fetchable result artifact/);
  });

  it("rejects legacy result artifact paths that traverse out of the pro consult namespace when fetched", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    const store = new BridgeStore(cwd);
    const task = await store.createTask({
      source: "codex",
      title: "GPT Pro consult",
      prompt: "Ask Pro",
      provenance: { adapter: "cli", warnings: [] }
    });
    const resultRecord = {
      schema_version: 1,
      task_id: task.id,
      status: "done",
      summary: "Legacy bad artifact list.",
      artifacts: [
        {
          path: ".bridge/artifacts/pro-consults/../repo-writes/payload.txt",
          role: "result",
          bytes: "replacement payload".length
        }
      ],
      commands: [],
      warnings: [],
      created_at: "2099-01-01T00:00:00.000Z"
    };
    await writeFile(
      path.join(cwd, ".bridge", "results", `${task.id}.json`),
      `${JSON.stringify(resultRecord, null, 2)}\n`,
      "utf8"
    );
    await store.writeReceipt({
      kind: "task_completed",
      task_id: task.id,
      summary: `Completed task ${task.id}`,
      metadata: { result_sha256: resultDigestForTest(resultRecord) }
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

  it("cleans up write dry-run replacement artifacts when receipt storage fails", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    await writeFile(path.join(cwd, "notes.md"), "old\n", "utf8");
    const head = await initGitRepo(cwd);
    const handlers = createMcpToolHandlers({ cwd });
    setBridgeStoreTestHooks({
      beforeRecordRename: async (kind) => {
        if (kind === "receipts") throw new Error("forced dry-run receipt failure");
      }
    });

    await expect(
      handlers.repo_write_file_dry_run({
        path: "notes.md",
        content: "new\n",
        expected_head: head
      })
    ).rejects.toThrow(/forced dry-run receipt failure/);
    await expect(readdir(path.join(cwd, ".bridge", "artifacts", "repo-writes"))).resolves.toEqual([]);
  });

  it("rejects oversized result artifacts before finalizing tasks", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    const store = new BridgeStore(cwd);
    const task = await store.createTask({
      source: "codex",
      title: "Large artifact",
      prompt: "Fetch the artifact.",
      provenance: { adapter: "cli" }
    });
    const artifactPath = await store.writeArtifactText(".bridge/artifacts/results/large.txt", "x".repeat(100_001));

    await expect(
      store.completeTask(task.id, {
        status: "done",
        summary: "Large result artifact",
        artifacts: [{ path: artifactPath, role: "result" }]
      })
    ).rejects.toThrow(/too large|100000/i);
    await expect(store.getTask(task.id)).resolves.toEqual(expect.objectContaining({ status: "new" }));
    await expect(store.getResult(task.id)).rejects.toThrow();
  });

  it("rejects oversized repo write payload artifacts before applying them", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    await writeFile(path.join(cwd, "notes.md"), "old\n", "utf8");
    const head = await initGitRepo(cwd);
    const oversizedContent = "x".repeat(1_000_001);
    const store = new BridgeStore(cwd);
    const artifactPath = await store.writeArtifactText(".bridge/artifacts/repo-writes/oversized.txt", oversizedContent);
    const receipt = await store.writeReceipt({
      kind: "repo_write_dry_run",
      summary: "Forged oversized write payload",
      metadata: {
        path: "notes.md",
        expected_head: head,
        preimage_sha256: sha256("old\n"),
        new_sha256: sha256(oversizedContent),
        diff: "--- a/notes.md\n+++ b/notes.md\n-old\n+oversized",
        new_content_artifact: artifactPath
      }
    });
    const handlers = createMcpToolHandlers({ cwd });

    await expect(
      handlers.repo_write_file_apply({
        receipt_id: receipt.id,
        expected_head: head,
        preimage_sha256: sha256("old\n")
      })
    ).rejects.toThrow(/Target file is too large|1000000/i);
    expect(await readFile(path.join(cwd, "notes.md"), "utf8")).toBe("old\n");
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

  it("rejects oversized legacy inline write payloads before hashing them", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    await writeFile(path.join(cwd, "notes.md"), "old\n", "utf8");
    const head = await initGitRepo(cwd);
    const store = new BridgeStore(cwd);
    const legacyReceipt = await store.writeReceipt({
      kind: "repo_write_dry_run",
      summary: "Legacy oversized dry-run write for notes.md",
      metadata: {
        path: "notes.md",
        expected_head: head,
        preimage_sha256: sha256("old\n"),
        new_sha256: "not-the-right-hash",
        diff: "--- a/notes.md\n+++ b/notes.md\n-old\n+oversized",
        new_content: "x".repeat(1_000_001)
      }
    });
    const handlers = createMcpToolHandlers({ cwd });

    await expect(
      handlers.repo_write_file_apply({
        receipt_id: legacyReceipt.id,
        expected_head: head,
        preimage_sha256: sha256("old\n")
      })
    ).rejects.toThrow(/too large|1000000/i);
    expect(await readFile(path.join(cwd, "notes.md"), "utf8")).toBe("old\n");
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

  it("rejects write apply for forged case-folded sensitive receipt paths", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    await writeFile(path.join(cwd, "notes.md"), "old\n", "utf8");
    await mkdir(path.join(cwd, ".Bridge"), { recursive: true });
    await writeFile(path.join(cwd, ".Bridge", "config.local.json"), "old\n", "utf8");
    const head = await initGitRepo(cwd);
    const store = new BridgeStore(cwd);
    const legacyReceipt = await store.writeReceipt({
      kind: "repo_write_dry_run",
      summary: "Forged dry-run write for case-folded bridge config",
      metadata: {
        path: ".Bridge/config.local.json",
        expected_head: head,
        preimage_sha256: sha256("old\n"),
        new_sha256: sha256("new\n"),
        diff: "--- a/.Bridge/config.local.json\n+++ b/.Bridge/config.local.json\n-old\n+new",
        new_content: "new\n"
      }
    });
    const handlers = createMcpToolHandlers({ cwd });

    await expect(
      handlers.repo_write_file_apply({
        receipt_id: legacyReceipt.id,
        expected_head: head,
        preimage_sha256: sha256("old\n")
      })
    ).rejects.toThrow(/sensitive/);
    expect(await readFile(path.join(cwd, ".Bridge", "config.local.json"), "utf8")).toBe("old\n");
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

  it("rejects write apply when git HEAD moves immediately before replacement", async () => {
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
    let moved = false;
    setSafeFileTestHooks({
      beforeReplace: async (filePath) => {
        if (!moved && filePath === repoFile) {
          moved = true;
          await writeFile(path.join(cwd, "head-marker.txt"), "move\n", "utf8");
          await execFileAsync("git", ["add", "head-marker.txt"], { cwd });
          await execFileAsync("git", ["commit", "-m", "move head during apply"], { cwd });
        }
      }
    });

    await expect(
      handlers.repo_write_file_apply({
        receipt_id: dryRun.receipt.id,
        expected_head: head,
        preimage_sha256: dryRun.preimage_sha256
      })
    ).rejects.toThrow(/HEAD mismatch/);
    expect(await readFile(repoFile, "utf8")).toBe("old\n");
  });

  it("rolls back write apply when git HEAD moves after replacement before receipt", async () => {
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
    setRepoWriteTestHooks({
      beforeAppliedReceipt: async () => {
        await writeFile(path.join(cwd, "head-marker.txt"), "move\n", "utf8");
        await execFileAsync("git", ["add", "head-marker.txt"], { cwd });
        await execFileAsync("git", ["commit", "-m", "move head after apply"], { cwd });
      }
    });

    await expect(
      handlers.repo_write_file_apply({
        receipt_id: dryRun.receipt.id,
        expected_head: head,
        preimage_sha256: dryRun.preimage_sha256
      })
    ).rejects.toThrow(/HEAD mismatch/);
    expect(await readFile(repoFile, "utf8")).toBe("old\n");
    const appliedReceipts = await handlers.bridge_list_receipts({ kind: "repo_write_applied" });
    expect(appliedReceipts.receipts).toEqual([]);
  });

  it("rolls back write apply when git HEAD moves during final replacement validation", async () => {
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
    let moved = false;
    setSafeFileTestHooks({
      afterWrite: async (filePath) => {
        if (!moved && filePath === repoFile) {
          moved = true;
          await writeFile(path.join(cwd, "head-marker.txt"), "move\n", "utf8");
          await execFileAsync("git", ["add", "head-marker.txt"], { cwd });
          await execFileAsync("git", ["commit", "-m", "move head during final validation"], { cwd });
        }
      }
    });

    await expect(
      handlers.repo_write_file_apply({
        receipt_id: dryRun.receipt.id,
        expected_head: head,
        preimage_sha256: dryRun.preimage_sha256
      })
    ).rejects.toThrow(/HEAD mismatch/);
    expect(await readFile(repoFile, "utf8")).toBe("old\n");
    const appliedReceipts = await handlers.bridge_list_receipts({ kind: "repo_write_applied" });
    expect(appliedReceipts.receipts).toEqual([]);
  });

  it("rolls back write apply when git HEAD moves while storing the applied receipt", async () => {
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
    let moved = false;
    setBridgeStoreTestHooks({
      beforeRecordRename: async (kind) => {
        if (!moved && kind === "receipts") {
          moved = true;
          await writeFile(path.join(cwd, "head-marker.txt"), "move\n", "utf8");
          await execFileAsync("git", ["add", "head-marker.txt"], { cwd });
          await execFileAsync("git", ["commit", "-m", "move head during applied receipt"], { cwd });
        }
      }
    });

    await expect(
      handlers.repo_write_file_apply({
        receipt_id: dryRun.receipt.id,
        expected_head: head,
        preimage_sha256: dryRun.preimage_sha256
      })
    ).rejects.toThrow(/HEAD mismatch/);
    expect(await readFile(repoFile, "utf8")).toBe("old\n");
    const appliedReceipts = await handlers.bridge_list_receipts({ kind: "repo_write_applied" });
    expect(appliedReceipts.receipts).toEqual([]);
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

  it("rejects write dry-runs outside git repos without leaking raw git command output", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    await writeFile(path.join(cwd, "notes.md"), "old\n", "utf8");
    const handlers = createMcpToolHandlers({ cwd });

    await expect(
      handlers.repo_write_file_dry_run({
        path: "notes.md",
        content: "new\n",
        expected_head: "main"
      })
    ).rejects.toThrow("repo write tools require a git worktree with a committed HEAD");
    await expect(
      handlers.repo_write_file_dry_run({
        path: "notes.md",
        content: "new\n",
        expected_head: "main"
      })
    ).rejects.not.toThrow(/Command failed:|rev-parse|not a git repository/i);
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

  it("rejects write dry-runs through symlink aliases to sensitive directories", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    await writeFile(path.join(cwd, "notes.md"), "old\n", "utf8");
    await mkdir(path.join(cwd, ".bridge", "artifacts"), { recursive: true });
    await writeFile(path.join(cwd, ".bridge", "artifacts", "aliased.txt"), "old\n", "utf8");
    await symlink(path.join(cwd, ".bridge"), path.join(cwd, "bridge-alias"));
    const head = await initGitRepo(cwd);
    const handlers = createMcpToolHandlers({ cwd });

    await expect(
      handlers.repo_write_file_dry_run({
        path: "bridge-alias/artifacts/aliased.txt",
        content: "new\n",
        expected_head: head
      })
    ).rejects.toThrow(/sensitive/);
  });

  it("rejects write dry-runs for env-like files", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    await writeFile(path.join(cwd, "notes.md"), "old\n", "utf8");
    await writeFile(path.join(cwd, ".envrc"), "old\n", "utf8");
    const head = await initGitRepo(cwd);
    const handlers = createMcpToolHandlers({ cwd });

    await expect(
      handlers.repo_write_file_dry_run({
        path: ".envrc",
        content: "new\n",
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

  it("rejects write dry-runs for case-folded sensitive paths", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    await writeFile(path.join(cwd, "notes.md"), "old\n", "utf8");
    await mkdir(path.join(cwd, ".Bridge"), { recursive: true });
    await mkdir(path.join(cwd, "Services", "API", ".GIT"), { recursive: true });
    await mkdir(path.join(cwd, "Services", "API"), { recursive: true });
    await writeFile(path.join(cwd, ".Bridge", "config.local.json"), "old\n", "utf8");
    await writeFile(path.join(cwd, "Services", "API", ".GIT", "config"), "old\n", "utf8");
    await writeFile(path.join(cwd, "Services", "API", ".ENV.Local"), "old\n", "utf8");
    const head = await initGitRepo(cwd);
    const handlers = createMcpToolHandlers({ cwd });

    for (const sensitivePath of [".Bridge/config.local.json", "Services/API/.GIT/config", "Services/API/.ENV.Local"]) {
      await expect(
        handlers.repo_write_file_dry_run({
          path: sensitivePath,
          content: "new\n",
          expected_head: head
        })
      ).rejects.toThrow(/sensitive/);
    }
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

  it("rejects missing write receipts without leaking filesystem errors", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    await writeFile(path.join(cwd, "notes.md"), "old\n", "utf8");
    const head = await initGitRepo(cwd);
    const handlers = createMcpToolHandlers({ cwd });
    const missingReceiptId = "receipt_20990101_000000_missing";

    await expect(
      handlers.repo_write_file_apply({
        receipt_id: missingReceiptId,
        expected_head: head,
        preimage_sha256: sha256("old\n")
      })
    ).rejects.toThrow(`Receipt not found: ${missingReceiptId}`);
    await expect(
      handlers.repo_write_file_apply({
        receipt_id: missingReceiptId,
        expected_head: head,
        preimage_sha256: sha256("old\n")
      })
    ).rejects.not.toThrow(/ENOENT|lstat|no such file/i);
    expect(await readFile(path.join(cwd, "notes.md"), "utf8")).toBe("old\n");
  });

  it("rejects unsigned forged dry-run receipt content before applying a write", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    await writeFile(path.join(cwd, "notes.md"), "old\n", "utf8");
    const head = await initGitRepo(cwd);
    const forgedReceiptId = "receipt_20990101_000000_forged-dry-run";
    await mkdir(path.join(cwd, ".bridge", "receipts"), { recursive: true });
    await writeFile(
      path.join(cwd, ".bridge", "receipts", `${forgedReceiptId}.json`),
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
          created_at: "2099-01-01T00:00:00.000Z"
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    const handlers = createMcpToolHandlers({ cwd });

    await expect(
      handlers.repo_write_file_apply({
        receipt_id: forgedReceiptId,
        expected_head: head,
        preimage_sha256: sha256("old\n")
      })
    ).rejects.toThrow(/receipt|integrity|trusted/i);
    expect(await readFile(path.join(cwd, "notes.md"), "utf8")).toBe("old\n");
  });

  it("rejects unsigned forged applied receipts before staging paths", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    await writeFile(path.join(cwd, "notes.md"), "old\n", "utf8");
    const head = await initGitRepo(cwd);
    await writeFile(path.join(cwd, "notes.md"), "forged\n", "utf8");
    const forgedReceiptId = "receipt_20990101_000000_forged-applied";
    await mkdir(path.join(cwd, ".bridge", "receipts"), { recursive: true });
    await writeFile(
      path.join(cwd, ".bridge", "receipts", `${forgedReceiptId}.json`),
      `${JSON.stringify(
        {
          schema_version: 1,
          id: forgedReceiptId,
          kind: "repo_write_applied",
          summary: "Forged applied write for notes.md",
          metadata: {
            path: "notes.md",
            expected_head: head,
            preimage_sha256: sha256("old\n"),
            new_sha256: sha256("forged\n")
          },
          created_at: "2099-01-01T00:00:00.000Z"
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    const handlers = createMcpToolHandlers({ cwd });

    await expect(
      handlers.repo_stage_reviewed_paths({
        receipt_ids: [forgedReceiptId],
        expected_head: head
      })
    ).rejects.toThrow(/receipt|integrity|trusted/i);
    const { stdout } = await execFileAsync("git", ["diff", "--cached", "--name-only"], { cwd });
    expect(stdout.trim()).toBe("");
  });

  it("rejects missing applied receipts without leaking filesystem errors or staging files", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    await writeFile(path.join(cwd, "notes.md"), "old\n", "utf8");
    const head = await initGitRepo(cwd);
    const handlers = createMcpToolHandlers({ cwd });
    const missingReceiptId = "receipt_20990101_000000_missing-applied";

    await expect(
      handlers.repo_stage_reviewed_paths({
        receipt_ids: [missingReceiptId],
        expected_head: head
      })
    ).rejects.toThrow(`Receipt not found: ${missingReceiptId}`);
    await expect(
      handlers.repo_stage_reviewed_paths({
        receipt_ids: [missingReceiptId],
        expected_head: head
      })
    ).rejects.not.toThrow(/ENOENT|lstat|no such file/i);
    const { stdout } = await execFileAsync("git", ["diff", "--cached", "--name-only"], { cwd });
    expect(stdout.trim()).toBe("");
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

  it("rejects staging forged applied receipts for case-folded sensitive paths", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    await writeFile(path.join(cwd, "notes.md"), "old\n", "utf8");
    await mkdir(path.join(cwd, ".Bridge"), { recursive: true });
    await writeFile(path.join(cwd, ".Bridge", "config.local.json"), "new\n", "utf8");
    const head = await initGitRepo(cwd);
    const store = new BridgeStore(cwd);
    const appliedReceipt = await store.writeReceipt({
      kind: "repo_write_applied",
      summary: "Forged applied write for case-folded bridge config",
      metadata: {
        path: ".Bridge/config.local.json",
        expected_head: head,
        preimage_sha256: sha256("old\n"),
        new_sha256: sha256("new\n")
      }
    });
    const handlers = createMcpToolHandlers({ cwd });

    await expect(
      handlers.repo_stage_reviewed_paths({
        receipt_ids: [appliedReceipt.id],
        expected_head: head
      })
    ).rejects.toThrow(/sensitive/);
    const { stdout } = await execFileAsync("git", ["diff", "--cached", "--name-only"], { cwd });
    expect(stdout.trim()).toBe("");
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

  it("rejects staging when git HEAD moves after validation but before git add", async () => {
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
    setRepoWriteTestHooks({
      beforeGitAdd: async () => {
        await writeFile(path.join(cwd, "head-marker.txt"), "move\n", "utf8");
        await execFileAsync("git", ["add", "head-marker.txt"], { cwd });
        await execFileAsync("git", ["commit", "-m", "move head before stage"], { cwd });
      }
    });

    await expect(
      handlers.repo_stage_reviewed_paths({
        receipt_ids: [applied.receipt.id],
        expected_head: head
      })
    ).rejects.toThrow(/HEAD mismatch/);
    const { stdout } = await execFileAsync("git", ["diff", "--cached", "--name-only"], { cwd });
    expect(stdout.trim()).toBe("");
  });

  it("unstages reviewed paths when git HEAD moves after git add before receipt", async () => {
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
    setRepoWriteTestHooks({
      beforeStageReceipt: async () => {
        await writeFile(path.join(cwd, "head-marker.txt"), "move\n", "utf8");
        await execFileAsync("git", ["add", "head-marker.txt"], { cwd });
        await execFileAsync("git", ["commit", "--only", "head-marker.txt", "-m", "move head after stage"], { cwd });
      }
    });

    await expect(
      handlers.repo_stage_reviewed_paths({
        receipt_ids: [applied.receipt.id],
        expected_head: head
      })
    ).rejects.toThrow(/HEAD mismatch/);
    const { stdout } = await execFileAsync("git", ["diff", "--cached", "--name-only"], { cwd });
    expect(stdout.trim()).toBe("");
    const stageReceipts = await handlers.bridge_list_receipts({ kind: "repo_stage_reviewed_paths" });
    expect(stageReceipts.receipts).toEqual([]);
  });

  it("unstages reviewed paths when git HEAD moves while storing the stage receipt", async () => {
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
    let moved = false;
    setBridgeStoreTestHooks({
      beforeRecordRename: async (kind) => {
        if (!moved && kind === "receipts") {
          moved = true;
          await writeFile(path.join(cwd, "head-marker.txt"), "move\n", "utf8");
          await execFileAsync("git", ["add", "head-marker.txt"], { cwd });
          await execFileAsync("git", ["commit", "--only", "head-marker.txt", "-m", "move head during stage receipt"], { cwd });
        }
      }
    });

    await expect(
      handlers.repo_stage_reviewed_paths({
        receipt_ids: [applied.receipt.id],
        expected_head: head
      })
    ).rejects.toThrow(/HEAD mismatch/);
    const { stdout } = await execFileAsync("git", ["diff", "--cached", "--name-only"], { cwd });
    expect(stdout.trim()).toBe("");
    const stageReceipts = await handlers.bridge_list_receipts({ kind: "repo_stage_reviewed_paths" });
    expect(stageReceipts.receipts).toEqual([]);
  });

  it("preserves pre-existing staged content when stage receipt storage fails", async () => {
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
    await writeFile(repoFile, "user staged\n", "utf8");
    await execFileAsync("git", ["add", "notes.md"], { cwd });
    await writeFile(repoFile, "new\n", "utf8");
    const { stdout: stagedBefore } = await execFileAsync("git", ["show", ":notes.md"], { cwd });
    setRepoWriteTestHooks({
      beforeStageReceipt: async () => {
        throw new Error("forced stage receipt failure");
      }
    });

    await expect(
      handlers.repo_stage_reviewed_paths({
        receipt_ids: [applied.receipt.id],
        expected_head: head
      })
    ).rejects.toThrow(/forced stage receipt failure/);
    const { stdout: stagedAfter } = await execFileAsync("git", ["show", ":notes.md"], { cwd });

    expect(stagedBefore).toBe("user staged\n");
    expect(stagedAfter).toBe(stagedBefore);
    expect(await readFile(repoFile, "utf8")).toBe("new\n");
    const stageReceipts = await handlers.bridge_list_receipts({ kind: "repo_stage_reviewed_paths" });
    expect(stageReceipts.receipts).toEqual([]);
  });

  it("reports rollback failure when reviewed path index restore cannot run", async () => {
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
    await writeFile(repoFile, "user staged\n", "utf8");
    await execFileAsync("git", ["add", "notes.md"], { cwd });
    await writeFile(repoFile, "new\n", "utf8");
    const indexLock = path.join(cwd, ".git", "index.lock");
    setRepoWriteTestHooks({
      beforeStageReceipt: async () => {
        throw new Error("forced stage receipt failure");
      },
      beforeRestoreGitIndex: async () => {
        await writeFile(indexLock, "locked\n", "utf8");
      }
    });

    try {
      await expect(
        handlers.repo_stage_reviewed_paths({
          receipt_ids: [applied.receipt.id],
          expected_head: head
        })
      ).rejects.toThrow(/forced stage receipt failure.*failed to restore git index/i);
    } finally {
      await rm(indexLock, { force: true });
    }
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

function resultDigestForTest(value: unknown): string {
  return sha256(canonicalJsonForTest(value));
}

function canonicalJsonForTest(value: unknown): string {
  return JSON.stringify(canonicalizeForTest(value));
}

function canonicalizeForTest(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalizeForTest(item));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const canonical: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] !== undefined) canonical[key] = canonicalizeForTest(record[key]);
    }
    return canonical;
  }
  return value;
}
