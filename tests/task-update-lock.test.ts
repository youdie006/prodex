import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeStore, setBridgeStoreTestHooks } from "../src/store.js";

// Found 2026-11-09. A claim held its own lock, but completing a task took no
// lock, so the two could interleave: the claim read "new", the completion ran
// to the end, then the claim wrote "claimed" over it. The task stayed claimed
// with no result_path next to a done result and its trusted receipt, and its
// claimer could no longer complete it. With real processes 11 of 30 tasks
// ended that way.
async function store(): Promise<{ a: BridgeStore; b: BridgeStore }> {
  const root = await mkdtemp(path.join(tmpdir(), "prodex-task-lock-"));
  return { a: new BridgeStore(root, { registerRoot: false }), b: new BridgeStore(root, { registerRoot: false }) };
}

const newTask = (s: BridgeStore) => s.createTask({ source: "codex", title: "race", prompt: "p", provenance: { adapter: "cli", warnings: [] } });

describe("task updates from two processes", () => {
  afterEach(() => setBridgeStoreTestHooks({}));

  it("does not let a claim overwrite a completion that ran while it was writing", async () => {
    const { a, b } = await store();
    const task = await newTask(a);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let paused = false;
    setBridgeStoreTestHooks({
      beforeRecordRename: async (kind) => {
        if (!paused && kind === "tasks") {
          paused = true;
          await gate;
        }
      }
    });
    const claim = a.claimTask(task.id, "agent-A");
    while (!paused) await new Promise((resolve) => setTimeout(resolve, 5));
    setBridgeStoreTestHooks({});
    const complete = b.completeTask(task.id, { status: "done", summary: "B finished it" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    await Promise.allSettled([claim, complete]);

    const onDisk = await a.getTask(task.id);
    const result = await a.getResult(task.id);
    expect(result.status).toBe("done");
    expect(onDisk.status).toBe("done");
    expect(onDisk.result_path).toBe(`.bridge/results/${task.id}.json`);
  });
});
