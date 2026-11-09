import { randomUUID, timingSafeEqual } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServer as createMcpServer } from "./mcp.js";
import { normalizeLoopbackHttpHost } from "./config.js";

export interface StartHttpMcpServerOptions {
  cwd: string;
  host?: string;
  port?: number;
  token?: string;
  tokenExpiresAt?: string;
  requestBodyLimitBytes?: number;
  /** False for a throwaway bridge that must not enter the machine-wide registry. */
  registerRoot?: boolean;
  /** Close a session after this long with no request and no open stream. */
  sessionIdleTimeoutMs?: number;
  /** Most sessions kept at once; initializing one more closes the least recently used. */
  maxSessions?: number;
  /** The clock session idleness is measured on; replaced in tests. */
  now?: () => number;
}

export interface RunningHttpMcpServer {
  host: string;
  port: number;
  url: string;
  mcp_url: string;
  close: (options?: CloseHttpMcpServerOptions) => Promise<void>;
}

export interface CloseHttpMcpServerOptions {
  forceAfterMs?: number;
  timeoutMs?: number;
}

interface TransportEntry {
  transport: StreamableHTTPServerTransport;
  lastActiveMs: number;
  openRequests: number;
}

const DEFAULT_REQUEST_BODY_LIMIT_BYTES = 1_048_576;
const TRANSPORT_CLOSE_TIMEOUT_MS = 5_000;
/**
 * Every initialize used to keep its MCP server and transport until a DELETE
 * that clients rarely send, about 170 KB each: measured 2026-11-09, RSS went
 * from 92 MB to 1 GB over 5,000 initializes. The bridge tools answer in
 * seconds, so a session with no request for half an hour and no stream open
 * has been left behind; a client that does come back gets 404, which MCP
 * clients answer by initializing again, at the cost of one round trip.
 */
const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 30 * 60_000;
/**
 * A personal server sees a few clients at a time (a ChatGPT project, Codex, a
 * Claude session), so 100 live sessions is far above real use while holding
 * at most about 17 MB, also against a client that initializes in a loop.
 */
const DEFAULT_MAX_SESSIONS = 100;
const SESSION_SWEEP_INTERVAL_MAX_MS = 60_000;

/**
 * The live MCP sessions, kept in least-recently-used order. A session is in
 * use while a request of its own is open (a GET stream stays open for as long
 * as the client listens), and idle from when its last request ended.
 */
class HttpMcpSessions {
  private readonly entries = new Map<string, TransportEntry>();

  constructor(
    private readonly limits: { idleTimeoutMs: number; maxSessions: number; now: () => number }
  ) {}

  /** The session's transport, counted as in use until res closes; undefined when unknown or closed. */
  use(sessionId: string, res: ServerResponse): StreamableHTTPServerTransport | undefined {
    const entry = this.entries.get(sessionId);
    if (!entry) return undefined;
    this.entries.delete(sessionId);
    this.entries.set(sessionId, entry);
    entry.openRequests += 1;
    entry.lastActiveMs = this.limits.now();
    res.once("close", () => {
      entry.openRequests -= 1;
      entry.lastActiveMs = this.limits.now();
    });
    return entry.transport;
  }

  add(sessionId: string, transport: StreamableHTTPServerTransport): void {
    this.entries.set(sessionId, { transport, lastActiveMs: this.limits.now(), openRequests: 0 });
    while (this.entries.size > this.limits.maxSessions) {
      // The least recently used session without an open request, else the
      // least recently used of all; never the one just added, which is last.
      let victim: string | undefined;
      for (const [id, entry] of this.entries) {
        if (entry.openRequests === 0) {
          victim = id;
          break;
        }
      }
      this.close(victim ?? this.entries.keys().next().value!);
    }
  }

  remove(sessionId: string, transport: StreamableHTTPServerTransport): void {
    if (this.entries.get(sessionId)?.transport === transport) this.entries.delete(sessionId);
  }

  sweep(): void {
    const now = this.limits.now();
    for (const [id, entry] of this.entries) {
      if (entry.openRequests === 0 && now - entry.lastActiveMs >= this.limits.idleTimeoutMs) this.close(id);
    }
  }

  async closeAll(): Promise<void> {
    const transports = Array.from(this.entries.values(), (entry) => entry.transport);
    this.entries.clear();
    await Promise.all(transports.map((transport) => closeTransport(transport)));
  }

  /** Forgotten at once, so the id answers 404 like any unknown session. */
  private close(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    this.entries.delete(sessionId);
    void closeTransport(entry.transport);
  }
}

function closeTransport(transport: StreamableHTTPServerTransport): Promise<void> {
  return withTimeout(transport.close(), TRANSPORT_CLOSE_TIMEOUT_MS, "timed out closing HTTP MCP transport").catch(() => undefined);
}

export async function startHttpMcpServer(options: StartHttpMcpServerOptions): Promise<RunningHttpMcpServer> {
  const host = normalizeLoopbackHttpHost(options.host ?? "127.0.0.1");
  const token = options.token;
  const requestBodyLimitBytes = options.requestBodyLimitBytes ?? DEFAULT_REQUEST_BODY_LIMIT_BYTES;
  const sessionIdleTimeoutMs = Math.max(1, options.sessionIdleTimeoutMs ?? DEFAULT_SESSION_IDLE_TIMEOUT_MS);
  const sessions = new HttpMcpSessions({
    idleTimeoutMs: sessionIdleTimeoutMs,
    maxSessions: Math.max(1, options.maxSessions ?? DEFAULT_MAX_SESSIONS),
    now: options.now ?? Date.now
  });

  const server = http.createServer(async (req, res) => {
    try {
      // Only the path and query are read, so the base is fixed: taking it from
      // the Host header turned a malformed header into a 500.
      let requestUrl: URL;
      try {
        requestUrl = new URL(req.url ?? "/", "http://localhost");
      } catch {
        writeJson(res, 400, { error: "bad_request" });
        return;
      }
      if (requestUrl.pathname === "/health") {
        writeJson(res, 200, { ok: true, name: "prodex" });
        return;
      }
      if (requestUrl.pathname !== "/mcp") {
        writeJson(res, 404, { error: "not_found" });
        return;
      }
      if (!isAuthorized(req, requestUrl, token, options.tokenExpiresAt)) {
        // Same 401 for missing/wrong/expired (no oracle), but tell the caller
        // HOW to authorize without leaking anything token-specific.
        writeJson(res, 401, {
          error: "unauthorized",
          hint: "Provide a valid token via `?prodex_token=<token>` or `Authorization: Bearer <token>`. If your token expired, run `prodex setup --token-ttl-hours <hours>`, restart `prodex start`, and read the new URL with `prodex status --show-token --url-only`."
        });
        return;
      }
      if (req.method === "POST") {
        await handlePost(req, res, sessions, options.cwd, requestBodyLimitBytes, options.registerRoot);
        return;
      }
      if (req.method === "GET" || req.method === "DELETE") {
        await handleSessionRequest(req, res, sessions);
        return;
      }
      writeJson(res, 405, { error: "method_not_allowed" });
    } catch (error) {
      if (!res.headersSent) {
        if (error instanceof HttpRequestError) {
          writeJson(res, error.status, error.body);
          return;
        }
        writeJson(res, 500, { error: "internal_server_error" });
      }
    }
  });

  const requestedPort = options.port ?? 8787;
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      // "address already in use" names neither who has it nor how to move.
      // Measured here: prodex's default port was held by an unrelated tool of
      // the user's, and the only thing said was the raw errno - on a machine
      // where the fix is one flag.
      if (error.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${requestedPort} on ${host} is already taken, so the HTTP MCP server did not start. ` +
              `Another prodex may already be running here - check with \`prodex status\` - or another program holds it ` +
              `(\`ss -ltnp | grep ${requestedPort}\` says which). Move prodex with \`prodex setup --port <free port>\`, then start again.`,
            { cause: error }
          )
        );
        return;
      }
      reject(error);
    });
    server.listen(requestedPort, host, () => {
      server.removeAllListeners("error");
      resolve();
    });
  });

  // Unref'd: an idle sweep is no reason for the process to stay up.
  const sweepTimer = setInterval(() => sessions.sweep(), Math.min(SESSION_SWEEP_INTERVAL_MAX_MS, sessionIdleTimeoutMs));
  sweepTimer.unref();

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port ?? 8787;
  const url = `http://${host}:${port}`;
  return {
    host,
    port,
    url,
    mcp_url: token ? `${url}/mcp?prodex_token=${encodeURIComponent(token)}` : `${url}/mcp`,
    close: async (closeOptions = {}) => {
      clearInterval(sweepTimer);
      await sessions.closeAll();
      await closeHttpServer(server, closeOptions);
    }
  };
}

async function closeHttpServer(server: http.Server, options: CloseHttpMcpServerOptions): Promise<void> {
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      if (options.forceAfterMs !== undefined) {
        forceTimer = setTimeout(() => {
          forceCloseHttpConnections(server);
        }, options.forceAfterMs);
      }
      if (options.timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          forceCloseHttpConnections(server);
          reject(new Error("timed out closing HTTP MCP server"));
        }, options.timeoutMs);
      }
      server.close((error) => (error ? reject(error) : resolve()));
    });
  } finally {
    if (forceTimer) clearTimeout(forceTimer);
    if (timeout) clearTimeout(timeout);
  }
}

function forceCloseHttpConnections(server: http.Server): void {
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function handlePost(
  req: IncomingMessage,
  res: ServerResponse,
  sessions: HttpMcpSessions,
  cwd: string,
  requestBodyLimitBytes: number,
  registerRoot: boolean | undefined
): Promise<void> {
  const body = await readJsonBody(req, requestBodyLimitBytes);
  const sessionId = headerValue(req.headers["mcp-session-id"]);
  if (sessionId) {
    const transport = sessions.use(sessionId, res);
    if (!transport) {
      writeJson(res, 404, { error: "session_not_found" });
      return;
    }
    await transport.handleRequest(req, res, body);
    return;
  }
  if (!sessionId && isInitializeRequest(body)) {
    let initializedSessionId = "";
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (newSessionId) => {
        initializedSessionId = newSessionId;
        sessions.add(newSessionId, transport);
      }
    });
    transport.onclose = () => {
      const id = transport.sessionId || initializedSessionId;
      if (id) sessions.remove(id, transport);
    };
    const mcpServer = createMcpServer(cwd, {
      source: "chatgpt_project",
      claimedBy: "chatgpt",
      ...(registerRoot !== undefined ? { registerRoot } : {})
    });
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
  sessions: HttpMcpSessions
): Promise<void> {
  const sessionId = headerValue(req.headers["mcp-session-id"]);
  if (!sessionId) {
    writeJson(res, 400, { error: "invalid_or_missing_session" });
    return;
  }
  const transport = sessions.use(sessionId, res);
  if (!transport) {
    writeJson(res, 404, { error: "session_not_found" });
    return;
  }
  await transport.handleRequest(req, res);
}

async function readJsonBody(req: IncomingMessage, limitBytes: number): Promise<unknown> {
  const contentLength = parseContentLength(req.headers["content-length"]);
  if (contentLength !== undefined && contentLength > limitBytes) {
    throw new HttpRequestError(413, { error: "request_too_large", max_bytes: limitBytes });
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    totalBytes += buffer.length;
    if (totalBytes > limitBytes) {
      throw new HttpRequestError(413, { error: "request_too_large", max_bytes: limitBytes });
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpRequestError(400, { error: "invalid_json" });
  }
}

function parseContentLength(value: string | string[] | undefined): number | undefined {
  const raw = headerValue(value);
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

class HttpRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>
  ) {
    super(String(body.error ?? status));
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function isAuthorized(req: IncomingMessage, url: URL, token?: string, tokenExpiresAt?: string): boolean {
  if (!token) return false;
  if (tokenExpiresAt && isExpired(tokenExpiresAt)) return false;
  const provided = url.searchParams.get("prodex_token");
  if (provided !== null && safeEqual(provided, token)) return true;
  // The scheme is case-insensitive (RFC 7235): "bearer <token>" is the same.
  const bearer = /^bearer +(.+)$/i.exec(headerValue(req.headers.authorization) ?? "");
  return bearer !== null && safeEqual(bearer[1]!, token);
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
