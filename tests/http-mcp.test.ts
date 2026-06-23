import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtemp } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startHttpMcpServer, type RunningHttpMcpServer } from "../src/http-mcp.js";

describe("HTTP MCP server", () => {
  let running: RunningHttpMcpServer | undefined;

  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it("serves the existing bridge tools over Streamable HTTP with a URL token", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-http-mcp-"));
    running = await startHttpMcpServer({ cwd, host: "127.0.0.1", port: 0, token: "test-token" });
    const client = new Client({ name: "gptprouse-test", version: "0.1.0" });

    await client.connect(new StreamableHTTPClientTransport(new URL(`${running.url}/mcp?gptprouse_token=test-token`)));
    const tools = await client.listTools();
    await client.close();

    expect(tools.tools.map((tool) => tool.name)).toContain("bridge_create_task");
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

  it("rejects requests that omit the configured URL token", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-http-mcp-"));
    running = await startHttpMcpServer({ cwd, host: "127.0.0.1", port: 0, token: "test-token" });

    const response = await fetch(`${running.url}/mcp`, { method: "POST", body: "{}" });

    expect(response.status).toBe(401);
  });

  it("rejects authorized MCP request bodies over the configured byte limit", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-http-mcp-"));
    running = await startHttpMcpServer({
      cwd,
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      requestBodyLimitBytes: 16
    });

    const response = await fetch(`${running.url}/mcp?gptprouse_token=test-token`, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", params: {} })
    });
    const body = await response.json();

    expect(response.status).toBe(413);
    expect(body.error).toBe("request_too_large");
  });

  it("rejects chunked authorized MCP request bodies over the configured byte limit", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-http-mcp-"));
    running = await startHttpMcpServer({
      cwd,
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      requestBodyLimitBytes: 8
    });

    const response = await postChunked(`${running.url}/mcp?gptprouse_token=test-token`, [
      '{"json',
      'rpc":"2.0"}'
    ]);

    expect(response.status).toBe(413);
    expect(response.body.error).toBe("request_too_large");
  });

  it("rejects malformed authorized JSON as a bad request", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-http-mcp-"));
    running = await startHttpMcpServer({ cwd, host: "127.0.0.1", port: 0, token: "test-token" });

    const response = await fetch(`${running.url}/mcp?gptprouse_token=test-token`, {
      method: "POST",
      body: "{not json"
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("invalid_json");
  });

  it("keeps valid JSON without a valid MCP session as a protocol bad request", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-http-mcp-"));
    running = await startHttpMcpServer({ cwd, host: "127.0.0.1", port: 0, token: "test-token" });

    const response = await fetch(`${running.url}/mcp?gptprouse_token=test-token`, { method: "POST", body: "{}" });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toContain("no valid MCP session");
  });

  it("returns not found for stale MCP session ids so clients can reinitialize", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-http-mcp-"));
    running = await startHttpMcpServer({ cwd, host: "127.0.0.1", port: 0, token: "test-token" });

    const post = await fetch(`${running.url}/mcp?gptprouse_token=test-token`, {
      method: "POST",
      headers: { "mcp-session-id": "stale-session" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    });
    const get = await fetch(`${running.url}/mcp?gptprouse_token=test-token`, {
      method: "GET",
      headers: { "mcp-session-id": "stale-session" }
    });
    const del = await fetch(`${running.url}/mcp?gptprouse_token=test-token`, {
      method: "DELETE",
      headers: { "mcp-session-id": "stale-session" }
    });

    expect(post.status).toBe(404);
    expect(get.status).toBe(404);
    expect(del.status).toBe(404);
  });

  it("rejects requests that use an expired configured URL token", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-http-mcp-"));
    running = await startHttpMcpServer({
      cwd,
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      tokenExpiresAt: new Date(Date.now() - 1000).toISOString()
    });

    const response = await fetch(`${running.url}/mcp?gptprouse_token=test-token`, { method: "POST", body: "{}" });

    expect(response.status).toBe(401);
  });
});

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
