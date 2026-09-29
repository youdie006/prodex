import { createServer, request as httpRequest } from "node:http";
import { AddressInfo, connect as connectTcp } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { startLoginViewer } from "../src/login-viewer.js";

const open = new Set<() => Promise<void>>();

afterEach(async () => {
  await Promise.all([...open].map(close => close()));
  open.clear();
});

async function upstream() {
  const server = createServer((req, res) => {
    if (req.url === "/core/rfb.js") {
      res.setHeader("Content-Type", "text/javascript");
      res.end("export default class RFB {}");
    } else if (req.url === "/vendor/pako.js") {
      res.end("export const pako = true;");
    } else if (req.url === "/core/redirect.js") {
      res.writeHead(302, { Location: "http://example.invalid/" }).end();
    } else if (req.url === "/core/large.js") {
      res.end(Buffer.alloc(2 * 1024 * 1024 + 1, 65));
    } else if (req.url === "/core/drip.js") {
      const interval = setInterval(() => res.write("x"), 100);
      res.on("close", () => clearInterval(interval));
    } else {
      res.writeHead(404).end();
    }
  });
  const wss = new WebSocketServer({ noServer: true });
  let sockets = 0;
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/websockify") return socket.destroy();
    wss.handleUpgrade(req, socket, head, ws => {
      sockets++;
      ws.send(Buffer.from("RFB 003.008\n"), { binary: true });
      ws.on("message", (data, binary) => ws.send(data, { binary }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const close = async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
    wss.close();
  };
  open.add(close);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, get sockets() { return sockets; } };
}

function options(url: string, extra: Record<string, unknown> = {}) {
  return {
    upstreamUrl: url,
    readPassword: async () => "Abc_1234",
    getStatus: async () => ({ ready: false, blocker: null }),
    timeoutMs: 10_000,
    ...extra
  };
}

async function launch(url: string, extra: Record<string, unknown> = {}) {
  const viewer = await startLoginViewer(options(url, extra));
  open.add(viewer.close);
  const parsed = new URL(viewer.launchUrl);
  const origin = parsed.origin;
  const capability = parsed.hash.slice(1);
  const session = await fetch(`${origin}/session`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ capability })
  });
  const cookie = session.headers.get("set-cookie")?.split(";")[0] ?? "";
  return { viewer, origin, capability, session, cookie };
}

describe("isolated login viewer", () => {
  it("accepts an explicitly published default HTTP port without contacting it", async () => {
    const viewer = await startLoginViewer({ upstreamUrl: "http://127.0.0.1:80/", readPassword: async () => "Abc_1234",
      getStatus: async () => ({ ready: false, blocker: null }), timeoutMs: 1000 });
    await viewer.close();
    expect(await viewer.completed).toBe("cancelled");
  });
  it("rejects unsafe upstream URLs and timeouts before listening", async () => {
    for (const url of [
      "http://localhost:6080", "http://127.0.0.2:6080", "https://127.0.0.1:6080",
      "http://user:pass@127.0.0.1:6080", "http://127.0.0.1:6080/vnc.html",
      "http://127.0.0.1:6080/?x=1", "http://[::1]:6080/#x"
    ]) {
      await expect(startLoginViewer(options(url))).rejects.toThrow();
    }
    for (const timeoutMs of [0, 999, 1_200_001, 1.5]) {
      await expect(startLoginViewer(options("http://127.0.0.1:6080", { timeoutMs }))).rejects.toThrow();
    }
  });

  it("uses a one-time fragment capability and authenticates a host-only cookie", async () => {
    const fixture = await upstream();
    let reads = 0;
    const { viewer, origin, capability, session, cookie } = await launch(fixture.url, {
      readPassword: async () => { reads++; return "Abc_1234"; }
    });
    expect(viewer.launchUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#([a-f0-9]{64})$/);
    expect(capability).toHaveLength(64);
    expect(session.status).toBe(204);
    expect(session.headers.get("set-cookie")).toMatch(/HttpOnly; SameSite=Strict; Path=\//);
    expect(session.headers.get("set-cookie")).not.toMatch(/Domain=/);
    expect(reads).toBe(0);
    const replay = await fetch(`${origin}/session`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ capability }) });
    expect(replay.status).toBe(403);
    expect((await fetch(`${origin}/credentials`, { headers: { Origin: origin } })).status).toBe(403);
    const credential = await fetch(`${origin}/credentials`, { headers: { Origin: origin, Cookie: cookie } });
    expect(credential.status).toBe(200);
    expect(await credential.json()).toEqual({ password: "Abc_1234" });
    expect(credential.headers.get("cache-control")).toBe("no-store");
    expect(reads).toBe(1);
  });

  it("allows exactly one simultaneous bootstrap claim", async () => {
    const fixture = await upstream();
    const viewer = await startLoginViewer(options(fixture.url));
    open.add(viewer.close);
    const url = new URL(viewer.launchUrl);
    const claims = Array.from({ length: 8 }, () => {
      let finish!: () => void;
      const response = new Promise<number>((resolve, reject) => {
        const request = httpRequest(`${url.origin}/session`, {
          method: "POST", headers: { Origin: url.origin, "Content-Type": "application/json" }
        }, incoming => {
          incoming.resume();
          incoming.on("end", () => resolve(incoming.statusCode ?? 0));
        });
        request.on("error", reject);
        request.write('{"capability":"');
        finish = () => request.end(`${url.hash.slice(1)}"}`);
      });
      return { finish, response };
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    claims.forEach(claim => claim.finish());
    const statuses = await Promise.all(claims.map(claim => claim.response));
    expect(statuses.filter(status => status === 204)).toHaveLength(1);
    expect(statuses.filter(status => status === 403)).toHaveLength(7);
  });

  it("serves a no-store self-script page without embedding credentials", async () => {
    const fixture = await upstream();
    const { origin } = await launch(fixture.url);
    const root = await fetch(origin);
    const html = await root.text();
    expect(root.headers.get("content-security-policy")).toMatch(/script-src 'self'/);
    expect(root.headers.get("content-security-policy")).toMatch(/style-src 'self'/);
    expect(root.headers.get("content-security-policy")).toMatch(/frame-ancestors 'none'/);
    expect(root.headers.get("x-content-type-options")).toBe("nosniff");
    expect(root.headers.get("referrer-policy")).toBe("no-referrer");
    expect(root.headers.get("cache-control")).toBe("no-store");
    expect(html).toContain("ProDex Login");
    expect(html).not.toContain("Abc_1234");
    expect(html).not.toContain("<style>");
    const style = await fetch(`${origin}/style.css`);
    expect(style.status).toBe(200);
    const css = await style.text();
    expect(css).toMatch(/body\s*\{[^}]*height:\s*100dvh/);
    expect(css).toMatch(/main\s*\{[^}]*display:\s*flex/);
    const app = await fetch(`${origin}/app.js`);
    const script = await app.text();
    expect(script).toContain("history.replaceState");
    expect(script).toContain("/novnc/core/rfb.js");
    expect(script).toContain("credentialsrequired");
    expect(script).toContain("Sign in required");
    expect(script).toContain("Security verification required");
    expect(script).toContain("Check login screen");
    expect(script).not.toContain("show('Action needed', blocker)");
  });

  it("enforces exact host and origin on bootstrap, APIs and WebSocket", async () => {
    const fixture = await upstream();
    const { origin, cookie } = await launch(fixture.url);
    expect((await fetch(`${origin}/status`, { headers: { Cookie: cookie, Origin: "http://evil.invalid" } })).status).toBe(403);
    expect((await rawGet(origin, "/status", { Cookie: cookie, Host: "localhost" })).status).toBe(403);
    expect((await fetch(`${origin}/credentials`, { headers: { Cookie: cookie } })).status).toBe(200);
    expect((await fetch(`${origin}/credentials`, { headers: { Cookie: cookie, "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
    expect((await fetch(`${origin}/session`, { method: "POST", headers: { Origin: "http://evil.invalid", "Content-Type": "application/json" }, body: "{}" })).status).toBe(403);
    expect((await fetch(`${origin}/status`, { headers: { Cookie: cookie, Origin: origin } })).status).toBe(200);
    await expect(connectWs(origin, cookie, "http://evil.invalid")).rejects.toThrow();
    await expect(connectWs(origin, "", origin)).rejects.toThrow();
    expect(fixture.sockets).toBe(0);
  });

  it("proxies only authenticated safe noVNC modules without redirects", async () => {
    const fixture = await upstream();
    const { origin, cookie } = await launch(fixture.url);
    expect((await fetch(`${origin}/novnc/core/rfb.js`)).status).toBe(403);
    const asset = await fetch(`${origin}/novnc/core/rfb.js`, { headers: { Cookie: cookie } });
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain("class RFB");
    expect((await fetch(`${origin}/novnc/vendor/pako.js`, { headers: { Cookie: cookie } })).status).toBe(200);
    expect((await fetch(`${origin}/core/rfb.js`, { headers: { Cookie: cookie } })).status).toBe(200);
    expect((await fetch(`${origin}/vendor/pako.js`, { headers: { Cookie: cookie } })).status).toBe(200);
    expect((await fetch(`${origin}/novnc/core/redirect.js`, { headers: { Cookie: cookie } })).status).toBe(502);
    expect((await fetch(`${origin}/novnc/core/large.js`, { headers: { Cookie: cookie } })).status).toBe(502);
    for (const path of ["/novnc/core/../vendor/pako.js", "/novnc/core/%2e%2e/vendor/pako.js", "/novnc/core/%2fetc.js", "/novnc/core/rfb.js?x=1", "/novnc/core/rfb.css"]) {
      expect((await rawGet(origin, path, { Cookie: cookie })).status).not.toBe(200);
    }
  });

  it("relays binary WebSocket messages for one authenticated client", async () => {
    const fixture = await upstream();
    const { origin, cookie } = await launch(fixture.url);
    let receiveGreeting!: (value: Buffer) => void;
    const greeting = new Promise<Buffer>(resolve => { receiveGreeting = resolve; });
    const ws = await connectWs(origin, cookie, origin, receiveGreeting);
    expect(await greeting).toEqual(Buffer.from("RFB 003.008\n"));
    const message = new Promise<Buffer>(resolve => ws.once("message", data => resolve(Buffer.from(data as Buffer))));
    ws.send(Buffer.from([0, 1, 255]));
    expect(await message).toEqual(Buffer.from([0, 1, 255]));
    await expect(connectWs(origin, cookie, origin)).rejects.toThrow();
    ws.close();
  });

  it("releases the viewer slot after a malformed WebSocket upgrade", async () => {
    const fixture = await upstream();
    const { origin, cookie } = await launch(fixture.url);
    const address = new URL(origin);
    const socket = connectTcp(Number(address.port), "127.0.0.1");
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    socket.resume();
    socket.setTimeout(2000, () => socket.destroy());
    const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
    socket.write(`GET /websockify HTTP/1.1\r\nHost: ${address.host}\r\nOrigin: ${origin}\r\nCookie: ${cookie}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: invalid\r\n\r\n`);
    await closed;
    const ws = await connectWs(origin, cookie, origin);
    ws.close();
  });

  it("bounds total asset time even when upstream keeps streaming", async () => {
    const fixture = await upstream();
    const { origin, cookie } = await launch(fixture.url);
    const response = await fetch(`${origin}/novnc/core/drip.js`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(6500) });
    expect(response.status).toBe(502);
  }, 8000);

  it("resolves ready after a short grace, and closes or times out without orphan sockets", async () => {
    const fixture = await upstream();
    let ready = false;
    const first = await launch(fixture.url, { getStatus: async () => ({ ready, blocker: null }) });
    expect(await (await fetch(`${first.origin}/status`, { headers: { Origin: first.origin, Cookie: first.cookie } })).json()).toEqual({ ready: false, blocker: null });
    ready = true;
    expect((await fetch(`${first.origin}/status`, { headers: { Origin: first.origin, Cookie: first.cookie } })).status).toBe(200);
    expect(await first.viewer.completed).toBe("ready");
    await first.viewer.close();
    const second = await startLoginViewer(options(fixture.url, { timeoutMs: 1000 }));
    expect(await second.completed).toBe("timeout");
    await second.close();
    const third = await startLoginViewer(options(fixture.url));
    await third.close();
    await third.close();
    expect(await third.completed).toBe("cancelled");
  });

  it("redacts callback failures and rejects invalid VNC passwords", async () => {
    const fixture = await upstream();
    const { origin, cookie } = await launch(fixture.url, {
      readPassword: async () => "too-long-secret",
      getStatus: async () => { throw new Error("private status detail"); }
    });
    const headers = { Cookie: cookie };
    const credentials = await fetch(`${origin}/credentials`, { headers });
    expect(credentials.status).toBe(502);
    expect(await credentials.text()).not.toContain("too-long-secret");
    const status = await fetch(`${origin}/status`, { headers });
    expect(status.status).toBe(502);
    expect(await status.text()).not.toContain("private status detail");
  });

  it("clears an in-flight status deadline when the viewer is closed", async () => {
    const fixture = await upstream();
    let entered!: () => void;
    const called = new Promise<void>(resolve => { entered = resolve; });
    const viewer = await startLoginViewer(options(fixture.url, {
      getStatus: async () => { entered(); return new Promise(() => {}); }
    }));
    const origin = new URL(viewer.launchUrl).origin;
    const capability = new URL(viewer.launchUrl).hash.slice(1);
    const session = await fetch(`${origin}/session`, {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ capability })
    });
    const cookie = session.headers.get("set-cookie")?.split(";")[0] ?? "";
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = fetch(`${origin}/status`, { headers: { Cookie: cookie } }).catch(() => undefined);
      await called;
      const beforeClose = vi.getTimerCount();
      await viewer.close();
      await pending;
      expect(beforeClose).toBeGreaterThan(0);
      expect(vi.getTimerCount()).toBeLessThan(beforeClose);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not schedule ready grace after close has started", async () => {
    const fixture = await upstream();
    let entered!: () => void;
    let resolveStatus!: (value: { ready: boolean; blocker: null }) => void;
    const called = new Promise<void>(resolve => { entered = resolve; });
    const status = new Promise<{ ready: boolean; blocker: null }>(resolve => { resolveStatus = resolve; });
    const { viewer, origin, cookie } = await launch(fixture.url, {
      getStatus: async () => { entered(); return status; }
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = fetch(`${origin}/status`, { headers: { Cookie: cookie } }).catch(() => undefined);
      await called;
      const beforeClose = vi.getTimerCount();
      const closing = viewer.close();
      resolveStatus({ ready: true, blocker: null });
      await closing;
      await pending;
      expect(await viewer.completed).toBe("cancelled");
      expect(vi.getTimerCount()).toBeLessThan(beforeClose);
    } finally {
      vi.useRealTimers();
    }
  });
});

async function connectWs(origin: string, cookie: string, pageOrigin: string, onFirstMessage?: (value: Buffer) => void): Promise<WebSocket> {
  const url = `${origin.replace(/^http/, "ws")}/websockify`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { origin: pageOrigin, headers: cookie ? { Cookie: cookie } : {} });
    if (onFirstMessage) ws.once("message", data => onFirstMessage(Buffer.from(data as Buffer)));
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => {
      res.resume();
      ws.terminate();
      reject(new Error(`WebSocket rejected: ${res.statusCode}`));
    });
  });
}

async function rawGet(origin: string, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(origin, { method: "GET", path, headers }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end();
  });
}
