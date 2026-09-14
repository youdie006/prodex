import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getTokenExpiryStatus, loadLocalConfig, writeLocalConfig } from "../src/config.js";
import { runSetupCommand } from "../src/cli-server.js";
import { buildIssueReport } from "../src/issue-report.js";
import { createMcpToolHandlers } from "../src/mcp-tools.js";
import { BridgeStore } from "../src/store.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("review privacy and recovery regressions", () => {
  it("directs expired-token recovery to an explicit renewal command", () => {
    const status = getTokenExpiryStatus({ token_expires_at: "2020-01-01T00:00:00.000Z" });
    expect(status.status).toBe("expired");
    expect(status.warning).toContain("prodex setup --token-ttl-hours <hours>");
  });

  it("renews the token without resetting an existing custom listener", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-renewal-review-"));
    roots.push(cwd);
    const initial = await writeLocalConfig(cwd, { host: "localhost", port: 9797, token: "fake-old-token", tokenTtlHours: 1 });
    await runSetupCommand(["--token-ttl-hours", "2"], { cwd, stdout: () => {}, stderr: () => {} });
    const renewed = await loadLocalConfig(cwd);
    expect(renewed.token).not.toBe(initial.token);
    expect(renewed.host).toBe("localhost");
    expect(renewed.port).toBe(9797);
    expect(getTokenExpiryStatus(renewed).status).toBe("valid");
  });

  it("keeps private answer text and recovery instructions out of public reports", () => {
    const report = buildIssueReport({
      task_id: "task_review",
      status: "blocked",
      blocker: {
        code: "smoke_token_mismatch",
        message: "Expected a smoke token. Actual: PRIVATE_ANSWER_MARKER",
        retryable: false,
        next_step: "Inspect https://chatgpt.com/c/PRIVATE_THREAD_MARKER or PRIVATE_LOCAL_PATH"
      }
    }, { version: "0.40.6", platform: "linux", nodeVersion: "v22" });
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE_|chatgpt\.com/);
    expect(report.title).toContain("smoke_token_mismatch");
    expect(report.body).toContain("0.40.6");
  });

  it("redacts nested thread metadata consistently without changing local records", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-privacy-review-"));
    roots.push(cwd);
    const store = new BridgeStore(cwd, { registerRoot: false });
    const handlers = createMcpToolHandlers({ cwd, registerRoot: false });
    const thread = "https://chatgpt.com/c/PRIVATE_THREAD_MARKER";
    const blocker = {
      code: "send_timeout", message: `Still waiting in ${thread}.`, retryable: true,
      next_step: `prodex pro browser recover --target-url ${thread}`, thread
    };
    const task = await store.createTask({ source: "codex", title: "Review", prompt: "test", provenance: { adapter: "cli" } });
    await store.completeTask(task.id, { status: "blocked", summary: blocker.message, blocker, warnings: [`recover: ${thread}`] });
    const session = await store.writeSession({
      direction: "codex_to_chatgpt", backend: "chatgpt-control", task_id: task.id,
      status: "blocked", thread, blocker, warnings: [`recover: ${thread}`]
    });
    const responses = [
      await handlers.bridge_fetch_result({ task_id: task.id }),
      await handlers.bridge_list_results(),
      await handlers.bridge_get_task({ task_id: task.id }),
      await handlers.bridge_list_tasks({}),
      await handlers.bridge_get_session({ session_id: session.id }),
      await handlers.bridge_list_sessions({})
    ];
    for (const response of responses) {
      expect(JSON.stringify(response)).not.toContain("PRIVATE_THREAD_MARKER");
      expect(JSON.stringify(response)).toContain("send_timeout");
    }
    expect((await store.getResult(task.id)).blocker?.thread).toBe(thread);
    expect((await store.getSession(session.id)).blocker?.thread).toBe(thread);
    expect((await store.getTask(task.id)).blocker?.thread).toBe(thread);
  });
});
