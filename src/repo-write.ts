import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { resolveRepoPath } from "./repo.js";
import { readVerifiedUtf8File, replaceVerifiedUtf8File } from "./safe-file.js";
import type { Receipt } from "./schema.js";
import type { BridgeStore } from "./store.js";

const execFileAsync = promisify(execFile);
const MAX_WRITE_BYTES = 1_000_000;

export type RepoWriteTestHooks = {
  beforeGitAdd?: (paths: string[]) => Promise<void> | void;
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

export async function createRepoWriteDryRun(
  root: string,
  store: BridgeStore,
  input: RepoWriteDryRunInput
): Promise<RepoWriteDryRunResult> {
  const head = await getGitHead(root);
  if (head !== input.expected_head) {
    throw new Error(`Git HEAD mismatch: expected ${input.expected_head}, got ${head}`);
  }
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
  const artifactPath = await store.writeArtifactText(`.bridge/artifacts/repo-writes/${newSha}.txt`, input.content);
  const metadata: DryRunMetadata = {
    path: input.path,
    expected_head: head,
    preimage_sha256: preimage,
    new_sha256: newSha,
    diff,
    new_content_artifact: artifactPath
  };
  const receipt = await store.writeReceipt({
    kind: "repo_write_dry_run",
    summary: `Dry-run write for ${input.path}`,
    metadata: metadata as unknown as Record<string, unknown>
  });

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
  const dryRunReceipt = await store.getReceipt(input.receipt_id);
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

  const head = await getGitHead(root);
  if (head !== input.expected_head) {
    throw new Error(`Git HEAD mismatch: expected ${input.expected_head}, got ${head}`);
  }
  const current = await readWritableExistingFile(root, metadata.path);
  const currentPreimage = sha256(current.content);
  if (currentPreimage !== input.preimage_sha256) {
    throw new Error(`File preimage changed for ${metadata.path}`);
  }

  const newContent = await readDryRunReplacementContent(store, metadata);

  await replaceVerifiedUtf8File(
    current.resolved,
    newContent,
    () => assertRealPathInside(root, current.resolved, metadata.path),
    (latestContent) => {
      if (sha256(latestContent) !== input.preimage_sha256) {
        throw new Error(`File preimage changed for ${metadata.path}`);
      }
    },
    { maxBytes: MAX_WRITE_BYTES }
  );
  const receipt = await store.writeReceipt({
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
  const head = await getGitHead(root);
  if (head !== input.expected_head) {
    throw new Error(`Git HEAD mismatch: expected ${input.expected_head}, got ${head}`);
  }

  const paths = new Set<string>();
  const expectedObjectIdByPath = new Map<string, string>();
  for (const receiptId of input.receipt_ids) {
    const receipt = await store.getReceipt(receiptId);
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
  await testHooks.beforeGitAdd?.(stagedPaths);
  await execFileAsync("git", ["add", "--", ...stagedPaths], { cwd: root });
  try {
    await verifyStagedContent(root, expectedObjectIdByPath);
  } catch (error) {
    await unstagePaths(root, stagedPaths);
    throw error;
  }
  const receipt = await store.writeReceipt({
    kind: "repo_stage_reviewed_paths",
    summary: `Staged reviewed paths: ${stagedPaths.join(", ")}`,
    metadata: {
      expected_head: input.expected_head,
      receipt_ids: input.receipt_ids,
      paths: stagedPaths
    }
  });
  return {
    receipt,
    paths: stagedPaths,
    receipt_ids: input.receipt_ids,
    expected_head: input.expected_head
  };
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

async function unstagePaths(root: string, paths: string[]): Promise<void> {
  await execFileAsync("git", ["restore", "--staged", "--", ...paths], { cwd: root }).catch(() => undefined);
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
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root });
  return stdout.trim();
}

async function readWritableExistingFile(root: string, repoPath: string): Promise<{ resolved: string; content: string }> {
  const resolved = resolveRepoPath(root, repoPath);
  const content = await readVerifiedUtf8File(resolved, () => assertRealPathInside(root, resolved, repoPath), {
    maxBytes: MAX_WRITE_BYTES
  }).catch((error) => {
    if (error instanceof Error && /too large/.test(error.message)) {
      throw new Error(`Path ${repoPath} is too large to write through repo tools`);
    }
    throw error;
  });
  return { resolved, content };
}

async function assertRealPathInside(root: string, resolved: string, repoPath: string): Promise<void> {
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(resolved)]);
  const relative = path.relative(realRoot, realTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path ${repoPath} escapes the repository root after resolving symlinks`);
  }
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
    ? await store.readArtifactText(metadata.new_content_artifact)
    : metadata.new_content;
  if (typeof newContent !== "string") {
    throw new Error(`Dry-run receipt metadata is missing replacement content`);
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

function buildSimpleDiff(repoPath: string, before: string, after: string): string {
  return [
    `--- a/${repoPath}`,
    `+++ b/${repoPath}`,
    ...before.replace(/\r\n/g, "\n").split("\n").map((line) => `-${line}`),
    ...after.replace(/\r\n/g, "\n").split("\n").map((line) => `+${line}`)
  ].join("\n");
}
