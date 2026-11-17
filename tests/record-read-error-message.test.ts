import { chmod, link, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BridgeStore } from "../src/store.js";

// Found 2026-11-09: with a task record at mode 000, `prodex tasks list` failed
// as "EACCES: permission denied, open '/proc/self/fd/20/task_...json'", naming
// a descriptor rather than the record, and with a hard-linked record as
// "Target path is hard linked and cannot be used through safe file
// operations", naming nothing. Neither said what to do about it.
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "prodex-record-read-error-"));
  const store = new BridgeStore(root, { registerRoot: false });
  const task = await store.createTask({ source: "codex", title: "t", prompt: "p", provenance: { adapter: "cli", warnings: [] } });
  const record = `.bridge/tasks/${task.id}.json`;
  return { root, store, task, record };
}

// Windows has no mode 000, and root reads such a file anyway.
const canMakeUnreadable = process.platform !== "win32" && process.getuid?.() !== 0;

describe("a record that cannot be read", () => {
  it.skipIf(!canMakeUnreadable)("is named by its repo path when it is unreadable", async () => {
    const { root, store, task, record } = await setup();
    await chmod(path.join(root, record), 0o000);
    const listed = store.listTasks();
    await expect(listed).rejects.toThrow(`Task record is not readable: ${record}`);
    await expect(listed).rejects.toThrow(/move it aside, then retry/i);
    await expect(listed).rejects.not.toThrow(root);
    await expect(listed).rejects.not.toThrow("/proc/self/fd");
    await expect(store.getTaskReadOnly(task.id)).rejects.toMatchObject({ code: "EACCES" });
  });

  it("is named by its repo path when it is hard linked", async () => {
    const { root, store, task, record } = await setup();
    await link(path.join(root, record), path.join(root, "second-name.json"));
    const listed = store.listTasks();
    await expect(listed).rejects.toThrow(`Task record is hard linked: ${record}`);
    await expect(listed).rejects.toThrow(/move the record aside, then retry/i);
    await expect(listed).rejects.not.toThrow(root);
    await expect(store.getTaskReadOnly(task.id)).rejects.toThrow(`Task record is hard linked: ${record}`);
  });
});
