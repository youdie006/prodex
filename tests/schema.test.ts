import { describe, expect, it } from "vitest";
import { TaskSchema } from "../src/schema.js";

describe("TaskSchema", () => {
  it("requires versioned provenance and lifecycle fields", () => {
    const parsed = TaskSchema.parse({
      schema_version: 1,
      id: "task_20260623_095500_review",
      source: "chatgpt_project",
      status: "new",
      title: "Review plan",
      prompt: "Please review this plan.",
      repo_id: "default",
      files: [],
      provenance: {
        adapter: "mcp",
        session_id: "sess_20260623_095500_review"
      },
      created_at: "2026-06-23T00:55:00.000Z",
      updated_at: "2026-06-23T00:55:00.000Z"
    });

    expect(parsed.schema_version).toBe(1);
    expect(parsed.provenance.adapter).toBe("mcp");
  });
});
