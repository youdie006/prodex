import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ReadRepoFileOptions {
  startLine?: number;
  maxLines?: number;
}

export interface ReadRepoFileResult {
  path: string;
  start_line: number;
  end_line: number;
  total_lines: number;
  content: string;
}

export interface SearchResult {
  path: string;
  line: number;
  text: string;
}

export function assertRepoRelativePath(repoPath: string): void {
  if (!repoPath || repoPath.trim() === "") {
    throw new Error("Path must be a non-empty repo-relative path");
  }
  if (path.isAbsolute(repoPath)) {
    throw new Error("Path must be repo-relative, not absolute");
  }
  const normalized = path.posix.normalize(repoPath.replaceAll("\\", "/"));
  if (normalized === "." || normalized.startsWith("../") || normalized === "..") {
    throw new Error("Path must stay inside the repo-relative root");
  }
}

export function resolveRepoPath(root: string, repoPath: string): string {
  assertRepoRelativePath(repoPath);
  const resolved = path.resolve(root, repoPath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path ${repoPath} escapes the repository root`);
  }
  return resolved;
}

export async function readRepoFile(root: string, repoPath: string, options: ReadRepoFileOptions = {}): Promise<ReadRepoFileResult> {
  const resolved = resolveRepoPath(root, repoPath);
  await assertRealPathInside(root, resolved, repoPath);
  const stat = await lstat(resolved);
  if (!stat.isFile()) {
    throw new Error(`Path ${repoPath} is not a regular file`);
  }
  const text = await readFile(resolved, "utf8");
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const startLine = Math.max(1, options.startLine ?? 1);
  const maxLines = Math.max(1, Math.min(options.maxLines ?? 200, 500));
  const selected = lines.slice(startLine - 1, startLine - 1 + maxLines);
  return {
    path: repoPath,
    start_line: startLine,
    end_line: startLine + selected.length - 1,
    total_lines: lines.length,
    content: selected.join("\n")
  };
}

export async function searchRepo(root: string, query: string, glob?: string): Promise<SearchResult[]> {
  if (!query.trim()) {
    throw new Error("Search query must not be empty");
  }
  const args = ["--line-number", "--no-heading", "--color", "never", query];
  if (glob) {
    args.push("--glob", glob);
  }
  try {
    const { stdout } = await execFileAsync("rg", args, {
      cwd: root,
      maxBuffer: 1024 * 1024
    });
    return stdout
      .split("\n")
      .filter(Boolean)
      .slice(0, 100)
      .map((line) => {
        const [file, lineNo, ...rest] = line.split(":");
        return { path: file, line: Number(lineNo), text: rest.join(":") };
      });
  } catch (error) {
    const maybe = error as { code?: number; stdout?: string };
    if (maybe.code === 1) return [];
    throw error;
  }
}

async function assertRealPathInside(root: string, resolved: string, repoPath: string): Promise<void> {
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(resolved)]);
  const relative = path.relative(realRoot, realTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path ${repoPath} escapes the repository root after resolving symlinks`);
  }
}
