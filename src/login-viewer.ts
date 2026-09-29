import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest, type ClientRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { loginViewerPage, loginViewerScript, loginViewerStyle } from "./login-viewer-page.js";

export interface LoginViewerOptions {
  upstreamUrl: string;
  readPassword: () => Promise<string>;
  getStatus: () => Promise<{ ready: boolean; blocker: string | null }>;
  timeoutMs: number;
}

export interface LoginViewer {
  launchUrl: string;
  close: () => Promise<void>;
  completed: Promise<"ready" | "timeout" | "cancelled">;
}

const MAX_ASSET_BYTES = 2 * 1024 * 1024;
const MAX_WS_MESSAGE = 16 * 1024 * 1024;
const MAX_WS_BUFFER = 32 * 1024 * 1024;
const READY_GRACE_MS = 1000;

function validateOptions(options: LoginViewerOptions): URL {
  if (!options || typeof options.upstreamUrl !== "string" ||
      !/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[0-9]{1,5}\/?$/.test(options.upstreamUrl) ||
      typeof options.readPassword !== "function" || typeof options.getStatus !== "function" ||
      !Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 1_200_000) {
    throw new Error("Invalid login viewer options");
  }
  let upstream: URL;
  try { upstream = new URL(options.upstreamUrl); }
  catch { throw new Error("Invalid login viewer options"); }
  const port = Number(upstream.port || "80");
  if (port < 1 || port > 65535 || upstream.pathname !== "/" ||
      upstream.username || upstream.password || upstream.search || upstream.hash) {
    throw new Error("Invalid login viewer options");
  }
  return upstream;
}

function onlyHeader(req: IncomingMessage, name: string): string | undefined {
  let count = 0;
  let value: string | undefined;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === name) {
      count++;
      value = req.rawHeaders[i + 1];
    }
  }
  return count === 1 ? value : undefined;
}

function isSafeAssetPath(rawPath: string): string | null {
  const path = rawPath.startsWith("/novnc/") ? rawPath.slice(6) : rawPath;
  if (!path.startsWith("/core/") && !path.startsWith("/vendor/")) return null;
  if (path.length > 240 || !path.endsWith(".js") || !/^\/[A-Za-z0-9_./-]+$/.test(path)) return null;
  const segments = path.slice(1).split("/");
  if (segments.some(segment => !segment || segment === "." || segment === "..")) return null;
  return path;
}

async function readSmallBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1024) throw new Error("Body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sameSecret(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function startLoginViewer(options: LoginViewerOptions): Promise<LoginViewer> {
  const upstream = validateOptions(options);
  const capability = randomBytes(32).toString("hex");
  const cookieName = `pd_${randomBytes(12).toString("hex")}`;
  const cookieValue = randomBytes(32).toString("hex");
  const sockets = new Set<Socket>();
  const upstreamSockets = new Set<WebSocket>();
  const assetRequests = new Set<ClientRequest>();
  const wss = new WebSocketServer({ noServer: true, clientTracking: false, maxPayload: MAX_WS_MESSAGE, perMessageDeflate: false });
  let origin = "";
  let host = "";
  let bootstrapped = false;
  let activeViewer = false;
  let overallTimer: NodeJS.Timeout | undefined;
  let graceTimer: NodeJS.Timeout | undefined;
  let outcome: "ready" | "timeout" | "cancelled" | undefined;
  let closing: Promise<void> | undefined;
  let resolveCompleted!: (value: "ready" | "timeout" | "cancelled") => void;
  const completed = new Promise<"ready" | "timeout" | "cancelled">(resolve => { resolveCompleted = resolve; });

  const send = (res: ServerResponse, code: number, body: string | Buffer = "", contentType = "text/plain; charset=utf-8") => {
    if (res.destroyed || res.headersSent) return;
    res.writeHead(code, { "Content-Type": contentType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
    res.end(body);
  };

  const validHost = (req: IncomingMessage) => onlyHeader(req, "host") === host;
  const exactOrigin = (req: IncomingMessage) => onlyHeader(req, "origin") === origin;
  const safeGetOrigin = (req: IncomingMessage) => {
    const originHeader = onlyHeader(req, "origin");
    const fetchSite = onlyHeader(req, "sec-fetch-site");
    return (originHeader === undefined ? !req.rawHeaders.some((v, i) => i % 2 === 0 && v.toLowerCase() === "origin") : originHeader === origin) &&
      (fetchSite === undefined ? !req.rawHeaders.some((v, i) => i % 2 === 0 && v.toLowerCase() === "sec-fetch-site") : fetchSite === "same-origin");
  };
  const authenticated = (req: IncomingMessage) => {
    const cookie = onlyHeader(req, "cookie");
    if (!cookie) return false;
    const matches = cookie.split(";").map(value => value.trim()).filter(value => value.startsWith(`${cookieName}=`));
    return matches.length === 1 && sameSecret(matches[0].slice(cookieName.length + 1), cookieValue);
  };

  const cleanup = async () => {
    if (overallTimer) clearTimeout(overallTimer);
    if (graceTimer) clearTimeout(graceTimer);
    for (const request of assetRequests) request.destroy();
    for (const ws of upstreamSockets) ws.terminate();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    wss.close();
  };

  const finish = (kind: "ready" | "timeout" | "cancelled"): Promise<void> => {
    if (closing) return closing;
    outcome = kind;
    closing = cleanup().catch(() => {}).then(() => { resolveCompleted(kind); });
    return closing;
  };

  const bounded = async <T>(fn: () => Promise<T>): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(fn),
        new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Timed out")), 5000); }),
        completed.then(() => { throw new Error("Viewer closed"); })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const fetchAsset = (path: string): Promise<Buffer> => new Promise((resolve, reject) => {
    const request = httpRequest(new URL(path, upstream), { method: "GET", timeout: 5000, headers: { Host: upstream.host } }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error("Asset unavailable"));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_ASSET_BYTES) {
          request.destroy();
          reject(new Error("Asset too large"));
        } else chunks.push(chunk);
      });
      response.on("end", () => resolve(Buffer.concat(chunks)));
      response.on("error", reject);
    });
    assetRequests.add(request);
    const deadline = setTimeout(() => request.destroy(), 5000);
    request.on("close", () => { clearTimeout(deadline); assetRequests.delete(request); });
    request.on("timeout", () => request.destroy());
    request.on("error", reject);
    request.end();
  });

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (outcome || !validHost(req)) return send(res, 403, "Forbidden");
    const path = req.url ?? "";
    if (req.method === "GET" && path === "/") {
      res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' ${origin.replace("http:", "ws:")}; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'`);
      return send(res, 200, loginViewerPage, "text/html; charset=utf-8");
    }
    if (req.method === "GET" && path === "/style.css") return send(res, 200, loginViewerStyle, "text/css; charset=utf-8");
    if (req.method === "GET" && path === "/app.js") return send(res, 200, loginViewerScript, "text/javascript; charset=utf-8");
    if (req.method === "POST" && path === "/session") {
      if (!exactOrigin(req) || onlyHeader(req, "content-type") !== "application/json" || bootstrapped) return send(res, 403, "Forbidden");
      let payload: unknown;
      try { payload = JSON.parse(await readSmallBody(req)); } catch { return send(res, 403, "Forbidden"); }
      if (outcome || bootstrapped || !payload || typeof payload !== "object" || Array.isArray(payload) ||
          Object.keys(payload).length !== 1 || !Object.hasOwn(payload, "capability") ||
          typeof (payload as { capability: unknown }).capability !== "string" ||
          !sameSecret((payload as { capability: string }).capability, capability)) return send(res, 403, "Forbidden");
      bootstrapped = true;
      res.setHeader("Set-Cookie", `${cookieName}=${cookieValue}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.ceil(options.timeoutMs / 1000)}`);
      return send(res, 204);
    }
    const asset = req.method === "GET" ? isSafeAssetPath(path) : null;
    if (asset) {
      if (!safeGetOrigin(req) || !authenticated(req)) return send(res, 403, "Forbidden");
      try { return send(res, 200, await fetchAsset(asset), "text/javascript; charset=utf-8"); }
      catch { return send(res, 502, "Viewer asset unavailable"); }
    }
    if (req.method === "GET" && (path === "/credentials" || path === "/status")) {
      if (!safeGetOrigin(req) || !authenticated(req)) return send(res, 403, "Forbidden");
      if (path === "/credentials") {
        try {
          const password = await bounded(options.readPassword);
          if (typeof password !== "string" || !/^[\x20-\x7e]{8}$/.test(password)) throw new Error("Invalid password");
          return send(res, 200, JSON.stringify({ password }), "application/json; charset=utf-8");
        } catch { return send(res, 502, "Viewer credentials unavailable"); }
      }
      try {
        const status = await bounded(options.getStatus);
        if (outcome) return;
        if (!status || typeof status.ready !== "boolean" ||
            (status.blocker !== null && typeof status.blocker !== "string")) throw new Error("Invalid status");
        const blocker = status.blocker?.slice(0, 240) ?? null;
        send(res, 200, JSON.stringify({ ready: status.ready, blocker }), "application/json; charset=utf-8");
        if (status.ready && !graceTimer) {
          if (overallTimer) clearTimeout(overallTimer);
          graceTimer = setTimeout(() => { void finish("ready"); }, READY_GRACE_MS);
        }
      } catch { return send(res, 502, "Viewer status unavailable"); }
      return;
    }
    send(res, 404, "Not found");
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => send(res, 500, "Viewer unavailable"));
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 100;
  server.on("connection", socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("upgrade", (req, socket, head) => {
    const deny = () => { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); };
    if (outcome || req.url !== "/websockify" || !validHost(req) || !exactOrigin(req) || !authenticated(req) || activeViewer) return deny();
    activeViewer = true;
    const target = new URL("/websockify", upstream);
    target.protocol = "ws:";
    const upstreamWs = new WebSocket(target, { origin: upstream.origin, handshakeTimeout: 5000, maxPayload: MAX_WS_MESSAGE, perMessageDeflate: false });
    upstreamSockets.add(upstreamWs);
    let clientWs: WebSocket | undefined;
    let upgraded = false;
    let ended = false;
    const endPair = () => {
      if (ended) return;
      ended = true;
      upstreamWs.terminate();
      clientWs?.terminate();
      if (!upgraded) socket.destroy();
      upstreamSockets.delete(upstreamWs);
      if (clientWs) upstreamSockets.delete(clientWs);
      activeViewer = false;
    };
    socket.once("close", endPair);
    upstreamWs.on("error", endPair);
    upstreamWs.on("close", endPair);
    upstreamWs.on("open", () => {
      if (outcome || socket.destroyed) return endPair();
      try {
        wss.handleUpgrade(req, socket, head, ws => {
          upgraded = true;
          clientWs = ws;
          upstreamSockets.add(ws);
          ws.on("error", endPair);
          ws.on("close", endPair);
          const relay = (source: WebSocket, destination: WebSocket) => (data: WebSocket.RawData, binary: boolean) => {
            const size = Array.isArray(data) ? data.reduce((total, part) => total + part.byteLength, 0) : data.byteLength;
            if (destination.readyState !== WebSocket.OPEN || destination.bufferedAmount + size > MAX_WS_BUFFER) return endPair();
            destination.send(data, { binary }, error => {
              if (error) endPair();
              else if (!ended && destination.bufferedAmount <= MAX_WS_BUFFER / 2) source.resume();
            });
            if (destination.bufferedAmount > MAX_WS_BUFFER / 2) source.pause();
          };
          ws.on("message", relay(ws, upstreamWs));
          upstreamWs.on("message", relay(upstreamWs, ws));
        });
      } catch { endPair(); }
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
  } catch {
    throw new Error("Unable to start login viewer");
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    await finish("cancelled");
    throw new Error("Unable to start login viewer");
  }
  host = `127.0.0.1:${address.port}`;
  origin = `http://${host}`;
  overallTimer = setTimeout(() => { void finish("timeout"); }, options.timeoutMs);
  return {
    launchUrl: `${origin}/#${capability}`,
    close: () => finish("cancelled"),
    completed
  };
}
