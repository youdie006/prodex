import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
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

const TASK_ID_PATTERN = /^task_\d{8}_\d{6}_[a-z0-9-]+$/;
const SESSION_ID_PATTERN = /^sess_\d{8}_\d{6}_[a-z0-9-]+$/;
const RECEIPT_ID_PATTERN = /^receipt_\d{8}_\d{6}_[a-z0-9-]+$/;

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

export type WriteReceiptInput = Omit<Receipt, "schema_version" | "id" | "created_at" | "metadata"> & {
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

export class BridgeStore {
  readonly root: string;
  readonly bridgeDir: string;

  constructor(root = process.cwd()) {
    this.root = root;
    this.bridgeDir = path.join(root, ".bridge");
  }

  async ensure(): Promise<void> {
    await mkdir(this.bridgeDir, { recursive: true });
    await this.assertBridgeDirIsRealDirectory();
    await Promise.all([
      mkdir(this.dir("tasks"), { recursive: true }),
      mkdir(this.dir("results"), { recursive: true }),
      mkdir(this.dir("sessions"), { recursive: true }),
      mkdir(this.dir("artifacts"), { recursive: true }),
      mkdir(this.dir("receipts"), { recursive: true })
    ]);
    await this.assertStorageDirsAreRealDirectories();
  }

  dir(kind: BridgeStorageKind): string {
    return path.join(this.bridgeDir, kind);
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    await this.ensure();
    const timestamp = nowIso();
    const task: Task = TaskSchema.parse({
      schema_version: SCHEMA_VERSION,
      id: await this.uniqueId("task", input.title, "tasks"),
      source: input.source,
      status: "new",
      title: input.title,
      prompt: input.prompt,
      repo_id: input.repo_id ?? "default",
      files: input.files ?? [],
      provenance: input.provenance,
      created_at: timestamp,
      updated_at: timestamp
    });
    await this.writeRecordJson("tasks", task.id, task);
    await this.writeReceipt({
      kind: "task_created",
      task_id: task.id,
      summary: `Created task ${task.id}`
    });
    return task;
  }

  async listTasks(status?: Task["status"]): Promise<Task[]> {
    await this.ensure();
    const tasks = await this.readAll("tasks", TaskSchema);
    return tasks
      .filter((task) => (status ? task.status === status : true))
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  }

  async getTask(taskId: string): Promise<Task> {
    return TaskSchema.parse(await this.readRecordJson("tasks", taskId));
  }

  async claimTask(taskId: string, claimedBy: string): Promise<Task> {
    const task = await this.getTask(taskId);
    if (task.status !== "new") {
      throw new Error(`Task ${taskId} is ${task.status}, not new`);
    }
    const updated = TaskSchema.parse({
      ...task,
      status: "claimed",
      claimed_by: claimedBy,
      claimed_at: nowIso(),
      updated_at: nowIso()
    });
    await this.writeRecordJson("tasks", taskId, updated);
    await this.writeReceipt({
      kind: "task_claimed",
      task_id: taskId,
      summary: `Claimed task ${taskId} by ${claimedBy}`
    });
    return updated;
  }

  async completeTask(taskId: string, input: CompleteTaskInput): Promise<Result> {
    const task = await this.getTask(taskId);
    const result: Result = ResultSchema.parse({
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
    await this.writeRecordJson("results", taskId, result);
    const updated = TaskSchema.parse({
      ...task,
      status: input.status,
      provenance: input.provenance ? { ...task.provenance, ...input.provenance } : task.provenance,
      blocker: input.blocker,
      result_path: `.bridge/results/${taskId}.json`,
      updated_at: nowIso()
    });
    await this.writeRecordJson("tasks", taskId, updated);
    await this.writeReceipt({
      kind: "task_completed",
      task_id: taskId,
      summary: `${input.status === "done" ? "Completed" : "Blocked"} task ${taskId}`
    });
    return result;
  }

  async listResults(): Promise<Result[]> {
    await this.ensure();
    return (await this.readAll("results", ResultSchema)).sort(
      (a, b) => a.created_at.localeCompare(b.created_at) || a.task_id.localeCompare(b.task_id)
    );
  }

  async getResult(taskId: string): Promise<Result> {
    return ResultSchema.parse(await this.readRecordJson("results", taskId));
  }

  async readResultArtifactText(taskId: string, artifactPath?: string): Promise<{ artifact: BridgeFile; content: string }> {
    const result = await this.getResult(taskId);
    const artifacts = result.artifacts.filter((artifact) => artifact.role === "result");
    const artifact = artifactPath ? artifacts.find((item) => item.path === artifactPath) : artifacts.length === 1 ? artifacts[0] : undefined;
    if (!artifact) {
      if (artifactPath) throw new Error(`Result artifact not found for ${taskId}: ${artifactPath}`);
      if (artifacts.length === 0) throw new Error(`Result ${taskId} has no result artifacts`);
      throw new Error(`Result ${taskId} has multiple result artifacts; pass an artifact path`);
    }
    const normalizedArtifactPath = path.posix.normalize(artifact.path.replaceAll("\\", "/"));
    if (!normalizedArtifactPath.startsWith(".bridge/artifacts/pro-consults/") || normalizedArtifactPath !== artifact.path) {
      throw new Error(`Artifact is not a fetchable result artifact for ${taskId}: ${artifact.path}`);
    }
    return { artifact, content: await this.readArtifactText(artifact.path) };
  }

  async writeSession(input: WriteSessionInput): Promise<Session> {
    await this.ensure();
    const id = input.id ?? (await this.uniqueId("sess", input.task_id ?? input.direction, "sessions"));
    const existing = await this.getSession(id).catch(() => undefined);
    const timestamp = nowIso();
    const session = SessionSchema.parse({
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
      created_at: existing?.created_at ?? timestamp,
      last_used_at: timestamp
    });
    await this.writeRecordJson("sessions", id, session);
    return session;
  }

  async getSession(sessionId: string): Promise<Session> {
    return SessionSchema.parse(await this.readRecordJson("sessions", sessionId));
  }

  async listSessions(status?: Session["status"]): Promise<Session[]> {
    await this.ensure();
    const sessions = await this.readAll("sessions", SessionSchema);
    return sessions
      .filter((session) => (status ? session.status === status : true))
      .sort((a, b) => b.last_used_at.localeCompare(a.last_used_at) || b.id.localeCompare(a.id));
  }

  async getReceipt(receiptId: string): Promise<Receipt> {
    return ReceiptSchema.parse(await this.readRecordJson("receipts", receiptId));
  }

  async listReceipts(input: ListReceiptsInput = {}): Promise<Receipt[]> {
    await this.ensure();
    return (await this.readAll("receipts", ReceiptSchema))
      .filter((receipt) => (input.kind ? receipt.kind === input.kind : true))
      .filter((receipt) => (input.task_id ? receipt.task_id === input.task_id : true))
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
      .map((receipt) => redactReceiptForDisplay(receipt));
  }

  async getReceiptForDisplay(receiptId: string): Promise<Receipt> {
    return redactReceiptForDisplay(await this.getReceipt(receiptId));
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
      { create: true }
    );
    return this.relativeToRoot(artifactPath);
  }

  async readArtifactText(relativePath: string): Promise<string> {
    await this.assertBridgeDirIsRealDirectory();
    await this.assertArtifactsDirIsRealDirectory();
    const artifactPath = this.resolveArtifactPath(relativePath);
    await this.assertArtifactParentDirectory(path.dirname(artifactPath));
    return readVerifiedUtf8File(artifactPath, () => this.assertArtifactTargetInside(artifactPath));
  }

  async writeReceipt(input: WriteReceiptInput): Promise<Receipt> {
    await this.ensure();
    const receipt = ReceiptSchema.parse({
      schema_version: SCHEMA_VERSION,
      id: await this.uniqueId("receipt", input.kind, "receipts"),
      created_at: nowIso(),
      ...input
    });
    await this.writeRecordJson("receipts", receipt.id, receipt);
    return receipt;
  }

  private async uniqueId(prefix: "task" | "sess" | "receipt", title: string, kind: "tasks" | "sessions" | "receipts"): Promise<string> {
    let id = makeBridgeId(prefix, title);
    let counter = 2;
    while (await exists(this.pathFor(kind, id))) {
      id = `${makeBridgeId(prefix, title)}-${counter}`;
      counter += 1;
    }
    return id;
  }

  private pathFor(kind: BridgeRecordKind, id: string): string {
    assertBridgeRecordId(kind, id);
    return path.join(this.dir(kind), `${id}.json`);
  }

  private async readAll<T>(kind: "tasks" | "results" | "sessions" | "receipts", schema: { parse(value: unknown): T }): Promise<T[]> {
    const dir = this.dir(kind);
    const entries = await readdir(dir, { withFileTypes: true });
    const items: T[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const id = entry.name.replace(/\.json$/, "");
      if (!isBridgeRecordId(kind, id)) continue;
      items.push(schema.parse(await this.readRecordJson(kind, id)));
    }
    return items;
  }

  private async readRecordJson(kind: BridgeRecordKind, id: string): Promise<unknown> {
    const filePath = this.pathFor(kind, id);
    await this.assertStorageDirIsRealDirectory(kind);
    return JSON.parse(await readVerifiedUtf8File(filePath, () => this.assertRecordTargetInside(kind, filePath)));
  }

  private async writeRecordJson(kind: BridgeRecordKind, id: string, value: unknown): Promise<void> {
    const filePath = this.pathFor(kind, id);
    await this.assertStorageDirIsRealDirectory(kind);
    await this.assertRecordTargetInsideIfExists(kind, filePath);
    await this.writeJson(kind, filePath, value);
    await this.assertRecordTargetInside(kind, filePath);
  }

  private async writeJson(kind: BridgeRecordKind, filePath: string, value: unknown): Promise<void> {
    await this.writeTextByRename(kind, filePath, `${JSON.stringify(value, null, 2)}\n`);
  }

  private async writeTextByRename(kind: BridgeRecordKind, filePath: string, content: string): Promise<void> {
    if (process.platform === "linux") {
      await this.writeTextByStableStorageRename(kind, filePath, content);
      return;
    }
    await this.writeTextByPathRename(kind, filePath, content);
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
        path.join(procFdPath(bridgeHandle.fd), kind),
        `Bridge storage directory .bridge/${kind}`
      );
      try {
        await this.assertStorageDirIsRealDirectory(kind);
        const storageFdPath = procFdPath(storageHandle.fd);
        const targetPath = path.join(storageFdPath, fileName);
        await assertRegularFileIfExists(targetPath, `Bridge record path for .bridge/${kind}`);
        const tmpPath = path.join(storageFdPath, `.${fileName}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
        try {
          await writeVerifiedUtf8File(tmpPath, content, async () => assertOpenDirectoryHandle(storageHandle), {
            create: true
          });
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

  private async writeTextByPathRename(kind: BridgeRecordKind, filePath: string, content: string): Promise<void> {
    const tmp = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    try {
      await writeVerifiedUtf8File(tmp, content, () => this.assertStorageDirIsRealDirectory(kind), { create: true });
      await rename(tmp, filePath);
      await this.assertStorageDirIsRealDirectory(kind);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw error;
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
      await mkdir(dirPath);
      const stat = await lstat(dirPath);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error("Artifact path must stay under .bridge/artifacts");
      }
    }
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

async function exists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath, "utf8");
    return true;
  } catch {
    return false;
  }
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
    if (maybe.code === "ELOOP") {
      throw new Error(`${label} must be a real directory and must not be a symlink`);
    }
    throw error;
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

function procFdPath(fd: number): string {
  return `/proc/self/fd/${fd}`;
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

function redactReceiptForDisplay(receipt: Receipt): Receipt {
  const metadata: Record<string, unknown> = { ...receipt.metadata };
  if (Object.hasOwn(metadata, "new_content")) {
    const inlineContent = metadata.new_content;
    delete metadata.new_content;
    metadata.new_content_redacted = {
      reason: "legacy inline replacement content",
      ...(typeof inlineContent === "string" ? { bytes: Buffer.byteLength(inlineContent, "utf8") } : {})
    };
  }
  return ReceiptSchema.parse({ ...receipt, metadata });
}
