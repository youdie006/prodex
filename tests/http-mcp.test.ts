import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtemp } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startHttpMcpServer, type RunningHttpMcpServer } from "../src/http-mcp.js";
import { BridgeStore } from "../src/store.js";

describe("HTTP MCP server", () => {
  let running: RunningHttpMcpServer | undefined;

  afterEach(async () => {
    await running?.close();
    running = undefined;
    vi.restoreAllMocks();
    vi.useRealTimers();
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

  it("accepts the bearer scheme in any letter case", async () => {
    // RFC 7235 makes the auth scheme case-insensitive; "bearer <token>" was
    // answered 401 as if the token were wrong.
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-http-mcp-"));
    running = await startHttpMcpServer({ cwd, host: "127.0.0.1", port: 0, token: "test-token" });

    for (const scheme of ["bearer", "BEARER"]) {
      const response = await fetch(`${running.url}/mcp`, {
        method: "POST",
        headers: { authorization: `${scheme} test-token` },
        body: "{}"
      });
      expect(response.status).toBe(400);
    }
    const wrong = await fetch(`${running.url}/mcp`, {
      method: "POST",
      headers: { authorization: "bearer wrong-token" },
      body: "{}"
    });
    expect(wrong.status).toBe(401);
  });

  it("serves a request whose Host header is malformed instead of failing with a server error", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-http-mcp-"));
    running = await startHttpMcpServer({ cwd, host: "127.0.0.1", port: 0, token: "test-token" });
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port: running!.port, path: "/mcp?prodex_token=test-token", method: "GET", headers: { host: "a b" } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        }
      );
      req.on("error", reject);
      req.end();
    });
    // Reaches the session check (no mcp-session-id), which is a 400; it was a 500.
    expect(status).toBe(400);
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

  it("does not leak internal exception messages when a request cannot be parsed", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-http-mcp-"));
    running = await startHttpMcpServer({ cwd, host: "127.0.0.1", port: 0, token: "test-token" });

    const raw = await rawHttpRequest(running.port, "GET //[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");

    expect(raw).toContain("HTTP/1.1 400");
    expect(raw).toContain('"error":"bad_request"');
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

  // Measured 2026-11-09: every initialize kept its MCP server and transport
  // until DELETE or shutdown, about 170 KB each; RSS went from 92 MB to 1 GB
  // over 5,000 initializes.
  it("closes a session left idle past the idle timeout and answers its id as unknown", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let now = 1_000_000;
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-http-mcp-"));
    running = await startHttpMcpServer({
      cwd,
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      sessionIdleTimeoutMs: 30 * 60_000,
      now: () => now
    });
    const idle = await initializeSession(running.url);
    const active = await initializeSession(running.url);

    now += 20 * 60_000;
    expect(await pingSession(running.url, active)).toBe(200);
    now += 15 * 60_000;
    vi.advanceTimersByTime(60_000);

    expect(await pingSession(running.url, idle)).toBe(404);
    expect(await pingSession(running.url, active)).toBe(200);
    expect(await initializeSession(running.url)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("keeps a quiet session whose client holds a stream open, and closes it once the stream ends", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let now = 1_000_000;
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-http-mcp-"));
    running = await startHttpMcpServer({
      cwd,
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      sessionIdleTimeoutMs: 30 * 60_000,
      now: () => now
    });
    const sessionId = await initializeSession(running.url);
    const stream = new AbortController();
    const opened = await fetch(`${running.url}/mcp?prodex_token=test-token`, {
      method: "GET",
      headers: { accept: "text/event-stream", "mcp-session-id": sessionId, "mcp-protocol-version": "2025-06-18" },
      signal: stream.signal
    });
    expect(opened.status).toBe(200);

    now += 60 * 60_000;
    vi.advanceTimersByTime(60_000);
    expect(await pingSession(running.url, sessionId)).toBe(200);

    stream.abort();
    // The server sees the stream end a moment later; each 200 here was a
    // request, so the next round moves the clock past the timeout again.
    let status = 200;
    for (let attempt = 0; attempt < 50 && status === 200; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      now += 60 * 60_000;
      vi.advanceTimersByTime(60_000);
      status = await pingSession(running.url, sessionId);
    }
    expect(status).toBe(404);
  });

  it("closes the least recently used session when the session cap is reached", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-http-mcp-"));
    running = await startHttpMcpServer({ cwd, host: "127.0.0.1", port: 0, token: "test-token", maxSessions: 2 });
    const first = await initializeSession(running.url);
    const second = await initializeSession(running.url);
    expect(await pingSession(running.url, first)).toBe(200);

    const third = await initializeSession(running.url);

    expect(await pingSession(running.url, second)).toBe(404);
    expect(await pingSession(running.url, first)).toBe(200);
    expect(await pingSession(running.url, third)).toBe(200);
  });

  it("sweeps idle sessions on a timer that does not hold the process open and stops on close", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const intervals = vi.spyOn(globalThis, "setInterval");
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-http-mcp-"));
    // Swept as often as the timeout itself when that is under a minute.
    running = await startHttpMcpServer({ cwd, host: "127.0.0.1", port: 0, token: "test-token", sessionIdleTimeoutMs: 45_000 });
    const sweep = intervals.mock.results[intervals.mock.calls.findIndex((call) => call[1] === 45_000)]?.value as
      | { hasRef(): boolean }
      | undefined;

    expect(sweep).toBeDefined();
    expect(sweep!.hasRef()).toBe(false);
    await running.close();
    running = undefined;
    expect(vi.getTimerCount()).toBe(0);
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
    const body = await response.json() as { hint: string };
    expect(body.hint).toContain("prodex setup --token-ttl-hours <hours>");
    expect(body.hint).toContain("restart");
  });
});

async function initializeSession(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/mcp?prodex_token=test-token`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "prodex-test", version: "0.1.0" } }
    })
  });
  await response.text();
  expect(response.status).toBe(200);
  return response.headers.get("mcp-session-id") ?? "";
}

async function pingSession(baseUrl: string, sessionId: string): Promise<number> {
  const response = await fetch(`${baseUrl}/mcp?prodex_token=test-token`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
      "mcp-protocol-version": "2025-06-18"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })
  });
  await response.text();
  return response.status;
}

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
