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
      warnings: []
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
      arguments: { thread: "https://chatgpt.com/c/recovered" }
    })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    await client.close();

    expect(result.isError ?? false).toBe(false);
    expect(result.content[0].text).toContain("the answer that finished after prodex stopped waiting");
    expect(recoverChatGptAnswerFromThreadMock).toHaveBeenCalledWith(
      expect.objectContaining({ targetUrl: "https://chatgpt.com/c/recovered" })
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
