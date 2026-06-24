import { link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setSafeFileTestHooks } from "../src/safe-file.js";
import { BridgeStore, setBridgeStoreTestHooks } from "../src/store.js";

describe("BridgeStore", () => {
  afterEach(() => {
    setSafeFileTestHooks({});
    setBridgeStoreTestHooks({});
  });

  it("creates, claims, completes, and fetches task results", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gptprouse-store-"));
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

  it("rejects finalizing a task after it is already done or blocked", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gptprouse-store-"));
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

  it("rejects finalizing a task when a mismatched result record already exists for a non-terminal task", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gptprouse-store-"));
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

  it("repairs a non-terminal task when retrying completion after the matching result was already written", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gptprouse-store-"));
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

  it("repairs a terminal task when retrying completion after the matching result was written but the receipt is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gptprouse-store-"));
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

  it("cleans up stale internal record temp hard links before reading a result", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gptprouse-store-"));
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
    const root = await mkdtemp(path.join(tmpdir(), "gptprouse-store-"));
    const outside = await mkdtemp(path.join(tmpdir(), "gptprouse-outside-"));
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
    const root = await mkdtemp(path.join(tmpdir(), "gptprouse-store-"));
    const store = new BridgeStore(root);

    const relativePath = await store.writeArtifactText(".bridge/artifacts/repo-writes/example.txt", "payload\n");

    expect(relativePath).toBe(".bridge/artifacts/repo-writes/example.txt");
    expect(await store.readArtifactText(relativePath)).toBe("payload\n");
    await expect(store.writeArtifactText(".bridge/receipts/not-artifact.txt", "bad\n")).rejects.toThrow(/artifacts/);
    await expect(store.writeArtifactText(".bridge/artifacts/../receipts/bad.txt", "bad\n")).rejects.toThrow(/artifacts/);
  });

  it("rejects artifact writes through symlink escapes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gptprouse-store-"));
    const outside = await mkdtemp(path.join(tmpdir(), "gptprouse-outside-"));
    await mkdir(path.join(root, ".bridge", "artifacts", "repo-writes"), { recursive: true });
    await symlink(outside, path.join(root, ".bridge", "artifacts", "repo-writes", "outside"));
    const store = new BridgeStore(root);

    await expect(
      store.writeArtifactText(".bridge/artifacts/repo-writes/outside/payload.txt", "payload\n")
    ).rejects.toThrow(/artifacts/);
  });

  it("rejects artifact writes when the target is swapped to a symlink before open", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gptprouse-store-"));
    const outside = await mkdtemp(path.join(tmpdir(), "gptprouse-outside-"));
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
    const root = await mkdtemp(path.join(tmpdir(), "gptprouse-store-"));
    const outside = await mkdtemp(path.join(tmpdir(), "gptprouse-outside-"));
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
    const root = await mkdtemp(path.join(tmpdir(), "gptprouse-store-"));
    const outside = await mkdtemp(path.join(tmpdir(), "gptprouse-outside-"));
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
    const root = await mkdtemp(path.join(tmpdir(), "gptprouse-store-"));
    const outside = await mkdtemp(path.join(tmpdir(), "gptprouse-outside-"));
    await mkdir(path.join(root, ".bridge", "artifacts"), { recursive: true });
    await symlink(outside, path.join(root, ".bridge", "artifacts", "repo-writes"));
    const store = new BridgeStore(root);

    await expect(
      store.writeArtifactText(".bridge/artifacts/repo-writes/nested/payload.txt", "payload\n")
    ).rejects.toThrow(/artifacts/);
    await expect(lstat(path.join(outside, "nested"))).rejects.toThrow();
  });

  it("rejects artifact writes when the artifacts directory itself is a symlink", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gptprouse-store-"));
    const outside = await mkdtemp(path.join(tmpdir(), "gptprouse-outside-"));
    await mkdir(path.join(root, ".bridge"), { recursive: true });
    await symlink(outside, path.join(root, ".bridge", "artifacts"));
    const store = new BridgeStore(root);

    await expect(
      store.writeArtifactText(".bridge/artifacts/repo-writes/payload.txt", "payload\n")
    ).rejects.toThrow(/artifacts/);
  });

  it("rejects bridge storage when the bridge directory itself is a symlink", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gptprouse-store-"));
    const outside = await mkdtemp(path.join(tmpdir(), "gptprouse-outside-"));
    await symlink(outside, path.join(root, ".bridge"));
    const store = new BridgeStore(root);

    await expect(
      store.writeArtifactText(".bridge/artifacts/repo-writes/payload.txt", "payload\n")
    ).rejects.toThrow(/Bridge directory/);
  });

  it("rejects artifact reads when the bridge directory itself is a symlink", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gptprouse-store-"));
    const outside = await mkdtemp(path.join(tmpdir(), "gptprouse-outside-"));
    await mkdir(path.join(outside, "artifacts", "repo-writes"), { recursive: true });
    await symlink(outside, path.join(root, ".bridge"));
    const store = new BridgeStore(root);

    await expect(
      store.readArtifactText(".bridge/artifacts/repo-writes/payload.txt")
    ).rejects.toThrow(/Bridge directory/);
  });

  it("rejects artifact reads through symlinked ancestors even when they point inside artifacts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gptprouse-store-"));
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
    const root = await mkdtemp(path.join(tmpdir(), "gptprouse-store-"));
    const outside = await mkdtemp(path.join(tmpdir(), "gptprouse-outside-"));
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

  it("rejects receipt storage when the receipts directory itself is a symlink", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gptprouse-store-"));
    const outside = await mkdtemp(path.join(tmpdir(), "gptprouse-outside-"));
    await mkdir(path.join(root, ".bridge"), { recursive: true });
    await symlink(outside, path.join(root, ".bridge", "receipts"));
    const store = new BridgeStore(root);

    await expect(
      store.writeReceipt({ kind: "consult_preview", summary: "Should not escape local receipt storage" })
    ).rejects.toThrow(/Bridge storage directory/);
    expect(await readdir(outside)).toEqual([]);
  });

  it("rejects record reads when the target is swapped to a symlink before open", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gptprouse-store-"));
    const outside = await mkdtemp(path.join(tmpdir(), "gptprouse-outside-"));
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
    const root = await mkdtemp(path.join(tmpdir(), "gptprouse-store-"));
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
    const root = await mkdtemp(path.join(tmpdir(), "gptprouse-store-"));
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
    const root = await mkdtemp(path.join(tmpdir(), "gptprouse-store-"));
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
    const root = await mkdtemp(path.join(tmpdir(), "gptprouse-store-"));
    const outside = await mkdtemp(path.join(tmpdir(), "gptprouse-outside-"));
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
});
