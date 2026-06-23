import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createMcpToolHandlers } from "../src/mcp-tools.js";

describe("MCP tool handlers", () => {
  it("creates tasks and fetches results through Claude-compatible handlers", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    const handlers = createMcpToolHandlers({ cwd });

    const created = await handlers.bridge_create_task({
      title: "From Claude",
      prompt: "Please hand this to Codex.",
      repo_id: "default",
      files: []
    });

    expect(created.task.id).toContain("task_");

    const listed = await handlers.bridge_list_tasks({});
    expect(listed.tasks.map((task) => task.title)).toContain("From Claude");
  });

  it("exposes read-only repo file access", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    await writeFile(path.join(cwd, "README.md"), "alpha\nbeta\n", "utf8");
    const handlers = createMcpToolHandlers({ cwd });

    const result = await handlers.repo_read_file({ path: "README.md", start_line: 2, max_lines: 1 });

    expect(result.content).toBe("beta");
  });
});
