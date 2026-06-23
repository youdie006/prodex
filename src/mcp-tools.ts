import { BridgeStore, type ListReceiptsInput } from "./store.js";
import { readRepoFile, searchRepo } from "./repo.js";
import { applyRepoWriteDryRun, createRepoWriteDryRun, stageReviewedPaths } from "./repo-write.js";
import type { SourceSchema } from "./schema.js";
import type { z } from "zod";

type BridgeSource = z.infer<typeof SourceSchema>;

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
      files?: Array<{ path: string; role?: "context" | "artifact" | "result"; bytes?: number }>;
    }) {
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
      return { tasks: await store.listTasks(input.status) };
    },

    async bridge_get_task(input: { task_id: string }) {
      return { task: await store.getTask(input.task_id) };
    },

    async bridge_claim_task(input: { task_id: string; claimed_by?: string }) {
      return { task: await store.claimTask(input.task_id, input.claimed_by ?? claimedBy) };
    },

    async bridge_list_results() {
      return { results: await store.listResults() };
    },

    async bridge_fetch_result(input: { task_id: string }) {
      return { result: await store.getResult(input.task_id) };
    },

    async bridge_fetch_result_artifact(input: { task_id: string; path?: string }) {
      return store.readResultArtifactText(input.task_id, input.path);
    },

    async bridge_list_receipts(input: ListReceiptsInput) {
      return { receipts: await store.listReceipts(input) };
    },

    async bridge_get_receipt(input: { receipt_id: string }) {
      return { receipt: await store.getReceiptForDisplay(input.receipt_id) };
    },

    async bridge_list_sessions(input: { status?: "preview" | "running" | "done" | "blocked" }) {
      return { sessions: await store.listSessions(input.status) };
    },

    async bridge_get_session(input: { session_id: string }) {
      return { session: await store.getSession(input.session_id) };
    },

    async repo_read_file(input: { path: string; start_line?: number; max_lines?: number }) {
      return readRepoFile(context.cwd, input.path, {
        startLine: input.start_line,
        maxLines: input.max_lines
      });
    },

    async repo_search(input: { query: string; glob?: string }) {
      return { matches: await searchRepo(context.cwd, input.query, input.glob) };
    },

    async repo_write_file_dry_run(input: { path: string; content: string; expected_head: string }) {
      return createRepoWriteDryRun(context.cwd, store, input);
    },

    async repo_write_file_apply(input: { receipt_id: string; expected_head: string; preimage_sha256: string }) {
      return applyRepoWriteDryRun(context.cwd, store, input);
    },

    async repo_stage_reviewed_paths(input: { receipt_ids: string[]; expected_head: string }) {
      return stageReviewedPaths(context.cwd, store, input);
    }
  };
}

export type McpToolHandlers = ReturnType<typeof createMcpToolHandlers>;
