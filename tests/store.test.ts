import { lstat, mkdir, mkdtemp, readFile, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BridgeStore } from "../src/store.js";

describe("BridgeStore", () => {
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
});
