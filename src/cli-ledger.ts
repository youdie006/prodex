import {
  assertNoExtraArgs,
  assertOnlyOptions,
  isHelpSubcommand,
  printHelpIfRequested,
  readFlag,
  readPositionalsWithOptions,
  readReceiptKindFlag,
  readRepeatedFlag,
  readSessionStatusFlag,
  readTaskStatusFlag,
  resolveCwdFlag,
  unknownSubcommandError
} from "./cli-args.js";
import { printReceiptsHelp, printResultsHelp, printSessionsHelp, printTasksHelp } from "./cli-help.js";
import { sourceAwareResultError } from "./cli-shared.js";
import type { CliIO } from "./cli.js";
import type { BridgeFile, Receipt } from "./schema.js";
import { BridgeStore, type ListReceiptsInput } from "./store.js";

export async function runTasksCommand(rest: string[], io: CliIO): Promise<number> {
    const [subcommand, ...taskArgs] = rest;
    if (!subcommand || isHelpSubcommand(subcommand)) {
      assertNoExtraArgs(taskArgs, "tasks help", 0);
      printTasksHelp(io.stdout);
      return 0;
    }
    if (subcommand === "create") {
      if (printHelpIfRequested(taskArgs, "tasks create", io.stdout, printTasksHelp, { valueFlags: ["--cwd", "--title", "--prompt", "--repo-id", "--file"] })) return 0;
      assertOnlyOptions(taskArgs, "tasks create", ["--cwd", "--title", "--prompt", "--repo-id", "--file"]);
      const title = readFlag(taskArgs, "--title");
      const prompt = readFlag(taskArgs, "--prompt");
      if (!title || !prompt) throw new Error("tasks create requires --title and --prompt");
      const targetStore = new BridgeStore(resolveCwdFlag(io.cwd, taskArgs));
      const task = await targetStore.createTask({
        source: "codex",
        title,
        prompt,
        repo_id: readFlag(taskArgs, "--repo-id") ?? "default",
        files: readRepeatedFlag(taskArgs, "--file").map((file) => ({ path: file, role: "context" as const })),
        provenance: { adapter: "cli", warnings: [] }
      });
      io.stdout(`${task.id}\t${task.status}\t${task.title}`);
      return 0;
    }
    if (subcommand === "list") {
      if (printHelpIfRequested(taskArgs, "tasks list", io.stdout, printTasksHelp, { valueFlags: ["--cwd", "--status"] })) return 0;
      assertOnlyOptions(taskArgs, "tasks list", ["--cwd", "--status"], ["--json"]);
      const targetStore = new BridgeStore(resolveCwdFlag(io.cwd, taskArgs));
      const status = readTaskStatusFlag(taskArgs);
      const tasks = await listTasksForInspection(targetStore, status);
      if (taskArgs.includes("--json")) {
        io.stdout(JSON.stringify(tasks, null, 2));
        return 0;
      }
      if (tasks.length === 0) {
        io.stdout(status ? `No tasks with status ${status}.` : "No tasks yet.");
        return 0;
      }
      for (const task of tasks) {
        io.stdout(`${task.id}\t${task.status}\t${task.title}`);
      }
      return 0;
    }
    if (subcommand === "show") {
      if (printHelpIfRequested(taskArgs, "tasks show", io.stdout, printTasksHelp, { valueFlags: ["--cwd"], maxPositionals: 1 })) return 0;
      const [taskId] = readPositionalsWithOptions(taskArgs, "tasks show", 1, ["--cwd"]);
      if (!taskId) throw new Error("tasks show requires <task-id|latest>");
      const targetStore = new BridgeStore(resolveCwdFlag(io.cwd, taskArgs));
      const task = taskId === "latest" ? await latestTask(targetStore, { readOnly: true }) : await targetStore.getTaskReadOnly(taskId);
      if (!task) throw new Error(taskId === "latest" ? "No tasks found" : `Task not found: ${taskId}`);
      io.stdout(JSON.stringify(task, null, 2));
      return 0;
    }
    if (subcommand === "claim") {
      if (printHelpIfRequested(taskArgs, "tasks claim", io.stdout, printTasksHelp, { valueFlags: ["--cwd", "--by"], maxPositionals: 1 })) return 0;
      const [taskId] = readPositionalsWithOptions(taskArgs, "tasks claim", 1, ["--cwd", "--by"]);
      if (!taskId) throw new Error("tasks claim requires <task-id>");
      const targetStore = new BridgeStore(resolveCwdFlag(io.cwd, taskArgs));
      const task = await targetStore.claimTask(taskId, readFlag(taskArgs, "--by") ?? "codex");
      io.stdout(`${task.id}\t${task.status}\t${task.claimed_by ?? ""}`);
      return 0;
    }
    if (subcommand === "complete") {
      if (
        printHelpIfRequested(taskArgs, "tasks complete", io.stdout, printTasksHelp, {
          valueFlags: ["--cwd", "--summary", "--command", "--artifact"],
          maxPositionals: 1
        })
      ) {
        return 0;
      }
      const [taskId] = readPositionalsWithOptions(taskArgs, "tasks complete", 1, ["--cwd", "--summary", "--command", "--artifact"]);
      if (!taskId) throw new Error("tasks complete requires <task-id> --summary");
      const summary = readFlag(taskArgs, "--summary");
      if (!summary) throw new Error("tasks complete requires <task-id> --summary");
      const targetStore = new BridgeStore(resolveCwdFlag(io.cwd, taskArgs));
      const result = await targetStore.completeTask(taskId, {
        status: "done",
        summary,
        commands: readRepeatedFlag(taskArgs, "--command"),
        artifacts: await writeTaskCompleteArtifacts(targetStore, readRepeatedFlag(taskArgs, "--artifact"))
      });
      io.stdout(`${result.task_id}\t${result.status}\t${result.summary}`);
      return 0;
    }
    if (subcommand === "block") {
      if (
        printHelpIfRequested(taskArgs, "tasks block", io.stdout, printTasksHelp, {
          valueFlags: ["--cwd", "--summary", "--code", "--next-step", "--command"],
          booleanFlags: ["--retryable"],
          maxPositionals: 1
        })
      ) {
        return 0;
      }
      const [taskId] = readPositionalsWithOptions(taskArgs, "tasks block", 1, ["--cwd", "--summary", "--code", "--next-step", "--command"], ["--retryable"]);
      if (!taskId) throw new Error("tasks block requires <task-id> --summary");
      const summary = readFlag(taskArgs, "--summary");
      if (!summary) throw new Error("tasks block requires <task-id> --summary");
      const targetStore = new BridgeStore(resolveCwdFlag(io.cwd, taskArgs));
      const result = await targetStore.completeTask(taskId, {
        status: "blocked",
        summary,
        blocker: {
          code: readFlag(taskArgs, "--code") ?? "manual_blocker",
          message: summary,
          retryable: taskArgs.includes("--retryable"),
          next_step: readFlag(taskArgs, "--next-step")
        },
        commands: readRepeatedFlag(taskArgs, "--command")
      });
      io.stdout(`${result.task_id}\t${result.status}\t${result.summary}`);
      return 0;
    }
    throw unknownSubcommandError("tasks", subcommand, ["create", "list", "show", "claim", "complete", "block"]);
}

export async function runResultsCommand(rest: string[], io: CliIO): Promise<number> {
    const [subcommand, ...resultArgs] = rest;
    if (!subcommand || isHelpSubcommand(subcommand)) {
      assertNoExtraArgs(resultArgs, "results help", 0);
      printResultsHelp(io.stdout);
      return 0;
    }
    if (subcommand === "show") {
      if (printHelpIfRequested(resultArgs, "results show", io.stdout, printResultsHelp, { valueFlags: ["--cwd"], maxPositionals: 1 })) return 0;
      const [taskId] = readPositionalsWithOptions(resultArgs, "results show", 1, ["--cwd"]);
      if (!taskId) throw new Error("results show requires <task-id|latest>");
      const targetCwd = resolveCwdFlag(io.cwd, resultArgs);
      const targetStore = new BridgeStore(targetCwd);
      const resultOptions = { cwd: readFlag(resultArgs, "--cwd") ? targetCwd : undefined };
      try {
        const resolvedTaskId = taskId === "latest" ? await latestResultTaskId(targetStore, { readOnly: true }) : taskId;
        io.stdout(JSON.stringify(await targetStore.getFinalizedResultReadOnly(resolvedTaskId), null, 2));
      } catch (error) {
        throw sourceAwareResultError(error, undefined, resultOptions);
      }
      return 0;
    }
    if (subcommand === "artifact") {
      if (printHelpIfRequested(resultArgs, "results artifact", io.stdout, printResultsHelp, { valueFlags: ["--cwd"], maxPositionals: 2 })) return 0;
      const [taskId, artifactPath] = readPositionalsWithOptions(resultArgs, "results artifact", 2, ["--cwd"]);
      if (!taskId) throw new Error("results artifact requires <task-id> [artifact-path]");
      const targetCwd = resolveCwdFlag(io.cwd, resultArgs);
      const targetStore = new BridgeStore(targetCwd);
      const resultOptions = { cwd: readFlag(resultArgs, "--cwd") ? targetCwd : undefined };
      try {
        const resolvedTaskId = taskId === "latest" ? await latestResultTaskId(targetStore, { readOnly: true }) : taskId;
        const artifact = await targetStore.readFinalizedResultArtifactText(resolvedTaskId, artifactPath);
        io.stdout(artifact.content);
      } catch (error) {
        throw sourceAwareResultError(error, undefined, resultOptions);
      }
      return 0;
    }
    if (subcommand === "reseal") {
      if (
        printHelpIfRequested(resultArgs, "results reseal", io.stdout, printResultsHelp, {
          valueFlags: ["--cwd"],
          booleanFlags: ["--confirm-current-result"],
          maxPositionals: 1
        })
      ) {
        return 0;
      }
      const [taskId] = readPositionalsWithOptions(resultArgs, "results reseal", 1, ["--cwd"], ["--confirm-current-result"]);
      if (!taskId) throw new Error("results reseal requires <task-id|latest> --confirm-current-result");
      if (!resultArgs.includes("--confirm-current-result")) {
        throw new Error("results reseal requires --confirm-current-result after you review the current .bridge/results/<task-id>.json payload locally.");
      }
      const targetStore = new BridgeStore(resolveCwdFlag(io.cwd, resultArgs));
      const resolvedTaskId = taskId === "latest" ? await latestRawResultTaskId(targetStore) : taskId;
      const resealed = await targetStore.resealResult(resolvedTaskId);
      io.stdout(`${resealed.result.task_id}\tresealed\t${resealed.receipt.id}\tresult_sha256=${resealed.receipt.metadata.result_sha256}`);
      return 0;
    }
    throw unknownSubcommandError("results", subcommand, ["show", "artifact", "reseal"]);
}

export async function runReceiptsCommand(rest: string[], io: CliIO): Promise<number> {
    const [subcommand, ...receiptArgs] = rest;
    if (!subcommand || isHelpSubcommand(subcommand)) {
      assertNoExtraArgs(receiptArgs, "receipts help", 0);
      printReceiptsHelp(io.stdout);
      return 0;
    }
    if (subcommand === "list") {
      if (printHelpIfRequested(receiptArgs, "receipts list", io.stdout, printReceiptsHelp, { valueFlags: ["--cwd", "--kind", "--task-id"] })) return 0;
      assertOnlyOptions(receiptArgs, "receipts list", ["--cwd", "--kind", "--task-id"], ["--json"]);
      const targetStore = new BridgeStore(resolveCwdFlag(io.cwd, receiptArgs));
      const receipts = await listReceiptsForInspection(targetStore, {
        kind: readReceiptKindFlag(receiptArgs),
        task_id: readFlag(receiptArgs, "--task-id")
      });
      if (receiptArgs.includes("--json")) {
        io.stdout(JSON.stringify(receipts, null, 2));
        return 0;
      }
      if (receipts.length === 0) {
        io.stdout("No receipts yet.");
        return 0;
      }
      for (const receipt of receipts) {
        io.stdout(`${receipt.id}\t${receipt.kind}\t${receipt.summary}${receiptInspectionListSuffix(receipt)}`);
      }
      return 0;
    }
    if (subcommand === "show") {
      if (printHelpIfRequested(receiptArgs, "receipts show", io.stdout, printReceiptsHelp, { valueFlags: ["--cwd"], maxPositionals: 1 })) return 0;
      const [receiptId] = readPositionalsWithOptions(receiptArgs, "receipts show", 1, ["--cwd"]);
      if (!receiptId) throw new Error("receipts show requires <receipt-id|latest>");
      const targetStore = new BridgeStore(resolveCwdFlag(io.cwd, receiptArgs));
      const receipt =
        receiptId === "latest" ? (await listReceiptsForInspection(targetStore))[0] : await targetStore.getReceiptForDisplayReadOnly(receiptId);
      if (!receipt) throw new Error(receiptId === "latest" ? "No receipts found" : `Receipt not found: ${receiptId}`);
      io.stdout(JSON.stringify(receipt, null, 2));
      return 0;
    }
    if (subcommand === "rotate-key") {
      if (printHelpIfRequested(receiptArgs, "receipts rotate-key", io.stdout, printReceiptsHelp, { valueFlags: ["--cwd"] })) return 0;
      assertOnlyOptions(receiptArgs, "receipts rotate-key", ["--cwd"]);
      const targetStore = new BridgeStore(resolveCwdFlag(io.cwd, receiptArgs));
      await targetStore.ensure();
      const rotated = await targetStore.rotateReceiptIntegrityKey();
      io.stdout(`Rotated the local receipt integrity key: ${rotated.keys} key(s) in .bridge/receipt-key.local.`);
      io.stdout("New receipts are signed with the new key; receipts signed before the rotation still verify via the retained legacy keys.");
      return 0;
    }
    throw unknownSubcommandError("receipts", subcommand, ["list", "show", "rotate-key"]);
}

export async function runSessionsCommand(rest: string[], io: CliIO): Promise<number> {
    const [subcommand, ...sessionArgs] = rest;
    if (!subcommand || isHelpSubcommand(subcommand)) {
      assertNoExtraArgs(sessionArgs, "sessions help", 0);
      printSessionsHelp(io.stdout);
      return 0;
    }
    if (subcommand === "list") {
      if (printHelpIfRequested(sessionArgs, "sessions list", io.stdout, printSessionsHelp, { valueFlags: ["--cwd", "--status"] })) return 0;
      assertOnlyOptions(sessionArgs, "sessions list", ["--cwd", "--status"], ["--json"]);
      const targetStore = new BridgeStore(resolveCwdFlag(io.cwd, sessionArgs));
      const status = readSessionStatusFlag(sessionArgs);
      const sessions = await listSessionsForInspection(targetStore, status);
      if (sessionArgs.includes("--json")) {
        io.stdout(JSON.stringify(sessions, null, 2));
        return 0;
      }
      if (sessions.length === 0) {
        io.stdout(status ? `No sessions with status ${status}.` : "No sessions yet.");
        return 0;
      }
      for (const session of sessions) {
        io.stdout(`${session.id}\t${session.status}\t${session.backend}\t${session.direction}`);
      }
      return 0;
    }
    if (subcommand === "show") {
      if (printHelpIfRequested(sessionArgs, "sessions show", io.stdout, printSessionsHelp, { valueFlags: ["--cwd"], maxPositionals: 1 })) return 0;
      const [sessionId] = readPositionalsWithOptions(sessionArgs, "sessions show", 1, ["--cwd"]);
      if (!sessionId) throw new Error("sessions show requires <session-id|latest>");
      const targetStore = new BridgeStore(resolveCwdFlag(io.cwd, sessionArgs));
      const session = sessionId === "latest" ? (await listSessionsForInspection(targetStore))[0] : await targetStore.getSessionReadOnly(sessionId);
      if (!session) throw new Error(sessionId === "latest" ? "No sessions found" : `Session not found: ${sessionId}`);
      io.stdout(formatSession(session));
      return 0;
    }
    if (subcommand === "cancel") {
      if (printHelpIfRequested(sessionArgs, "sessions cancel", io.stdout, printSessionsHelp, { valueFlags: ["--cwd"], maxPositionals: 1 })) return 0;
      const [sessionId] = readPositionalsWithOptions(sessionArgs, "sessions cancel", 1, ["--cwd"]);
      if (!sessionId) throw new Error("sessions cancel requires <session-id|latest>");
      const targetStore = new BridgeStore(resolveCwdFlag(io.cwd, sessionArgs));
      const target = sessionId === "latest" ? (await listSessionsForInspection(targetStore))[0] : undefined;
      if (sessionId === "latest" && !target) throw new Error("No sessions found");
      const session = await targetStore.cancelSession(target ? target.id : sessionId);
      io.stdout(`${session.id}\t${session.status}\tcancelled`);
      return 0;
    }
    throw unknownSubcommandError("sessions", subcommand, ["list", "show", "cancel"]);
}

export function formatSession(session: Awaited<ReturnType<BridgeStore["getSession"]>>): string {
  return JSON.stringify(
    {
      id: session.id,
      status: session.status,
      direction: session.direction,
      backend: session.backend,
      project: session.project,
      thread: session.thread,
      task_id: session.task_id,
      blocker: session.blocker,
      warnings: session.warnings,
      created_at: session.created_at,
      last_used_at: session.last_used_at
    },
    null,
    2
  );
}

export async function latestRawResultTaskId(store: BridgeStore): Promise<string> {
  const result = (await store.listResults()).at(-1);
  if (!result) throw new Error("No results found");
  return result.task_id;
}

export async function latestResultTaskId(store: BridgeStore, options: { readOnly?: boolean } = {}): Promise<string> {
  const results = options.readOnly ? await listResultsForInspection(store) : await store.listResults();
  const result = results.at(-1);
  if (!result) throw new Error("No results found");
  return result.task_id;
}

export async function latestTask(
  store: BridgeStore,
  options: { readOnly?: boolean } = {}
): Promise<Awaited<ReturnType<BridgeStore["listTasks"]>>[number] | undefined> {
  const tasks = options.readOnly ? await listTasksForInspection(store) : await store.listTasks();
  return tasks.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))[0];
}

export async function listReceiptsForInspection(store: BridgeStore, input: ListReceiptsInput = {}): Promise<Awaited<ReturnType<BridgeStore["listReceipts"]>>> {
  return store.listReceiptsReadOnly(input);
}

export async function listSessionsForInspection(
  store: BridgeStore,
  status?: Parameters<BridgeStore["listSessions"]>[0]
): Promise<Awaited<ReturnType<BridgeStore["listSessions"]>>> {
  return store.listSessionsReadOnly(status);
}

export function receiptInspectionListSuffix(receipt: Receipt): string {
  const status = receipt.metadata.integrity_status;
  if (
    typeof status === "object" &&
    status !== null &&
    "trusted" in status &&
    (status as { trusted?: unknown }).trusted === false
  ) {
    return "\tintegrity=untrusted";
  }
  return "";
}

export async function writeTaskCompleteArtifacts(store: BridgeStore, values: string[]): Promise<BridgeFile[]> {
  const artifacts: BridgeFile[] = [];
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator <= 0) {
      throw new Error("tasks complete --artifact requires path=text");
    }
    const artifactPath = value.slice(0, separator);
    const content = value.slice(separator + 1);
    if (!artifactPath.trim()) {
      throw new Error("tasks complete --artifact requires path=text");
    }
    const storedPath = await store.writeArtifactText(artifactPath, content);
    artifacts.push({ path: storedPath, role: "result" });
  }
  return artifacts;
}

export async function listTasksForInspection(
  store: BridgeStore,
  status?: Parameters<BridgeStore["listTasks"]>[0]
): Promise<Awaited<ReturnType<BridgeStore["listTasks"]>>> {
  return store.listTasksReadOnly(status);
}

export async function listResultsForInspection(store: BridgeStore): Promise<Awaited<ReturnType<BridgeStore["listResults"]>>> {
  return store.listFinalizedResultsReadOnly();
}

export async function listRawResultsForInspection(store: BridgeStore): Promise<Awaited<ReturnType<BridgeStore["listResults"]>>> {
  return store.listResultsReadOnly();
}
