import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type BridgeFile,
  makeBridgeId,
  nowIso,
  type Provenance,
  type Receipt,
  ReceiptSchema,
  type Result,
  ResultSchema,
  SCHEMA_VERSION,
  type SourceSchema,
  type Task,
  TaskSchema
} from "./schema.js";
import type { z } from "zod";

type Source = z.infer<typeof SourceSchema>;

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
}

export class BridgeStore {
  readonly root: string;
  readonly bridgeDir: string;

  constructor(root = process.cwd()) {
    this.root = root;
    this.bridgeDir = path.join(root, ".bridge");
  }

  async ensure(): Promise<void> {
    await Promise.all([
      mkdir(this.dir("tasks"), { recursive: true }),
      mkdir(this.dir("results"), { recursive: true }),
      mkdir(this.dir("sessions"), { recursive: true }),
      mkdir(this.dir("artifacts"), { recursive: true }),
      mkdir(this.dir("receipts"), { recursive: true })
    ]);
  }

  dir(kind: "tasks" | "results" | "sessions" | "artifacts" | "receipts"): string {
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
    await this.writeJson(this.pathFor("tasks", task.id), task);
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
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async getTask(taskId: string): Promise<Task> {
    return TaskSchema.parse(await this.readJson(this.pathFor("tasks", taskId)));
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
    await this.writeJson(this.pathFor("tasks", taskId), updated);
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
      created_at: nowIso()
    });
    await this.writeJson(this.pathFor("results", taskId), result);
    const updated = TaskSchema.parse({
      ...task,
      status: input.status,
      result_path: `.bridge/results/${taskId}.json`,
      updated_at: nowIso()
    });
    await this.writeJson(this.pathFor("tasks", taskId), updated);
    await this.writeReceipt({
      kind: "task_completed",
      task_id: taskId,
      summary: `${input.status === "done" ? "Completed" : "Blocked"} task ${taskId}`
    });
    return result;
  }

  async listResults(): Promise<Result[]> {
    await this.ensure();
    return (await this.readAll("results", ResultSchema)).sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async getResult(taskId: string): Promise<Result> {
    return ResultSchema.parse(await this.readJson(this.pathFor("results", taskId)));
  }

  async writeReceipt(input: Omit<Receipt, "schema_version" | "id" | "created_at">): Promise<Receipt> {
    await this.ensure();
    const receipt = ReceiptSchema.parse({
      schema_version: SCHEMA_VERSION,
      id: await this.uniqueId("receipt", input.kind, "receipts"),
      created_at: nowIso(),
      ...input
    });
    await this.writeJson(this.pathFor("receipts", receipt.id), receipt);
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

  private pathFor(kind: "tasks" | "results" | "sessions" | "receipts", id: string): string {
    return path.join(this.dir(kind), `${id}.json`);
  }

  private async readAll<T>(kind: "tasks" | "results", schema: { parse(value: unknown): T }): Promise<T[]> {
    const { readdir } = await import("node:fs/promises");
    const dir = this.dir(kind);
    const entries = await readdir(dir, { withFileTypes: true });
    const items: T[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      items.push(schema.parse(await this.readJson(path.join(dir, entry.name))));
    }
    return items;
  }

  private async readJson(filePath: string): Promise<unknown> {
    return JSON.parse(await readFile(filePath, "utf8"));
  }

  private async writeJson(filePath: string, value: unknown): Promise<void> {
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tmp, filePath);
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
