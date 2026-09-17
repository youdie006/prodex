import { once } from "node:events";
import { WebSocketServer } from "ws";
import { describe, expect, it } from "vitest";

import { withCdpSession } from "../scripts/browser-launch-smoke.mjs";

async function fixture(work: (url: string, server: WebSocketServer) => Promise<void>) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("missing fixture address");
  try {
    await work(`ws://127.0.0.1:${address.port}`, server);
  } finally {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

describe("navigation diagnostic CDP session", () => {
  it("delivers unsolicited events before the matching command reply", async () => {
    await fixture(async (url, server) => {
      server.on("connection", socket => socket.on("message", data => {
        const command = JSON.parse(data.toString());
        socket.send("not JSON");
        socket.send(JSON.stringify({ method: "Network.responseReceived", params: { marker: "synthetic" } }));
        socket.send(JSON.stringify({ id: command.id, result: { accepted: true } }));
      }));
      const events: unknown[] = [];
      await withCdpSession(url, async (send: Function, subscribe: Function) => {
        const unsubscribe = subscribe((event: unknown) => events.push(event));
        expect(await send("Page.navigate")).toEqual({ accepted: true });
        unsubscribe();
        await send("Page.navigate");
      });
      expect(events).toEqual([{ method: "Network.responseReceived", params: { marker: "synthetic" } }]);
    });
  });

  it("rejects outstanding commands when a bounded caller finishes early", async () => {
    await fixture(async url => {
      let pending: Promise<unknown> | undefined;
      await withCdpSession(url, async (send: Function) => {
        pending = send("Page.navigate").catch((error: Error) => error.message);
      });
      expect(await pending).toBe("CDP session closed before a reply");
    });
  });
});
