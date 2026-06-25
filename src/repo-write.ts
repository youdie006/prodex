import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { assertResolvedRepoPathAllowed, resolveRepoPath } from "./repo.js";
import { readVerifiedUtf8File, replaceVerifiedUtf8File } from "./safe-file.js";
import type { Receipt } from "./schema.js";
import type { BridgeStore } from "./store.js";

const execFileAsync = promisify(execFile);
const MAX_WRITE_BYTES = 1_000_000;

export type RepoWriteTestHooks = {
  beforeAppliedReceipt?: (path: string) => Promise<void> | void;
  beforeGitAdd?: (paths: string[]) => Promise<void> | void;
  beforeStageReceipt?: (paths: string[]) => Promise<void> | void;
};

let testHooks: RepoWriteTestHooks = {};

export function setRepoWriteTestHooks(hooks: RepoWriteTestHooks): void {
  testHooks = hooks;
}

export interface RepoWriteDryRunInput {
  path: string;
  content: string;
  expected_head: string;
}

export interface RepoWriteApplyInput {
  receipt_id: string;
  expected_head: string;
  preimage_sha256: string;
}

export interface RepoStageReviewedPathsInput {
  receipt_ids: string[];
  expected_head: string;
}

export interface RepoWriteDryRunResult {
  receipt: Receipt;
  path: string;
  expected_head: string;
  preimage_sha256: string;
  new_sha256: string;
  diff: string;
}

export interface RepoWriteApplyResult {
  receipt: Receipt;
  path: string;
  expected_head: string;
  preimage_sha256: string;
  new_sha256: string;
}

export interface RepoStageReviewedPathsResult {
  receipt: Receipt;
  paths: string[];
  receipt_ids: string[];
  expected_head: string;
}

interface DryRunMetadata {
  path: string;
  expected_head: string;
  preimage_sha256: string;
  new_sha256: string;
  diff: string;
  new_content_artifact?: string;
  new_content?: string;
}

interface AppliedMetadata {
  path: string;
  expected_head: string;
  preimage_sha256: string;
  new_sha256: string;
}

interface GitIndexEntry {
  mode: string;
  objectId: string;
}

export async function createRepoWriteDryRun(
  root: string,
  store: BridgeStore,
  input: RepoWriteDryRunInput
): Promise<RepoWriteDryRunResult> {
  const head = await assertGitHead(root, input.expected_head);
  if (Buffer.byteLength(input.content, "utf8") > MAX_WRITE_BYTES) {
    throw new Error(`New content is too large to write through repo tools`);
  }

  const current = await readWritableExistingFile(root, input.path);
  if (current.content === input.content) {
    throw new Error(`No changes for ${input.path}`);
  }

  const preimage = sha256(current.content);
  const newSha = sha256(input.content);
  const diff = buildSimpleDiff(input.path, current.content, input.content);
  const candidateArtifactPath = `.bridge/artifacts/repo-writes/${newSha}.txt`;
  const artifactAlreadyExisted = await store.hasArtifactText(candidateArtifactPath);
  const artifactPath = await store.writeArtifactText(candidateArtifactPath, input.content);
  const metadata: DryRunMetadata = {
    path: input.path,
    expected_head: head,
    preimage_sha256: preimage,
    new_sha256: newSha,
    diff,
    new_content_artifact: artifactPath
  };
  let receipt: Receipt;
  try {
    receipt = await store.writeReceipt({
      kind: "repo_write_dry_run",
      summary: `Dry-run write for ${input.path}`,
      metadata: metadata as unknown as Record<string, unknown>
    });
  } catch (error) {
    if (!artifactAlreadyExisted) {
      try {
        await store.deleteArtifactTextIfPresent(artifactPath);
      } catch (cleanupError) {
        throw new Error(`${errorMessage(error)} (also failed to clean up write artifact: ${errorMessage(cleanupError)})`);
      }
    }
    throw error;
  }

  return {
    receipt,
    path: input.path,
    expected_head: head,
    preimage_sha256: preimage,
    new_sha256: newSha,
    diff
  };
}

export async function applyRepoWriteDryRun(
  root: string,
  store: BridgeStore,
  input: RepoWriteApplyInput
): Promise<RepoWriteApplyResult> {
  const dryRunReceipt = await store.getTrustedReceipt(input.receipt_id);
  if (dryRunReceipt.kind !== "repo_write_dry_run") {
    throw new Error(`Receipt ${input.receipt_id} is not a repo_write_dry_run receipt`);
  }
  const metadata = parseDryRunMetadata(dryRunReceipt.metadata);
  if (metadata.expected_head !== input.expected_head) {
    throw new Error(`Expected HEAD does not match dry-run receipt`);
  }
  if (metadata.preimage_sha256 !== input.preimage_sha256) {
    throw new Error(`Expected preimage does not match dry-run receipt`);
  }

  await assertGitHead(root, input.expected_head);
  const current = await readWritableExistingFile(root, metadata.path);
  const currentPreimage = sha256(current.content);
  if (currentPreimage !== input.preimage_sha256) {
    throw new Error(`File preimage changed for ${metadata.path}`);
  }

  const newContent = await readDryRunReplacementContent(store, metadata);

  let receipt: Receipt | undefined;
  try {
    await replaceVerifiedUtf8File(
      current.resolved,
      newContent,
      async () => {
        await assertResolvedRepoPathAllowed(root, current.resolved, metadata.path);
        await assertGitHead(root, input.expected_head);
      },
      async (latestContent) => {
        await assertGitHead(root, input.expected_head);
        if (sha256(latestContent) !== input.preimage_sha256) {
          throw new Error(`File preimage changed for ${metadata.path}`);
        }
      },
      { maxBytes: MAX_WRITE_BYTES }
    );
    await testHooks.beforeAppliedReceipt?.(metadata.path);
    await assertGitHead(root, input.expected_head);
    receipt = await store.writeReceipt({
      kind: "repo_write_applied",
      summary: `Applied write receipt ${input.receipt_id} to ${metadata.path}`,
      metadata: {
        dry_run_receipt_id: input.receipt_id,
        path: metadata.path,
        expected_head: input.expected_head,
        preimage_sha256: input.preimage_sha256,
        new_sha256: metadata.new_sha256
      }
    });
    await assertGitHead(root, input.expected_head);
  } catch (error) {
    const cleanupErrors: string[] = [];
    if (receipt) {
      try {
        await store.deleteReceiptIfPresent(receipt.id);
      } catch (cleanupError) {
        cleanupErrors.push(`failed to delete applied receipt ${receipt.id}: ${errorMessage(cleanupError)}`);
      }
    }
    try {
      await rollbackReplacementIfPresent(root, current.resolved, metadata.path, current.content, metadata.new_sha256);
    } catch (rollbackError) {
      cleanupErrors.push(`failed to roll back replacement: ${errorMessage(rollbackError)}`);
    }
    if (cleanupErrors.length > 0) throw new Error(`${errorMessage(error)} (also ${cleanupErrors.join("; ")})`);
    throw error;
  }
  if (!receipt) throw new Error("Applied write receipt was not stored");
  return {
    receipt,
    path: metadata.path,
    expected_head: input.expected_head,
    preimage_sha256: input.preimage_sha256,
    new_sha256: metadata.new_sha256
  };
}

export async function stageReviewedPaths(
  root: string,
  store: BridgeStore,
  input: RepoStageReviewedPathsInput
): Promise<RepoStageReviewedPathsResult> {
  if (input.receipt_ids.length === 0) {
    throw new Error("At least one applied write receipt is required");
  }
  await assertGitHead(root, input.expected_head);

  const paths = new Set<string>();
  const expectedObjectIdByPath = new Map<string, string>();
  for (const receiptId of input.receipt_ids) {
    const receipt = await store.getTrustedReceipt(receiptId);
    if (receipt.kind !== "repo_write_applied") {
      throw new Error(`Receipt ${receiptId} is not a repo_write_applied receipt`);
    }
    const metadata = parseAppliedMetadata(receipt.metadata);
    if (metadata.expected_head !== input.expected_head) {
      throw new Error(`Expected HEAD does not match applied receipt ${receiptId}`);
    }

    const current = await readWritableExistingFile(root, metadata.path);
    const currentSha = sha256(current.content);
    if (currentSha !== metadata.new_sha256) {
      throw new Error(`File content changed after applied receipt ${receiptId} for ${metadata.path}`);
    }
    const gitPath = path.relative(root, current.resolved).replaceAll(path.sep, "/");
    paths.add(gitPath);
    expectedObjectIdByPath.set(gitPath, await gitObjectIdForContent(root, gitPath, current.content));
  }

  const stagedPaths = Array.from(paths).sort();
  const originalIndexEntries = await readGitIndexEntries(root, stagedPaths);
  let staged = false;
  let receipt: Receipt | undefined;
  try {
    await testHooks.beforeGitAdd?.(stagedPaths);
    await assertGitHead(root, input.expected_head);
    await execFileAsync("git", ["add", "--", ...stagedPaths], { cwd: root });
    staged = true;
    await verifyStagedContent(root, expectedObjectIdByPath);
    await testHooks.beforeStageReceipt?.(stagedPaths);
    await assertGitHead(root, input.expected_head);
    receipt = await store.writeReceipt({
      kind: "repo_stage_reviewed_paths",
      summary: `Staged reviewed paths: ${stagedPaths.join(", ")}`,
      metadata: {
        expected_head: input.expected_head,
        receipt_ids: input.receipt_ids,
        paths: stagedPaths
      }
    });
    await assertGitHead(root, input.expected_head);
    return {
      receipt,
      paths: stagedPaths,
      receipt_ids: input.receipt_ids,
      expected_head: input.expected_head
    };
  } catch (error) {
    const cleanupErrors: string[] = [];
    if (receipt) {
      try {
        await store.deleteReceiptIfPresent(receipt.id);
      } catch (cleanupError) {
        cleanupErrors.push(`failed to delete stage receipt ${receipt.id}: ${errorMessage(cleanupError)}`);
      }
    }
    if (staged) {
      try {
        await restoreGitIndexEntries(root, originalIndexEntries);
      } catch (restoreError) {
        cleanupErrors.push(`failed to restore git index: ${errorMessage(restoreError)}`);
      }
    }
    if (cleanupErrors.length > 0) throw new Error(`${errorMessage(error)} (also ${cleanupErrors.join("; ")})`);
    throw error;
  }
}

async function gitObjectIdForContent(root: string, gitPath: string, content: string): Promise<string> {
  return runGitWithStdin(root, ["hash-object", `--path=${gitPath}`, "--stdin"], content);
}

async function verifyStagedContent(root: string, expectedObjectIdByPath: Map<string, string>): Promise<void> {
  for (const [gitPath, expectedObjectId] of expectedObjectIdByPath) {
    const stagedObjectId = await gitObjectIdForStagedPath(root, gitPath);
    if (stagedObjectId !== expectedObjectId) {
      throw new Error(`Staged content changed before git add for ${gitPath}`);
    }
  }
}

async function gitObjectIdForStagedPath(root: string, gitPath: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["ls-files", "--stage", "-z", "--", gitPath], {
    cwd: root,
    maxBuffer: MAX_WRITE_BYTES + 1024
  });
  const entry = stdout.split("\0").find(Boolean);
  const objectId = entry?.split(/\s+/)[1];
  if (!objectId) {
    throw new Error(`Path ${gitPath} was not staged`);
  }
  return objectId;
}

async function readGitIndexEntries(root: string, paths: string[]): Promise<Map<string, GitIndexEntry | undefined>> {
  const entries = new Map<string, GitIndexEntry | undefined>();
  for (const gitPath of paths) {
    const { stdout } = await execFileAsync("git", ["ls-files", "--stage", "-z", "--", gitPath], {
      cwd: root,
      encoding: "buffer",
      maxBuffer: MAX_WRITE_BYTES + 1024
    });
    entries.set(gitPath, parseGitIndexEntry(stdout));
  }
  return entries;
}

function parseGitIndexEntry(stdout: Buffer): GitIndexEntry | undefined {
  const entry = stdout.toString("utf8").split("\0").find(Boolean);
  if (!entry) return undefined;
  const match = /^(\d+)\s+([a-f0-9]{40,64})\s+\d+\t/.exec(entry);
  if (!match) {
    throw new Error("Could not parse git index entry for staged path");
  }
  return { mode: match[1], objectId: match[2] };
}

async function restoreGitIndexEntries(root: string, entries: Map<string, GitIndexEntry | undefined>): Promise<void> {
  for (const [gitPath, entry] of entries) {
    if (entry) {
      await execFileAsync("git", ["update-index", "--add", "--cacheinfo", entry.mode, entry.objectId, gitPath], { cwd: root }).catch(
        () => undefined
      );
    } else {
      await execFileAsync("git", ["rm", "--cached", "--ignore-unmatch", "--", gitPath], { cwd: root }).catch(() => undefined);
    }
  }
}

async function runGitWithStdin(root: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8").trim());
      } else {
        reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `git ${args.join(" ")} failed with code ${code}`));
      }
    });
    child.stdin.end(input, "utf8");
  });
}

async function getGitHead(root: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root });
    return stdout.trim();
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      throw new Error("git is required on PATH for repo write tools");
    }
    if (isMissingGitHeadError(error)) {
      throw new Error("repo write tools require a git worktree with a committed HEAD");
    }
    throw new Error(`git HEAD check failed: ${commandFailureDetail(error)}`);
  }
}

async function assertGitHead(root: string, expectedHead: string): Promise<string> {
  const head = await getGitHead(root);
  if (head !== expectedHead) {
    throw new Error(`Git HEAD mismatch: expected ${expectedHead}, got ${head}`);
  }
  return head;
}

async function rollbackReplacementIfPresent(
  root: string,
  resolvedPath: string,
  repoPath: string,
  originalContent: string,
  replacementSha: string
): Promise<void> {
  let currentContent: string;
  try {
    currentContent = await readVerifiedUtf8File(resolvedPath, () => assertResolvedRepoPathAllowed(root, resolvedPath, repoPath), {
      maxBytes: MAX_WRITE_BYTES
    });
  } catch {
    return;
  }
  if (sha256(currentContent) !== replacementSha) return;
  await replaceVerifiedUtf8File(
    resolvedPath,
    originalContent,
    () => assertResolvedRepoPathAllowed(root, resolvedPath, repoPath),
    (latestContent) => {
      if (sha256(latestContent) !== replacementSha) {
        throw new Error(`Cannot roll back ${repoPath}; replacement content changed`);
      }
    },
    { maxBytes: MAX_WRITE_BYTES }
  );
}

async function readWritableExistingFile(root: string, repoPath: string): Promise<{ resolved: string; content: string }> {
  const resolved = resolveRepoPath(root, repoPath);
  await assertResolvedRepoPathAllowed(root, resolved, repoPath);
  const content = await readVerifiedUtf8File(resolved, () => assertResolvedRepoPathAllowed(root, resolved, repoPath), {
    maxBytes: MAX_WRITE_BYTES
  }).catch((error) => {
    if (error instanceof Error && /too large/.test(error.message)) {
      throw new Error(`Path ${repoPath} is too large to write through repo tools`);
    }
    throw error;
  });
  return { resolved, content };
}

function parseDryRunMetadata(value: Record<string, unknown>): DryRunMetadata {
  const metadata = value as Partial<DryRunMetadata>;
  for (const key of ["path", "expected_head", "preimage_sha256", "new_sha256", "diff"] as const) {
    if (typeof metadata[key] !== "string") {
      throw new Error(`Dry-run receipt metadata is missing ${key}`);
    }
  }
  if (typeof metadata.new_content_artifact !== "string" && typeof metadata.new_content !== "string") {
    throw new Error(`Dry-run receipt metadata is missing new_content_artifact`);
  }
  return metadata as DryRunMetadata;
}

async function readDryRunReplacementContent(store: BridgeStore, metadata: DryRunMetadata): Promise<string> {
  const newContent = metadata.new_content_artifact
    ? await store.readArtifactText(metadata.new_content_artifact, { maxBytes: MAX_WRITE_BYTES })
    : metadata.new_content;
  if (typeof newContent !== "string") {
    throw new Error(`Dry-run receipt metadata is missing replacement content`);
  }
  const newContentBytes = Buffer.byteLength(newContent, "utf8");
  if (newContentBytes > MAX_WRITE_BYTES) {
    throw new Error(`Dry-run replacement content is too large (${newContentBytes} bytes > ${MAX_WRITE_BYTES} bytes)`);
  }
  if (sha256(newContent) !== metadata.new_sha256) {
    throw new Error(
      metadata.new_content_artifact
        ? `Dry-run artifact content changed for ${metadata.path}`
        : `Dry-run inline content does not match receipt hash for ${metadata.path}`
    );
  }
  return newContent;
}

function parseAppliedMetadata(value: Record<string, unknown>): AppliedMetadata {
  const metadata = value as Partial<AppliedMetadata>;
  for (const key of ["path", "expected_head", "preimage_sha256", "new_sha256"] as const) {
    if (typeof metadata[key] !== "string") {
      throw new Error(`Applied receipt metadata is missing ${key}`);
    }
  }
  return metadata as AppliedMetadata;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function isMissingGitHeadError(error: unknown): boolean {
  const detail = commandFailureDetail(error);
  return /not a git repository|needed a single revision|ambiguous argument ['"]?HEAD|unknown revision or path not in the working tree/i.test(
    detail
  );
}

function commandFailureDetail(error: unknown): string {
  const failed = typeof error === "object" && error !== null ? error : {};
  const stderr = firstOutputLine((failed as { stderr?: unknown }).stderr);
  if (stderr) return stderr;
  const stdout = firstOutputLine((failed as { stdout?: unknown }).stdout);
  if (stdout) return stdout;
  if (typeof (failed as { code?: unknown }).code === "number") return `exit code ${(failed as { code: number }).code}`;
  if (typeof (failed as { signal?: unknown }).signal === "string" && (failed as { signal: string }).signal) {
    return `signal ${(failed as { signal: string }).signal}`;
  }
  return "failed without output";
}

function firstOutputLine(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

function buildSimpleDiff(repoPath: string, before: string, after: string): string {
  return [
    `--- a/${repoPath}`,
    `+++ b/${repoPath}`,
    ...before.replace(/\r\n/g, "\n").split("\n").map((line) => `-${line}`),
    ...after.replace(/\r\n/g, "\n").split("\n").map((line) => `+${line}`)
  ].join("\n");
}
