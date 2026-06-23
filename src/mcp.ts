import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createMcpToolHandlers } from "./mcp-tools.js";
import { ReceiptKindSchema, type SourceSchema } from "./schema.js";
import type { z as zod } from "zod";

type BridgeSource = zod.infer<typeof SourceSchema>;

export interface CreateMcpServerOptions {
  source?: BridgeSource;
  claimedBy?: string;
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

export function createServer(cwd = process.cwd(), options: CreateMcpServerOptions = {}): McpServer {
  const server = new McpServer({ name: "gptprouse", version: "0.2.0" });
  const handlers = createMcpToolHandlers({ cwd, source: options.source, claimedBy: options.claimedBy });

  server.registerTool(
    "bridge_create_task",
    {
      description: "Create a durable task for Codex/local execution in .bridge/tasks.",
      inputSchema: {
        title: z.string().min(1),
        prompt: z.string().min(1),
        repo_id: z.string().optional(),
        files: z.array(z.object({ path: z.string(), role: z.enum(["context", "artifact", "result"]).optional(), bytes: z.number().optional() })).optional()
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
      inputSchema: { task_id: z.string() }
    },
    async (input) => asText(await handlers.bridge_get_task(input))
  );

  server.registerTool(
    "bridge_claim_task",
    {
      description: "Claim a new bridge task for execution.",
      inputSchema: { task_id: z.string(), claimed_by: z.string().optional() }
    },
    async (input) => asText(await handlers.bridge_claim_task(input))
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
      inputSchema: { task_id: z.string() }
    },
    async (input) => asText(await handlers.bridge_fetch_result(input))
  );

  server.registerTool(
    "bridge_fetch_result_artifact",
    {
      description: "Fetch text content for a result-listed artifact. Arbitrary .bridge artifacts are not exposed.",
      inputSchema: { task_id: z.string(), path: z.string().optional() }
    },
    async (input) => asText(await handlers.bridge_fetch_result_artifact(input))
  );

  server.registerTool(
    "bridge_list_receipts",
    {
      description: "List durable bridge receipts with legacy inline write payloads redacted.",
      inputSchema: { kind: ReceiptKindSchema.optional(), task_id: z.string().optional() }
    },
    async (input) => asText(await handlers.bridge_list_receipts(input))
  );

  server.registerTool(
    "bridge_get_receipt",
    {
      description: "Fetch one bridge receipt with legacy inline write payloads redacted.",
      inputSchema: { receipt_id: z.string() }
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
      inputSchema: { session_id: z.string() }
    },
    async (input) => asText(await handlers.bridge_get_session(input))
  );

  server.registerTool(
    "repo_read_file",
    {
      description: "Read a repo-relative text file with line bounds. Absolute paths and traversal are rejected.",
      inputSchema: {
        path: z.string(),
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
      inputSchema: { query: z.string().min(1), glob: z.string().optional() }
    },
    async (input) => asText(await handlers.repo_search(input))
  );

  server.registerTool(
    "repo_write_file_dry_run",
    {
      description: "Create a receipt-gated write preview for an existing repo-relative text file. Does not modify files.",
      inputSchema: {
        path: z.string(),
        content: z.string(),
        expected_head: z.string().min(1)
      }
    },
    async (input) => asText(await handlers.repo_write_file_dry_run(input))
  );

  server.registerTool(
    "repo_write_file_apply",
    {
      description: "Apply a prior write dry-run only when git HEAD and preimage hash match.",
      inputSchema: {
        receipt_id: z.string().min(1),
        expected_head: z.string().min(1),
        preimage_sha256: z.string().min(1)
      }
    },
    async (input) => asText(await handlers.repo_write_file_apply(input))
  );

  server.registerTool(
    "repo_stage_reviewed_paths",
    {
      description: "Stage paths only when backed by applied write receipts matching the current git HEAD and file content.",
      inputSchema: {
        receipt_ids: z.array(z.string().min(1)).min(1),
        expected_head: z.string().min(1)
      }
    },
    async (input) => asText(await handlers.repo_stage_reviewed_paths(input))
  );

  return server;
}

export async function runMcpServer(cwd = process.cwd()): Promise<void> {
  const server = createServer(cwd);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
