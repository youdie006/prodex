import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendChatGptPromptMock = vi.hoisted(() => vi.fn());
const recoverChatGptAnswerFromThreadMock = vi.hoisted(() => vi.fn());

vi.mock("../src/chatgpt-browser.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/chatgpt-browser.js")>();
  return {
    ...actual,
    sendChatGptPrompt: sendChatGptPromptMock,
    recoverChatGptAnswerFromThread: recoverChatGptAnswerFromThreadMock
  };
});

const { createServer } = await import("../src/mcp.js");
const { performBrowserConsultForMcp, performBrowserRecoverForMcp } = await import("../src/cli-pro.js");

type CreatedServer = ReturnType<typeof createServer>;

async function connectClient(server: CreatedServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "prodex-test", version: "0.1.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

beforeEach(() => {
  process.env.PRODEX_MIN_SEND_INTERVAL_MS = "0";
  sendChatGptPromptMock.mockReset();
});

afterEach(() => {
  delete process.env.PRODEX_MIN_SEND_INTERVAL_MS;
  vi.unstubAllEnvs();
});

describe("pro_consult MCP tool registration", () => {
  it("is absent by default so the HTTP MCP surface never exposes it", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-mcp-consult-"));
    const client = await connectClient(createServer(cwd));

    const tools = await client.listTools();
    await client.close();

    expect(tools.tools.map((tool) => tool.name)).not.toContain("pro_consult");
  });

  it("bridges send progress to MCP progress notifications when the client asks for them", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-mcp-consult-"));
    sendChatGptPromptMock.mockImplementationOnce(
      async (options: { onProgress?: (event: { phase: string; elapsedMs: number; detail?: string }) => void }) => {
        options.onProgress?.({ phase: "connecting", elapsedMs: 0, detail: "port 9333" });
        options.onProgress?.({ phase: "waiting", elapsedMs: 15_000, detail: "generating" });
        return {
          url: "https://chatgpt.com/c/mcp-progress",
          title: "ChatGPT",
          answer: "progress answer",
          modelHints: [],
          warnings: []
        };
      }
    );
    const { performBrowserConsultForMcp } = await import("../src/cli-pro.js");
    const server = createServer(cwd, {
      browserConsult: (input, onProgress) => performBrowserConsultForMcp(cwd, input, onProgress)
    });
    const client = await connectClient(server);
    const progressMessages: string[] = [];

    const result = (await client.callTool(
      { name: "pro_consult", arguments: { prompt: "Progress question" } },
      undefined,
      {
        onprogress: (progress: { message?: string }) => {
          if (progress.message) progressMessages.push(progress.message);
        }
      }
    )) as { content: Array<{ type: string; text: string }> };
    await client.close();

    expect(JSON.parse(result.content[0].text).answer).toContain("progress answer");
    expect(progressMessages).toContain("progress: connecting to browser (port 9333)");
    expect(progressMessages).toContain("progress: waiting 15s (generating)");
  });

  it("no longer advertises pro_mode, and ignores it when an agent passes one anyway", async () => {
    // Field failure: ChatGPT removed Pro sub-modes, but the tool still
    // advertised pro_mode - so agents passed pro_mode:"true" and got a hard
    // "must be one of 기본, 확장" error instead of an answer.
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-mcp-consult-"));
    sendChatGptPromptMock.mockResolvedValueOnce({
      url: "https://chatgpt.com/c/mcp-no-pro-mode",
      title: "ChatGPT",
      answer: "answered anyway",
      modelHints: [],
      warnings: []
    });
    const server = createServer(cwd, {
      browserConsult: (input) => performBrowserConsultForMcp(cwd, input)
    });
    const client = await connectClient(server);
    const tools = await client.listTools();
    const consult = tools.tools.find((tool) => tool.name === "pro_consult");
    expect(Object.keys((consult?.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {})).not.toContain(
      "pro_mode"
    );
    expect(JSON.stringify(consult?.description ?? "")).not.toContain("pro_mode");

    const result = (await client.callTool({
      name: "pro_consult",
      arguments: { prompt: "MCP question", pro_mode: "true" }
    })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    await client.close();

    expect(result.isError ?? false).toBe(false);
    expect(result.content[0].text).toContain("answered anyway");
    expect(sendChatGptPromptMock).toHaveBeenLastCalledWith(expect.not.objectContaining({ proMode: expect.anything() }));
  });

  it("gives agents a way to recover an answer whose consult timed out", async () => {
    // A timed-out consult hands back the thread, but an MCP-only agent had no
    // tool to do anything with it - the next step was a shell command it may
    // not be able to run. Recovery has to be reachable the same way the
    // consult was.
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-mcp-recover-"));
    recoverChatGptAnswerFromThreadMock.mockResolvedValueOnce({
      url: "https://chatgpt.com/c/recovered",
      title: "ChatGPT",
      answer: "the answer that finished after prodex stopped waiting",
      modelHints: [],
      warnings: [],
      requestId: "9cb9650622e74a62bd9074c42a311945",
      requestVerified: true
    });
    const server = createServer(cwd, {
      browserConsult: (input) => performBrowserConsultForMcp(cwd, input),
      browserRecover: (input) => performBrowserRecoverForMcp(cwd, input)
    });
    const client = await connectClient(server);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("pro_recover");

    const result = (await client.callTool({
      name: "pro_recover",
      arguments: {
        thread: "https://chatgpt.com/c/recovered",
        request_id: "9cb9650622e74a62bd9074c42a311945"
      }
    })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    await client.close();

    expect(result.isError ?? false).toBe(false);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.answer).toContain("the answer that finished after prodex stopped waiting");
    expect(payload.request_id).toBe("9cb9650622e74a62bd9074c42a311945");
    expect(payload.request_verified).toBe(true);
    expect(recoverChatGptAnswerFromThreadMock).toHaveBeenCalledWith(
      expect.objectContaining({
        targetUrl: "https://chatgpt.com/c/recovered",
        requestId: "9cb9650622e74a62bd9074c42a311945"
      })
    );
  });

  it("does not register pro_recover without a recover callback", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-mcp-recover-"));
    const server = createServer(cwd, {});
    const client = await connectClient(server);
    const tools = await client.listTools();
    await client.close();
    expect(tools.tools.map((tool) => tool.name)).not.toContain("pro_recover");
  });

  it("is registered and answers when a browser-consult callback is wired", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-mcp-consult-"));
    sendChatGptPromptMock.mockResolvedValueOnce({
      url: "https://chatgpt.com/c/mcp-consult",
      title: "ChatGPT",
      answer: "mcp consult answer",
      modelHints: [],
      warnings: []
    });
    const server = createServer(cwd, {
      browserConsult: (input) => performBrowserConsultForMcp(cwd, input)
    });
    const client = await connectClient(server);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("pro_consult");

    const result = (await client.callTool({ name: "pro_consult", arguments: { prompt: "MCP question" } })) as {
      content: Array<{ type: string; text: string }>;
    };
    await client.close();

    const payload = JSON.parse(result.content[0].text) as {
      task_id: string;
      status: string;
      thread: string;
      answer: string;
    };
    expect(payload.status).toBe("done");
    expect(payload.task_id).toMatch(/^task_/);
    expect(payload.thread).toBe("https://chatgpt.com/c/mcp-consult");
    expect(payload.answer).toContain("mcp consult answer");
  });

  it("assigns one stable, distinct default session key per MCP server", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-mcp-consult-"));
    const seen: string[] = [];
    const connect = async () => {
      const server = createServer(cwd, {
        browserConsult: async (input) => {
          seen.push(input.session_key ?? "");
          return { session_key: input.session_key };
        }
      });
      return connectClient(server);
    };
    const first = await connect();
    await first.callTool({ name: "pro_consult", arguments: { prompt: "first" } });
    await first.callTool({ name: "pro_consult", arguments: { prompt: "second" } });
    await first.close();
    const second = await connect();
    await second.callTool({ name: "pro_consult", arguments: { prompt: "third" } });
    await second.close();

    expect(seen[0]).toMatch(/^mcp-/);
    expect(seen[1]).toBe(seen[0]);
    expect(seen[2]).not.toBe(seen[0]);
  });

  it("validates explicit MCP session keys", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-mcp-consult-"));
    const browserConsult = vi.fn(async () => ({}));
    const client = await connectClient(createServer(cwd, { browserConsult }));

    const invalid = (await client.callTool({
      name: "pro_consult",
      arguments: { prompt: "question", session_key: "not an identifier with prose" }
    })) as { isError?: boolean };
    await client.close();

    expect(invalid.isError).toBe(true);
    expect(browserConsult).not.toHaveBeenCalled();
  });

  it("advertises task-driven dialogue and explicit user approval, not a fixed two-turn loop", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-mcp-policy-"));
    const browserConsult = vi.fn(async () => ({}));
    const client = await connectClient(createServer(cwd, { browserConsult }));
    const tools = await client.listTools();
    const consult = tools.tools.find((tool) => tool.name === "pro_consult")!;
    expect(consult.description).toContain("concrete unresolved question");
    expect(consult.description).toContain("repetitive");
    expect(consult.description).toContain("PRODEX_MAX_AUTO_FOLLOWUPS");
    expect(consult.inputSchema.properties).toHaveProperty("user_approved");
    await client.callTool({
      name: "pro_consult",
      arguments: { prompt: "User asked to continue", continue_task: "task_20260915_010000_parent", user_approved: true }
    });
    await client.close();
    expect(browserConsult).toHaveBeenCalledWith(expect.objectContaining({ user_approved: true }), undefined);
  });
});

describe("performBrowserConsultForMcp", () => {
  it("threads selection options into the send and returns structured fields", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-mcp-consult-"));
    sendChatGptPromptMock.mockResolvedValueOnce({
      url: "https://chatgpt.com/c/mcp-options",
      title: "ChatGPT",
      answer: "selected answer",
      modelHints: [],
      warnings: []
    });

    const outcome = await performBrowserConsultForMcp(cwd, {
      prompt: "Question with options",
      model: "Pro",
      pro_mode: "확장",
      timeout_ms: 123_456
    });

    expect(sendChatGptPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: "Pro", proMode: "확장", timeoutMs: 123_456 })
    );
    expect(outcome.thread).toBe("https://chatgpt.com/c/mcp-options");
    expect(outcome.answer).toBe("selected answer");
    expect(outcome.notes.every((note) => !note.startsWith("progress:"))).toBe(true);
  });

  it("threads new_chat through to the send", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-mcp-consult-"));
    sendChatGptPromptMock.mockResolvedValueOnce({
      url: "https://chatgpt.com/c/mcp-fresh",
      title: "ChatGPT",
      answer: "fresh",
      modelHints: [],
      warnings: []
    });

    await performBrowserConsultForMcp(cwd, { prompt: "Fresh consult", new_chat: true });

    expect(sendChatGptPromptMock).toHaveBeenCalledWith(expect.objectContaining({ newChat: true }));
  });

  it("does not let new_chat false opt into the shared current tab", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-mcp-consult-"));
    sendChatGptPromptMock.mockResolvedValueOnce({
      url: "https://chatgpt.com/c/mcp-default-fresh",
      title: "ChatGPT",
      answer: "fresh",
      modelHints: [],
      warnings: []
    });

    await performBrowserConsultForMcp(cwd, { prompt: "Fresh by default", new_chat: false, session_key: "mcp-client-a" });

    expect(sendChatGptPromptMock).toHaveBeenCalledWith(expect.objectContaining({ newChat: true }));
  });

  it("returns and records browser request correlation evidence", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-mcp-consult-"));
    sendChatGptPromptMock.mockResolvedValueOnce({
      url: "https://chatgpt.com/c/mcp-correlated",
      title: "ChatGPT",
      answer: "correlated",
      modelHints: [],
      modelSlug: "gpt-6-pro",
      warnings: [],
      requestId: "9cb9650622e74a62bd9074c42a311945",
      requestVerified: true
    });

    const outcome = await performBrowserConsultForMcp(cwd, {
      prompt: "Correlation check",
      session_key: "mcp-client-a"
    });
    const { BridgeStore } = await import("../src/store.js");
    const receipts = await new BridgeStore(cwd).listReceipts({ kind: "consult_answer_saved", task_id: outcome.task_id });

    expect(outcome.request_id).toBe("9cb9650622e74a62bd9074c42a311945");
    expect(outcome.request_verified).toBe(true);
    expect(outcome.session_key).toBe("mcp-client-a");
    expect(outcome.model_used).toBe("gpt-6-pro");
    expect(outcome.continuation).toEqual({ continue_task: outcome.task_id, session_key: "mcp-client-a" });
    expect(outcome.followup_budget).toEqual({ limit: 5, used: 0, remaining: 5 });
    expect(receipts[0]?.metadata).toEqual(
      expect.objectContaining({
        request_id: "9cb9650622e74a62bd9074c42a311945",
        request_verified: true
      })
    );
  });

  it("keeps truncation warnings visible in the MCP notes", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-mcp-consult-"));
    sendChatGptPromptMock.mockResolvedValueOnce({
      url: "https://chatgpt.com/c/mcp-truncated",
      title: "ChatGPT",
      answer: "partial answer",
      modelHints: [],
      warnings: [
        "answer_incomplete: ChatGPT was still generating after 10ms, so the answer below may be truncated. Raise --timeout-ms and retry for the full response."
      ]
    });

    const outcome = await performBrowserConsultForMcp(cwd, { prompt: "Truncation check" });

    expect(outcome.notes.some((note) => note.startsWith("answer_incomplete:"))).toBe(true);
  });

  it("records the consult in the bridge ledger like a CLI ask", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-mcp-consult-"));
    sendChatGptPromptMock.mockResolvedValueOnce({
      url: "https://chatgpt.com/c/mcp-ledger",
      title: "ChatGPT",
      answer: "ledger answer",
      modelHints: [],
      warnings: []
    });

    const outcome = await performBrowserConsultForMcp(cwd, { prompt: "Ledger check" });

    const { BridgeStore } = await import("../src/store.js");
    const store = new BridgeStore(cwd);
    const receipts = await store.listReceipts({});
    expect(receipts.some((receipt) => receipt.kind === "consult_answer_saved" && receipt.task_id === outcome.task_id)).toBe(
      true
    );
  });
});

describe("MCP follow-up approval checkpoints", () => {
  const thread = "https://chatgpt.com/c/dialogue-budget";
  const answer = {
    url: thread,
    title: "ChatGPT",
    answer: "What is the height?",
    modelHints: [],
    modelSlug: "gpt-6-pro",
    requestId: "9cb9650622e74a62bd9074c42a311945",
    requestVerified: true,
    warnings: []
  };

  async function start() {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-mcp-followup-"));
    sendChatGptPromptMock.mockResolvedValue(answer);
    const root = await performBrowserConsultForMcp(cwd, { prompt: "Width is 17", session_key: "caller-a", effort: "Pro" });
    return { cwd, root };
  }

  it("returns reusable exact-target arguments and structured parent/model evidence", async () => {
    const { cwd, root } = await start();
    expect(root.continuation).toEqual({ continue_task: root.task_id, session_key: "caller-a", effort: "Pro" });
    expect(root.pro_verified).toBe(true);
    sendChatGptPromptMock.mockResolvedValueOnce({ ...answer, answer: "391" });
    const next = await performBrowserConsultForMcp(cwd, { ...root.continuation, prompt: "The height is 23" });
    expect(next.answer).toBe("391");
    expect(next.continued_from).toBe(root.task_id);
    expect(next.continuation?.continue_task).toBe(next.task_id);
    expect(next.followup_budget).toEqual({ limit: 5, used: 1, remaining: 4 });
    expect(sendChatGptPromptMock).toHaveBeenLastCalledWith(expect.objectContaining({ targetUrl: thread, effort: "Pro" }));
    expect(sendChatGptPromptMock).toHaveBeenLastCalledWith(expect.not.objectContaining({ newChat: true }));
  });

  it("shares the limit across MCP clients and older task references without another send", async () => {
    vi.stubEnv("PRODEX_MAX_AUTO_FOLLOWUPS", "1");
    const { cwd, root } = await start();
    await performBrowserConsultForMcp(cwd, { prompt: "Height is 23", continue_task: root.task_id, session_key: "caller-a" });
    const { BridgeStore } = await import("../src/store.js");
    const store = new BridgeStore(cwd);
    const before = (await store.listTasks()).length;
    const client = await connectClient(createServer(cwd, { browserConsult: (input) => performBrowserConsultForMcp(cwd, input) }));
    const result = await client.callTool({ name: "pro_consult", arguments: { prompt: "More review", continue_task: root.task_id, session_key: "caller-b" } });
    await client.close();
    const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(payload.status).toBe("awaiting_user");
    expect(payload.task_id).toBeNull();
    expect(payload.continuation.continue_task).toBe(root.task_id);
    expect(payload.followup_budget).toEqual({ limit: 1, used: 1, remaining: 0 });
    expect(payload.blocker.code).toBe("followup_approval_required");
    expect(sendChatGptPromptMock).toHaveBeenCalledTimes(2);
    expect((await store.listTasks()).length).toBe(before);
  });

  it("requires approval before every follow-up with a zero budget, without persisting approval in the handle", async () => {
    vi.stubEnv("PRODEX_MAX_AUTO_FOLLOWUPS", "0");
    const { cwd, root } = await start();
    const blocked = await performBrowserConsultForMcp(cwd, { ...root.continuation, prompt: "Height is 23" });
    expect(blocked.status).toBe("awaiting_user");
    expect(sendChatGptPromptMock).toHaveBeenCalledTimes(1);
    const approved = await performBrowserConsultForMcp(cwd, { ...blocked.continuation, prompt: "Height is 23", user_approved: true });
    expect(approved.status).toBe("done");
    expect(approved.continuation).not.toHaveProperty("user_approved");
    const again = await performBrowserConsultForMcp(cwd, { ...approved.continuation, prompt: "One more check" });
    expect(again.status).toBe("awaiting_user");
    expect(sendChatGptPromptMock).toHaveBeenCalledTimes(2);
  });

  it("consumes a failed attempt and never automatically retries it", async () => {
    vi.stubEnv("PRODEX_MAX_AUTO_FOLLOWUPS", "1");
    const { cwd, root } = await start();
    sendChatGptPromptMock.mockRejectedValueOnce(new Error("send_timeout: answer is not finished"));
    await expect(performBrowserConsultForMcp(cwd, { ...root.continuation, prompt: "Height is 23" })).rejects.toThrow(/send_timeout/);
    const outcome = await performBrowserConsultForMcp(cwd, { ...root.continuation, prompt: "Do not resend without approval" });
    expect(outcome.status).toBe("awaiting_user");
    expect(sendChatGptPromptMock).toHaveBeenCalledTimes(2);
  });

  it("renews only after user approval and spends the renewed budget normally", async () => {
    vi.stubEnv("PRODEX_MAX_AUTO_FOLLOWUPS", "1");
    const { cwd, root } = await start();
    const first = await performBrowserConsultForMcp(cwd, { ...root.continuation, prompt: "Height is 23" });
    expect(first.followup_budget?.remaining).toBe(0);
    const approved = await performBrowserConsultForMcp(cwd, { ...first.continuation, prompt: "User requested another review", user_approved: true });
    expect(approved.followup_budget).toEqual({ limit: 1, used: 0, remaining: 1 });
    const next = await performBrowserConsultForMcp(cwd, { ...approved.continuation, prompt: "A concrete unresolved detail" });
    expect(next.followup_budget?.remaining).toBe(0);
    const stopped = await performBrowserConsultForMcp(cwd, { ...next.continuation, prompt: "No more without approval" });
    expect(stopped.status).toBe("awaiting_user");
    expect(sendChatGptPromptMock).toHaveBeenCalledTimes(4);
  }, 60_000);

  it("also gates implicit same-session continuation", async () => {
    vi.stubEnv("PRODEX_MAX_AUTO_FOLLOWUPS", "0");
    const { cwd, root } = await start();
    const outcome = await performBrowserConsultForMcp(cwd, { prompt: "Height is 23", session_key: "caller-a", continue_thread: true });
    expect(outcome.status).toBe("awaiting_user");
    expect(outcome.continued_from).toBe(root.task_id);
    expect(outcome.continuation?.continue_task).toBe(root.task_id);
    expect(sendChatGptPromptMock).toHaveBeenCalledTimes(1);
  });

  it("does not change user-directed CLI continuation", async () => {
    vi.stubEnv("PRODEX_MAX_AUTO_FOLLOWUPS", "0");
    const { cwd, root } = await start();
    const { runCli } = await import("../src/cli.js");
    const lines: string[] = [];
    await runCli(["ask", "--continue-task", root.task_id, "--json", "User typed this follow-up"], {
      cwd, stdout: (line) => lines.push(line), stderr: () => {}
    });
    expect(JSON.parse(lines.join("\n")).status).toBe("done");
    expect(sendChatGptPromptMock).toHaveBeenCalledTimes(2);
  });

  it("starts a separate topic with its own budget", async () => {
    vi.stubEnv("PRODEX_MAX_AUTO_FOLLOWUPS", "0");
    const { cwd, root } = await start();
    const nextThread = "https://chatgpt.com/c/separate-topic";
    sendChatGptPromptMock.mockResolvedValueOnce({ ...answer, url: nextThread });
    const next = await performBrowserConsultForMcp(cwd, { prompt: "A separate user task", session_key: "caller-a" });
    expect(next.thread).toBe(nextThread);
    expect(next.task_id).not.toBe(root.task_id);
    expect(next.continued_from).toBeUndefined();
    expect(next.followup_budget).toEqual({ limit: 0, used: 0, remaining: 0 });
  });

  it("fails closed on invalid budget configuration before sending", async () => {
    vi.stubEnv("PRODEX_MAX_AUTO_FOLLOWUPS", "unlimited");
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-mcp-followup-"));
    sendChatGptPromptMock.mockResolvedValueOnce(answer);
    await expect(performBrowserConsultForMcp(cwd, { prompt: "Question" })).rejects.toThrow(/PRODEX_MAX_AUTO_FOLLOWUPS/);
    expect(sendChatGptPromptMock).not.toHaveBeenCalled();
  });

  it("does not recommend automated continuation of an unverified answer", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-mcp-followup-"));
    sendChatGptPromptMock.mockResolvedValueOnce({ ...answer, requestVerified: false });
    const outcome = await performBrowserConsultForMcp(cwd, { prompt: "Question" });
    expect(outcome.request_verified).toBe(false);
    expect(outcome.continuation).toBeUndefined();
  });

  it("does not recommend automated continuation of a partial answer", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-mcp-followup-"));
    sendChatGptPromptMock.mockResolvedValueOnce({ ...answer, warnings: ["answer_incomplete: still generating"] });
    const outcome = await performBrowserConsultForMcp(cwd, { prompt: "Question" });
    expect(outcome.continuation).toBeUndefined();
    expect(outcome.warnings).toContain("answer_incomplete: still generating");
  });

  it.each(["incomplete", "unverified"])("refuses implicit continuation after an %s answer without selecting an older topic", async (quality) => {
    const { cwd } = await start();
    sendChatGptPromptMock.mockResolvedValueOnce({
      ...answer,
      url: "https://chatgpt.com/c/uncertain-latest-topic",
      ...(quality === "incomplete" ? { warnings: ["answer_incomplete: still generating"] } : { requestVerified: false })
    });
    await performBrowserConsultForMcp(cwd, { prompt: "A second topic", session_key: "caller-a" });
    const { BridgeStore } = await import("../src/store.js");
    const store = new BridgeStore(cwd);
    const before = (await store.listTasks()).length;

    await expect(performBrowserConsultForMcp(cwd, {
      prompt: "Continue the last answer", session_key: "caller-a", continue_thread: true
    })).rejects.toThrow(/incomplete|unverified|uncertain|recover/i);

    expect(sendChatGptPromptMock).toHaveBeenCalledTimes(2);
    expect((await store.listTasks()).length).toBe(before);
    expect((await store.listReceipts()).some((receipt) => receipt.kind === "consult_followup_reserved")).toBe(false);
  });
});
