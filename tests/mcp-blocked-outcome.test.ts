import { describe, expect, it } from "vitest";

import { mcpBlockedConsultOutcome } from "../src/cli-pro.js";

// Measured 2026-10-20 over a fresh stdio MCP server (0.40.37): a pro_consult
// that timed out came back as plain error text telling the agent to run
// `prodex pro browser recover --target-url ... --request-id ...`. The --json
// blocked record (thread, blocker) printed for it was dropped, and pro_recover
// asks for "the blocker's thread field" that the agent never received.
const id = "5a72bbd0652789141ce28fcfd619540c";
const thread = "https://chatgpt.com/c/6ad6c773-20b8-83e8-b690-8283f580ea78";
const blocked = {
  task_id: "task_20261020_014525_gpt-pro-consult",
  status: "blocked",
  thread,
  answer: null,
  warnings: [],
  blocker: {
    code: "send_timeout",
    message: "Timed out after 15s (15000ms) waiting for ChatGPT to respond.",
    retryable: false,
    next_step: `Do not resend automatically. ChatGPT often finishes after prodex gives up; recover that exact request instead: \`prodex pro browser recover --target-url ${thread} --request-id ${id}\`.`
  }
};

describe("a blocked consult over MCP", () => {
  it("returns the blocked record with the pro_recover call to make", () => {
    const outcome = mcpBlockedConsultOutcome(JSON.stringify(blocked, null, 2).split("\n"), new Error("Timed out ... blocked consult recorded"));
    expect(outcome).toMatchObject({
      task_id: blocked.task_id,
      status: "blocked",
      thread,
      request_id: id,
      blocker: { code: "send_timeout" },
      recover: { tool: "pro_recover", arguments: { thread, request_id: id } }
    });
    expect(outcome?.message).toContain("blocked consult recorded");
  });

  it("names no recovery when nothing was sent into a thread", () => {
    const early = { ...blocked, thread: null, blocker: { code: "composer_not_ready", message: "No composer.", retryable: true } };
    const outcome = mcpBlockedConsultOutcome([JSON.stringify(early)], new Error("No composer."));
    expect(outcome?.status).toBe("blocked");
    expect(outcome).not.toHaveProperty("recover");
  });

  it("leaves an error without a blocked record to be thrown as before", () => {
    expect(mcpBlockedConsultOutcome(["not json"], new Error("boom"))).toBeUndefined();
    expect(mcpBlockedConsultOutcome([], new Error("boom"))).toBeUndefined();
  });
});
