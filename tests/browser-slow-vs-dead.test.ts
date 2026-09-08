import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

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
    const status = await getChatGptBrowserStatus({ port: 1, timeoutMs: 1_000 });
    expect(status.reachable).toBe(false);
    expect(status.blocker?.code).toBe("browser_unreachable");
  });

  it("does not mistake a tiny timeout on a closed port for a busy browser", async () => {
    // With a 10ms budget the timer fires before the refusal reports back, so
    // the fetch error says "timeout" about a port nothing listens on. The TCP
    // check underneath is what keeps that from reading as "running but busy".
    const status = await getChatGptBrowserStatus({ port: 65534, timeoutMs: 10 });
    expect(status.blocker?.code).toBe("browser_unreachable");
  });

  it("only counts a refused connection as evidence of death", () => {
    expect(statusMeansBrowserDead({ reachable: false, blocker: { code: "browser_unreachable" } })).toBe(true);
    expect(statusMeansBrowserDead({ reachable: false, blocker: { code: "browser_slow" } })).toBe(false);
    expect(statusMeansBrowserDead({ reachable: true })).toBe(false);
  });
});
