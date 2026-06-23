import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createMcpToolHandlers } from "./mcp-tools.js";
import type { SourceSchema } from "./schema.js";
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

  return server;
}

export async function runMcpServer(cwd = process.cwd()): Promise<void> {
  const server = createServer(cwd);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
