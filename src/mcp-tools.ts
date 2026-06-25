import { BridgeStore, MAX_FETCHABLE_RESULT_ARTIFACT_BYTES, type ListReceiptsInput } from "./store.js";
import { readRepoFile, searchRepo } from "./repo.js";
import { applyRepoWriteDryRun, createRepoWriteDryRun, stageReviewedPaths } from "./repo-write.js";
import type { BridgeFile, SourceSchema } from "./schema.js";
import type { z } from "zod";

type BridgeSource = z.infer<typeof SourceSchema>;
type McpBridgeFileInput = { path: string; role?: BridgeFile["role"]; bytes?: number };

export const MAX_MCP_BRIDGE_TEXT_BYTES = MAX_FETCHABLE_RESULT_ARTIFACT_BYTES;
export const MAX_MCP_SHORT_TEXT_BYTES = 10_000;
const MAX_MCP_LIST_ITEMS = 100;

export interface McpToolContext {
  cwd: string;
  source?: BridgeSource;
  claimedBy?: string;
}

export function createMcpToolHandlers(context: McpToolContext) {
  const store = new BridgeStore(context.cwd);
  const source = context.source ?? "claude";
  const claimedBy = context.claimedBy ?? source;
  return {
    async bridge_create_task(input: {
      title: string;
      prompt: string;
      repo_id?: string;
      files?: McpBridgeFileInput[];
    }) {
      assertMcpTextField(input.title, "title", MAX_MCP_SHORT_TEXT_BYTES);
      assertMcpTextField(input.prompt, "prompt");
      assertMcpTextField(input.repo_id, "repo_id", MAX_MCP_SHORT_TEXT_BYTES);
      assertMcpFiles(input.files);
      const task = await store.createTask({
        source,
        title: input.title,
        prompt: input.prompt,
        repo_id: input.repo_id ?? "default",
        files: (input.files ?? []).map((file) => ({ ...file, role: file.role ?? "context" })),
        provenance: { adapter: "mcp", warnings: [] }
      });
      return { task };
    },

    async bridge_list_tasks(input: { status?: "new" | "claimed" | "done" | "blocked" }) {
      return { tasks: await store.listTasksReadOnly(input.status) };
    },

    async bridge_get_task(input: { task_id: string }) {
      assertMcpTextField(input.task_id, "task_id", MAX_MCP_SHORT_TEXT_BYTES);
      return { task: await store.getTaskReadOnly(input.task_id) };
    },

    async bridge_claim_task(input: { task_id: string; claimed_by?: string }) {
      assertMcpTextField(input.task_id, "task_id", MAX_MCP_SHORT_TEXT_BYTES);
      assertMcpTextField(input.claimed_by, "claimed_by", MAX_MCP_SHORT_TEXT_BYTES);
      return { task: await store.claimTask(input.task_id, input.claimed_by ?? claimedBy) };
    },

    async bridge_complete_task(input: { task_id: string; summary: string; artifacts?: McpBridgeFileInput[]; commands?: string[]; warnings?: string[] }) {
      assertMcpTextField(input.task_id, "task_id", MAX_MCP_SHORT_TEXT_BYTES);
      assertMcpTextField(input.summary, "summary");
      assertMcpFiles(input.artifacts);
      assertMcpStringList(input.commands, "commands");
      assertMcpStringList(input.warnings, "warnings");
      const result = await store.completeTask(input.task_id, {
        status: "done",
        summary: input.summary,
        artifacts: normalizeResultArtifacts(input.artifacts),
        commands: input.commands,
        warnings: input.warnings,
        provenance: { adapter: "mcp" }
      });
      return { result };
    },

    async bridge_block_task(input: {
      task_id: string;
      summary: string;
      code?: string;
      next_step?: string;
      retryable?: boolean;
      artifacts?: McpBridgeFileInput[];
      commands?: string[];
      warnings?: string[];
    }) {
      assertMcpTextField(input.task_id, "task_id", MAX_MCP_SHORT_TEXT_BYTES);
      assertMcpTextField(input.summary, "summary");
      assertMcpTextField(input.code, "code", MAX_MCP_SHORT_TEXT_BYTES);
      assertMcpTextField(input.next_step, "next_step");
      assertMcpFiles(input.artifacts);
      assertMcpStringList(input.commands, "commands");
      assertMcpStringList(input.warnings, "warnings");
      const result = await store.completeTask(input.task_id, {
        status: "blocked",
        summary: input.summary,
        artifacts: normalizeResultArtifacts(input.artifacts),
        commands: input.commands,
        warnings: input.warnings,
        blocker: {
          code: input.code ?? "manual_blocker",
          message: input.summary,
          retryable: input.retryable === true,
          next_step: input.next_step
        },
        provenance: { adapter: "mcp" }
      });
      return { result };
    },

    async bridge_list_results() {
      return { results: await store.listResultsReadOnly() };
    },

    async bridge_fetch_result(input: { task_id: string }) {
      assertMcpTextField(input.task_id, "task_id", MAX_MCP_SHORT_TEXT_BYTES);
      return { result: await store.getResultReadOnly(input.task_id) };
    },

    async bridge_fetch_result_artifact(input: { task_id: string; path?: string }) {
      assertMcpTextField(input.task_id, "task_id", MAX_MCP_SHORT_TEXT_BYTES);
      assertMcpTextField(input.path, "path", MAX_MCP_SHORT_TEXT_BYTES);
      return store.readResultArtifactText(input.task_id, input.path, { maxBytes: MAX_MCP_BRIDGE_TEXT_BYTES, readOnly: true });
    },

    async bridge_list_receipts(input: ListReceiptsInput) {
      assertMcpTextField(input.task_id, "task_id", MAX_MCP_SHORT_TEXT_BYTES);
      return { receipts: await store.listReceiptsReadOnly(input) };
    },

    async bridge_get_receipt(input: { receipt_id: string }) {
      assertMcpTextField(input.receipt_id, "receipt_id", MAX_MCP_SHORT_TEXT_BYTES);
      return { receipt: await store.getReceiptForDisplayReadOnly(input.receipt_id) };
    },

    async bridge_list_sessions(input: { status?: "preview" | "running" | "done" | "blocked" }) {
      return { sessions: await store.listSessionsReadOnly(input.status) };
    },

    async bridge_get_session(input: { session_id: string }) {
      assertMcpTextField(input.session_id, "session_id", MAX_MCP_SHORT_TEXT_BYTES);
      return { session: await store.getSessionReadOnly(input.session_id) };
    },

    async repo_read_file(input: { path: string; start_line?: number; max_lines?: number }) {
      assertMcpTextField(input.path, "path", MAX_MCP_SHORT_TEXT_BYTES);
      return readRepoFile(context.cwd, input.path, {
        startLine: input.start_line,
        maxLines: input.max_lines
      });
    },

    async repo_search(input: { query: string; glob?: string }) {
      assertMcpTextField(input.query, "query");
      assertMcpTextField(input.glob, "glob", MAX_MCP_SHORT_TEXT_BYTES);
      return { matches: await searchRepo(context.cwd, input.query, input.glob) };
    },

    async repo_write_file_dry_run(input: { path: string; content: string; expected_head: string }) {
      assertMcpTextField(input.path, "path", MAX_MCP_SHORT_TEXT_BYTES);
      assertMcpTextField(input.expected_head, "expected_head", MAX_MCP_SHORT_TEXT_BYTES);
      return createRepoWriteDryRun(context.cwd, store, input);
    },

    async repo_write_file_apply(input: { receipt_id: string; expected_head: string; preimage_sha256: string }) {
      assertMcpTextField(input.receipt_id, "receipt_id", MAX_MCP_SHORT_TEXT_BYTES);
      assertMcpTextField(input.expected_head, "expected_head", MAX_MCP_SHORT_TEXT_BYTES);
      assertMcpTextField(input.preimage_sha256, "preimage_sha256", MAX_MCP_SHORT_TEXT_BYTES);
      return applyRepoWriteDryRun(context.cwd, store, input);
    },

    async repo_stage_reviewed_paths(input: { receipt_ids: string[]; expected_head: string }) {
      assertMcpStringList(input.receipt_ids, "receipt_ids", MAX_MCP_SHORT_TEXT_BYTES);
      assertMcpTextField(input.expected_head, "expected_head", MAX_MCP_SHORT_TEXT_BYTES);
      return stageReviewedPaths(context.cwd, store, input);
    }
  };
}

export type McpToolHandlers = ReturnType<typeof createMcpToolHandlers>;

function normalizeResultArtifacts(files: McpBridgeFileInput[] | undefined): BridgeFile[] | undefined {
  return files?.map((file) => ({ ...file, role: "result" }));
}

function assertMcpTextField(value: string | undefined, label: string, maxBytes = MAX_MCP_BRIDGE_TEXT_BYTES): void {
  if (value === undefined) return;
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > maxBytes) {
    throw new Error(`MCP ${label} is too large (${bytes} bytes > ${maxBytes} bytes)`);
  }
}

function assertMcpStringList(values: string[] | undefined, label: string, maxBytes = MAX_MCP_BRIDGE_TEXT_BYTES): void {
  if (values === undefined) return;
  if (values.length > MAX_MCP_LIST_ITEMS) {
    throw new Error(`MCP ${label} has too many items (${values.length} > ${MAX_MCP_LIST_ITEMS})`);
  }
  for (const [index, value] of values.entries()) {
    assertMcpTextField(value, `${label}[${index}]`, maxBytes);
  }
}

function assertMcpFiles(files: McpBridgeFileInput[] | undefined): void {
  if (files === undefined) return;
  if (files.length > MAX_MCP_LIST_ITEMS) {
    throw new Error(`MCP files has too many items (${files.length} > ${MAX_MCP_LIST_ITEMS})`);
  }
  for (const [index, file] of files.entries()) {
    assertMcpTextField(file.path, `files[${index}].path`, MAX_MCP_SHORT_TEXT_BYTES);
  }
}
