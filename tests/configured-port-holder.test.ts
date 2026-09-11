import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { describeConfiguredPortHolder } from "../src/cli.js";

// `doctor` printed "config: ok" for an endpoint that could never be served:
// measured on this machine, the configured port was held by an unrelated
// program, so `prodex start` failed with EADDRINUSE every time while the one
// line someone reads before believing the setup said it was fine.
let server: Server | undefined;

async function listen(handler: (status: number) => number): Promise<number> {
  server = createServer((_req, res) => {
    res.statusCode = handler(0);
    res.end("{}");
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return typeof address === "object" && address ? address.port : 0;
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

describe("noticing a configured port prodex cannot bind", () => {
  it("flags a stranger holding the port, and says what it answered", async () => {
    const port = await listen(() => 404);
    const holder = await describeConfiguredPortHolder("127.0.0.1", port);
    expect(holder).toMatch(/not a prodex server/i);
    expect(holder).toMatch(/HTTP 404/);
  });

  // prodex's own server answers /mcp - 401 without a token is still an answer,
  // and flagging it would cry about a healthy setup on every doctor run.
  it("stays quiet for a server that answers the MCP endpoint", async () => {
    for (const status of [401, 200, 400]) {
      const port = await listen(() => status);
      expect(await describeConfiguredPortHolder("127.0.0.1", port)).toBeUndefined();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it("stays quiet when nothing is listening, which is the port being free", async () => {
    // Port 1 on loopback: privileged and unused, so the connection is refused.
    expect(await describeConfiguredPortHolder("127.0.0.1", 1)).toBeUndefined();
  });
});
