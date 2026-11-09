import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { createServer, DEFAULT_STDIO_MESSAGE_LIMIT_BYTES, LimitedStdioServerTransport } from "../src/mcp.js";

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

  it("closes after stdin stream errors", async () => {
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
    input.emit("error", new Error("broken stdin"));
    await eventually(() => errors.length > 0 && closed);

    expect(errors[0]?.message).toBe("broken stdin");
    expect(closed).toBe(true);
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

  it("recovers from a malformed frame and still delivers pipelined valid messages", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = new LimitedStdioServerTransport(input, output, { maxMessageBytes: 1024 });
    const delivered: unknown[] = [];
    const errors: Error[] = [];
    let closed = false;
    transport.onmessage = (message) => delivered.push(message);
    transport.onerror = (error) => errors.push(error);
    transport.onclose = () => {
      closed = true;
    };

    await transport.start();
    // A bad frame followed, in the same chunk, by a valid pipelined message.
    input.write(`{bad json}\n${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

    await eventually(() => delivered.length > 0);
    expect(errors.length).toBe(1); // the bad frame was reported...
    expect(closed).toBe(false); // ...but did not tear down the session...
    expect(delivered).toEqual([expect.objectContaining({ method: "notifications/initialized" })]); // ...and the valid one still arrived.
    await transport.close();
  });

  it("send() rejects instead of hanging when the output closes under backpressure", async () => {
    const input = new PassThrough();
    // highWaterMark 1 with no reader => write() returns false => the send path
    // waits for "drain", which never comes because we destroy the stream.
    const output = new PassThrough({ highWaterMark: 1 });
    const transport = new LimitedStdioServerTransport(input, output, { maxMessageBytes: 1024 });
    await transport.start();

    const sendPromise = transport.send({ jsonrpc: "2.0", id: 1, result: {} } as never);
    output.destroy();

    await expect(sendPromise).rejects.toThrow(/closed|drain/i);
  });
});

describe("MCP stdio message limit", () => {
  // Measured 2026-11-09: repo_write_file_dry_run content of 1,000,000
  // characters with a newline every 20 is a 1.05 MB frame once JSON escapes the
  // newlines. The old 1 MiB limit closed the session on it without a word.
  it("delivers the largest content repo_write_file_dry_run accepts, even with every character escaped", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = new LimitedStdioServerTransport(input, output);
    const delivered: unknown[] = [];
    let closed = false;
    transport.onmessage = (message) => delivered.push(message);
    transport.onerror = () => undefined;
    transport.onclose = () => {
      closed = true;
    };

    await transport.start();
    // A control character is one byte to the handler's 1,000,000-byte check
    // and six bytes in JSON (\u0001), the most escaping can add.
    const frame = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "repo_write_file_dry_run", arguments: { path: "a.txt", content: "\u0001".repeat(1_000_000), expected_head: "x" } }
    });
    input.write(`${frame}\n`);
    await eventually(() => delivered.length > 0 || closed);

    expect(closed).toBe(false);
    expect(delivered).toHaveLength(1);
    await transport.close();
  });

  it("fits the largest call every tool's schema allows, fully escaped", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-mcp-limit-"));
    const server = createServer(cwd, { registerRoot: false, browserConsult: async () => ({}), browserRecover: async () => ({}) });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "prodex-test", version: "0.1.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const { tools } = await client.listTools();
    await client.close();
    await rm(cwd, { recursive: true, force: true });

    // Room for the JSON-RPC envelope around the arguments: jsonrpc, id,
    // method, the tool name and a progress token.
    const envelopeBytes = 1024;
    const largest = tools
      .map((tool) => ({ tool: tool.name, bytes: envelopeBytes + worstCaseJsonBytes(tool.inputSchema, tool.inputSchema) }))
      .sort((left, right) => right.bytes - left.bytes)[0]!;

    expect(tools.length).toBeGreaterThan(15);
    expect(largest.bytes, `${largest.tool} can take ${largest.bytes} bytes`).toBeLessThanOrEqual(DEFAULT_STDIO_MESSAGE_LIMIT_BYTES);
  });
});

describe("MCP stdio server process", () => {
  // The frame arriving whole is the case that used to leave the process
  // running and deaf: the transport only paused stdin, and with nothing more
  // to read the pipe kept the event loop alive.
  it.each([
    ["arrives whole", `${"x".repeat(4096)}\n`, /4096 bytes/],
    ["has no end", "x".repeat(4096), /at least \d{4} bytes/]
  ])("exits nonzero and says why when a message over the limit %s", async (_label, frame, size) => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-mcp-oversize-"));
    const moduleUrl = pathToFileURL(path.resolve("src/mcp.ts")).href;
    const script = `
      import { runMcpServer } from ${JSON.stringify(moduleUrl)};
      await runMcpServer(process.env.MCP_TEST_CWD, { registerRoot: false }, { maxMessageBytes: 1024 });
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: { ...process.env, MCP_TEST_CWD: cwd },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.stdin.on("error", () => undefined);
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    try {
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } })}\n`
      );
      await eventuallyWithin(20_000, () => stdout.includes('"id":1'));
      child.stdin.write(frame);
      const code = await Promise.race([exited, new Promise<"still running">((resolve) => setTimeout(() => resolve("still running"), 10_000))]);

      expect(code).toBe(1);
      const lines = stderr.split("\n").filter((line) => line.trim().length > 0);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/too large/);
      expect(lines[0]).toMatch(size);
      expect(lines[0]).toContain("1024 bytes");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

type JsonSchema = {
  $ref?: string;
  type?: string;
  enum?: unknown[];
  maxLength?: number;
  pattern?: string;
  maxItems?: number;
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
};

/**
 * The longest JSON a serializer can write for arguments the schema accepts:
 * every optional property present, every array at maxItems, and every string
 * character escaped as \uXXXX, six bytes. A field with no bound throws, so a
 * new unbounded field fails here instead of in a client's session.
 */
function worstCaseJsonBytes(schema: JsonSchema, root: JsonSchema): number {
  if (schema.$ref) {
    const target = schema.$ref
      .replace(/^#\//, "")
      .split("/")
      .reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], root);
    return worstCaseJsonBytes(target as JsonSchema, root);
  }
  if (schema.enum) return Math.max(...schema.enum.map((value) => Buffer.byteLength(JSON.stringify(value))));
  switch (schema.type) {
    case "string": {
      // A fixed-length pattern such as ^[a-f0-9]{32}$ bounds a string too.
      const length = schema.maxLength ?? Number(/^\^\[[^\]]+\]\{(\d+)\}\$$/.exec(schema.pattern ?? "")?.[1] ?? Number.NaN);
      if (!Number.isFinite(length)) throw new Error(`unbounded string in ${JSON.stringify(schema)}`);
      return 2 + 6 * length;
    }
    case "integer":
    case "number":
      // Longest number JSON.stringify writes: -1.7976931348623157e+308.
      return 24;
    case "boolean":
      return 5;
    case "array": {
      if (schema.maxItems === undefined || !schema.items) throw new Error(`unbounded array in ${JSON.stringify(schema)}`);
      return 2 + schema.maxItems * (worstCaseJsonBytes(schema.items, root) + 1);
    }
    case "object":
      return (
        2 +
        Object.entries(schema.properties ?? {}).reduce(
          (total, [key, value]) => total + Buffer.byteLength(JSON.stringify(key)) + 2 + worstCaseJsonBytes(value, root),
          0
        )
      );
    default:
      throw new Error(`unsupported schema ${JSON.stringify(schema)}`);
  }
}

async function eventuallyWithin(timeoutMs: number, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition was not met");
}

async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not met");
}
