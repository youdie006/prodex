import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { LimitedStdioServerTransport } from "../src/mcp.js";

describe("MCP stdio transport", () => {
  it("rejects oversized stdio input before a newline is received", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = new LimitedStdioServerTransport(input, output, { maxMessageBytes: 16 });
    const errors: Error[] = [];
    let closed = false;
    transport.onerror = (error) => errors.push(error);
    transport.onclose = () => {
      closed = true;
    };

    await transport.start();
    input.write(Buffer.alloc(17, "x"));
    await eventually(() => errors.length > 0 && closed);

    expect(errors[0]?.message).toContain("too large");
    expect(closed).toBe(true);
  });

  it("does not fire close more than once after an input limit error", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = new LimitedStdioServerTransport(input, output, { maxMessageBytes: 16 });
    let closeCount = 0;
    transport.onerror = () => undefined;
    transport.onclose = () => {
      closeCount += 1;
    };

    await transport.start();
    input.write(Buffer.alloc(17, "x"));
    await eventually(() => closeCount === 1);
    await transport.close();

    expect(closeCount).toBe(1);
  });

  it("parses normal newline-delimited JSON-RPC messages", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = new LimitedStdioServerTransport(input, output, { maxMessageBytes: 1024 });
    const received = new Promise<unknown>((resolve) => {
      transport.onmessage = (message) => resolve(message);
    });

    await transport.start();
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

    await expect(received).resolves.toEqual(expect.objectContaining({ method: "notifications/initialized" }));
    await transport.close();
  });
});

async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not met");
}
