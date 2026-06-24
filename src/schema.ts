import { z } from "zod";

export const SCHEMA_VERSION = 1;

export const AdapterSchema = z.enum(["cli", "mcp", "manual", "oracle", "chatgpt-control"]);
export const TaskStatusSchema = z.enum(["new", "claimed", "done", "blocked"]);
export const ResultStatusSchema = z.enum(["done", "blocked"]);
export const SourceSchema = z.enum(["chatgpt_project", "codex", "claude", "manual"]);
export const ReceiptKindSchema = z.enum([
  "task_created",
  "task_claimed",
  "task_completed",
  "consult_preview",
  "consult_answer_saved",
  "repo_write_dry_run",
  "repo_write_applied",
  "repo_stage_reviewed_paths"
]);

export const ProvenanceSchema = z.object({
  adapter: AdapterSchema,
  session_id: z.string().optional(),
  thread: z.string().optional(),
  project: z.string().optional(),
  warnings: z.array(z.string()).default([])
});

export const BridgeFileSchema = z.object({
  path: z.string(),
  role: z.enum(["context", "artifact", "result"]).default("context"),
  bytes: z.number().int().nonnegative().optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional()
});

export const BlockerSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean().default(false),
  next_step: z.string().optional()
});

export const TaskSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  id: z.string().regex(/^task_\d{8}_\d{6}_[a-z0-9-]+$/),
  source: SourceSchema,
  status: TaskStatusSchema,
  title: z.string().min(1),
  prompt: z.string().min(1),
  repo_id: z.string().min(1).default("default"),
  files: z.array(BridgeFileSchema).default([]),
  provenance: ProvenanceSchema,
  claimed_by: z.string().optional(),
  claimed_at: z.string().datetime().optional(),
  blocker: BlockerSchema.optional(),
  result_path: z.string().optional(),
  manifest_path: z.string().optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
});

export const ResultSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  task_id: z.string(),
  status: ResultStatusSchema,
  summary: z.string(),
  artifacts: z.array(BridgeFileSchema).default([]),
  commands: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
  blocker: BlockerSchema.optional(),
  created_at: z.string().datetime()
});

export const SessionSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  id: z.string().regex(/^sess_\d{8}_\d{6}_[a-z0-9-]+$/),
  direction: z.enum(["codex_to_chatgpt", "chatgpt_to_codex", "claude_to_codex"]),
  backend: AdapterSchema,
  project: z.string().optional(),
  thread: z.string().optional(),
  task_id: z.string().optional(),
  status: z.enum(["preview", "running", "done", "blocked"]).default("preview"),
  blocker: BlockerSchema.optional(),
  warnings: z.array(z.string()).default([]),
  created_at: z.string().datetime(),
  last_used_at: z.string().datetime()
});

export const ReceiptSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  id: z.string(),
  kind: ReceiptKindSchema,
  task_id: z.string().optional(),
  session_id: z.string().optional(),
  summary: z.string(),
  metadata: z.record(z.unknown()).default({}),
  created_at: z.string().datetime()
});

export type BridgeFile = z.infer<typeof BridgeFileSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type Result = z.infer<typeof ResultSchema>;
export type Session = z.infer<typeof SessionSchema>;
export type Receipt = z.infer<typeof ReceiptSchema>;
export type Provenance = z.infer<typeof ProvenanceSchema>;
export type Blocker = z.infer<typeof BlockerSchema>;

export function nowIso(): string {
  return new Date().toISOString();
}

export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "item";
}

export function makeBridgeId(prefix: "task" | "sess" | "receipt", title: string, date = new Date()): string {
  const stamp = date.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "_");
  return `${prefix}_${stamp}_${slugify(title)}`;
}
