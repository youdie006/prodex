import { link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeBridgeId } from "../src/schema.js";
import { setSafeFileTestHooks } from "../src/safe-file.js";
import { BridgeStore, setBridgeStoreTestHooks } from "../src/store.js";

describe("BridgeStore", () => {
  afterEach(() => {
    setSafeFileTestHooks({});
    setBridgeStoreTestHooks({});
    vi.useRealTimers();
  });

  it("creates, claims, completes, and fetches task results", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const store = new BridgeStore(root);
    await store.ensure();

    const task = await store.createTask({
      source: "codex",
      title: "Smoke task",
      prompt: "Check the smoke path.",
      repo_id: "default",
      files: [],
      provenance: { adapter: "cli" }
    });

    const claimed = await store.claimTask(task.id, "codex-main");
    expect(claimed.status).toBe("claimed");
    expect(claimed.claimed_by).toBe("codex-main");

    const result = await store.completeTask(task.id, {
      status: "done",
      summary: "Smoke passed.",
      artifacts: [],
      commands: ["npm test"]
    });

    expect(result.task_id).toBe(task.id);
    expect((await store.getTask(task.id)).status).toBe("done");
    expect((await store.getResult(task.id)).summary).toBe("Smoke passed.");

    const stored = JSON.parse(
      await readFile(path.join(root, ".bridge", "tasks", `${task.id}.json`), "utf8")
    );
    expect(stored.schema_version).toBe(1);
  });

  it("rejects claiming a task that is already claimed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const store = new BridgeStore(root);
    await store.ensure();
    const task = await store.createTask({
      source: "codex",
      title: "Claim once",
      prompt: "x",
      repo_id: "default",
      files: [],
      provenance: { adapter: "cli" }
    });

    await store.claimTask(task.id, "agent-a");
    await expect(store.claimTask(task.id, "agent-b")).rejects.toThrow(/not new|already/i);
  });

  it("adopts a concurrently-created integrity key instead of clobbering it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const keyPath = path.join(root, ".bridge", "receipt-key.local");
    const winnerKey = "a".repeat(64);
    let injected = false;
    try {
      // Simulate another process winning the create race in the exact window
      // between this store's key read-miss and its own key write.
      setBridgeStoreTestHooks({
        afterReceiptKeyReadMiss: async () => {
          if (injected) return;
          injected = true;
          await writeFile(keyPath, `${winnerKey}\n`, { mode: 0o600 });
        }
      });
      const store = new BridgeStore(root);
      const task = await store.createTask({
        source: "codex",
        title: "Race key",
        prompt: "x",
        repo_id: "default",
        files: [],
        provenance: { adapter: "cli" }
      });
      // Exclusive-create must have observed EEXIST and adopted the winner's key,
      // not overwritten it (which would untrust receipts signed with it).
      expect((await readFile(keyPath, "utf8")).trim()).toBe(winnerKey);
      // The task_created receipt must verify as trusted under the adopted key.
      const receipts = await store.listReceiptsReadOnly({ task_id: task.id });
      const untrusted = receipts.filter((r) => (r.metadata as Record<string, unknown> | undefined)?.integrity_status);
      expect(untrusted).toEqual([]);
    } finally {
      setBridgeStoreTestHooks({});
    }
  });

  it("recovers a claim after a crashed holder left a stale lock file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const store = new BridgeStore(root);
    await store.ensure();
    const task = await store.createTask({
      source: "codex",
      title: "Stale lock",
      prompt: "x",
      repo_id: "default",
      files: [],
      provenance: { adapter: "cli" }
    });

    // Simulate a crashed claimer: a lock file with no live holder, backdated
    // well past the staleness threshold.
    const lockPath = path.join(root, ".bridge", "tasks", `.${task.id}.claim.lock`);
    await writeFile(lockPath, "", "utf8");
    const old = new Date(Date.now() - 10 * 60 * 1000);
    await utimes(lockPath, old, old);

    const claimed = await store.claimTask(task.id, "agent-after-crash");
    expect(claimed.status).toBe("claimed");
    expect(claimed.claimed_by).toBe("agent-after-crash");
  });

  it("does not double-claim a task under concurrent claims", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const store = new BridgeStore(root);
    await store.ensure();
    const task = await store.createTask({
      source: "codex",
      title: "Race claim",
      prompt: "x",
      repo_id: "default",
      files: [],
      provenance: { adapter: "cli" }
    });

    const results = await Promise.allSettled([
      store.claimTask(task.id, "agent-a"),
      store.claimTask(task.id, "agent-b")
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    // The persisted task reflects exactly the one winner.
    const persisted = await store.getTask(task.id);
    expect(persisted.status).toBe("claimed");
    expect((fulfilled[0] as PromiseFulfilledResult<{ claimed_by?: string }>).value.claimed_by).toBe(persisted.claimed_by);
  });

  it("stores bridge directories and generated files with private permissions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const store = new BridgeStore(root);
    const task = await store.createTask({
      source: "codex",
      title: "Private bridge files",
      prompt: "Check local file permissions.",
      repo_id: "default",
      files: [],
      provenance: { adapter: "cli" }
    });
    await store.completeTask(task.id, { status: "done", summary: "Permission check." });
    const session = await store.writeSession({
      direction: "codex_to_chatgpt",
      backend: "manual",
      status: "preview"
    });
    const artifactPath = await store.writeArtifactText(".bridge/artifacts/pro-consults/private.md", "private artifact\n");

    await expectMode(path.join(root, ".bridge"), 0o700);
    for (const dirname of ["tasks", "results", "sessions", "artifacts", "receipts", path.join("artifacts", "pro-consults")]) {
      await expectMode(path.join(root, ".bridge", dirname), 0o700);
    }
    await expectMode(path.join(root, ".bridge", "tasks", `${task.id}.json`), 0o600);
    await expectMode(path.join(root, ".bridge", "results", `${task.id}.json`), 0o600);
    await expectMode(path.join(root, ".bridge", "sessions", `${session.id}.json`), 0o600);
    await expectMode(path.join(root, artifactPath), 0o600);
    const receipts = await readdir(path.join(root, ".bridge", "receipts"));
    expect(receipts.length).toBeGreaterThan(0);
    for (const receipt of receipts) {
      await expectMode(path.join(root, ".bridge", "receipts", receipt), 0o600);
    }
  });

  it("treats unsafe record id path occupants as existing without dereferencing them", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const store = new BridgeStore(root);
    await store.ensure();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-25T00:00:00.000Z"));
    const title = "Predictable record";
    const firstId = makeBridgeId("task", title);
    await symlink(path.join(root, "missing-outside-record.json"), path.join(root, ".bridge", "tasks", `${firstId}.json`));

    const task = await store.createTask({
      source: "codex",
      title,
      prompt: "Do not follow unsafe record id occupants.",
      repo_id: "default",
      files: [],
      provenance: { adapter: "cli" }
    });

    expect(task.id).toBe(`${firstId}-2`);
    expect((await lstat(path.join(root, ".bridge", "tasks", `${firstId}.json`))).isSymbolicLink()).toBe(true);
    await expect(store.getTask(task.id)).resolves.toEqual(expect.objectContaining({ id: `${firstId}-2` }));
  });

  it("keeps every task when many are created concurrently at the same timestamp and title", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const store = new BridgeStore(root);
    await store.ensure();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-25T00:00:00.000Z"));

    const count = 8;
    const created = await Promise.all(
      Array.from({ length: count }, (_, index) =>
        store.createTask({
          source: "codex",
          title: "Concurrent review",
          prompt: `prompt ${index}`,
          repo_id: "default",
          files: [],
          provenance: { adapter: "cli" }
        })
      )
    );

    const ids = new Set(created.map((task) => task.id));
    expect(ids.size).toBe(count);
    const listed = await store.listTasks();
    expect(listed.length).toBe(count);
    expect(new Set(listed.map((task) => task.prompt)).size).toBe(count);
  });

  it("rejects finalizing a task after it is already done or blocked", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const store = new BridgeStore(root);
    const doneTask = await store.createTask({
      source: "codex",
      title: "Done once",
      prompt: "Check terminal completion.",
      repo_id: "default",
      files: [],
      provenance: { adapter: "cli" }
    });
    const blockedTask = await store.createTask({
      source: "codex",
      title: "Blocked once",
      prompt: "Check terminal block.",
      repo_id: "default",
      files: [],
      provenance: { adapter: "cli" }
    });

    await store.completeTask(doneTask.id, { status: "done", summary: "First summary." });
    await store.completeTask(blockedTask.id, { status: "blocked", summary: "First blocker." });

    await expect(store.completeTask(doneTask.id, { status: "done", summary: "Second summary." })).rejects.toThrow(
      /already done|not finalizable/i
    );
    await expect(store.completeTask(blockedTask.id, { status: "done", summary: "Second blocker." })).rejects.toThrow(
      /already blocked|not finalizable/i
    );
    await expect(store.getResult(doneTask.id)).resolves.toEqual(expect.objectContaining({ summary: "First summary." }));
    await expect(store.getResult(blockedTask.id)).resolves.toEqual(expect.objectContaining({ summary: "First blocker." }));
  });

  it("reports terminal tasks with missing result records as repairable corruption", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const store = new BridgeStore(root);
    const task = await store.createTask({
      source: "codex",
      title: "Terminal missing result",
      prompt: "Explain the missing result.",
      repo_id: "default",
      files: [],
      provenance: { adapter: "cli" }
    });
    await store.completeTask(task.id, {
      status: "done",
      summary: "Original summary."
    });
    await rm(path.join(root, ".bridge", "results", `${task.id}.json`));

    await expect(store.completeTask(task.id, { status: "done", summary: "Retry summary." })).rejects.toThrow(
      `Task ${task.id} is done but .bridge/results/${task.id}.json is missing`
    );
  });

  it("rejects finalizing a task when a mismatched result record already exists for a non-terminal task", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const store = new BridgeStore(root);
    const task = await store.createTask({
      source: "codex",
      title: "Partial finalize",
      prompt: "Recover from a partial result write.",
      repo_id: "default",
      files: [],
      provenance: { adapter: "cli" }
    });
    await writeFile(
      path.join(root, ".bridge", "results", `${task.id}.json`),
      `${JSON.stringify(
        {
          schema_version: 1,
          task_id: task.id,
          status: "done",
          summary: "Recovered summary.",
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

    await expect(store.completeTask(task.id, { status: "done", summary: "Overwrite attempt." })).rejects.toThrow(
      /already has a result|cannot be finalized/i
    );
    await expect(store.getTask(task.id)).resolves.toEqual(expect.objectContaining({ status: "new" }));
    await expect(store.getResult(task.id)).resolves.toEqual(expect.objectContaining({ summary: "Recovered summary." }));
  });

  it("rejects result records whose internal task_id does not match the filename", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const store = new BridgeStore(root);
    const task = await store.createTask({
      source: "codex",
      title: "Mismatched result identity",
      prompt: "Reject result records that point at a different task.",
      repo_id: "default",
      files: [],
      provenance: { adapter: "cli" }
    });
    const otherTaskId = "task_20990101_000000_other-result";
    await writeFile(
      path.join(root, ".bridge", "results", `${task.id}.json`),
      `${JSON.stringify(
        {
          schema_version: 1,
          task_id: otherTaskId,
          status: "done",
          summary: "This belongs to a different task.",
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

    await expect(store.getResult(task.id)).rejects.toThrow(/Result record is corrupt: \.bridge\/results\/.*\.json\. Move it aside or fix the JSON/i);
    await expect(store.listResults()).rejects.toThrow(/Result record is corrupt: \.bridge\/results\/.*\.json\. Move it aside or fix the JSON/i);
  });

  it("rejects task, session, and receipt records whose internal ids do not match the filename", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const store = new BridgeStore(root);
    await store.ensure();
    const taskRecordId = "task_20990101_000000_task-record";
    const sessionRecordId = "sess_20990101_000000_session-record";
    const receiptRecordId = "receipt_20990101_000000_receipt-record";
    await writeFile(
      path.join(root, ".bridge", "tasks", `${taskRecordId}.json`),
      `${JSON.stringify(
        {
          schema_version: 1,
          id: "task_20990101_000000_other-task",
          source: "codex",
          status: "new",
          title: "Mismatched task",
          prompt: "This task id does not match the record filename.",
          repo_id: "default",
          files: [],
          provenance: { adapter: "cli", warnings: [] },
          created_at: "2099-01-01T00:00:00.000Z",
          updated_at: "2099-01-01T00:00:00.000Z"
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(
      path.join(root, ".bridge", "sessions", `${sessionRecordId}.json`),
      `${JSON.stringify(
        {
          schema_version: 1,
          id: "sess_20990101_000000_other-session",
          direction: "codex_to_chatgpt",
          backend: "manual",
          status: "preview",
          warnings: [],
          created_at: "2099-01-01T00:00:00.000Z",
          last_used_at: "2099-01-01T00:00:00.000Z"
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(
      path.join(root, ".bridge", "receipts", `${receiptRecordId}.json`),
      `${JSON.stringify(
        {
          schema_version: 1,
          id: "receipt_20990101_000000_other-receipt",
          kind: "task_created",
          summary: "Mismatched receipt id",
          metadata: {},
          created_at: "2099-01-01T00:00:00.000Z"
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await expect(store.getTask(taskRecordId)).rejects.toThrow(/Task record is corrupt: \.bridge\/tasks\/.*\.json\. Move it aside or fix the JSON/i);
    await expect(store.listTasks()).rejects.toThrow(/Task record is corrupt: \.bridge\/tasks\/.*\.json\. Move it aside or fix the JSON/i);
    await expect(store.getSession(sessionRecordId)).rejects.toThrow(
      /Session record is corrupt: \.bridge\/sessions\/.*\.json\. Move it aside or fix the JSON/i
    );
    await expect(store.listSessions()).rejects.toThrow(
      /Session record is corrupt: \.bridge\/sessions\/.*\.json\. Move it aside or fix the JSON/i
    );
    await expect(store.getReceipt(receiptRecordId)).rejects.toThrow(
      /Receipt record is corrupt: \.bridge\/receipts\/.*\.json\. Move it aside or fix the JSON/i
    );
    await expect(store.listReceipts()).rejects.toThrow(
      /Receipt record is corrupt: \.bridge\/receipts\/.*\.json\. Move it aside or fix the JSON/i
    );
  });

  it("cleans up a created task record when the creation receipt cannot be stored", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const store = new BridgeStore(root);
    setBridgeStoreTestHooks({
      beforeRecordRename: async (kind) => {
        if (kind === "receipts") throw new Error("forced task receipt failure");
      }
    });

    await expect(
      store.createTask({
        source: "codex",
        title: "Receipt fails",
        prompt: "Do not leave an unreceipted task.",
        repo_id: "default",
        files: [],
        provenance: { adapter: "cli" }
      })
    ).rejects.toThrow(/forced task receipt failure/);
    await expect(readdir(path.join(root, ".bridge", "tasks"))).resolves.toEqual([]);
  });

  it("restores an unclaimed task when the claim receipt cannot be stored", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const store = new BridgeStore(root);
    const task = await store.createTask({
      source: "codex",
      title: "Claim receipt fails",
      prompt: "Do not leave an unreceipted claim.",
      repo_id: "default",
      files: [],
      provenance: { adapter: "cli" }
    });
    setBridgeStoreTestHooks({
      beforeRecordRename: async (kind) => {
        if (kind === "receipts") throw new Error("forced claim receipt failure");
      }
    });

    await expect(store.claimTask(task.id, "codex-main")).rejects.toThrow(/forced claim receipt failure/);

    const restored = await store.getTask(task.id);
    expect(restored).toEqual(expect.objectContaining({ id: task.id, status: "new" }));
    expect(restored).not.toHaveProperty("claimed_by");
    expect(restored).not.toHaveProperty("claimed_at");
    await expect(store.listReceipts({ kind: "task_claimed", task_id: task.id })).resolves.toHaveLength(0);
  });

  it("restores a non-terminal task when the completion receipt cannot be stored", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const store = new BridgeStore(root);
    const task = await store.createTask({
      source: "codex",
      title: "Completion receipt fails",
      prompt: "Do not leave an unreceipted terminal task.",
      repo_id: "default",
      files: [],
      provenance: { adapter: "cli" }
    });
    const claimed = await store.claimTask(task.id, "codex-main");
    setBridgeStoreTestHooks({
      beforeRecordRename: async (kind) => {
        if (kind === "receipts") throw new Error("forced completion receipt failure");
      }
    });

    await expect(
      store.completeTask(task.id, {
        status: "done",
        summary: "Completion summary.",
        commands: ["npm test"]
      })
    ).rejects.toThrow(/forced completion receipt failure/);

    const restored = await store.getTask(task.id);
    expect(restored).toEqual(expect.objectContaining({ id: task.id, status: "claimed", claimed_by: "codex-main" }));
    expect(restored).not.toHaveProperty("result_path");
    await expect(store.getResult(task.id)).resolves.toEqual(expect.objectContaining({ task_id: task.id, summary: "Completion summary." }));
    await expect(store.listReceipts({ kind: "task_completed", task_id: task.id })).resolves.toHaveLength(0);

    setBridgeStoreTestHooks({});
    const retried = await store.completeTask(claimed.id, {
      status: "done",
      summary: "Completion summary.",
      commands: ["npm test"]
    });

    expect(retried).toEqual(expect.objectContaining({ task_id: task.id, summary: "Completion summary." }));
    await expect(store.getTask(task.id)).resolves.toEqual(expect.objectContaining({ status: "done" }));
    await expect(store.listReceipts({ kind: "task_completed", task_id: task.id })).resolves.toHaveLength(1);
  });

  it("repairs a non-terminal task when retrying completion after the matching result was already written", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const store = new BridgeStore(root);
    const task = await store.createTask({
      source: "codex",
      title: "Retry partial finalize",
      prompt: "Recover by retrying the same completion.",
      repo_id: "default",
      files: [],
      provenance: { adapter: "cli" }
    });
    await writeFile(
      path.join(root, ".bridge", "results", `${task.id}.json`),
      `${JSON.stringify(
        {
          schema_version: 1,
          task_id: task.id,
          status: "done",
          summary: "Recovered summary.",
          artifacts: [],
          commands: ["npm test"],
          warnings: ["already wrote result"],
          created_at: "2099-01-01T00:00:00.000Z"
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const result = await store.completeTask(task.id, {
      status: "done",
      summary: "Recovered summary.",
      commands: ["npm test"],
      warnings: ["already wrote result"]
    });

    expect(result).toEqual(expect.objectContaining({ task_id: task.id, summary: "Recovered summary." }));
    await expect(store.getTask(task.id)).resolves.toEqual(
      expect.objectContaining({
        status: "done",
        result_path: `.bridge/results/${task.id}.json`
      })
    );
    await expect(store.getResult(task.id)).resolves.toEqual(expect.objectContaining({ summary: "Recovered summary." }));
  });

  it("repairs a non-terminal task with a legacy unhashed result artifact without rereading the artifact", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const store = new BridgeStore(root);
    const task = await store.createTask({
      source: "codex",
      title: "Retry legacy artifact",
      prompt: "Recover by retrying a legacy artifact completion.",
      repo_id: "default",
      files: [],
      provenance: { adapter: "cli" }
    });
    await mkdir(path.join(root, ".bridge", "artifacts", "results"), { recursive: true });
    await writeFile(path.join(root, ".bridge", "artifacts", "results", "legacy.md"), "legacy answer\n", "utf8");
    await writeFile(
      path.join(root, ".bridge", "results", `${task.id}.json`),
      `${JSON.stringify(
        {
          schema_version: 1,
          task_id: task.id,
          status: "done",
          summary: "Recovered legacy artifact summary.",
          artifacts: [{ path: ".bridge/artifacts/results/legacy.md", role: "result", bytes: 14 }],
          commands: ["npm test"],
          warnings: [],
          created_at: "2099-01-01T00:00:00.000Z"
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await rm(path.join(root, ".bridge", "artifacts", "results", "legacy.md"));

    const result = await store.completeTask(task.id, {
      status: "done",
      summary: "Recovered legacy artifact summary.",
      artifacts: [{ path: ".bridge/artifacts/results/legacy.md", role: "result", bytes: 14 }],
      commands: ["npm test"]
    });

    expect(result).toEqual(expect.objectContaining({ task_id: task.id, summary: "Recovered legacy artifact summary." }));
    await expect(store.getTask(task.id)).resolves.toEqual(expect.objectContaining({ status: "done" }));
  });

  it("rejects non-terminal task repair when a hashed result artifact is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const store = new BridgeStore(root);
    const task = await store.createTask({
      source: "codex",
      title: "Retry hashed artifact",
      prompt: "Recover by retrying a hashed artifact completion.",
      repo_id: "default",
      files: [],
      provenance: { adapter: "cli" }
    });
    await mkdir(path.join(root, ".bridge", "artifacts", "results"), { recursive: true });
    await writeFile(path.join(root, ".bridge", "artifacts", "results", "hashed.md"), "hashed answer\n", "utf8");
    await writeFile(
      path.join(root, ".bridge", "results", `${task.id}.json`),
      `${JSON.stringify(
        {
          schema_version: 1,
          task_id: task.id,
          status: "done",
          summary: "Recovered hashed artifact summary.",
          artifacts: [
            {
              path: ".bridge/artifacts/results/hashed.md",
              role: "result",
              bytes: "hashed answer\n".length,
              sha256: "e89c883dd92d10b652566ef903006543e5901c315d5346f54b0d7339c127411a"
            }
          ],
          commands: ["npm test"],
          warnings: [],
          created_at: "2099-01-01T00:00:00.000Z"
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await rm(path.join(root, ".bridge", "artifacts", "results", "hashed.md"));

    await expect(
      store.completeTask(task.id, {
        status: "done",
        summary: "Recovered hashed artifact summary.",
        artifacts: [{ path: ".bridge/artifacts/results/hashed.md", role: "result", bytes: 1 }],
        commands: ["npm test"]
      })
    ).rejects.toThrow(/Result artifact changed after finalization|no such file|ENOENT/i);
    await expect(store.getTask(task.id)).resolves.toEqual(expect.objectContaining({ status: "new" }));
    await expect(store.listReceipts({ kind: "task_completed", task_id: task.id })).resolves.toHaveLength(0);
  });

  it("repairs a terminal task when retrying completion after the matching result was written but the receipt is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const store = new BridgeStore(root);
    const task = await store.createTask({
      source: "codex",
      title: "Retry missing receipt",
      prompt: "Recover a terminal task receipt.",
      repo_id: "default",
      files: [],
      provenance: { adapter: "cli" }
    });
    const first = await store.completeTask(task.id, {
      status: "done",
      summary: "Receipt repair summary.",
      commands: ["npm test"]
    });
    const completionReceipts = await store.listReceipts({ kind: "task_completed", task_id: task.id });
    for (const receipt of completionReceipts) {
      await rm(path.join(root, ".bridge", "receipts", `${receipt.id}.json`));
    }

    const retried = await store.completeTask(task.id, {
      status: "done",
      summary: "Receipt repair summary.",
      commands: ["npm test"]
    });

    expect(retried).toEqual(first);
    await expect(store.getTask(task.id)).resolves.toEqual(expect.objectContaining({ status: "done" }));
    await expect(store.listReceipts({ kind: "task_completed", task_id: task.id })).resolves.toHaveLength(1);
  });

  it("rejects trusted result reads when the finalized result payload changed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const store = new BridgeStore(root);
    const task = await store.createTask({
      source: "codex",
      title: "Tampered result payload",
      prompt: "Do not trust mutable result files.",
      repo_id: "default",
      files: [],
      provenance: { adapter: "cli" }
    });
    await store.completeTask(task.id, {
      status: "done",
      summary: "Original trusted summary.",
      commands: ["npm test"]
    });
    const resultPath = path.join(root, ".bridge", "results", `${task.id}.json`);
    const resultRecord = JSON.parse(await readFile(resultPath, "utf8")) as Record<string, unknown>;
    resultRecord.summary = "Tampered summary.";
    await writeFile(resultPath, `${JSON.stringify(resultRecord, null, 2)}\n`, "utf8");

    await expect(store.getFinalizedResultReadOnly(task.id)).rejects.toThrow(/result payload|result_sha256|untrusted/i);
  });

  it("repairs a terminal task when the existing completion receipt is untrusted", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const store = new BridgeStore(root);
    const task = await store.createTask({
      source: "codex",
      title: "Retry untrusted receipt",
      prompt: "Recover a terminal task receipt with broken integrity.",
      repo_id: "default",
      files: [],
      provenance: { adapter: "cli" }
    });
    const first = await store.completeTask(task.id, {
      status: "done",
      summary: "Receipt integrity repair summary.",
      commands: ["npm test"]
    });
    const [completionReceipt] = await store.listReceipts({ kind: "task_completed", task_id: task.id });
    const receiptPath = path.join(root, ".bridge", "receipts", `${completionReceipt.id}.json`);
    const receiptRecord = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
    delete receiptRecord.integrity;
    await writeFile(receiptPath, `${JSON.stringify(receiptRecord, null, 2)}\n`, "utf8");

    const retried = await store.completeTask(task.id, {
      status: "done",
      summary: "Receipt integrity repair summary.",
      commands: ["npm test"]
    });

    expect(retried).toEqual(first);
    await expect(store.getTask(task.id)).resolves.toEqual(expect.objectContaining({ status: "done" }));
    await expect(store.getFinalizedResultReadOnly(task.id)).resolves.toEqual(expect.objectContaining({ summary: "Receipt integrity repair summary." }));
  });

  it("reseals a finalized result only from a locally signed legacy completion receipt", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const store = new BridgeStore(root);
    const task = await store.createTask({
      source: "codex",
      title: "Reseal legacy result",
      prompt: "Upgrade a legacy completion receipt.",
      repo_id: "default",
      files: [],
      provenance: { adapter: "cli" }
    });
    await store.completeTask(task.id, {
      status: "done",
      summary: "Legacy result summary.",
      commands: ["npm test"]
    });
    const completionReceipts = await store.listReceipts({ kind: "task_completed", task_id: task.id });
    for (const receipt of completionReceipts) {
      await store.deleteReceiptIfPresent(receipt.id);
    }
    await store.writeReceipt({
      kind: "task_completed",
      task_id: task.id,
      summary: `Legacy completed task ${task.id}`
    });
    await expect(store.getFinalizedResultReadOnly(task.id)).rejects.toThrow(/result_sha256/i);

    const resealed = await store.resealResult(task.id);

    expect(resealed.result.summary).toBe("Legacy result summary.");
    expect(resealed.receipt.kind).toBe("task_completed");
    expect(resealed.receipt.metadata.result_sha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(store.getFinalizedResultReadOnly(task.id)).resolves.toEqual(expect.objectContaining({ summary: "Legacy result summary." }));
  });

  it("does not reseal a finalized result from unsigned or different-payload completion receipts", async () => {
    const unsignedRoot = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const unsignedStore = new BridgeStore(unsignedRoot);
    const unsignedTask = await unsignedStore.createTask({
      source: "codex",
      title: "Unsigned reseal",
      prompt: "Do not reseal unsigned receipts.",
      repo_id: "default",
      files: [],
      provenance: { adapter: "cli" }
    });
    await unsignedStore.completeTask(unsignedTask.id, { status: "done", summary: "Unsigned result." });
    for (const receipt of await unsignedStore.listReceipts({ kind: "task_completed", task_id: unsignedTask.id })) {
      await unsignedStore.deleteReceiptIfPresent(receipt.id);
    }
    await writeFile(
      path.join(unsignedRoot, ".bridge", "receipts", "receipt_20990101_000000_unsigned-completion.json"),
      `${JSON.stringify(
        {
          schema_version: 1,
          id: "receipt_20990101_000000_unsigned-completion",
          kind: "task_completed",
          task_id: unsignedTask.id,
          summary: "Unsigned completion",
          metadata: {},
          created_at: "2099-01-01T00:00:00.000Z"
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await expect(unsignedStore.resealResult(unsignedTask.id)).rejects.toThrow(/locally trusted legacy task_completed receipt/i);

    const mismatchRoot = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const mismatchStore = new BridgeStore(mismatchRoot);
    const mismatchTask = await mismatchStore.createTask({
      source: "codex",
      title: "Mismatched reseal",
      prompt: "Do not reseal different result payloads.",
      repo_id: "default",
      files: [],
      provenance: { adapter: "cli" }
    });
    await mismatchStore.completeTask(mismatchTask.id, { status: "done", summary: "Mismatched result." });
    for (const receipt of await mismatchStore.listReceipts({ kind: "task_completed", task_id: mismatchTask.id })) {
      await mismatchStore.deleteReceiptIfPresent(receipt.id);
    }
    await mismatchStore.writeReceipt({
      kind: "task_completed",
      task_id: mismatchTask.id,
      summary: `Mismatched completed task ${mismatchTask.id}`,
      metadata: { result_sha256: "0".repeat(64) }
    });

    await expect(mismatchStore.resealResult(mismatchTask.id)).rejects.toThrow(/locally trusted legacy task_completed receipt/i);

    const multipleRoot = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const multipleStore = new BridgeStore(multipleRoot);
    const multipleTask = await multipleStore.createTask({
      source: "codex",
      title: "Multiple legacy reseal",
      prompt: "Do not guess between multiple legacy completion receipts.",
      repo_id: "default",
      files: [],
      provenance: { adapter: "cli" }
    });
    await multipleStore.completeTask(multipleTask.id, { status: "done", summary: "Multiple legacy result." });
    for (const receipt of await multipleStore.listReceipts({ kind: "task_completed", task_id: multipleTask.id })) {
      await multipleStore.deleteReceiptIfPresent(receipt.id);
    }
    await multipleStore.writeReceipt({
      kind: "task_completed",
      task_id: multipleTask.id,
      summary: `First legacy completed task ${multipleTask.id}`
    });
    await multipleStore.writeReceipt({
      kind: "task_completed",
      task_id: multipleTask.id,
      summary: `Second legacy completed task ${multipleTask.id}`
    });

    await expect(multipleStore.resealResult(multipleTask.id)).rejects.toThrow(/multiple locally signed legacy task_completed receipts/i);
  });

  it("rejects terminal task receipt repair when a finalized result artifact is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const store = new BridgeStore(root);
    const task = await store.createTask({
      source: "codex",
      title: "Retry receipt artifact",
      prompt: "Recover a terminal task receipt with an artifact.",
      repo_id: "default",
      files: [],
      provenance: { adapter: "cli" }
    });
    const artifactPath = await store.writeArtifactText(".bridge/artifacts/results/receipt-repair.md", "receipt repair answer\n");
    const first = await store.completeTask(task.id, {
      status: "done",
      summary: "Receipt repair artifact summary.",
      artifacts: [{ path: artifactPath, role: "result" }],
      commands: ["npm test"]
    });
    const completionReceipts = await store.listReceipts({ kind: "task_completed", task_id: task.id });
    for (const receipt of completionReceipts) {
      await rm(path.join(root, ".bridge", "receipts", `${receipt.id}.json`));
    }
    await rm(path.join(root, artifactPath));

    await expect(
      store.completeTask(task.id, {
        status: "done",
        summary: "Receipt repair artifact summary.",
        artifacts: first.artifacts,
        commands: ["npm test"]
      })
    ).rejects.toThrow(/Result artifact changed after finalization|no such file|ENOENT/i);
    await expect(store.listReceipts({ kind: "task_completed", task_id: task.id })).resolves.toHaveLength(0);
  });

  it("rejects terminal task receipt repair when a finalized result artifact changed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const store = new BridgeStore(root);
    const task = await store.createTask({
      source: "codex",
      title: "Retry tampered receipt artifact",
      prompt: "Do not retrust changed result artifacts.",
      repo_id: "default",
      files: [],
      provenance: { adapter: "cli" }
    });
    const artifactPath = await store.writeArtifactText(".bridge/artifacts/results/receipt-repair-tamper.md", "original receipt repair answer\n");
    const first = await store.completeTask(task.id, {
      status: "done",
      summary: "Receipt repair tamper summary.",
      artifacts: [{ path: artifactPath, role: "result" }],
      commands: ["npm test"]
    });
    const completionReceipts = await store.listReceipts({ kind: "task_completed", task_id: task.id });
    for (const receipt of completionReceipts) {
      await rm(path.join(root, ".bridge", "receipts", `${receipt.id}.json`));
    }
    await store.writeArtifactText(artifactPath, "tampered receipt repair answer\n");

    await expect(
      store.completeTask(task.id, {
        status: "done",
        summary: "Receipt repair tamper summary.",
        artifacts: first.artifacts,
        commands: ["npm test"]
      })
    ).rejects.toThrow(/Result artifact changed after finalization/);
    await expect(store.listReceipts({ kind: "task_completed", task_id: task.id })).resolves.toHaveLength(0);
  });

  it("cleans up stale internal record temp hard links before reading a result", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const store = new BridgeStore(root);
    const task = await store.createTask({
      source: "codex",
      title: "Stale temp hard link",
      prompt: "Recover a result with a leftover temp hard link.",
      repo_id: "default",
      files: [],
      provenance: { adapter: "cli" }
    });
    await store.completeTask(task.id, { status: "done", summary: "Readable result." });
    const resultPath = path.join(root, ".bridge", "results", `${task.id}.json`);
    const staleTempPath = path.join(root, ".bridge", "results", `.${task.id}.json.stale.tmp`);
    await link(resultPath, staleTempPath);

    await expect(store.getResult(task.id)).resolves.toEqual(expect.objectContaining({ summary: "Readable result." }));
    await expect(lstat(staleTempPath)).rejects.toThrow();
  });

  it("does not clean stale record temp hard links through a swapped storage symlink", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const outside = await mkdtemp(path.join(tmpdir(), "prodex-outside-"));
    const store = new BridgeStore(root);
    const task = await store.createTask({
      source: "codex",
      title: "Swapped cleanup",
      prompt: "Avoid cleaning outside the bridge.",
      repo_id: "default",
      files: [],
      provenance: { adapter: "cli" }
    });
    await store.completeTask(task.id, { status: "done", summary: "Protected result." });
    const resultPath = path.join(root, ".bridge", "results", `${task.id}.json`);
    const tempName = `.${task.id}.json.stale.tmp`;
    await link(resultPath, path.join(root, ".bridge", "results", tempName));
    await link(resultPath, path.join(outside, tempName));
    let swapped = false;
    setBridgeStoreTestHooks({
      beforeRecordTempCleanup: async (kind) => {
        if (kind !== "results" || swapped) return;
        swapped = true;
        await rename(path.join(root, ".bridge", "results"), path.join(root, ".bridge", "results-real"));
        await symlink(outside, path.join(root, ".bridge", "results"));
      }
    });

    await expect(store.getResult(task.id)).rejects.toThrow(/Bridge storage directory|symlink|changed|ENOENT/i);
    await expect(lstat(path.join(outside, tempName))).resolves.toEqual(expect.objectContaining({ nlink: expect.any(Number) }));
  });

  it("stores artifacts only under the local artifacts directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const store = new BridgeStore(root);

    const relativePath = await store.writeArtifactText(".bridge/artifacts/repo-writes/example.txt", "payload\n");

    expect(relativePath).toBe(".bridge/artifacts/repo-writes/example.txt");
    expect(await store.readArtifactText(relativePath)).toBe("payload\n");
    await expect(store.writeArtifactText(".bridge/receipts/not-artifact.txt", "bad\n")).rejects.toThrow(/artifacts/);
    await expect(store.writeArtifactText(".bridge/artifacts/../receipts/bad.txt", "bad\n")).rejects.toThrow(/artifacts/);
  });

  it("rejects artifact writes through symlink escapes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const outside = await mkdtemp(path.join(tmpdir(), "prodex-outside-"));
    await mkdir(path.join(root, ".bridge", "artifacts", "repo-writes"), { recursive: true });
    await symlink(outside, path.join(root, ".bridge", "artifacts", "repo-writes", "outside"));
    const store = new BridgeStore(root);

    await expect(
      store.writeArtifactText(".bridge/artifacts/repo-writes/outside/payload.txt", "payload\n")
    ).rejects.toThrow(/artifacts/);
  });

  it("rejects artifact writes when the target is swapped to a symlink before open", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const outside = await mkdtemp(path.join(tmpdir(), "prodex-outside-"));
    const outsideFile = path.join(outside, "secret.txt");
    const relativePath = ".bridge/artifacts/repo-writes/payload.txt";
    const artifactPath = path.join(root, relativePath);
    await mkdir(path.dirname(artifactPath), { recursive: true });
    await writeFile(outsideFile, "outside\n", "utf8");
    const store = new BridgeStore(root);
    let swapped = false;
    setSafeFileTestHooks({
      beforeOpen: async (filePath) => {
        if (!swapped && filePath === artifactPath) {
          swapped = true;
          await symlink(outsideFile, artifactPath);
        }
      }
    });

    await expect(store.writeArtifactText(relativePath, "payload\n")).rejects.toThrow(/symlink|changed|artifacts/i);
    expect(await readFile(outsideFile, "utf8")).toBe("outside\n");
  });

  it("rejects artifact writes through hard-linked files without touching the linked target", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const outside = await mkdtemp(path.join(tmpdir(), "prodex-outside-"));
    const outsideFile = path.join(outside, "secret.txt");
    const relativePath = ".bridge/artifacts/repo-writes/payload.txt";
    const artifactPath = path.join(root, relativePath);
    await mkdir(path.dirname(artifactPath), { recursive: true });
    await writeFile(outsideFile, "outside\n", "utf8");
    await link(outsideFile, artifactPath);
    const store = new BridgeStore(root);

    await expect(store.writeArtifactText(relativePath, "payload\n")).rejects.toThrow(/linked|hard link/i);
    expect(await readFile(outsideFile, "utf8")).toBe("outside\n");
  });

  it("rejects artifact writes without touching outside files when the parent directory is swapped before open", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const outside = await mkdtemp(path.join(tmpdir(), "prodex-outside-"));
    const swapDir = path.join(root, ".bridge", "artifacts", "subdir");
    const artifactPath = path.join(swapDir, "payload.txt");
    const outsideFile = path.join(outside, "payload.txt");
    await mkdir(swapDir, { recursive: true });
    await writeFile(outsideFile, "outside\n", "utf8");
    const store = new BridgeStore(root);
    let swapped = false;
    setSafeFileTestHooks({
      beforeOpen: async (filePath, operation) => {
        if (!swapped && operation === "write" && filePath === artifactPath) {
          swapped = true;
          await rm(swapDir, { recursive: true, force: true });
          await symlink(outside, swapDir);
        }
      }
    });

    await expect(store.writeArtifactText(".bridge/artifacts/subdir/payload.txt", "payload\n")).rejects.toThrow(
      /symlink|changed|artifacts/i
    );
    expect(await readFile(outsideFile, "utf8")).toBe("outside\n");
  });

  it("does not create directories through symlinked artifact ancestors before rejecting", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const outside = await mkdtemp(path.join(tmpdir(), "prodex-outside-"));
    await mkdir(path.join(root, ".bridge", "artifacts"), { recursive: true });
    await symlink(outside, path.join(root, ".bridge", "artifacts", "repo-writes"));
    const store = new BridgeStore(root);

    await expect(
      store.writeArtifactText(".bridge/artifacts/repo-writes/nested/payload.txt", "payload\n")
    ).rejects.toThrow(/artifacts/);
    await expect(lstat(path.join(outside, "nested"))).rejects.toThrow();
  });

  it("rejects artifact writes when the artifacts directory itself is a symlink", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const outside = await mkdtemp(path.join(tmpdir(), "prodex-outside-"));
    await mkdir(path.join(root, ".bridge"), { recursive: true });
    await symlink(outside, path.join(root, ".bridge", "artifacts"));
    const store = new BridgeStore(root);

    await expect(
      store.writeArtifactText(".bridge/artifacts/repo-writes/payload.txt", "payload\n")
    ).rejects.toThrow(/artifacts/);
  });

  it("rejects bridge storage when the bridge directory itself is a symlink", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const outside = await mkdtemp(path.join(tmpdir(), "prodex-outside-"));
    await symlink(outside, path.join(root, ".bridge"));
    const store = new BridgeStore(root);

    await expect(
      store.writeArtifactText(".bridge/artifacts/repo-writes/payload.txt", "payload\n")
    ).rejects.toThrow(/Bridge directory/);
  });

  it("rejects artifact reads when the bridge directory itself is a symlink", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const outside = await mkdtemp(path.join(tmpdir(), "prodex-outside-"));
    await mkdir(path.join(outside, "artifacts", "repo-writes"), { recursive: true });
    await symlink(outside, path.join(root, ".bridge"));
    const store = new BridgeStore(root);

    await expect(
      store.readArtifactText(".bridge/artifacts/repo-writes/payload.txt")
    ).rejects.toThrow(/Bridge directory/);
  });

  it("rejects artifact reads through symlinked ancestors even when they point inside artifacts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const store = new BridgeStore(root);
    await store.writeArtifactText(".bridge/artifacts/real-dir/payload.txt", "payload\n");
    await symlink(
      path.join(root, ".bridge", "artifacts", "real-dir"),
      path.join(root, ".bridge", "artifacts", "linked-dir")
    );

    await expect(
      store.readArtifactText(".bridge/artifacts/linked-dir/payload.txt")
    ).rejects.toThrow(/artifacts/);
  });

  it("rejects artifact reads when the target is swapped to a symlink before open", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const outside = await mkdtemp(path.join(tmpdir(), "prodex-outside-"));
    const outsideFile = path.join(outside, "secret.txt");
    await writeFile(outsideFile, "outside\n", "utf8");
    const store = new BridgeStore(root);
    const relativePath = await store.writeArtifactText(".bridge/artifacts/repo-writes/payload.txt", "payload\n");
    const artifactPath = path.join(root, relativePath);
    let swapped = false;
    setSafeFileTestHooks({
      beforeOpen: async (filePath) => {
        if (!swapped && filePath === artifactPath) {
          swapped = true;
          await rm(artifactPath);
          await symlink(outsideFile, artifactPath);
        }
      }
    });

    await expect(store.readArtifactText(relativePath)).rejects.toThrow(/symlink|changed|artifacts/i);
    expect(await readFile(outsideFile, "utf8")).toBe("outside\n");
  });

  it("rejects unsafe artifact reads without leaking raw bridge filesystem paths", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const store = new BridgeStore(root);
    const relativePath = ".bridge/artifacts/results/hard-linked-artifact.txt";
    await store.writeArtifactText(relativePath, "payload\n");
    const artifactPath = path.join(root, relativePath);
    const outside = await mkdtemp(path.join(tmpdir(), "prodex-outside-"));
    await link(artifactPath, path.join(outside, "hard-linked-artifact.txt"));

    await expect(store.readArtifactText(relativePath)).rejects.toThrow(/linked|hard link/i);
    await expect(store.readArtifactText(relativePath)).rejects.not.toThrow(root);
    await expect(store.readArtifactText(relativePath)).rejects.not.toThrow(path.join(root, ".bridge"));
  });

  it("rejects receipt storage when the receipts directory itself is a symlink", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const outside = await mkdtemp(path.join(tmpdir(), "prodex-outside-"));
    await mkdir(path.join(root, ".bridge"), { recursive: true });
    await symlink(outside, path.join(root, ".bridge", "receipts"));
    const store = new BridgeStore(root);

    await expect(
      store.writeReceipt({ kind: "consult_preview", summary: "Should not escape local receipt storage" })
    ).rejects.toThrow(/Bridge storage directory/);
    expect(await readdir(outside)).toEqual([]);
  });

  it("rejects record reads when the target is swapped to a symlink before open", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const outside = await mkdtemp(path.join(tmpdir(), "prodex-outside-"));
    const outsideFile = path.join(outside, "receipt.json");
    await writeFile(outsideFile, "{}\n", "utf8");
    const store = new BridgeStore(root);
    const receipt = await store.writeReceipt({ kind: "consult_preview", summary: "safe receipt" });
    const receiptPath = path.join(root, ".bridge", "receipts", `${receipt.id}.json`);
    let swapped = false;
    setSafeFileTestHooks({
      beforeOpen: async (filePath) => {
        if (!swapped && filePath === receiptPath) {
          swapped = true;
          await rm(receiptPath);
          await symlink(outsideFile, receiptPath);
        }
      }
    });

    await expect(store.getReceipt(receipt.id)).rejects.toThrow(/symlink|changed|record/i);
    expect(await readFile(outsideFile, "utf8")).toBe("{}\n");
  });

  it("uses session ids as a deterministic latest tie-breaker", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const store = new BridgeStore(root);
    await store.ensure();
    const first = {
      schema_version: 1,
      id: "sess_20990101_000000_first",
      direction: "codex_to_chatgpt",
      backend: "manual",
      status: "preview",
      warnings: [],
      created_at: "2099-01-01T00:00:00.000Z",
      last_used_at: "2099-01-01T00:00:00.000Z"
    };
    const second = {
      ...first,
      id: "sess_20990101_000000_second"
    };
    await writeFile(path.join(root, ".bridge", "sessions", `${first.id}.json`), `${JSON.stringify(first, null, 2)}\n`, "utf8");
    await writeFile(path.join(root, ".bridge", "sessions", `${second.id}.json`), `${JSON.stringify(second, null, 2)}\n`, "utf8");

    await expect(store.listSessions()).resolves.toMatchObject([{ id: second.id }, { id: first.id }]);
  });

  it("uses result task ids as a deterministic latest tie-breaker", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const store = new BridgeStore(root);
    await store.ensure();
    const first = {
      schema_version: 1,
      task_id: "task_20990101_000000_z-first",
      status: "done",
      summary: "First",
      artifacts: [],
      commands: [],
      warnings: [],
      created_at: "2099-01-01T00:00:00.000Z"
    };
    const second = {
      ...first,
      task_id: "task_20990101_000000_a-second",
      summary: "Second"
    };
    await writeFile(path.join(root, ".bridge", "results", `${first.task_id}.json`), `${JSON.stringify(first, null, 2)}\n`, "utf8");
    await writeFile(path.join(root, ".bridge", "results", `${second.task_id}.json`), `${JSON.stringify(second, null, 2)}\n`, "utf8");

    await expect(store.listResults()).resolves.toMatchObject([{ task_id: second.task_id }, { task_id: first.task_id }]);
  });

  it("uses task ids as a deterministic task list tie-breaker", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const store = new BridgeStore(root);
    await store.ensure();
    const first = {
      schema_version: 1,
      id: "task_20990101_000000_z-first",
      source: "codex",
      status: "new",
      title: "First",
      prompt: "First prompt",
      repo_id: "default",
      files: [],
      provenance: { adapter: "cli", warnings: [] },
      created_at: "2099-01-01T00:00:00.000Z",
      updated_at: "2099-01-01T00:00:00.000Z"
    };
    const second = {
      ...first,
      id: "task_20990101_000000_a-second",
      title: "Second",
      prompt: "Second prompt"
    };
    await writeFile(path.join(root, ".bridge", "tasks", `${first.id}.json`), `${JSON.stringify(first, null, 2)}\n`, "utf8");
    await writeFile(path.join(root, ".bridge", "tasks", `${second.id}.json`), `${JSON.stringify(second, null, 2)}\n`, "utf8");

    await expect(store.listTasks()).resolves.toMatchObject([{ id: second.id }, { id: first.id }]);
  });

  it("rejects record writes when the storage directory is swapped to a symlink before open", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const outside = await mkdtemp(path.join(tmpdir(), "prodex-outside-"));
    const movedReceiptsDir = path.join(root, ".bridge", "receipts-real");
    const store = new BridgeStore(root);
    await store.ensure();
    let swapped = false;
    setSafeFileTestHooks({
      beforeOpen: async (_filePath, operation) => {
        if (!swapped && operation === "write") {
          swapped = true;
          await rename(path.join(root, ".bridge", "receipts"), movedReceiptsDir);
          await symlink(outside, path.join(root, ".bridge", "receipts"));
        }
      }
    });

    await expect(
      store.writeReceipt({ kind: "consult_preview", summary: "Should not follow swapped receipt storage" })
    ).rejects.toThrow(/Bridge storage directory|record|symlink|ENOENT/i);
    expect(await readdir(outside)).toEqual([]);
  });

  it("uses stable directory fd paths for new result writes even when process.platform is non-Linux", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const outside = await mkdtemp(path.join(tmpdir(), "prodex-outside-"));
    const movedResultsDir = path.join(root, ".bridge", "results-real");
    const store = new BridgeStore(root);
    const task = await store.createTask({
      source: "codex",
      title: "Fallback result swap",
      prompt: "Avoid writing outside through fallback create.",
      repo_id: "default",
      files: [],
      provenance: { adapter: "cli" }
    });
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    let swapped = false;
    setSafeFileTestHooks({
      beforeOpen: async (filePath, operation) => {
        if (!swapped && operation === "write" && filePath === path.join(root, ".bridge", "results", `${task.id}.json`)) {
          swapped = true;
          await rename(path.join(root, ".bridge", "results"), movedResultsDir);
          await symlink(outside, path.join(root, ".bridge", "results"));
        }
      }
    });

    try {
      await expect(store.completeTask(task.id, { status: "done", summary: "Should not write outside." })).resolves.toEqual(
        expect.objectContaining({ status: "done", summary: "Should not write outside." })
      );
      expect(await readdir(outside)).toEqual([]);
      expect(swapped).toBe(false);
      await expect(readFile(path.join(root, ".bridge", "results", `${task.id}.json`), "utf8")).resolves.toContain("Should not write outside.");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("rejects non-Linux record writes when storage is swapped before rename", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const outside = await mkdtemp(path.join(tmpdir(), "prodex-outside-"));
    const movedReceiptsDir = path.join(root, ".bridge", "receipts-real");
    const store = new BridgeStore(root);
    await store.ensure();
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    let swapped = false;
    setBridgeStoreTestHooks({
      beforeRecordRename: async (kind) => {
        if (swapped || kind !== "receipts") return;
        swapped = true;
        await rename(path.join(root, ".bridge", "receipts"), movedReceiptsDir);
        await symlink(outside, path.join(root, ".bridge", "receipts"));
      }
    });

    try {
      await expect(store.writeReceipt({ kind: "consult_preview", summary: "Should not rename outside" })).rejects.toThrow(
        /changed|symlink|Bridge storage directory/i
      );
      expect(await readdir(outside)).toEqual([]);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
      setBridgeStoreTestHooks({});
    }
  });

  it("fails closed when stable directory fd paths are unavailable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-store-"));
    const store = new BridgeStore(root);
    await store.ensure();
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    setBridgeStoreTestHooks({ disableDirectoryFdPaths: true });

    try {
      await expect(store.writeReceipt({ kind: "consult_preview", summary: "Should fail closed" })).rejects.toThrow(
        /stable directory file descriptor paths/i
      );
      await expect(readdir(path.join(root, ".bridge", "receipts"))).resolves.toEqual([]);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
      setBridgeStoreTestHooks({});
    }
  });
});

async function expectMode(filePath: string, expectedMode: number): Promise<void> {
  if (process.platform === "win32") return;
  expect((await stat(filePath)).mode & 0o777).toBe(expectedMode);
}
