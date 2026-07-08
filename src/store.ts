import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { registerBridgeRoot } from "./registry.js";
import { constants, existsSync } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { assertRepoRelativePath } from "./repo.js";
import { readVerifiedUtf8File, writeVerifiedUtf8File } from "./safe-file.js";
import {
  type BridgeFile,
  type Blocker,
  makeBridgeId,
  nowIso,
  type Provenance,
  type Receipt,
  ReceiptSchema,
  type Result,
  ResultSchema,
  SCHEMA_VERSION,
  type Session,
  SessionSchema,
  type SourceSchema,
  type Task,
  TaskSchema
} from "./schema.js";
import type { z } from "zod";

type Source = z.infer<typeof SourceSchema>;
type BridgeStorageKind = "tasks" | "results" | "sessions" | "artifacts" | "receipts";
type BridgeRecordKind = Exclude<BridgeStorageKind, "artifacts">;

export type BridgeStoreTestHooks = {
  beforeRecordTempCleanup?: (kind: BridgeRecordKind, filePath: string) => Promise<void> | void;
  beforeRecordRename?: (kind: BridgeRecordKind, filePath: string) => Promise<void> | void;
  // Fires after the integrity-key read misses (ENOENT) but before this store
  // writes its own key, so a test can simulate another process winning the
  // create race in that exact window.
  afterReceiptKeyReadMiss?: () => Promise<void> | void;
  disableDirectoryFdPaths?: boolean;
};

let storeTestHooks: BridgeStoreTestHooks = {};

export function setBridgeStoreTestHooks(hooks: BridgeStoreTestHooks): void {
  storeTestHooks = hooks;
}

const TASK_ID_PATTERN = /^task_\d{8}_\d{6}_[a-z0-9-]+$/;
const SESSION_ID_PATTERN = /^sess_\d{8}_\d{6}_[a-z0-9-]+$/;
const RECEIPT_ID_PATTERN = /^receipt_\d{8}_\d{6}_[a-z0-9-]+$/;
const BRIDGE_DIRECTORY_MODE = 0o700;
const BRIDGE_FILE_MODE = 0o600;
// A claim is a sub-second read-modify-write; a claim lock older than this
// belongs to a crashed holder, not a live claimer, so it can be reaped.
const CLAIM_LOCK_STALE_MS = 60_000;
const RECEIPT_INTEGRITY_KEY_BYTES = 32;

async function claimLockIsStale(lockPath: string): Promise<boolean> {
  try {
    const info = await stat(lockPath);
    return Date.now() - info.mtimeMs > CLAIM_LOCK_STALE_MS;
  } catch (error) {
    // Vanished between the EEXIST and the stat (the holder just released it):
    // treat as free so the retry can grab it.
    if (isErrorCode(error, "ENOENT")) return true;
    throw error;
  }
}
const FETCHABLE_RESULT_ARTIFACT_PREFIXES = [".bridge/artifacts/pro-consults/", ".bridge/artifacts/results/"];
export const MAX_FETCHABLE_RESULT_ARTIFACT_BYTES = 100_000;
const MAX_BRIDGE_ARTIFACT_READ_BYTES = 1_000_000;

type ReceiptIntegrityInspectionStatus = {
  trusted: false;
  reason: string;
};

export interface CreateTaskInput {
  source: Source;
  title: string;
  prompt: string;
  repo_id?: string;
  files?: BridgeFile[];
  provenance: Provenance;
}

export interface CompleteTaskInput {
  status: "done" | "blocked";
  summary: string;
  artifacts?: BridgeFile[];
  commands?: string[];
  warnings?: string[];
  blocker?: Blocker;
  provenance?: Partial<Provenance>;
}

export type WriteReceiptInput = Omit<Receipt, "schema_version" | "id" | "created_at" | "metadata" | "integrity"> & {
  metadata?: Record<string, unknown>;
};

export interface WriteSessionInput {
  id?: string;
  direction: Session["direction"];
  backend: Session["backend"];
  project?: string;
  thread?: string;
  task_id?: string;
  status?: Session["status"];
  blocker?: Blocker;
  warnings?: string[];
}

export interface ListReceiptsInput {
  kind?: Receipt["kind"];
  task_id?: string;
}

export interface ResealResultOutput {
  result: Result;
  receipt: Receipt;
}

export class BridgeStore {
  readonly root: string;
  readonly bridgeDir: string;

  constructor(root = process.cwd()) {
    this.root = root;
    this.bridgeDir = path.join(root, ".bridge");
  }

  async ensure(): Promise<void> {
    await ensurePrivateDirectory(this.bridgeDir, "Bridge directory");
    await Promise.all([
      ensurePrivateDirectory(this.dir("tasks"), "Bridge storage directory .bridge/tasks"),
      ensurePrivateDirectory(this.dir("results"), "Bridge storage directory .bridge/results"),
      ensurePrivateDirectory(this.dir("sessions"), "Bridge storage directory .bridge/sessions"),
      ensurePrivateDirectory(this.dir("artifacts"), "Bridge storage directory .bridge/artifacts"),
      ensurePrivateDirectory(this.dir("receipts"), "Bridge storage directory .bridge/receipts")
    ]);
    await this.assertStorageDirsAreRealDirectories();
    await this.ensureBridgeGitignore();
    await this.ensureReceiptIntegrityKey();
    // Advisory: let local indexers (sessionwiki's prodex adapter) find this
    // bridge. Best-effort inside - a registry failure never breaks the bridge.
    await registerBridgeRoot(this.root);
  }

  dir(kind: BridgeStorageKind): string {
    return path.join(this.bridgeDir, kind);
  }

  private receiptIntegrityKeyPath(): string {
    return path.join(this.bridgeDir, "receipt-key.local");
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    await this.ensure();
    const timestamp = nowIso();
    const taskFiles = validateTaskFiles(input.files ?? []);
    const task: Task = await this.createWithUniqueId("task", input.title, "tasks", (id) =>
      TaskSchema.parse({
        schema_version: SCHEMA_VERSION,
        id,
        source: input.source,
        status: "new",
        title: input.title,
        prompt: input.prompt,
        repo_id: input.repo_id ?? "default",
        files: taskFiles,
        provenance: input.provenance,
        created_at: timestamp,
        updated_at: timestamp
      })
    );
    try {
      await this.writeReceipt({
        kind: "task_created",
        task_id: task.id,
        summary: `Created task ${task.id}`
      });
    } catch (error) {
      try {
        await this.deleteRecordIfPresent("tasks", task.id);
      } catch (cleanupError) {
        throw new Error(`${errorMessage(error)} (also failed to clean up task record: ${errorMessage(cleanupError)})`);
      }
      throw error;
    }
    return task;
  }

  async listTasks(status?: Task["status"]): Promise<Task[]> {
    await this.ensure();
    const tasks = await this.readAll("tasks", parseTaskRecord);
    return tasks
      .filter((task) => (status ? task.status === status : true))
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  }

  async listTasksReadOnly(status?: Task["status"]): Promise<Task[]> {
    if (!(await this.hasReadyStorageDirReadOnly("tasks"))) return [];
    const tasks = await this.readAll("tasks", parseTaskRecord, { cleanupTempHardLinks: false });
    return tasks
      .filter((task) => (status ? task.status === status : true))
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  }

  async getTask(taskId: string): Promise<Task> {
    return this.parseRecord("tasks", taskId, await this.readRecordJson("tasks", taskId), parseTaskRecord);
  }

  async getTaskReadOnly(taskId: string): Promise<Task> {
    return this.parseRecord("tasks", taskId, await this.readRecordJson("tasks", taskId, { cleanupTempHardLinks: false }), parseTaskRecord);
  }

  async claimTask(taskId: string, claimedBy: string): Promise<Task> {
    // Claiming is check-then-write, so two agents that both read "new" would
    // otherwise both write "claimed" (a silent double-claim). Serialize the
    // whole read-modify-write behind an O_EXCL lock file so exactly one claim
    // wins; a concurrent claimer sees the lock (or the already-claimed status
    // after it releases) and is rejected.
    const lockPath = path.join(this.dir("tasks"), `.${taskId}.claim.lock`);
    let lockHandle: FileHandle;
    try {
      lockHandle = await open(lockPath, "wx", BRIDGE_FILE_MODE);
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) throw error;
      // A claim is a fast read-modify-write, so a lock older than the staleness
      // window belongs to a crashed holder (killed before its finally removed
      // it), not a live claimer - otherwise it would wedge this task's claims
      // forever. Reap the stale lock and retry the exclusive create once.
      if (!(await claimLockIsStale(lockPath))) {
        throw new Error(`Task ${taskId} is already being claimed by another process`);
      }
      await rm(lockPath, { force: true }).catch(() => undefined);
      try {
        lockHandle = await open(lockPath, "wx", BRIDGE_FILE_MODE);
      } catch (retryError) {
        if (isErrorCode(retryError, "EEXIST")) {
          throw new Error(`Task ${taskId} is already being claimed by another process`);
        }
        throw retryError;
      }
    }
    try {
      const task = await this.getTask(taskId);
      if (task.status !== "new") {
        throw new Error(`Task ${taskId} is ${task.status}, not new`);
      }
      return await this.writeClaimedTask(taskId, task, claimedBy);
    } finally {
      await lockHandle.close().catch(() => undefined);
      await rm(lockPath, { force: true }).catch(() => undefined);
    }
  }

  private async writeClaimedTask(taskId: string, task: Task, claimedBy: string): Promise<Task> {
    const updated = TaskSchema.parse({
      ...task,
      status: "claimed",
      claimed_by: claimedBy,
      claimed_at: nowIso(),
      updated_at: nowIso()
    });
    await this.writeRecordJson("tasks", taskId, updated);
    try {
      await this.writeReceipt({
        kind: "task_claimed",
        task_id: taskId,
        summary: `Claimed task ${taskId} by ${claimedBy}`
      });
    } catch (error) {
      try {
        await this.writeRecordJson("tasks", taskId, task);
      } catch (cleanupError) {
        throw new Error(`${errorMessage(error)} (also failed to restore task claim state: ${errorMessage(cleanupError)})`);
      }
      throw error;
    }
    return updated;
  }

  async completeTask(taskId: string, input: CompleteTaskInput): Promise<Result> {
    const task = await this.getTask(taskId);
    assertFetchableResultArtifacts(input.artifacts ?? []);
    const retryResult: Result = ResultSchema.parse({
      schema_version: SCHEMA_VERSION,
      task_id: taskId,
      status: input.status,
      summary: input.summary,
      artifacts: input.artifacts ?? [],
      commands: input.commands ?? [],
      warnings: input.warnings ?? [],
      blocker: input.blocker,
      created_at: nowIso()
    });
    if (task.status === "done" || task.status === "blocked") {
      const existingResult = await this.getResult(taskId).catch((error) => {
        if (isErrorCode(error, "ENOENT")) throw terminalTaskMissingResultError(task);
        throw error;
      });
      if (await this.hasTrustedTaskCompletionReceipt(taskId, existingResult)) {
        throw new Error(`Task ${taskId} is already ${task.status} and cannot be finalized again`);
      }
      assertResultMatchesRetry(taskId, existingResult, retryResult);
      await this.assertResultArtifactsUnchanged(existingResult);
      await this.writeTaskCompletionReceipt(taskId, existingResult);
      return existingResult;
    }
    const existingResult = await this.getResult(taskId).catch((error) => {
      if (isErrorCode(error, "ENOENT")) return undefined;
      throw error;
    });
    if (existingResult) {
      assertResultMatchesRetry(taskId, existingResult, retryResult);
      await this.assertResultArtifactsUnchanged(existingResult);
      const updated = TaskSchema.parse({
        ...task,
        status: existingResult.status,
        provenance: input.provenance ? { ...task.provenance, ...input.provenance } : task.provenance,
        blocker: existingResult.blocker,
        result_path: `.bridge/results/${taskId}.json`,
        updated_at: nowIso()
      });
      await this.writeRecordJson("tasks", taskId, updated);
      await this.writeTaskCompletionReceiptOrRestoreTask(taskId, existingResult, task);
      return existingResult;
    }
    const artifacts = await this.withResultArtifactHashes(input.artifacts ?? []);
    const result: Result = ResultSchema.parse({
      ...retryResult,
      artifacts
    });
    const wroteResult = await this.writeNewRecordJson("results", taskId, result);
    const finalResult = wroteResult ? result : await this.getResult(taskId);
    if (!wroteResult) {
      assertResultMatchesRetry(taskId, finalResult, retryResult);
    }
    await this.assertResultArtifactsUnchanged(finalResult);
    const updated = TaskSchema.parse({
      ...task,
      status: finalResult.status,
      provenance: input.provenance ? { ...task.provenance, ...input.provenance } : task.provenance,
      blocker: finalResult.blocker,
      result_path: `.bridge/results/${taskId}.json`,
      updated_at: nowIso()
    });
    await this.writeRecordJson("tasks", taskId, updated);
    await this.writeTaskCompletionReceiptOrRestoreTask(taskId, finalResult, task);
    return finalResult;
  }

  async listResults(): Promise<Result[]> {
    await this.ensure();
    return (await this.readAll("results", parseResultRecord)).sort(
      (a, b) => a.created_at.localeCompare(b.created_at) || a.task_id.localeCompare(b.task_id)
    );
  }

  async listResultsReadOnly(): Promise<Result[]> {
    if (!(await this.hasReadyStorageDirReadOnly("results"))) return [];
    return (await this.readAll("results", parseResultRecord, { cleanupTempHardLinks: false })).sort(
      (a, b) => a.created_at.localeCompare(b.created_at) || a.task_id.localeCompare(b.task_id)
    );
  }

  async listFinalizedResultsReadOnly(): Promise<Result[]> {
    const results = await this.listResultsReadOnly();
    if (results.length === 0) return results;
    if (!(await this.hasReadyStorageDirReadOnly("receipts"))) {
      throw untrustedResultError(this.root, results[0].task_id, "has no trusted task_completed receipt");
    }
    // Read receipts ONCE and index them by task_id instead of re-reading and
    // re-parsing the whole receipts directory for every result, which was
    // O(results x receipts) on the completion/list hot path.
    const completionReceiptsByTask = new Map<string, Receipt[]>();
    for (const receipt of await this.readAll("receipts", parseReceiptRecord, { cleanupTempHardLinks: false })) {
      if (receipt.kind !== "task_completed" || !receipt.task_id) continue;
      const existing = completionReceiptsByTask.get(receipt.task_id);
      if (existing) existing.push(receipt);
      else completionReceiptsByTask.set(receipt.task_id, [receipt]);
    }
    for (const result of results) {
      await this.assertReceiptsTrustCompletion(result.task_id, result, completionReceiptsByTask.get(result.task_id) ?? []);
    }
    return results;
  }

  async getResult(taskId: string): Promise<Result> {
    return this.parseRecord("results", taskId, await this.readRecordJson("results", taskId), parseResultRecord);
  }

  async getResultReadOnly(taskId: string): Promise<Result> {
    return this.parseRecord("results", taskId, await this.readRecordJson("results", taskId, { cleanupTempHardLinks: false }), parseResultRecord);
  }

  async getFinalizedResultReadOnly(taskId: string): Promise<Result> {
    const result = await this.getResultReadOnly(taskId);
    await this.assertTrustedTaskCompletionReceiptReadOnly(taskId, result);
    return result;
  }

  async resealResult(taskId: string): Promise<ResealResultOutput> {
    const task = await this.getTask(taskId);
    if (task.status !== "done" && task.status !== "blocked") {
      throw new Error(`Task ${taskId} is ${task.status}, not done or blocked`);
    }
    const result = await this.getResult(taskId);
    if (result.status !== task.status) {
      throw new Error(`Result ${taskId} status ${result.status} does not match task status ${task.status}`);
    }
    await this.assertResultArtifactsUnchanged(result);
    if (await this.hasTrustedTaskCompletionReceipt(taskId, result)) {
      throw new Error(`Result ${taskId} already has a trusted task_completed receipt`);
    }
    await this.assertHasTrustedLegacyCompletionReceiptForReseal(taskId, result);
    return {
      result,
      receipt: await this.writeTaskCompletionReceipt(taskId, result)
    };
  }

  async readFinalizedResultArtifactText(
    taskId: string,
    artifactPath?: string,
    options: { maxBytes?: number } = {}
  ): Promise<{ artifact: BridgeFile; content: string }> {
    return this.readResultArtifactText(taskId, artifactPath, { ...options, readOnly: true });
  }

  async readResultArtifactText(
    taskId: string,
    artifactPath?: string,
    options: { maxBytes?: number; readOnly?: boolean } = {}
  ): Promise<{ artifact: BridgeFile; content: string }> {
    const result = options.readOnly ? await this.getResultReadOnly(taskId) : await this.getResult(taskId);
    if (options.readOnly) {
      await this.assertTrustedTaskCompletionReceiptReadOnly(taskId, result);
    }
    const artifacts = result.artifacts.filter((artifact) => artifact.role === "result");
    const artifact = artifactPath ? artifacts.find((item) => item.path === artifactPath) : artifacts.length === 1 ? artifacts[0] : undefined;
    if (!artifact) {
      if (artifactPath) throw new Error(`Result artifact not found for ${taskId}: ${artifactPath}`);
      if (artifacts.length === 0) throw new Error(`Result ${taskId} has no result artifacts`);
      throw new Error(`Result ${taskId} has multiple result artifacts; pass one artifact path: ${artifacts.map((item) => item.path).join(", ")}`);
    }
    const normalizedArtifactPath = path.posix.normalize(artifact.path.replaceAll("\\", "/"));
    if (!isFetchableResultArtifactPath(normalizedArtifactPath) || normalizedArtifactPath !== artifact.path) {
      throw new Error(`Artifact is not a fetchable result artifact for ${taskId}: ${artifact.path}`);
    }
    const content = await this.readArtifactText(artifact.path, options);
    if (artifact.sha256 && sha256(content) !== artifact.sha256) {
      throw new Error(`Result artifact changed after finalization for ${taskId}: ${artifact.path} sha256 mismatch`);
    }
    return { artifact, content };
  }

  private async withResultArtifactHashes(artifacts: BridgeFile[]): Promise<BridgeFile[]> {
    const withHashes: BridgeFile[] = [];
    for (const artifact of artifacts) {
      if (artifact.role !== "result") {
        withHashes.push(artifact);
        continue;
      }
      const content = await this.readArtifactText(artifact.path);
      const bytes = Buffer.byteLength(content, "utf8");
      if (bytes > MAX_FETCHABLE_RESULT_ARTIFACT_BYTES) {
        throw new Error(
          `Result artifact is too large to fetch (${bytes} bytes > ${MAX_FETCHABLE_RESULT_ARTIFACT_BYTES} bytes): ${artifact.path}`
        );
      }
      withHashes.push({ ...artifact, bytes, sha256: sha256(content) });
    }
    return withHashes;
  }

  private async assertResultArtifactsUnchanged(result: Result): Promise<void> {
    for (const artifact of result.artifacts) {
      if (artifact.role !== "result" || !artifact.sha256) continue;
      const normalizedArtifactPath = path.posix.normalize(artifact.path.replaceAll("\\", "/"));
      if (!isFetchableResultArtifactPath(normalizedArtifactPath) || normalizedArtifactPath !== artifact.path) {
        throw new Error(`Artifact is not a fetchable result artifact for ${result.task_id}: ${artifact.path}`);
      }
      let content: string;
      try {
        content = await this.readArtifactText(artifact.path);
      } catch (error) {
        throw new Error(`Result artifact changed after finalization for ${result.task_id}: ${artifact.path} ${errorMessage(error)}`);
      }
      if (sha256(content) !== artifact.sha256) {
        throw new Error(`Result artifact changed after finalization for ${result.task_id}: ${artifact.path} sha256 mismatch`);
      }
    }
  }

  async writeSession(input: WriteSessionInput): Promise<Session> {
    await this.ensure();
    const timestamp = nowIso();
    if (input.id === undefined) {
      return this.createWithUniqueId("sess", input.task_id ?? input.direction, "sessions", (id) =>
        SessionSchema.parse({
          schema_version: SCHEMA_VERSION,
          id,
          direction: input.direction,
          backend: input.backend,
          project: input.project,
          thread: input.thread,
          task_id: input.task_id,
          status: input.status ?? "preview",
          blocker: input.blocker,
          warnings: input.warnings ?? [],
          created_at: timestamp,
          last_used_at: timestamp
        })
      );
    }
    const existing = await this.getSession(input.id).catch(() => undefined);
    const session = SessionSchema.parse({
      schema_version: SCHEMA_VERSION,
      id: input.id,
      direction: input.direction,
      backend: input.backend,
      project: input.project,
      thread: input.thread,
      task_id: input.task_id,
      status: input.status ?? "preview",
      blocker: input.blocker,
      warnings: input.warnings ?? [],
      created_at: existing?.created_at ?? timestamp,
      last_used_at: timestamp
    });
    await this.writeRecordJson("sessions", input.id, session);
    return session;
  }

  async getSession(sessionId: string): Promise<Session> {
    return this.parseRecord("sessions", sessionId, await this.readRecordJson("sessions", sessionId), parseSessionRecord);
  }

  // Mark an existing session as blocked - used to clear a session left in
  // "running"/"preview" by an interrupted send. Preserves the session's other
  // fields; throws if the session does not exist.
  async cancelSession(sessionId: string): Promise<Session> {
    const existing = await this.getSession(sessionId);
    return this.writeSession({
      id: existing.id,
      direction: existing.direction,
      backend: existing.backend,
      project: existing.project,
      thread: existing.thread,
      task_id: existing.task_id,
      status: "blocked",
      blocker: { code: "cancelled", message: "Session cancelled via CLI.", retryable: false },
      warnings: existing.warnings
    });
  }

  async getSessionReadOnly(sessionId: string): Promise<Session> {
    return this.parseRecord("sessions", sessionId, await this.readRecordJson("sessions", sessionId, { cleanupTempHardLinks: false }), parseSessionRecord);
  }

  async listSessions(status?: Session["status"]): Promise<Session[]> {
    await this.ensure();
    const sessions = await this.readAll("sessions", parseSessionRecord);
    return sessions
      .filter((session) => (status ? session.status === status : true))
      .sort((a, b) => b.last_used_at.localeCompare(a.last_used_at) || b.id.localeCompare(a.id));
  }

  async listSessionsReadOnly(status?: Session["status"]): Promise<Session[]> {
    if (!(await this.hasReadyStorageDirReadOnly("sessions"))) return [];
    const sessions = await this.readAll("sessions", parseSessionRecord, { cleanupTempHardLinks: false });
    return sessions
      .filter((session) => (status ? session.status === status : true))
      .sort((a, b) => b.last_used_at.localeCompare(a.last_used_at) || b.id.localeCompare(a.id));
  }

  async getReceipt(receiptId: string): Promise<Receipt> {
    return this.parseRecord("receipts", receiptId, await this.readRecordJson("receipts", receiptId), parseReceiptRecord);
  }

  async getTrustedReceipt(receiptId: string): Promise<Receipt> {
    const receipt = await this.getReceipt(receiptId);
    await this.assertReceiptIntegrity(receipt);
    return receipt;
  }

  async deleteReceiptIfPresent(receiptId: string): Promise<void> {
    await this.ensure();
    await this.deleteRecordIfPresent("receipts", receiptId);
  }

  async getReceiptReadOnly(receiptId: string): Promise<Receipt> {
    return this.parseRecord("receipts", receiptId, await this.readRecordJson("receipts", receiptId, { cleanupTempHardLinks: false }), parseReceiptRecord);
  }

  async listReceipts(input: ListReceiptsInput = {}): Promise<Receipt[]> {
    await this.ensure();
    const receipts = (await this.readAll("receipts", parseReceiptRecord))
      .filter((receipt) => (input.kind ? receipt.kind === input.kind : true))
      .filter((receipt) => (input.task_id ? receipt.task_id === input.task_id : true))
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
    return Promise.all(receipts.map((receipt) => this.redactReceiptForDisplay(receipt)));
  }

  async listReceiptsReadOnly(input: ListReceiptsInput = {}): Promise<Receipt[]> {
    if (!(await this.hasReadyStorageDirReadOnly("receipts"))) return [];
    const receipts = (await this.readAll("receipts", parseReceiptRecord, { cleanupTempHardLinks: false }))
      .filter((receipt) => (input.kind ? receipt.kind === input.kind : true))
      .filter((receipt) => (input.task_id ? receipt.task_id === input.task_id : true))
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
    return Promise.all(receipts.map((receipt) => this.redactReceiptForDisplay(receipt)));
  }

  async getReceiptForDisplay(receiptId: string): Promise<Receipt> {
    return this.redactReceiptForDisplay(await this.getReceipt(receiptId));
  }

  async getReceiptForDisplayReadOnly(receiptId: string): Promise<Receipt> {
    return this.redactReceiptForDisplay(await this.getReceiptReadOnly(receiptId));
  }

  private async hasTrustedTaskCompletionReceipt(taskId: string, result: Result): Promise<boolean> {
    const receipts = (await this.readAll("receipts", parseReceiptRecord)).filter(
      (receipt) => receipt.kind === "task_completed" && receipt.task_id === taskId
    );
    for (const receipt of receipts) {
      try {
        await this.assertReceiptIntegrity(receipt, {
          remediation: "Task completion receipts must be generated by this local bridge"
        });
        assertReceiptResultDigest(receipt, result);
        return true;
      } catch {
        continue;
      }
    }
    return false;
  }

  private async assertTrustedTaskCompletionReceiptReadOnly(taskId: string, result: Result): Promise<void> {
    if (!(await this.hasReadyStorageDirReadOnly("receipts"))) {
      throw untrustedResultError(this.root, taskId, "has no trusted task_completed receipt");
    }
    const receipts = (await this.readAll("receipts", parseReceiptRecord, { cleanupTempHardLinks: false })).filter(
      (receipt) => receipt.kind === "task_completed" && receipt.task_id === taskId
    );
    await this.assertReceiptsTrustCompletion(taskId, result, receipts);
  }

  // Given the already-loaded task_completed receipts for one task, accept if any
  // one is locally trusted and its result digest matches; otherwise throw.
  private async assertReceiptsTrustCompletion(taskId: string, result: Result, receipts: Receipt[]): Promise<void> {
    if (receipts.length === 0) {
      throw untrustedResultError(this.root, taskId, "has no trusted task_completed receipt");
    }
    const failures: string[] = [];
    for (const receipt of receipts) {
      try {
        await this.assertReceiptIntegrity(receipt, {
          remediation: "Task completion receipts must be generated by this local bridge"
        });
        assertReceiptResultDigest(receipt, result);
        return;
      } catch (error) {
        failures.push(errorMessage(error));
      }
    }
    throw untrustedResultError(this.root, taskId, `has an untrusted task_completed receipt: ${failures[0] ?? "local integrity unavailable"}`);
  }

  private async writeTaskCompletionReceipt(taskId: string, result: Result): Promise<Receipt> {
    return this.writeReceipt({
      kind: "task_completed",
      task_id: taskId,
      summary: `${result.status === "done" ? "Completed" : "Blocked"} task ${taskId}`,
      metadata: {
        result_sha256: resultDigest(result)
      }
    });
  }

  private async writeTaskCompletionReceiptOrRestoreTask(taskId: string, result: Result, previousTask: Task): Promise<void> {
    try {
      await this.writeTaskCompletionReceipt(taskId, result);
    } catch (error) {
      try {
        await this.writeRecordJson("tasks", taskId, previousTask);
      } catch (cleanupError) {
        throw new Error(`${errorMessage(error)} (also failed to restore task completion state: ${errorMessage(cleanupError)})`);
      }
      throw error;
    }
  }

  private async assertHasTrustedLegacyCompletionReceiptForReseal(taskId: string, result: Result): Promise<void> {
    const receipts = (await this.readAll("receipts", parseReceiptRecord))
      .filter((receipt) => receipt.kind === "task_completed" && receipt.task_id === taskId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
    if (receipts.length === 0) {
      throw untrustedResultError(this.root, taskId, "has no trusted task_completed receipt to reseal");
    }
    const failures: string[] = [];
    const legacyReceiptIds: string[] = [];
    for (const receipt of receipts) {
      try {
        await this.assertReceiptIntegrity(receipt, {
          remediation: "Only locally signed legacy task_completed receipts can be resealed"
        });
        assertLegacyCompletionReceiptCanBeResealed(receipt, result);
        legacyReceiptIds.push(receipt.id);
      } catch (error) {
        failures.push(errorMessage(error));
      }
    }
    if (legacyReceiptIds.length === 1) return;
    if (legacyReceiptIds.length > 1) {
      throw untrustedResultError(
        this.root,
        taskId,
        `has multiple locally signed legacy task_completed receipts to reseal (${legacyReceiptIds.join(", ")}); move extras aside, then retry`
      );
    }
    throw untrustedResultError(
      this.root,
      taskId,
      `has no locally trusted legacy task_completed receipt to reseal: ${failures[0] ?? "local integrity unavailable"}`
    );
  }

  async writeArtifactText(relativePath: string, content: string): Promise<string> {
    await this.ensure();
    await this.assertBridgeDirIsRealDirectory();
    await this.assertArtifactsDirIsRealDirectory();
    const artifactPath = this.resolveArtifactPath(relativePath);
    await this.ensureArtifactParentDirectory(path.dirname(artifactPath));
    await writeVerifiedUtf8File(
      artifactPath,
      content,
      async () => {
        await this.assertArtifactParentDirectory(path.dirname(artifactPath));
        await this.assertArtifactTargetInsideIfExists(artifactPath);
      },
      { create: true, mode: BRIDGE_FILE_MODE }
    );
    return this.relativeToRoot(artifactPath);
  }

  async hasArtifactText(relativePath: string): Promise<boolean> {
    const artifactPath = this.resolveArtifactPath(relativePath);
    try {
      await this.assertBridgeDirIsRealDirectory();
      await this.assertArtifactsDirIsRealDirectory();
      await this.assertArtifactParentDirectory(path.dirname(artifactPath));
      await this.assertArtifactTargetInside(artifactPath);
      return true;
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return false;
      throw error;
    }
  }

  async deleteArtifactTextIfPresent(relativePath: string): Promise<void> {
    await this.assertBridgeDirIsRealDirectory();
    await this.assertArtifactsDirIsRealDirectory();
    const artifactPath = this.resolveArtifactPath(relativePath);
    const parentPath = path.dirname(artifactPath);
    await this.assertArtifactParentDirectory(parentPath);
    const parentHandle = await openNoFollowDirectory(parentPath, "Artifact directory");
    try {
      const targetPath = path.join(directoryFdPath(parentHandle.fd), path.basename(artifactPath));
      let stat;
      try {
        stat = await lstat(targetPath);
      } catch (error) {
        if (isErrorCode(error, "ENOENT")) return;
        throw error;
      }
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error("Artifact path must be a regular file and must not be a symlink");
      }
      await rm(targetPath, { force: true });
      await this.assertArtifactParentDirectory(parentPath);
    } finally {
      await parentHandle.close();
    }
  }

  async readArtifactText(relativePath: string, options: { maxBytes?: number } = {}): Promise<string> {
    await this.assertBridgeDirIsRealDirectory();
    await this.assertArtifactsDirIsRealDirectory();
    const artifactPath = this.resolveArtifactPath(relativePath);
    await this.assertArtifactParentDirectory(path.dirname(artifactPath));
    return readVerifiedUtf8File(artifactPath, () => this.assertArtifactTargetInside(artifactPath), {
      maxBytes: options.maxBytes ?? MAX_BRIDGE_ARTIFACT_READ_BYTES
    });
  }

  async writeReceipt(input: WriteReceiptInput): Promise<Receipt> {
    await this.ensure();
    return this.createWithUniqueId("receipt", input.kind, "receipts", async (id) => {
      const unsigned = ReceiptSchema.parse({
        schema_version: SCHEMA_VERSION,
        id,
        created_at: nowIso(),
        ...input
      });
      return ReceiptSchema.parse({
        ...unsigned,
        integrity: {
          algorithm: "hmac-sha256",
          digest: await this.receiptDigest(unsigned)
        }
      });
    });
  }

  private async assertReceiptIntegrity(
    receipt: Receipt,
    options: { remediation?: string } = {
      remediation: "Recreate the write dry-run before applying or staging."
    }
  ): Promise<void> {
    const remediation = options.remediation ?? "Recreate the write dry-run before applying or staging.";
    if (receipt.integrity?.algorithm !== "hmac-sha256") {
      throw new Error(`Receipt ${receipt.id} is missing local integrity seal. ${remediation}`);
    }
    if (!(await this.receiptDigestMatches(receipt))) {
      throw new Error(`Receipt ${receipt.id} failed local integrity verification. ${remediation}`);
    }
  }

  private async redactReceiptForDisplay(receipt: Receipt): Promise<Receipt> {
    return redactReceiptForDisplay(receipt, await this.receiptIntegrityInspectionStatus(receipt));
  }

  private async receiptIntegrityInspectionStatus(receipt: Receipt): Promise<ReceiptIntegrityInspectionStatus | undefined> {
    if (receipt.integrity?.algorithm !== "hmac-sha256") {
      return { trusted: false, reason: "missing local integrity seal" };
    }
    try {
      if (!(await this.receiptDigestMatches(receipt))) {
        return { trusted: false, reason: "local integrity verification failed" };
      }
      return undefined;
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) {
        return { trusted: false, reason: "missing local integrity key" };
      }
      return { trusted: false, reason: `local integrity unavailable: ${errorMessage(error)}` };
    }
  }

  // New receipts are always signed with the first (active) key.
  private async receiptDigest(receipt: Receipt): Promise<string> {
    const [activeKey] = await this.readReceiptIntegrityKeys();
    return receiptDigestWithKey(receipt, activeKey);
  }

  // Verification accepts any key in the file so receipts signed before a
  // rotation stay trusted.
  private async receiptDigestMatches(receipt: Receipt): Promise<boolean> {
    if (receipt.integrity?.algorithm !== "hmac-sha256") return false;
    const digest = receipt.integrity.digest;
    for (const key of await this.readReceiptIntegrityKeys()) {
      if (safeHexEqual(digest, receiptDigestWithKey(receipt, key))) return true;
    }
    return false;
  }

  // Prepend a freshly generated key; existing keys stay for verification only.
  async rotateReceiptIntegrityKey(): Promise<{ keys: number }> {
    await this.ensureReceiptIntegrityKey();
    const existing = await this.readReceiptIntegrityKeys();
    const keys = [randomBytes(RECEIPT_INTEGRITY_KEY_BYTES).toString("hex"), ...existing];
    await writeVerifiedUtf8File(this.receiptIntegrityKeyPath(), `${keys.join("\n")}\n`, () => this.assertReceiptIntegrityKeyTargetSafe(), {
      create: true,
      mode: BRIDGE_FILE_MODE
    });
    return { keys: keys.length };
  }

  private async ensureReceiptIntegrityKey(): Promise<string> {
    try {
      const [activeKey] = await this.readReceiptIntegrityKeys();
      return activeKey;
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) throw error;
    }
    await storeTestHooks.afterReceiptKeyReadMiss?.();
    const key = randomBytes(RECEIPT_INTEGRITY_KEY_BYTES).toString("hex");
    try {
      // Exclusive-create (not last-writer-wins rename): if two processes both
      // read ENOENT and race to write, a rename would clobber the first key and
      // silently untrust every receipt already signed with it. O_EXCL makes the
      // loser observe EEXIST and adopt the winner's key instead.
      await writeVerifiedUtf8File(this.receiptIntegrityKeyPath(), `${key}\n`, () => this.assertReceiptIntegrityKeyTargetSafe(), {
        exclusive: true,
        mode: BRIDGE_FILE_MODE
      });
      return key;
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) throw error;
      const [activeKey] = await this.readReceiptIntegrityKeys();
      return activeKey;
    }
  }

  // The key file holds one 32-byte hex key per line: the first line signs new
  // receipts, later lines are legacy keys kept so pre-rotation receipts verify.
  private async readReceiptIntegrityKeys(): Promise<string[]> {
    const lines = (
      await readVerifiedUtf8File(this.receiptIntegrityKeyPath(), () => this.assertReceiptIntegrityKeyTargetSafe({ allowMissing: false }), {
        mode: BRIDGE_FILE_MODE
      })
    )
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length === 0 || !lines.every((line) => /^[a-f0-9]{64}$/.test(line))) {
      throw new Error(".bridge/receipt-key.local is corrupt. Move it aside and recreate write receipts.");
    }
    return lines;
  }

  private async ensureBridgeGitignore(): Promise<void> {
    const ignorePath = path.join(this.bridgeDir, ".gitignore");
    let current = "";
    try {
      current = await readVerifiedUtf8File(ignorePath, () => this.assertBridgeGitignoreTargetSafe());
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) throw error;
    }
    const required = [
      "tasks/*.json",
      "results/*.json",
      "sessions/*.json",
      "receipts/*.json",
      "artifacts/*",
      "config.local.json",
      "receipt-key.local",
      "last-browser-send",
      "!.gitignore"
    ];
    const lines = new Set(current.split(/\r?\n/).filter(Boolean));
    for (const line of required) lines.add(line);
    await writeVerifiedUtf8File(ignorePath, `${Array.from(lines).join("\n")}\n`, () => this.assertBridgeGitignoreTargetSafe(), {
      create: true
    });
  }

  async hasReadyBridgeStorageReadOnly(): Promise<boolean> {
    try {
      await this.assertStorageDirsAreRealDirectories();
      return true;
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return false;
      throw error;
    }
  }

  private async hasReadyStorageDirReadOnly(kind: BridgeStorageKind): Promise<boolean> {
    try {
      await this.assertStorageDirIsRealDirectory(kind);
      return true;
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return false;
      throw error;
    }
  }

  // Allocate a record id and write it with an exclusive create, retrying with a -N suffix on
  // collision, so id allocation and the write are a single atomic step. The previous check-then-
  // write (exists() loop + overwrite) was a TOCTOU: two concurrent creates with the same
  // timestamp+title both saw "absent" and resolved to the same id, silently overwriting one
  // record under the normal Codex+Claude shared-.bridge mode. This mirrors the exclusive-create
  // path already used for results.
  private async createWithUniqueId<T>(
    prefix: "task" | "sess" | "receipt",
    title: string,
    kind: "tasks" | "sessions" | "receipts",
    build: (id: string) => T | Promise<T>
  ): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      const base = makeBridgeId(prefix, title);
      const id = attempt === 1 ? base : `${base}-${attempt}`;
      const record = await build(id);
      if (await this.writeNewRecordJson(kind, id, record)) return record;
      if (attempt >= 10000) {
        throw new Error(`Unable to allocate a unique ${prefix} id under .bridge/${kind} after ${attempt} attempts`);
      }
    }
  }

  private pathFor(kind: BridgeRecordKind, id: string): string {
    assertBridgeRecordId(kind, id);
    return path.join(this.dir(kind), `${id}.json`);
  }

  private async readAll<T>(
    kind: "tasks" | "results" | "sessions" | "receipts",
    parseRecord: (id: string, value: unknown) => T,
    options: { cleanupTempHardLinks?: boolean } = {}
  ): Promise<T[]> {
    const dir = this.dir(kind);
    const entries = await readdir(dir, { withFileTypes: true });
    const items: T[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const id = entry.name.replace(/\.json$/, "");
      if (!isBridgeRecordId(kind, id)) continue;
      items.push(this.parseRecord(kind, id, await this.readRecordJson(kind, id, options), parseRecord));
    }
    return items;
  }

  private parseRecord<T>(kind: BridgeRecordKind, id: string, value: unknown, parseRecord: (id: string, value: unknown) => T): T {
    try {
      return parseRecord(id, value);
    } catch (error) {
      throw recordCorruptError(kind, id, this.pathFor(kind, id), this.root, error);
    }
  }

  private async readRecordJson(
    kind: BridgeRecordKind,
    id: string,
    options: { cleanupTempHardLinks?: boolean } = {}
  ): Promise<unknown> {
    const filePath = this.pathFor(kind, id);
    try {
      await this.assertStorageDirIsRealDirectory(kind);
      if (options.cleanupTempHardLinks ?? true) {
        await this.cleanupRecordTempHardLinks(kind, filePath);
      }
      const raw = await readVerifiedUtf8File(filePath, () => this.assertRecordTargetInside(kind, filePath));
      try {
        return JSON.parse(raw);
      } catch (error) {
        throw recordCorruptError(kind, id, filePath, this.root, error);
      }
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) {
        throw recordNotFoundError(kind, id);
      }
      throw error;
    }
  }

  private async writeRecordJson(kind: BridgeRecordKind, id: string, value: unknown): Promise<void> {
    const filePath = this.pathFor(kind, id);
    await this.assertStorageDirIsRealDirectory(kind);
    await this.assertRecordTargetInsideIfExists(kind, filePath);
    await this.writeJson(kind, filePath, value);
    await this.assertRecordTargetInside(kind, filePath);
  }

  private async writeNewRecordJson(kind: BridgeRecordKind, id: string, value: unknown): Promise<boolean> {
    const filePath = this.pathFor(kind, id);
    await this.assertStorageDirIsRealDirectory(kind);
    const wrote = await this.writeJsonIfAbsent(kind, filePath, value);
    if (!wrote) return false;
    await this.assertRecordTargetInside(kind, filePath);
    return true;
  }

  private async writeJson(kind: BridgeRecordKind, filePath: string, value: unknown): Promise<void> {
    await this.writeTextByRename(kind, filePath, `${JSON.stringify(value, null, 2)}\n`);
  }

  private async writeJsonIfAbsent(kind: BridgeRecordKind, filePath: string, value: unknown): Promise<boolean> {
    return await this.writeTextByCreateExclusive(kind, filePath, `${JSON.stringify(value, null, 2)}\n`);
  }

  private async writeTextByRename(kind: BridgeRecordKind, filePath: string, content: string): Promise<void> {
    if (hasStableDirectoryFdPaths()) {
      await this.writeTextByStableStorageRename(kind, filePath, content);
      return;
    }
    throw new Error("Bridge record writes require stable directory file descriptor paths on this platform.");
  }

  private async writeTextByCreateExclusive(kind: BridgeRecordKind, filePath: string, content: string): Promise<boolean> {
    if (hasStableDirectoryFdPaths()) {
      return await this.writeTextByStableStorageLinkIfAbsent(kind, filePath, content);
    }
    throw new Error("Bridge record writes require stable directory file descriptor paths on this platform.");
  }

  private async deleteRecordIfPresent(kind: BridgeRecordKind, id: string): Promise<void> {
    const filePath = this.pathFor(kind, id);
    const fileName = path.basename(filePath);
    const expectedDir = this.dir(kind);
    if (path.dirname(filePath) !== expectedDir) {
      throw new Error(`Bridge record path must stay under .bridge/${kind}`);
    }
    const bridgeHandle = await openNoFollowDirectory(this.bridgeDir, "Bridge directory");
    try {
      const storageHandle = await openNoFollowDirectory(
        path.join(directoryFdPath(bridgeHandle.fd), kind),
        `Bridge storage directory .bridge/${kind}`
      );
      try {
        await this.assertStorageDirIsRealDirectory(kind);
        const targetPath = path.join(directoryFdPath(storageHandle.fd), fileName);
        let stat;
        try {
          stat = await lstat(targetPath);
        } catch (error) {
          if (isErrorCode(error, "ENOENT")) return;
          throw error;
        }
        if (stat.isSymbolicLink() || !stat.isFile()) {
          throw new Error(`Bridge record path for .bridge/${kind} must be a regular file and must not be a symlink`);
        }
        await rm(targetPath, { force: true });
        await this.assertStorageDirIsRealDirectory(kind);
      } finally {
        await storageHandle.close();
      }
    } finally {
      await bridgeHandle.close();
    }
  }

  private async writeTextByStableStorageRename(kind: BridgeRecordKind, filePath: string, content: string): Promise<void> {
    const fileName = path.basename(filePath);
    const expectedDir = this.dir(kind);
    if (path.dirname(filePath) !== expectedDir) {
      throw new Error(`Bridge record path must stay under .bridge/${kind}`);
    }
    const bridgeHandle = await openNoFollowDirectory(this.bridgeDir, "Bridge directory");
    try {
      const storageHandle = await openNoFollowDirectory(
        path.join(directoryFdPath(bridgeHandle.fd), kind),
        `Bridge storage directory .bridge/${kind}`
      );
      try {
        await this.assertStorageDirIsRealDirectory(kind);
        const storageFdPath = directoryFdPath(storageHandle.fd);
        const targetPath = path.join(storageFdPath, fileName);
        await assertRegularFileIfExists(targetPath, `Bridge record path for .bridge/${kind}`);
        const tmpPath = path.join(storageFdPath, `.${fileName}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
        try {
          await writeVerifiedUtf8File(tmpPath, content, async () => assertOpenDirectoryHandle(storageHandle), {
            create: true,
            mode: BRIDGE_FILE_MODE
          });
          await storeTestHooks.beforeRecordRename?.(kind, filePath);
          await rename(tmpPath, targetPath);
          await assertRegularFileIfExists(targetPath, `Bridge record path for .bridge/${kind}`);
          await this.assertStorageDirIsRealDirectory(kind);
        } catch (error) {
          await rm(tmpPath, { force: true }).catch(() => undefined);
          throw error;
        }
      } finally {
        await storageHandle.close();
      }
    } finally {
      await bridgeHandle.close();
    }
  }

  private async writeTextByStableStorageLinkIfAbsent(kind: BridgeRecordKind, filePath: string, content: string): Promise<boolean> {
    const fileName = path.basename(filePath);
    const expectedDir = this.dir(kind);
    if (path.dirname(filePath) !== expectedDir) {
      throw new Error(`Bridge record path must stay under .bridge/${kind}`);
    }
    const bridgeHandle = await openNoFollowDirectory(this.bridgeDir, "Bridge directory");
    try {
      const storageHandle = await openNoFollowDirectory(
        path.join(directoryFdPath(bridgeHandle.fd), kind),
        `Bridge storage directory .bridge/${kind}`
      );
      try {
        await this.assertStorageDirIsRealDirectory(kind);
        const storageFdPath = directoryFdPath(storageHandle.fd);
        const targetPath = path.join(storageFdPath, fileName);
        const tmpPath = path.join(storageFdPath, `.${fileName}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
        let linked = false;
        try {
          await writeVerifiedUtf8File(tmpPath, content, async () => assertOpenDirectoryHandle(storageHandle), {
            create: true,
            exclusive: true,
            mode: BRIDGE_FILE_MODE
          });
          try {
            await storeTestHooks.beforeRecordRename?.(kind, filePath);
            await link(tmpPath, targetPath);
          } catch (error) {
            if (isErrorCode(error, "EEXIST")) {
              await rm(tmpPath, { force: true }).catch(() => undefined);
              return false;
            }
            throw error;
          }
          linked = true;
          await rm(tmpPath, { force: true });
          await assertRegularFileIfExists(targetPath, `Bridge record path for .bridge/${kind}`);
          await this.assertStorageDirIsRealDirectory(kind);
        } catch (error) {
          if (!linked) await rm(tmpPath, { force: true }).catch(() => undefined);
          throw error;
        }
      } finally {
        await storageHandle.close();
      }
    } finally {
      await bridgeHandle.close();
    }
    return true;
  }

  private async cleanupRecordTempHardLinks(kind: BridgeRecordKind, filePath: string): Promise<void> {
    const fileName = path.basename(filePath);
    const expectedDir = this.dir(kind);
    if (path.dirname(filePath) !== expectedDir) {
      throw new Error(`Bridge record path must stay under .bridge/${kind}`);
    }
    const bridgeHandle = await openNoFollowDirectory(this.bridgeDir, "Bridge directory");
    try {
      const storageHandle = await openNoFollowDirectory(
        path.join(directoryFdPath(bridgeHandle.fd), kind),
        `Bridge storage directory .bridge/${kind}`
      );
      try {
        const storageFdPath = directoryFdPath(storageHandle.fd);
        const targetPath = path.join(storageFdPath, fileName);
        let targetStat;
        try {
          targetStat = await lstat(targetPath);
        } catch (error) {
          if (isErrorCode(error, "ENOENT")) return;
          throw error;
        }
        if (targetStat.isSymbolicLink() || !targetStat.isFile() || targetStat.nlink <= 1) return;
        await storeTestHooks.beforeRecordTempCleanup?.(kind, filePath);
        const tempPrefix = `.${fileName}.`;
        const entries = await readdir(storageFdPath, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.startsWith(tempPrefix) || !entry.name.endsWith(".tmp")) continue;
          const tempPath = path.join(storageFdPath, entry.name);
          const tempStat = await lstat(tempPath).catch(() => undefined);
          if (!tempStat?.isFile() || tempStat.isSymbolicLink()) continue;
          if (tempStat.dev === targetStat.dev && tempStat.ino === targetStat.ino) {
            await rm(tempPath, { force: true });
          }
        }
      } finally {
        await storageHandle.close();
      }
    } finally {
      await bridgeHandle.close();
    }
  }

  private resolveArtifactPath(relativePath: string): string {
    const normalized = relativePath.replaceAll("\\", "/");
    if (!normalized.startsWith(".bridge/artifacts/")) {
      throw new Error("Artifact path must be under .bridge/artifacts");
    }
    const resolved = path.resolve(this.root, normalized);
    const relative = path.relative(this.dir("artifacts"), resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Artifact path must stay under .bridge/artifacts");
    }
    return resolved;
  }

  private relativeToRoot(filePath: string): string {
    return path.relative(this.root, filePath).replaceAll(path.sep, "/");
  }

  private async assertArtifactTargetInside(filePath: string): Promise<void> {
    const stat = await lstat(filePath);
    if (stat.isSymbolicLink()) {
      throw new Error("Artifact path must not be a symlink");
    }
    await this.assertRealPathInsideArtifacts(filePath);
  }

  private async assertArtifactsDirIsRealDirectory(): Promise<void> {
    await this.assertStorageDirIsRealDirectory("artifacts");
  }

  private async ensureArtifactParentDirectory(parentPath: string): Promise<void> {
    await this.walkArtifactParentDirectory(parentPath, true);
  }

  private async assertArtifactParentDirectory(parentPath: string): Promise<void> {
    await this.walkArtifactParentDirectory(parentPath, false);
  }

  private async walkArtifactParentDirectory(parentPath: string, createMissing: boolean): Promise<void> {
    const artifactsDir = this.dir("artifacts");
    const relative = path.relative(artifactsDir, parentPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Artifact path must stay under .bridge/artifacts");
    }
    let current = artifactsDir;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      if (createMissing) {
        await this.ensureRealDirectorySegment(current);
      } else {
        await this.assertRealDirectorySegment(current);
      }
    }
  }

  private async ensureRealDirectorySegment(dirPath: string): Promise<void> {
    try {
      const stat = await lstat(dirPath);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error("Artifact path must stay under .bridge/artifacts");
      }
    } catch (error) {
      const maybe = error as { code?: string };
      if (maybe.code !== "ENOENT") throw error;
      await mkdir(dirPath, { mode: BRIDGE_DIRECTORY_MODE });
      const stat = await lstat(dirPath);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error("Artifact path must stay under .bridge/artifacts");
      }
    }
    await chmodPrivateDirectory(dirPath, "Artifact directory");
  }

  private async assertRealDirectorySegment(dirPath: string): Promise<void> {
    const stat = await lstat(dirPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("Artifact path must stay under .bridge/artifacts");
    }
  }

  private async assertBridgeDirIsRealDirectory(): Promise<void> {
    const stat = await lstat(this.bridgeDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("Bridge directory must be a real directory");
    }
  }

  private async assertBridgeGitignoreTargetSafe(options: { allowMissing?: boolean } = { allowMissing: true }): Promise<void> {
    await this.assertBridgeDirIsRealDirectory();
    const ignorePath = path.join(this.bridgeDir, ".gitignore");
    try {
      const stat = await lstat(ignorePath);
      if (stat.isSymbolicLink()) {
        throw new Error(".bridge/.gitignore must not be a symlink");
      }
      if (!stat.isFile()) {
        throw new Error(".bridge/.gitignore must be a regular file");
      }
    } catch (error) {
      if (isErrorCode(error, "ENOENT") && options.allowMissing !== false) return;
      throw error;
    }
  }

  private async assertReceiptIntegrityKeyTargetSafe(options: { allowMissing?: boolean } = { allowMissing: true }): Promise<void> {
    await this.assertBridgeDirIsRealDirectory();
    const keyPath = this.receiptIntegrityKeyPath();
    try {
      const stat = await lstat(keyPath);
      if (stat.isSymbolicLink()) {
        throw new Error(".bridge/receipt-key.local must not be a symlink");
      }
      if (!stat.isFile()) {
        throw new Error(".bridge/receipt-key.local must be a regular file");
      }
    } catch (error) {
      if (isErrorCode(error, "ENOENT") && options.allowMissing !== false) return;
      throw error;
    }
  }

  private async assertStorageDirsAreRealDirectories(): Promise<void> {
    await Promise.all(
      (["tasks", "results", "sessions", "artifacts", "receipts"] as const).map((kind) =>
        this.assertStorageDirIsRealDirectory(kind)
      )
    );
  }

  private async assertStorageDirIsRealDirectory(kind: BridgeStorageKind): Promise<void> {
    await this.assertBridgeDirIsRealDirectory();
    const stat = await lstat(this.dir(kind));
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Bridge storage directory .bridge/${kind} must be a real directory`);
    }
  }

  private async assertRecordTargetInside(kind: BridgeRecordKind, filePath: string): Promise<void> {
    await this.assertStorageDirIsRealDirectory(kind);
    const stat = await lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Bridge record path for .bridge/${kind} must be a regular file and must not be a symlink`);
    }
    await this.assertRealPathInsideStorageDir(kind, filePath);
  }

  private async assertRecordTargetInsideIfExists(kind: BridgeRecordKind, filePath: string): Promise<void> {
    try {
      await this.assertRecordTargetInside(kind, filePath);
    } catch (error) {
      const maybe = error as { code?: string };
      if (maybe.code !== "ENOENT") throw error;
    }
  }

  private async assertArtifactTargetInsideIfExists(filePath: string): Promise<void> {
    try {
      await this.assertArtifactTargetInside(filePath);
    } catch (error) {
      const maybe = error as { code?: string };
      if (maybe.code !== "ENOENT") throw error;
    }
  }

  private async assertRealPathInsideArtifacts(filePath: string): Promise<void> {
    const [realArtifacts, realTarget] = await Promise.all([realpath(this.dir("artifacts")), realpath(filePath)]);
    const relative = path.relative(realArtifacts, realTarget);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Artifact path must stay under .bridge/artifacts");
    }
  }

  private async assertRealPathInsideStorageDir(kind: BridgeRecordKind, filePath: string): Promise<void> {
    const [realStorageDir, realTarget] = await Promise.all([realpath(this.dir(kind)), realpath(filePath)]);
    const relative = path.relative(realStorageDir, realTarget);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Bridge record path must stay under .bridge/${kind}`);
    }
  }
}

function validateTaskFiles(files: BridgeFile[]): BridgeFile[] {
  for (const file of files) {
    assertRepoRelativePath(file.path);
  }
  return files;
}

function recordNotFoundError(kind: BridgeRecordKind, id: string): Error & { code: "ENOENT" } {
  const error = new Error(`${recordLabel(kind)} not found: ${id}`) as Error & { code: "ENOENT" };
  error.code = "ENOENT";
  return error;
}

function recordCorruptError(kind: BridgeRecordKind, id: string, filePath: string, root: string, cause: unknown): Error {
  assertBridgeRecordId(kind, id);
  return new Error(`${recordLabel(kind)} record is corrupt: ${formatRecordPath(root, filePath)}. Move it aside or fix the JSON, then retry.`, {
    cause
  });
}

function untrustedResultError(root: string, taskId: string, reason: string): Error {
  const error = new Error(
    `Result record is untrusted: ${formatRecordPath(root, path.join(root, ".bridge", "results", `${taskId}.json`))} ${reason}. If this is a locally signed legacy completion receipt, review .bridge/results/${taskId}.json, then run \`prodex results reseal ${taskId} --confirm-current-result\`. Retry the completion path or move the result record aside, then retry.`
  ) as Error & { code: "EUNTRUSTED_RESULT"; taskId: string };
  error.code = "EUNTRUSTED_RESULT";
  error.taskId = taskId;
  return error;
}

function formatRecordPath(root: string, filePath: string): string {
  const relative = path.relative(root, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return filePath;
  return relative.split(path.sep).join("/");
}

function recordLabel(kind: BridgeRecordKind): string {
  switch (kind) {
    case "tasks":
      return "Task";
    case "results":
      return "Result";
    case "sessions":
      return "Session";
    case "receipts":
      return "Receipt";
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isFetchableResultArtifactPath(normalizedPath: string): boolean {
  return FETCHABLE_RESULT_ARTIFACT_PREFIXES.some((prefix) => normalizedPath.startsWith(prefix));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertFetchableResultArtifacts(artifacts: BridgeFile[]): void {
  for (const artifact of artifacts) {
    if (artifact.role !== "result") continue;
    const normalizedPath = path.posix.normalize(artifact.path.replaceAll("\\", "/"));
    if (!isFetchableResultArtifactPath(normalizedPath) || normalizedPath !== artifact.path) {
      throw new Error(`Artifact is not a fetchable result artifact: ${artifact.path}`);
    }
  }
}

function parseTaskRecord(expectedId: string, value: unknown): Task {
  const task = TaskSchema.parse(value);
  assertMatchingRecordIdentity("task", expectedId, task.id);
  return task;
}

function parseResultRecord(expectedTaskId: string, value: unknown): Result {
  const result = ResultSchema.parse(value);
  assertMatchingRecordIdentity("result", expectedTaskId, result.task_id, "task_id");
  return result;
}

function parseSessionRecord(expectedId: string, value: unknown): Session {
  const session = SessionSchema.parse(value);
  assertMatchingRecordIdentity("session", expectedId, session.id);
  return session;
}

function parseReceiptRecord(expectedId: string, value: unknown): Receipt {
  const receipt = ReceiptSchema.parse(value);
  assertMatchingRecordIdentity("receipt", expectedId, receipt.id);
  return receipt;
}

function assertMatchingRecordIdentity(kind: string, expectedId: string, actualId: string, field = "id"): void {
  if (actualId !== expectedId) {
    throw new Error(`${kind} ${field} ${actualId} does not match ${kind} record ${expectedId}`);
  }
}

function receiptDigestWithKey(receipt: Receipt, key: string): string {
  return createHmac("sha256", Buffer.from(key, "hex")).update(canonicalJson(stripReceiptIntegrity(receipt))).digest("hex");
}

function stripReceiptIntegrity(receipt: Receipt): Omit<Receipt, "integrity"> {
  const { integrity: _integrity, ...unsigned } = receipt;
  return unsigned;
}

function assertReceiptResultDigest(receipt: Receipt, result: Result): void {
  const expected = resultDigest(result);
  const actual = receipt.metadata?.result_sha256;
  if (actual === undefined) {
    throw new Error(`Receipt ${receipt.id} is missing result_sha256`);
  }
  if (typeof actual !== "string" || !safeHexEqual(actual, expected)) {
    throw new Error(`Receipt ${receipt.id} does not match current result payload: result_sha256 mismatch`);
  }
}

function assertLegacyCompletionReceiptCanBeResealed(receipt: Receipt, result: Result): void {
  const actual = receipt.metadata?.result_sha256;
  if (actual === undefined) return;
  if (typeof actual === "string" && safeHexEqual(actual, resultDigest(result))) {
    throw new Error(`Receipt ${receipt.id} already matches current result payload`);
  }
  throw new Error(`Receipt ${receipt.id} is not a legacy completion receipt: result_sha256 is already present`);
}

function resultDigest(result: Result): string {
  return sha256(canonicalJson(result));
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const canonical: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] !== undefined) canonical[key] = canonicalize(record[key]);
    }
    return canonical;
  }
  return value;
}

function safeHexEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function assertResultMatchesRetry(taskId: string, existing: Result, retry: Result): void {
  if (JSON.stringify(resultRetryFingerprint(existing)) !== JSON.stringify(resultRetryFingerprint(retry))) {
    throw new Error(`Task ${taskId} already has a different result and cannot be finalized again`);
  }
}

function terminalTaskMissingResultError(task: Task): Error {
  return new Error(
    `Task ${task.id} is ${task.status} but .bridge/results/${task.id}.json is missing. Restore the result file, retry with the original completion record if you have it, or move the terminal task record aside, then retry.`
  );
}

function resultRetryFingerprint(result: Result): Omit<Result, "schema_version" | "created_at"> {
  return {
    task_id: result.task_id,
    status: result.status,
    summary: result.summary,
    artifacts: result.artifacts.map(resultArtifactRetryFingerprint),
    commands: result.commands,
    warnings: result.warnings,
    blocker: result.blocker
  };
}

function resultArtifactRetryFingerprint(artifact: BridgeFile): Pick<BridgeFile, "path" | "role"> {
  return {
    path: artifact.path,
    role: artifact.role
  };
}

async function openNoFollowDirectory(dirPath: string, label: string): Promise<FileHandle> {
  const noFollowFlag = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const directoryFlag = typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0;
  try {
    const handle = await open(dirPath, constants.O_RDONLY | directoryFlag | noFollowFlag);
    try {
      await assertOpenDirectoryHandle(handle);
      return handle;
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  } catch (error) {
    const maybe = error as { code?: string };
    if (maybe.code === "ELOOP" || maybe.code === "ENOTDIR") {
      throw new Error(`${label} must be a real directory and must not be a symlink`);
    }
    throw error;
  }
}

async function ensurePrivateDirectory(dirPath: string, label: string): Promise<void> {
  await mkdir(dirPath, { recursive: true, mode: BRIDGE_DIRECTORY_MODE });
  await chmodPrivateDirectory(dirPath, label);
}

async function chmodPrivateDirectory(dirPath: string, label: string): Promise<void> {
  const handle = await openNoFollowDirectory(dirPath, label);
  try {
    await handle.chmod(BRIDGE_DIRECTORY_MODE);
    await assertOpenDirectoryHandle(handle);
  } finally {
    await handle.close();
  }
}

async function assertOpenDirectoryHandle(handle: FileHandle): Promise<void> {
  const stat = await handle.stat();
  if (!stat.isDirectory()) {
    throw new Error("Bridge storage directory handle must remain a real directory");
  }
}

async function assertRegularFileIfExists(filePath: string, label: string): Promise<void> {
  try {
    const stat = await lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`${label} must be a regular file and must not be a symlink`);
    }
  } catch (error) {
    const maybe = error as { code?: string };
    if (maybe.code !== "ENOENT") throw error;
  }
}

function hasStableDirectoryFdPaths(): boolean {
  return directoryFdPathBase() !== undefined;
}

function directoryFdPath(fd: number): string {
  const base = directoryFdPathBase();
  if (!base) {
    throw new Error("Bridge record writes require stable directory file descriptor paths on this platform.");
  }
  return `${base}/${fd}`;
}

function directoryFdPathBase(): string | undefined {
  if (storeTestHooks.disableDirectoryFdPaths) return undefined;
  if (existsSync("/proc/self/fd")) return "/proc/self/fd";
  if (existsSync("/dev/fd")) return "/dev/fd";
  return undefined;
}

function assertBridgeRecordId(kind: BridgeRecordKind, id: string): void {
  if (!isBridgeRecordId(kind, id)) {
    throw new Error(`Invalid bridge record id for ${kind}: ${id}`);
  }
}

function isBridgeRecordId(kind: BridgeRecordKind, id: string): boolean {
  const pattern = kind === "receipts" ? RECEIPT_ID_PATTERN : kind === "sessions" ? SESSION_ID_PATTERN : TASK_ID_PATTERN;
  return pattern.test(id);
}

function redactReceiptForDisplay(receipt: Receipt, integrityStatus?: ReceiptIntegrityInspectionStatus): Receipt {
  const metadata: Record<string, unknown> = { ...receipt.metadata };
  delete metadata.integrity_status;
  if (Object.hasOwn(metadata, "new_content")) {
    const inlineContent = metadata.new_content;
    delete metadata.new_content;
    metadata.new_content_redacted = {
      reason: "legacy inline replacement content",
      ...(typeof inlineContent === "string" ? { bytes: Buffer.byteLength(inlineContent, "utf8") } : {})
    };
  }
  if (Object.hasOwn(metadata, "diff")) {
    const diff = metadata.diff;
    delete metadata.diff;
    metadata.diff_redacted = {
      reason: "write preview diff",
      ...(typeof diff === "string" ? { bytes: Buffer.byteLength(diff, "utf8") } : {})
    };
  }
  const selection = metadata.selection;
  if (
    selection &&
    typeof selection === "object" &&
    !Array.isArray(selection) &&
    (Object.hasOwn(selection, "project") || Object.hasOwn(selection, "project_new"))
  ) {
    // The ChatGPT project name is personal context; keep the non-personal model
    // axes visible but drop the name from display output. The raw receipt file
    // keeps it for local inspection.
    const redactedSelection: Record<string, unknown> = { ...(selection as Record<string, unknown>) };
    delete redactedSelection.project;
    delete redactedSelection.project_new;
    redactedSelection.project_redacted = true;
    metadata.selection = redactedSelection;
  }
  if (Object.hasOwn(metadata, "thread")) {
    // The ChatGPT conversation URL is personal context (like the session
    // thread, which is stripped at the MCP boundary). Drop it from display /
    // MCP output; the raw receipt file keeps it for local inspection.
    delete metadata.thread;
    metadata.thread_redacted = true;
  }
  if (integrityStatus) {
    metadata.integrity_status = integrityStatus;
  }
  return ReceiptSchema.parse({ ...receipt, metadata });
}
