import { createServer, type Server } from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { describeConfiguredPortHolder } from "../src/cli.js";

// `doctor` printed "config: ok" for an endpoint that could never be served:
// measured on this machine, the configured port was held by an unrelated
// program, so `prodex start` failed with EADDRINUSE every time while the one
// line someone reads before believing the setup said it was fine.
let server: Server | net.Server | undefined;

async function listening(created: Server | net.Server): Promise<number> {
  server = created;
  await new Promise<void>((resolve) => created.listen(0, "127.0.0.1", resolve));
  const address = created.address();
  return typeof address === "object" && address ? address.port : 0;
}

const httpAnswering = (status: number) =>
  listening(
    createServer((_req, res) => {
      res.statusCode = status;
      res.end("{}");
    })
  );

/** What a prodex HTTP server answers: /health without a token, /mcp only with its own. */
const prodexServer = (token: string) =>
  listening(
    createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/health") {
        res.end(JSON.stringify({ ok: true, name: "prodex" }));
        return;
      }
      res.statusCode = req.headers.authorization === `Bearer ${token}` ? 400 : 401;
      res.end("{}");
    })
  );

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

describe("noticing a configured port prodex cannot bind", () => {
  it("flags a stranger holding the port, and says what it answered", async () => {
    const port = await httpAnswering(404);
    const holder = await describeConfiguredPortHolder("127.0.0.1", port, "t");
    expect(holder).toMatch(/not a prodex server/i);
    expect(holder).toMatch(/HTTP 404/);
  });

  // Found 2026-11-09: any server answering 200, 400 or 401 was taken for
  // prodex, and a program that does not speak HTTP, or says nothing at all,
  // was taken for a free port. `prodex start` then failed on the port doctor
  // had called fine.
  it("flags an HTTP server that is not prodex, whatever it answers", async () => {
    for (const status of [401, 200, 400]) {
      const port = await httpAnswering(status);
      expect(await describeConfiguredPortHolder("127.0.0.1", port, "t")).toMatch(/not a prodex server/i);
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it("flags a program that does not speak HTTP", async () => {
    const sockets: net.Socket[] = [];
    const port = await listening(
      net.createServer((socket) => {
        sockets.push(socket);
        socket.end("SSH-2.0-OpenSSH_9.6\r\n");
      })
    );
    try {
      expect(await describeConfiguredPortHolder("127.0.0.1", port, "t")).toMatch(/does not answer HTTP/i);
    } finally {
      for (const socket of sockets) socket.destroy();
    }
  });

  it("flags a program that accepts the connection and never answers", async () => {
    const sockets: net.Socket[] = [];
    const port = await listening(net.createServer((socket) => void sockets.push(socket)));
    try {
      expect(await describeConfiguredPortHolder("127.0.0.1", port, "t")).toMatch(/does not answer HTTP/i);
    } finally {
      for (const socket of sockets) socket.destroy();
    }
  });

  it("stays quiet for this repo's own prodex server", async () => {
    const port = await prodexServer("mine");
    expect(await describeConfiguredPortHolder("127.0.0.1", port, "mine")).toBeUndefined();
  });

  // Every repo's `prodex setup` defaults to port 8787, so another repo's
  // running server is the likeliest holder; it refuses this repo's token.
  it("flags another prodex server that refuses this repo's token", async () => {
    const port = await prodexServer("theirs");
    expect(await describeConfiguredPortHolder("127.0.0.1", port, "mine")).toMatch(/another prodex server/i);
  });

  it("stays quiet when nothing is listening, which is the port being free", async () => {
    // Port 1 on loopback: privileged and unused, so the connection is refused.
    expect(await describeConfiguredPortHolder("127.0.0.1", 1, "t")).toBeUndefined();
  });
});
