import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { BridgeStore } from "../src/store.js";

// Reading records one at a time cost the file count times the filesystem's
// latency. Measured on this repo, whose store sits on a Windows mount at ~24ms
// a file: 505 receipts took 12.0s and 146 tasks took 4.8s, and `pro latest` -
// the command every send prints as its follow-up - paid it on every call,
// because verifying ONE result reads every receipt. Concurrent reads bring the
// same work to 2.1s and 0.4s. What must not change is what a caller is TOLD,
// so these pin the contract the sequential loop had.
async function storeWithReceipts(files: Record<string, string>): Promise<BridgeStore> {
  const root = await mkdtemp(path.join(tmpdir(), "prodex-readall-"));
  const store = new BridgeStore(root);
  await store.ensure();
  await mkdir(path.join(root, ".bridge", "receipts"), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await writeFile(path.join(root, ".bridge", "receipts", name), body, "utf8");
  }
  return store;
}

function receipt(id: string, taskId: string): string {
  return JSON.stringify({
    schema_version: 1,
    id,
    kind: "task_created",
    task_id: taskId,
    created_at: "2026-08-27T00:00:00.000Z",
    summary: "x",
    metadata: {},
    integrity: { algorithm: "hmac-sha256", digest: "0".repeat(64) }
  });
}

describe("reading a directory of records", () => {
  it("returns every record, not just the ones that won a race", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 60; i += 1) {
      const id = `receipt_2026082${i % 10}_00000${i % 10}_task-created${i}`;
      files[`${id}.json`] = receipt(id, `task_2026082${i % 10}_00000${i % 10}_demo`);
    }
    const store = await storeWithReceipts(files);

    const receipts = await store.listReceiptsReadOnly();

    expect(receipts).toHaveLength(60);
    expect(new Set(receipts.map((entry) => entry.id)).size).toBe(60);
  });

  it("reports the EARLIEST corrupt record, the one the sequential loop reached first", async () => {
    // The old loop threw at the first bad file and never read the rest, so that
    // is the error callers learned about. Concurrent reads must not hand back
    // whichever failure happened to land first.
    //
    // The two corrupt files are deliberately lopsided: the earlier one is
    // megabytes of junk and the later one is a few bytes, so the later one
    // always loses its read race by a wide margin. Reporting by index gives the
    // big one every time; reporting by whoever failed first gives the small one
    // every time. Without that gap the two behaviours are a coin flip and the
    // test only caught the regression three runs in five.
    const store = await storeWithReceipts({
      "receipt_20260827_000001_task-created.json": receipt("receipt_20260827_000001_task-created", "task_20260827_000001_demo"),
      "receipt_20260827_000002_task-created.json": `{ this is not json ${"x".repeat(4_000_000)}`,
      "receipt_20260827_000003_task-created.json": "{",
      "receipt_20260827_000004_task-created.json": receipt("receipt_20260827_000004_task-created", "task_20260827_000004_demo")
    });

    await expect(store.listReceiptsReadOnly()).rejects.toThrow(/000002/);
  });
});
