import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtemp } from "node:fs/promises";
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
    expect(tools.tools.map((tool) => tool.name)).toContain("repo_search");
    expect(tools.tools.map((tool) => tool.name)).toContain("repo_write_file_dry_run");
    expect(tools.tools.map((tool) => tool.name)).toContain("repo_write_file_apply");
  });

  it("rejects requests that omit the configured URL token", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-http-mcp-"));
    running = await startHttpMcpServer({ cwd, host: "127.0.0.1", port: 0, token: "test-token" });

    const response = await fetch(`${running.url}/mcp`, { method: "POST", body: "{}" });

    expect(response.status).toBe(401);
  });
});
