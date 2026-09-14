import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { BridgeStore } from "../src/store.js";
import { createMcpToolHandlers } from "../src/mcp-tools.js";
import { runResultsCommand } from "../src/cli-ledger.js";

it("labels a legacy unhashed artifact as unverified without silently migrating it", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "prodex-legacy-warning-"));
  try {
    const store = new BridgeStore(cwd, { registerRoot: false });
    const task = await store.createTask({ source: "codex", title: "Legacy", prompt: "test", provenance: { adapter: "cli" } });
    const artifact = await store.writeArtifactText(".bridge/artifacts/results/legacy.md", "original\n");
    const legacy = {
      schema_version: 1, task_id: task.id, status: "done", summary: "Legacy answer",
      artifacts: [{ path: artifact, role: "result" }], commands: [], warnings: [], created_at: new Date().toISOString()
    };
    await writeFile(path.join(cwd, ".bridge", "results", `${task.id}.json`), JSON.stringify(legacy));
    await store.completeTask(task.id, { status: "done", summary: "Legacy answer", artifacts: [{ path: artifact, role: "result" }] });
    await writeFile(path.join(cwd, artifact), "changed\n");
    const fetched = await createMcpToolHandlers({ cwd, registerRoot: false }).bridge_fetch_result_artifact({ task_id: task.id });
    expect(fetched.content).toBe("changed\n");
    expect(fetched).toHaveProperty("warnings", [expect.stringContaining("legacy_artifact_unverified")]);
    const stdout: string[] = [];
    const stderr: string[] = [];
    expect(await runResultsCommand(["artifact", task.id], {
      cwd, stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value)
    })).toBe(0);
    expect(stdout).toEqual(["changed\n"]);
    expect(stderr).toEqual([expect.stringContaining("legacy_artifact_unverified")]);
    expect((await store.getResult(task.id)).artifacts[0].sha256).toBeUndefined();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
