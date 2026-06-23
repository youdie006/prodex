import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { resolveRepoPath } from "./repo.js";
import type { Receipt } from "./schema.js";
import type { BridgeStore } from "./store.js";

const execFileAsync = promisify(execFile);
const MAX_WRITE_BYTES = 1_000_000;

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

interface DryRunMetadata {
  path: string;
  expected_head: string;
  preimage_sha256: string;
  new_sha256: string;
  diff: string;
  new_content: string;
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
  const metadata: DryRunMetadata = {
    path: input.path,
    expected_head: head,
    preimage_sha256: preimage,
    new_sha256: newSha,
    diff,
    new_content: input.content
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

  await writeFile(current.resolved, metadata.new_content, "utf8");
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

async function getGitHead(root: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root });
  return stdout.trim();
}

async function readWritableExistingFile(root: string, repoPath: string): Promise<{ resolved: string; content: string }> {
  const resolved = resolveRepoPath(root, repoPath);
  await assertRealPathInside(root, resolved, repoPath);
  const stat = await lstat(resolved);
  if (!stat.isFile()) {
    throw new Error(`Path ${repoPath} is not a regular file`);
  }
  if (stat.size > MAX_WRITE_BYTES) {
    throw new Error(`Path ${repoPath} is too large to write through repo tools (${stat.size} bytes)`);
  }
  return { resolved, content: await readFile(resolved, "utf8") };
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
  for (const key of ["path", "expected_head", "preimage_sha256", "new_sha256", "diff", "new_content"] as const) {
    if (typeof metadata[key] !== "string") {
      throw new Error(`Dry-run receipt metadata is missing ${key}`);
    }
  }
  return metadata as DryRunMetadata;
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
