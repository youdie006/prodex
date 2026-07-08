import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtemp } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startHttpMcpServer, type RunningHttpMcpServer } from "../src/http-mcp.js";
import { BridgeStore } from "../src/store.js";

describe("HTTP MCP server", () => {
  let running: RunningHttpMcpServer | undefined;

  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it("serves the existing bridge tools over Streamable HTTP with a URL token", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-http-mcp-"));
    running = await startHttpMcpServer({ cwd, host: "127.0.0.1", port: 0, token: "test-token" });
    const client = new Client({ name: "prodex-test", version: "0.1.0" });

    await client.connect(new StreamableHTTPClientTransport(new URL(`${running.url}/mcp?prodex_token=test-token`)));
    const tools = await client.listTools();
    await client.close();

    expect(tools.tools.map((tool) => tool.name)).toContain("bridge_create_task");
    expect(tools.tools.map((tool) => tool.name)).toContain("bridge_complete_task");
    expect(tools.tools.map((tool) => tool.name)).toContain("bridge_block_task");
    expect(tools.tools.map((tool) => tool.name)).toContain("bridge_list_sessions");
    expect(tools.tools.map((tool) => tool.name)).toContain("bridge_get_session");
    expect(tools.tools.map((tool) => tool.name)).toContain("bridge_fetch_result_artifact");
    expect(tools.tools.map((tool) => tool.name)).toContain("bridge_list_receipts");
    expect(tools.tools.map((tool) => tool.name)).toContain("bridge_get_receipt");
    expect(tools.tools.map((tool) => tool.name)).toContain("repo_search");
    expect(tools.tools.map((tool) => tool.name)).toContain("repo_write_file_dry_run");
    expect(tools.tools.map((tool) => tool.name)).toContain("repo_write_file_apply");
    expect(tools.tools.map((tool) => tool.name)).toContain("repo_stage_reviewed_paths");
  });

  it("refuses to bind the HTTP MCP server to non-loopback hosts", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-http-mcp-"));

    await expect(
      startHttpMcpServer({ cwd, host: "0.0.0.0", port: 0, token: "test-token" }).then((server) => {
        running = server;
        return server;
      })
    ).rejects.toThrow(/loopback|local/i);
  });

  it("completes and blocks tasks through real Streamable HTTP MCP tool calls", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-http-mcp-"));
    running = await startHttpMcpServer({ cwd, host: "127.0.0.1", port: 0, token: "test-token" });
    const client = new Client({ name: "prodex-test", version: "0.1.0" });

    await client.connect(new StreamableHTTPClientTransport(new URL(`${running.url}/mcp?prodex_token=test-token`)));
    try {
      const createdDone = await callJsonTool<{ task: { id: string } }>(client, "bridge_create_task", {
        title: "HTTP done",
        prompt: "Finish this task"
      });
      const completed = await callJsonTool<{ result: { task_id: string; status: string; summary: string; commands: string[] } }>(
        client,
        "bridge_complete_task",
        {
          task_id: createdDone.task.id,
          summary: "Completed over HTTP MCP",
          commands: ["http mcp complete smoke"]
        }
      );
      const createdBlocked = await callJsonTool<{ task: { id: string } }>(client, "bridge_create_task", {
        title: "HTTP blocked",
        prompt: "Block this task"
      });
      const blocked = await callJsonTool<{ result: { task_id: string; status: string; blocker: { code: string; retryable: boolean } } }>(
        client,
        "bridge_block_task",
        {
          task_id: createdBlocked.task.id,
          summary: "Blocked over HTTP MCP",
          code: "http_mcp_blocker",
          retryable: true,
          next_step: "Inspect the blocker."
        }
      );

      expect(completed.result).toEqual(
        expect.objectContaining({
          task_id: createdDone.task.id,
          status: "done",
          summary: "Completed over HTTP MCP",
          commands: ["http mcp complete smoke"]
        })
      );
      expect(blocked.result).toEqual(
        expect.objectContaining({
          task_id: createdBlocked.task.id,
          status: "blocked",
          blocker: expect.objectContaining({ code: "http_mcp_blocker", retryable: true })
        })
      );

      const store = new BridgeStore(cwd);
      await expect(store.getTask(createdDone.task.id)).resolves.toEqual(expect.objectContaining({ status: "done" }));
      await expect(store.getResult(createdBlocked.task.id)).resolves.toEqual(
        expect.objectContaining({
          status: "blocked",
          blocker: expect.objectContaining({ code: "http_mcp_blocker", next_step: "Inspect the blocker." })
        })
      );
    } finally {
      await client.close();
    }
  });

  it("rejects requests that omit the configured URL token", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-http-mcp-"));
    running = await startHttpMcpServer({ cwd, host: "127.0.0.1", port: 0, token: "test-token" });

    const response = await fetch(`${running.url}/mcp`, { method: "POST", body: "{}" });

    expect(response.status).toBe(401);
  });

  it("rejects a wrong token via URL and bearer (exercises the safeEqual false branch)", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-http-mcp-"));
    running = await startHttpMcpServer({ cwd, host: "127.0.0.1", port: 0, token: "test-token" });

    const viaUrl = await fetch(`${running.url}/mcp?prodex_token=wrong-token`, { method: "POST", body: "{}" });
    expect(viaUrl.status).toBe(401);
    const viaBearer = await fetch(`${running.url}/mcp`, {
      method: "POST",
      body: "{}",
      headers: { authorization: "Bearer wrong-token" }
    });
    expect(viaBearer.status).toBe(401);
    // Sanity: the CORRECT token is not rejected by auth, so 401 above is really
    // the token comparison and not a blanket reject.
    const correct = await fetch(`${running.url}/mcp?prodex_token=test-token`, {
      method: "POST",
      body: "{}",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json" }
    });
    expect(correct.status).not.toBe(401);
  });

  it("accepts bearer authorization tokens for MCP requests", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-http-mcp-"));
    running = await startHttpMcpServer({ cwd, host: "127.0.0.1", port: 0, token: "test-token" });

    const response = await fetch(`${running.url}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer test-token" },
      body: "{}"
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toContain("no valid MCP session");
  });

  it("rejects authorized MCP request bodies over the configured byte limit", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-http-mcp-"));
    running = await startHttpMcpServer({
      cwd,
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      requestBodyLimitBytes: 16
    });

    const response = await fetch(`${running.url}/mcp?prodex_token=test-token`, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", params: {} })
    });
    const body = await response.json();

    expect(response.status).toBe(413);
    expect(body.error).toBe("request_too_large");
  });

  it("rejects chunked authorized MCP request bodies over the configured byte limit", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-http-mcp-"));
    running = await startHttpMcpServer({
      cwd,
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      requestBodyLimitBytes: 8
    });

    const response = await postChunked(`${running.url}/mcp?prodex_token=test-token`, [
      '{"json',
      'rpc":"2.0"}'
    ]);

    expect(response.status).toBe(413);
    expect(response.body.error).toBe("request_too_large");
  });

  it("rejects malformed authorized JSON as a bad request", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-http-mcp-"));
    running = await startHttpMcpServer({ cwd, host: "127.0.0.1", port: 0, token: "test-token" });

    const response = await fetch(`${running.url}/mcp?prodex_token=test-token`, {
      method: "POST",
      body: "{not json"
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("invalid_json");
  });

  it("does not leak internal exception messages in generic HTTP 500 responses", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-http-mcp-"));
    running = await startHttpMcpServer({ cwd, host: "127.0.0.1", port: 0, token: "test-token" });

    const raw = await rawHttpRequest(
      running.port,
      "GET /mcp?prodex_token=test-token HTTP/1.1\r\nHost: :\r\nConnection: close\r\n\r\n"
    );

    expect(raw).toContain("HTTP/1.1 500");
    expect(raw).toContain('"error":"internal_server_error"');
    expect(raw).not.toContain("Invalid URL");
    expect(raw).not.toContain('"message"');
  });

  it("keeps valid JSON without a valid MCP session as a protocol bad request", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-http-mcp-"));
    running = await startHttpMcpServer({ cwd, host: "127.0.0.1", port: 0, token: "test-token" });

    const response = await fetch(`${running.url}/mcp?prodex_token=test-token`, { method: "POST", body: "{}" });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toContain("no valid MCP session");
  });

  it("returns not found for stale MCP session ids so clients can reinitialize", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-http-mcp-"));
    running = await startHttpMcpServer({ cwd, host: "127.0.0.1", port: 0, token: "test-token" });

    const post = await fetch(`${running.url}/mcp?prodex_token=test-token`, {
      method: "POST",
      headers: { "mcp-session-id": "stale-session" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    });
    const get = await fetch(`${running.url}/mcp?prodex_token=test-token`, {
      method: "GET",
      headers: { "mcp-session-id": "stale-session" }
    });
    const del = await fetch(`${running.url}/mcp?prodex_token=test-token`, {
      method: "DELETE",
      headers: { "mcp-session-id": "stale-session" }
    });

    expect(post.status).toBe(404);
    expect(get.status).toBe(404);
    expect(del.status).toBe(404);
  });

  it("rejects requests that use an expired configured URL token", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-http-mcp-"));
    running = await startHttpMcpServer({
      cwd,
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      tokenExpiresAt: new Date(Date.now() - 1000).toISOString()
    });

    const response = await fetch(`${running.url}/mcp?prodex_token=test-token`, { method: "POST", body: "{}" });

    expect(response.status).toBe(401);
  });
});

async function callJsonTool<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.find((item) => item.type === "text")?.text;
  if (!text) throw new Error(`Tool ${name} did not return text content`);
  return JSON.parse(text) as T;
}

function postChunked(url: string, chunks: string[]): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      new URL(url),
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        }
      },
      (res) => {
        const responseChunks: Buffer[] = [];
        res.on("data", (chunk) => responseChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("error", reject);
        res.on("end", () => {
          const rawBody = Buffer.concat(responseChunks).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            body: rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {}
          });
        });
      }
    );
    req.on("error", reject);
    for (const chunk of chunks) {
      req.write(chunk);
    }
    req.end();
  });
}

function rawHttpRequest(port: number, requestText: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.end(requestText);
    });
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    socket.on("error", reject);
    socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}
