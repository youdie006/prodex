import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { BridgeStore } from "../src/store.js";

async function trustedStatus(store: BridgeStore, receiptId: string): Promise<unknown> {
  const shown = await store.getReceiptForDisplayReadOnly(receiptId);
  return shown.metadata.integrity_status;
}

describe("receipt integrity key rotation", () => {
  it("keeps old receipts trusted after rotation and signs new ones with the new key", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-rotate-"));
    const store = new BridgeStore(cwd);
    await store.ensure();
    const before = await store.writeReceipt({ kind: "task_created", task_id: "task_a", summary: "before rotation" });

    const out: string[] = [];
    await runCli(["receipts", "rotate-key"], { cwd, stdout: (line) => out.push(line), stderr: () => {} });

    const keyFile = await readFile(path.join(cwd, ".bridge", "receipt-key.local"), "utf8");
    const keys = keyFile.split("\n").filter((line) => line.trim());
    expect(keys).toHaveLength(2);
    expect(keys.every((key) => /^[a-f0-9]{64}$/.test(key))).toBe(true);

    const after = await store.writeReceipt({ kind: "task_created", task_id: "task_b", summary: "after rotation" });

    // Old receipt verifies via the legacy key; new receipt via the active key.
    expect(await trustedStatus(store, before.id)).toBeUndefined();
    expect(await trustedStatus(store, after.id)).toBeUndefined();
    expect(out.join("\n")).toContain("2 key(s)");
  });

  it("marks receipts untrusted when no key in the file matches", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-rotate-"));
    const store = new BridgeStore(cwd);
    await store.ensure();
    const receipt = await store.writeReceipt({ kind: "task_created", task_id: "task_a", summary: "s" });

    const keyPath = path.join(cwd, ".bridge", "receipt-key.local");
    await writeFile(keyPath, `${"a".repeat(64)}\n${"b".repeat(64)}\n`, "utf8");

    expect(await trustedStatus(store, receipt.id)).toEqual({
      trusted: false,
      reason: "local integrity verification failed"
    });
  });

  it("rejects a corrupt multi-line key file", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-rotate-"));
    const store = new BridgeStore(cwd);
    await store.ensure();
    const keyPath = path.join(cwd, ".bridge", "receipt-key.local");
    await writeFile(keyPath, `${"a".repeat(64)}\nnot-a-key\n`, "utf8");

    await expect(store.writeReceipt({ kind: "task_created", task_id: "task_a", summary: "s" })).rejects.toThrow(/corrupt/);
  });
});
