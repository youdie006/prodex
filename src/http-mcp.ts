import { randomUUID } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServer as createMcpServer } from "./mcp.js";

export interface StartHttpMcpServerOptions {
  cwd: string;
  host?: string;
  port?: number;
  token?: string;
  tokenExpiresAt?: string;
}

export interface RunningHttpMcpServer {
  host: string;
  port: number;
  url: string;
  mcp_url: string;
  close: () => Promise<void>;
}

interface TransportEntry {
  transport: StreamableHTTPServerTransport;
}

export async function startHttpMcpServer(options: StartHttpMcpServerOptions): Promise<RunningHttpMcpServer> {
  const host = options.host ?? "127.0.0.1";
  const token = options.token;
  const transports = new Map<string, TransportEntry>();

  const server = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`);
      if (requestUrl.pathname === "/health") {
        writeJson(res, 200, { ok: true, name: "gptprouse" });
        return;
      }
      if (requestUrl.pathname !== "/mcp") {
        writeJson(res, 404, { error: "not_found" });
        return;
      }
      if (!isAuthorized(req, requestUrl, token, options.tokenExpiresAt)) {
        writeJson(res, 401, { error: "unauthorized" });
        return;
      }
      if (req.method === "POST") {
        await handlePost(req, res, transports, options.cwd);
        return;
      }
      if (req.method === "GET" || req.method === "DELETE") {
        await handleSessionRequest(req, res, transports);
        return;
      }
      writeJson(res, 405, { error: "method_not_allowed" });
    } catch (error) {
      if (!res.headersSent) {
        writeJson(res, 500, {
          error: "internal_server_error",
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8787, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port ?? 8787;
  const url = `http://${host}:${port}`;
  return {
    host,
    port,
    url,
    mcp_url: token ? `${url}/mcp?gptprouse_token=${encodeURIComponent(token)}` : `${url}/mcp`,
    close: async () => {
      await Promise.all(Array.from(transports.values()).map((entry) => entry.transport.close().catch(() => undefined)));
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  };
}

async function handlePost(
  req: IncomingMessage,
  res: ServerResponse,
  transports: Map<string, TransportEntry>,
  cwd: string
): Promise<void> {
  const body = await readJsonBody(req);
  const sessionId = headerValue(req.headers["mcp-session-id"]);
  if (sessionId && transports.has(sessionId)) {
    await transports.get(sessionId)!.transport.handleRequest(req, res, body);
    return;
  }
  if (!sessionId && isInitializeRequest(body)) {
    let initializedSessionId = "";
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (newSessionId) => {
        initializedSessionId = newSessionId;
        transports.set(newSessionId, { transport });
      }
    });
    transport.onclose = () => {
      const id = transport.sessionId || initializedSessionId;
      if (id) transports.delete(id);
    };
    const mcpServer = createMcpServer(cwd, { source: "chatgpt_project", claimedBy: "chatgpt" });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, body);
    return;
  }
  writeJson(res, 400, {
    jsonrpc: "2.0",
    error: { code: -32000, message: "Bad Request: no valid MCP session" },
    id: null
  });
}

async function handleSessionRequest(
  req: IncomingMessage,
  res: ServerResponse,
  transports: Map<string, TransportEntry>
): Promise<void> {
  const sessionId = headerValue(req.headers["mcp-session-id"]);
  if (!sessionId || !transports.has(sessionId)) {
    writeJson(res, 400, { error: "invalid_or_missing_session" });
    return;
  }
  await transports.get(sessionId)!.transport.handleRequest(req, res);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return undefined;
  return JSON.parse(text);
}

function isAuthorized(req: IncomingMessage, url: URL, token?: string, tokenExpiresAt?: string): boolean {
  if (!token) return true;
  if (tokenExpiresAt && isExpired(tokenExpiresAt)) return false;
  if (url.searchParams.get("gptprouse_token") === token) return true;
  const authorization = headerValue(req.headers.authorization);
  return authorization === `Bearer ${token}`;
}

function isExpired(tokenExpiresAt: string): boolean {
  const expiresAtMs = Date.parse(tokenExpiresAt);
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now();
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(`${JSON.stringify(value)}\n`);
}
