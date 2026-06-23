import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setSafeFileTestHooks } from "../src/safe-file.js";
import { BridgeStore } from "../src/store.js";

describe("BridgeStore", () => {
  afterEach(() => {
    setSafeFileTestHooks({});
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
