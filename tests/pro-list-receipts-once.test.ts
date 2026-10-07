import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { listConsultListEntries } from "../src/cli-pro.js";
import { BridgeStore } from "../src/store.js";

// Measured 2026-10-07: `prodex pro list` took 238 s in a repo with 260
// consults and 969 receipts, because every consult re-read every receipt to
// find its own completion receipt.
describe("listing consults", () => {
  it("reads the receipts once, not once per consult, and still trusts each", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-list-receipts-"));
    const store = new BridgeStore(cwd);
    for (let i = 0; i < 12; i += 1) {
      const task = await store.createTask({
        source: "codex",
        title: "GPT Pro consult",
        prompt: `Consult ${i}`,
        repo_id: "default",
        files: [],
        provenance: { adapter: "chatgpt-control", warnings: [] }
      });
      await store.completeTask(task.id, { status: "done", summary: `answer ${i}`, commands: ["visible ChatGPT browser consult"] });
    }
    const readAll = vi.spyOn(BridgeStore.prototype as unknown as { readAll: (...args: unknown[]) => unknown }, "readAll");
    const entries = await listConsultListEntries(store);
    const receiptReads = readAll.mock.calls.filter((call) => call[0] === "receipts").length;
    readAll.mockRestore();
    expect(entries).toHaveLength(12);
    expect(entries.every((entry) => entry.kind === "trusted")).toBe(true);
    expect(receiptReads).toBeLessThanOrEqual(1);
  });
});
