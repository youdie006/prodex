import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendChatGptPromptMock = vi.hoisted(() => vi.fn());

vi.mock("../src/chatgpt-browser.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/chatgpt-browser.js")>();
  return {
    ...actual,
    sendChatGptPrompt: sendChatGptPromptMock
  };
});

const { createServer } = await import("../src/mcp.js");
const { performBrowserConsultForMcp } = await import("../src/cli-pro.js");

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
