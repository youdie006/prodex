import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeTaskCompleteArtifacts } from "../src/cli-ledger.js";
import { BridgeStore } from "../src/store.js";

// Measured: `tasks complete --artifact .bridge/artifacts/results/b.md=one
// --artifact .bridge/artifacts/results/b.md=two` overwrote "one" without a
// word and recorded b.md twice, after which `results artifact <task>` refused
// with "multiple result artifacts" while naming the same file twice.

async function claimedTask(): Promise<{ root: string; store: BridgeStore; taskId: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "prodex-dup-artifact-"));
  const store = new BridgeStore(root);
  await store.ensure();
  const task = await store.createTask({
    source: "codex",
    title: "Dup artifact",
    prompt: "p",
    repo_id: "default",
    files: [],
    provenance: { adapter: "cli" }
  });
  await store.claimTask(task.id, "codex");
  return { root, store, taskId: task.id };
}

describe("one result artifact path per result", () => {
  it("refuses a result that lists the same artifact twice", async () => {
    const { store, taskId } = await claimedTask();
    const stored = await store.writeArtifactText(".bridge/artifacts/results/b.md", "one");
    await expect(
      store.completeTask(taskId, {
        status: "done",
        summary: "s",
        artifacts: [
          { path: stored, role: "result" },
          { path: stored, role: "result" }
        ]
      })
    ).rejects.toThrow(/\.bridge\/artifacts\/results\/b\.md.*more than once/);
    expect((await store.getTask(taskId)).status).toBe("claimed");
  });

  it("refuses repeated --artifact paths before writing either one", async () => {
    const { root, store } = await claimedTask();
    await expect(
      writeTaskCompleteArtifacts(store, [".bridge/artifacts/results/b.md=one", ".bridge/artifacts/results/./b.md=two"])
    ).rejects.toThrow(/--artifact .*b\.md.*more than once/);
    await expect(access(path.join(root, ".bridge", "artifacts", "results", "b.md"))).rejects.toThrow();
  });
});
