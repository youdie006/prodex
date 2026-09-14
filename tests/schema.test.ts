import { describe, expect, it } from "vitest";
import { SessionKeySchema, TaskSchema } from "../src/schema.js";

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

describe("SessionKeySchema", () => {
  it("accepts bounded identifiers and rejects empty, oversized, or prose values", () => {
    expect(SessionKeySchema.parse("codex:thread-123/turn_4")).toBe("codex:thread-123/turn_4");
    expect(() => SessionKeySchema.parse("   ")).toThrow();
    expect(() => SessionKeySchema.parse("x".repeat(129))).toThrow();
    expect(() => SessionKeySchema.parse("review my private research prompt")).toThrow();
  });
});
