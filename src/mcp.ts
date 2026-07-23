import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createRequire } from "node:module";
import process from "node:process";
import type { Readable, Writable } from "node:stream";
import { serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createMcpToolHandlers, MAX_MCP_BRIDGE_TEXT_BYTES, MAX_MCP_SHORT_TEXT_BYTES } from "./mcp-tools.js";
import { ReceiptKindSchema, type SourceSchema } from "./schema.js";
import type { z as zod } from "zod";

type BridgeSource = zod.infer<typeof SourceSchema>;
const McpBridgeTextSchema = z.string().max(MAX_MCP_BRIDGE_TEXT_BYTES);
const McpShortTextSchema = z.string().max(MAX_MCP_SHORT_TEXT_BYTES);
const BridgeFileInputSchema = z.object({
  path: McpShortTextSchema,
  role: z.enum(["context", "artifact", "result"]).optional(),
  bytes: z.number().int().nonnegative().optional()
});
export const DEFAULT_STDIO_MESSAGE_LIMIT_BYTES = 1_048_576;

export interface BrowserConsultToolInput {
  prompt: string;
  model?: string;
  pro_mode?: string;
  effort?: string;
  project?: string;
  timeout_ms?: number;
  files?: string[];
  new_chat?: boolean;
}

export interface CreateMcpServerOptions {
  source?: BridgeSource;
  claimedBy?: string;
  /**
   * When provided, registers the pro_consult tool backed by this callback.
   * Wire it ONLY for the local stdio MCP server: the HTTP MCP surface is
   * exposed to ChatGPT itself (and possibly a tunnel), and must never be able
   * to drive the user's browser. Injected from cli.ts to avoid an import
   * cycle (mcp -> cli-pro -> cli-server -> http-mcp -> mcp). The optional
   * onProgress receives human-readable progress lines for MCP progress
   * notifications during multi-minute consults.
   */
  browserConsult?: (input: BrowserConsultToolInput, onProgress?: (message: string) => void) => Promise<unknown>;
}

function asText(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

const mcpPackageJson = createRequire(import.meta.url)("../package.json") as { version?: string };

export function createServer(cwd = process.cwd(), options: CreateMcpServerOptions = {}): McpServer {
  const server = new McpServer({ name: "prodex", version: mcpPackageJson.version ?? "0.0.0" });
  const handlers = createMcpToolHandlers({ cwd, source: options.source, claimedBy: options.claimedBy });

  server.registerTool(
    "bridge_create_task",
    {
      description: "Create a durable task for Codex/local execution in .bridge/tasks.",
      inputSchema: {
        title: McpShortTextSchema.min(1),
        prompt: McpBridgeTextSchema.min(1),
        repo_id: McpShortTextSchema.optional(),
        files: z.array(BridgeFileInputSchema).max(100).optional()
      }
    },
    async (input) => asText(await handlers.bridge_create_task(input))
  );

  server.registerTool(
    "bridge_list_tasks",
    {
      description: "List durable bridge tasks.",
      inputSchema: { status: z.enum(["new", "claimed", "done", "blocked"]).optional() }
    },
    async (input) => asText(await handlers.bridge_list_tasks(input))
  );

  server.registerTool(
    "bridge_get_task",
    {
      description: "Fetch one bridge task by id.",
      inputSchema: { task_id: McpShortTextSchema }
    },
    async (input) => asText(await handlers.bridge_get_task(input))
  );

  server.registerTool(
    "bridge_claim_task",
    {
      description: "Claim a new bridge task for execution.",
      inputSchema: { task_id: McpShortTextSchema, claimed_by: McpShortTextSchema.optional() }
    },
    async (input) => asText(await handlers.bridge_claim_task(input))
  );

  server.registerTool(
    "bridge_complete_task",
    {
      description: "Complete a bridge task with a durable result record.",
      inputSchema: {
        task_id: McpShortTextSchema,
        summary: McpBridgeTextSchema.min(1),
        artifacts: z.array(BridgeFileInputSchema).max(100).optional(),
        commands: z.array(McpBridgeTextSchema).max(100).optional(),
        warnings: z.array(McpBridgeTextSchema).max(100).optional()
      }
    },
    async (input) => asText(await handlers.bridge_complete_task(input))
  );

  server.registerTool(
    "bridge_block_task",
    {
      description: "Close a bridge task as blocked with durable blocker metadata.",
      inputSchema: {
        task_id: McpShortTextSchema,
        summary: McpBridgeTextSchema.min(1),
        code: McpShortTextSchema.optional(),
        next_step: McpBridgeTextSchema.optional(),
        retryable: z.boolean().optional(),
        artifacts: z.array(BridgeFileInputSchema).max(100).optional(),
        commands: z.array(McpBridgeTextSchema).max(100).optional(),
        warnings: z.array(McpBridgeTextSchema).max(100).optional()
      }
    },
    async (input) => asText(await handlers.bridge_block_task(input))
  );

  server.registerTool(
    "bridge_list_results",
    {
      description: "List completed or blocked bridge results.",
      inputSchema: {}
    },
    async () => asText(await handlers.bridge_list_results())
  );

  server.registerTool(
    "bridge_fetch_result",
    {
      description: "Fetch the result for a bridge task.",
      inputSchema: { task_id: McpShortTextSchema }
    },
    async (input) => asText(await handlers.bridge_fetch_result(input))
  );

  server.registerTool(
    "bridge_fetch_result_artifact",
    {
      description: "Fetch text content for a result-listed artifact. Arbitrary .bridge artifacts are not exposed.",
      inputSchema: { task_id: McpShortTextSchema, path: McpShortTextSchema.optional() }
    },
    async (input) => asText(await handlers.bridge_fetch_result_artifact(input))
  );

  server.registerTool(
    "bridge_list_receipts",
    {
      description: "List durable bridge receipts with legacy inline write payloads redacted.",
      inputSchema: { kind: ReceiptKindSchema.optional(), task_id: McpShortTextSchema.optional() }
    },
    async (input) => asText(await handlers.bridge_list_receipts(input))
  );

  server.registerTool(
    "bridge_get_receipt",
    {
      description: "Fetch one bridge receipt with legacy inline write payloads redacted.",
      inputSchema: { receipt_id: McpShortTextSchema }
    },
    async (input) => asText(await handlers.bridge_get_receipt(input))
  );

  server.registerTool(
    "bridge_list_sessions",
    {
      description: "List durable consult/session records.",
      inputSchema: { status: z.enum(["preview", "running", "done", "blocked"]).optional() }
    },
    async (input) => asText(await handlers.bridge_list_sessions(input))
  );

  server.registerTool(
    "bridge_get_session",
    {
      description: "Fetch one consult/session record by id.",
      inputSchema: { session_id: McpShortTextSchema }
    },
    async (input) => asText(await handlers.bridge_get_session(input))
  );

  server.registerTool(
    "repo_read_file",
    {
      description: "Read a repo-relative text file with line bounds. Absolute paths and traversal are rejected.",
      inputSchema: {
        path: McpShortTextSchema,
        start_line: z.number().int().positive().optional(),
        max_lines: z.number().int().positive().max(500).optional()
      }
    },
    async (input) => asText(await handlers.repo_read_file(input))
  );

  server.registerTool(
    "repo_search",
    {
      description: "Search the current repo with ripgrep. Read-only.",
      inputSchema: { query: McpBridgeTextSchema.min(1), glob: McpShortTextSchema.optional() }
    },
    async (input) => asText(await handlers.repo_search(input))
  );

  server.registerTool(
    "repo_write_file_dry_run",
    {
      description: "Create a receipt-gated write preview for an existing repo-relative text file. Does not modify files.",
      inputSchema: {
        path: McpShortTextSchema,
        content: z.string().max(1_000_000),
        expected_head: McpShortTextSchema.min(1)
      }
    },
    async (input) => asText(await handlers.repo_write_file_dry_run(input))
  );

  server.registerTool(
    "repo_write_file_apply",
    {
      description: "Apply a prior write dry-run only when git HEAD and preimage hash match.",
      inputSchema: {
        receipt_id: McpShortTextSchema.min(1),
        expected_head: McpShortTextSchema.min(1),
        preimage_sha256: McpShortTextSchema.min(1)
      }
    },
    async (input) => asText(await handlers.repo_write_file_apply(input))
  );

  server.registerTool(
    "repo_stage_reviewed_paths",
    {
      description: "Stage paths only when backed by applied write receipts matching the current git HEAD and file content.",
      inputSchema: {
        receipt_ids: z.array(McpShortTextSchema.min(1)).min(1).max(100),
        expected_head: McpShortTextSchema.min(1)
      }
    },
    async (input) => asText(await handlers.repo_stage_reviewed_paths(input))
  );

  const browserConsult = options.browserConsult;
  if (browserConsult) {
    server.registerTool(
      "pro_consult",
      {
        description:
          "Ask the user's logged-in ChatGPT (Pro) in the visible browser and wait for the full answer. This drives a real browser send: it can take minutes (Pro extended reasoning), is human-paced, and records a durable receipt under .bridge/. Requires a running `prodex pro browser login` session. By DEFAULT the consult continues in the currently-open thread, so consecutive follow-ups on the same topic stay in one conversation (keeps context, avoids sidebar clutter). Pass new_chat:true ONLY to start a fresh thread for a genuinely new topic. If the thread is still generating a previous answer, the send automatically queues behind it (up to the timeout budget) - long 'tab busy' progress is normal, not stuck. `project` and `model` come from saved defaults (per-repo config, or PRODEX_DEFAULT_PROJECT / PRODEX_DEFAULT_MODEL env vars) when omitted - do NOT pass them per-call unless deliberately overriding. Returns task_id, thread URL, and the answer text.",
        inputSchema: {
          prompt: McpBridgeTextSchema.min(1),
          model: McpShortTextSchema.optional(),
          pro_mode: McpShortTextSchema.optional(),
          effort: McpShortTextSchema.optional(),
          project: McpShortTextSchema.optional(),
          timeout_ms: z.number().int().positive().max(3_600_000).optional(),
          files: z.array(McpShortTextSchema).max(20).optional(),
          new_chat: z
            .boolean()
            .optional()
            .describe("Start a fresh thread. Omit to continue the current thread (preferred for follow-ups).")
        }
      },
      async (input, extra) => {
        // Bridge send progress to MCP progress notifications, but only when
        // the client asked for them (sent a progressToken). Clients that
        // reset their request timeout on progress can then survive
        // multi-minute Pro consults without a raised static timeout.
        const progressToken = extra._meta?.progressToken;
        let progress = 0;
        const onProgress =
          progressToken === undefined
            ? undefined
            : (message: string) => {
                void extra
                  .sendNotification({
                    method: "notifications/progress",
                    params: { progressToken, progress: ++progress, message }
                  })
                  .catch(() => {
                    // Progress delivery must never break the consult.
                  });
              };
        return asText(await browserConsult(input, onProgress));
      }
    );
  }

  return server;
}

export async function runMcpServer(cwd = process.cwd(), options: CreateMcpServerOptions = {}): Promise<void> {
  const server = createServer(cwd, options);
  const transport = new LimitedStdioServerTransport();
  await server.connect(transport);
}

export class LimitedStdioServerTransport implements Transport {
  onclose?: Transport["onclose"];
  onerror?: Transport["onerror"];
  onmessage?: Transport["onmessage"];
  sessionId?: string;
  setProtocolVersion?: Transport["setProtocolVersion"];

  private buffer = Buffer.alloc(0);
  private started = false;
  private closed = false;
  private readonly maxMessageBytes: number;

  constructor(
    private readonly stdin: Readable = process.stdin,
    private readonly stdout: Writable = process.stdout,
    options: { maxMessageBytes?: number } = {}
  ) {
    this.maxMessageBytes = Math.max(1, options.maxMessageBytes ?? DEFAULT_STDIO_MESSAGE_LIMIT_BYTES);
  }

  async start(): Promise<void> {
    if (this.started) {
      throw new Error("LimitedStdioServerTransport already started");
    }
    this.started = true;
    this.stdin.on("data", this.onData);
    this.stdin.on("error", this.onInputError);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.stdin.off("data", this.onData);
    this.stdin.off("error", this.onInputError);
    if (this.stdin.listenerCount("data") === 0) {
      this.stdin.pause();
    }
    this.buffer = Buffer.alloc(0);
    this.onclose?.();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const json = serializeMessage(message);
    await new Promise<void>((resolve, reject) => {
      if (this.stdout.write(json)) {
        resolve();
        return;
      }
      // Backpressure: wait for "drain", but also settle on "error"/"close" so a
      // downstream reader that dies mid-write can never hang this promise
      // forever (which would also leak the drain listener). All three handlers
      // are removed on the first to fire.
      const cleanup = (): void => {
        this.stdout.off("drain", onDrain);
        this.stdout.off("error", onError);
        this.stdout.off("close", onClose);
      };
      const onDrain = (): void => {
        cleanup();
        resolve();
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onClose = (): void => {
        cleanup();
        reject(new Error("stdout closed before the message drained"));
      };
      this.stdout.once("drain", onDrain);
      this.stdout.once("error", onError);
      this.stdout.once("close", onClose);
    });
  }

  private readonly onData = (chunk: Buffer | string): void => {
    try {
      const buffer = Buffer.from(chunk);
      this.buffer = this.buffer.length === 0 ? buffer : Buffer.concat([this.buffer, buffer]);
      this.processBuffer();
    } catch (error) {
      this.buffer = Buffer.alloc(0);
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      void this.close();
    }
  };

  private readonly onInputError = (error: Error): void => {
    this.onerror?.(error);
    void this.close();
  };

  private processBuffer(): void {
    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) {
        if (this.buffer.length > this.maxMessageBytes) {
          throw new Error(`MCP stdio message is too large (${this.buffer.length} bytes > ${this.maxMessageBytes} bytes)`);
        }
        return;
      }
      if (newlineIndex > this.maxMessageBytes) {
        throw new Error(`MCP stdio message is too large (${newlineIndex} bytes > ${this.maxMessageBytes} bytes)`);
      }
      const line = this.buffer.toString("utf8", 0, newlineIndex).replace(/\r$/, "");
      this.buffer = this.buffer.subarray(newlineIndex + 1);
      if (line.trim().length === 0) continue;
      let message: JSONRPCMessage;
      try {
        message = JSONRPCMessageSchema.parse(JSON.parse(line));
      } catch (error) {
        // A single malformed frame is recoverable: report it and keep
        // processing the rest of the buffer instead of tearing down the whole
        // session (which would also drop any valid pipelined messages after
        // it). This matches the SDK's StdioServerTransport. Only the oversize
        // guards above stay fatal.
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
        continue;
      }
      this.onmessage?.(message);
    }
  }
}
