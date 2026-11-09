import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createMcpToolHandlers } from "../src/mcp-tools.js";
import { BridgeStore } from "../src/store.js";

// Found 2026-11-09: MCP bridge_complete_task naming an artifact that does not
// exist returned the raw "ENOENT: no such file or directory, lstat
// '<home>/.../.bridge/artifacts/results'", which names the parent directory
// rather than the file and hands the machine's absolute path to the client,
// the HTTP MCP surface included. A deleted artifact read later did the same.
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "prodex-missing-artifact-"));
  const store = new BridgeStore(root, { registerRoot: false });
  const task = await store.createTask({ source: "codex", title: "t", prompt: "p", provenance: { adapter: "mcp", warnings: [] } });
  return { root, store, task };
}

describe("a missing artifact", () => {
  it("is named by its repo path when a completion lists it", async () => {
    const { root, task } = await setup();
    const handlers = createMcpToolHandlers({ cwd: root, registerRoot: false });
    const missing = ".bridge/artifacts/results/does-not-exist.md";
    const attempt = handlers.bridge_complete_task({ task_id: task.id, summary: "s", artifacts: [{ path: missing, role: "result" }] } as never);
    await expect(attempt).rejects.toThrow(`Artifact not found: ${missing}`);
    await expect(attempt).rejects.not.toThrow(root);
  });

  it("is named by its repo path when a saved result's artifact was deleted", async () => {
    const { root, store, task } = await setup();
    const stored = await store.writeArtifactText(".bridge/artifacts/results/answer.md", "answer");
    await store.completeTask(task.id, { status: "done", summary: "s", artifacts: [{ path: stored, role: "result" }] });
    await rm(path.join(root, stored));
    const read = store.readResultArtifactText(task.id, stored);
    await expect(read).rejects.toThrow(stored);
    await expect(read).rejects.not.toThrow(root);
  });
});
