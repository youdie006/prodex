import { createServer, type Server } from "node:http";
import net, { type AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchTimedOut, getChatGptBrowserStatus, statusMeansBrowserDead } from "../src/chatgpt-browser.js";

// The page lookup mapped every failure to "No Chrome DevTools endpoint is
// reachable", a timeout included. A timeout is a browser that is busy - a
// loaded machine, a heavy thread, a tab held by a dialog - and it was getting
// the same verdict as a browser that is gone. The silence check that decides
// whether to END a browser counted three of those as a dead one, and what
// followed was SIGTERM to a live browser mid-answer.
describe("telling a slow browser from a dead one", () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    vi.restoreAllMocks();
  });

  it("recognises a fetch that timed out rather than one that was refused", () => {
    const timedOut = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    expect(fetchTimedOut(timedOut)).toBe(true);
    expect(fetchTimedOut(new TypeError("fetch failed"))).toBe(false);
    expect(fetchTimedOut(undefined)).toBe(false);
  });

  it("reports a port that answers too slowly as slow, not unreachable", async () => {
    server = createServer((_request, response) => {
      setTimeout(() => response.end("[]"), 2_000);
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    const status = await getChatGptBrowserStatus({ port, timeoutMs: 300 });

    expect(status.reachable).toBe(false);
    expect(status.blocker?.code).toBe("browser_slow");
    expect(status.blocker?.message).toMatch(/running but busy/);
  });

  it("still reports a port nothing listens on as unreachable", async () => {
    server = createServer();
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    const status = await getChatGptBrowserStatus({ port, timeoutMs: 1_000 });
    expect(status.reachable).toBe(false);
    expect(status.blocker?.code).toBe("browser_unreachable");
  });

  it.each([
    [503, "unavailable"],
    [200, "not json"],
    [200, "{}"]
  ])("does not treat an HTTP %s control error as a stopped browser", async (code, body) => {
    server = createServer((_request, response) => {
      response.writeHead(code, { Connection: "close" });
      response.end(body);
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const status = await getChatGptBrowserStatus({ port, timeoutMs: 300 });
    expect(status.blocker?.code).toBe("browser_control_unavailable");
    expect(statusMeansBrowserDead(status)).toBe(false);
    expect(status.blocker?.next_step).not.toContain("login");
  });

  it.each([
    ["ECONNREFUSED", "browser_unreachable", true],
    ["ETIMEDOUT", "browser_control_unavailable", false]
  ] as const)("uses TCP %s evidence after a tiny fetch timeout", async (code, blocker, dead) => {
    // A closed local port is not guaranteed to refuse before the TCP deadline
    // under load. Inject each outcome; the real-socket check remains above.
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new DOMException("Fetch timed out", "TimeoutError"));
    vi.spyOn(net, "createConnection").mockImplementation(() => {
      const socket = new net.Socket();
      queueMicrotask(() => socket.destroy(Object.assign(new Error(code), { code })));
      return socket;
    });
    const status = await getChatGptBrowserStatus({ port: 19333, timeoutMs: 10 });
    expect(status.blocker?.code).toBe(blocker);
    expect(statusMeansBrowserDead(status)).toBe(dead);
  });

  it("only counts a refused connection as evidence of death", () => {
    expect(statusMeansBrowserDead({ reachable: false, blocker: { code: "browser_unreachable" } })).toBe(true);
    expect(statusMeansBrowserDead({ reachable: false, blocker: { code: "browser_slow" } })).toBe(false);
    expect(statusMeansBrowserDead({ reachable: true })).toBe(false);
    expect(statusMeansBrowserDead({ reachable: false })).toBe(false);
    expect(statusMeansBrowserDead({ reachable: false, blocker: { code: "browser_control_unavailable" } })).toBe(false);
  });
});
