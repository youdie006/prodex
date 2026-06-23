import { realpath } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readVerifiedUtf8File } from "./safe-file.js";

const execFileAsync = promisify(execFile);
const MAX_REPO_READ_BYTES = 1_000_000;
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
  assertNotSensitiveRepoPath(normalized);
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
  const text = await readVerifiedUtf8File(resolved, () => assertRealPathInside(root, resolved, repoPath), {
    maxBytes: MAX_REPO_READ_BYTES
  }).catch((error) => {
    if (error instanceof Error && /too large/.test(error.message)) {
      throw new Error(`Path ${repoPath} is too large to read through repo tools`);
    }
    throw error;
  });
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
  if (glob) {
    assertRepoRelativeGlob(glob);
  }
  const args = [
    "--line-number",
    "--no-heading",
    "--color",
    "never",
    "--glob",
    "!.bridge/**",
    "--glob",
    "!**/.bridge/**",
    "--glob",
    "!.git/**",
    "--glob",
    "!**/.git/**",
    "--glob",
    "!.env*",
    "--glob",
    "!**/.env*",
    "--glob",
    "!node_modules/**",
    "--glob",
    "!**/node_modules/**",
    "--glob",
    "!dist/**",
    "--glob",
    "!**/dist/**",
    query
  ];
  if (glob) {
    args.push("--glob", glob);
  }
  args.push(".");
  try {
    const { stdout } = await execFileAsync("rg", args, {
      cwd: root,
      timeout: 10_000,
      maxBuffer: 1024 * 1024
    });
    return stdout
      .split("\n")
      .filter(Boolean)
      .slice(0, 100)
      .map((line) => {
        const [file, lineNo, ...rest] = line.split(":");
        return { path: file.replace(/^\.\//, ""), line: Number(lineNo), text: rest.join(":") };
      });
  } catch (error) {
    const maybe = error as { code?: number; stdout?: string };
    if (maybe.code === 1) return [];
    throw error;
  }
}

function assertNotSensitiveRepoPath(normalizedPath: string): void {
  const segments = normalizedPath.split("/");
  if (segments.some((segment) => segment === ".env" || segment.startsWith(".env."))) {
    throw new Error(`Path ${normalizedPath} is sensitive and cannot be read through repo tools`);
  }
  if (
    segments.some(
      (segment) => segment === ".bridge" || segment === ".git" || segment === "node_modules" || segment === "dist"
    )
  ) {
    throw new Error(`Path ${normalizedPath} is sensitive and cannot be read through repo tools`);
  }
}

function assertRepoRelativeGlob(glob: string): void {
  const normalized = path.posix.normalize(glob.replaceAll("\\", "/").replace(/^!/, ""));
  if (normalized.startsWith("../") || normalized === ".." || path.isAbsolute(normalized)) {
    throw new Error("Glob must stay inside the repo-relative root");
  }
  assertNoSensitiveLiteralGlobSegment(normalized);
  const concretePrefix = normalized.replace(/[*?[{].*$/, "").replace(/\/+$/, "");
  if (concretePrefix) {
    assertNotSensitiveRepoPath(concretePrefix);
  }
}

function assertNoSensitiveLiteralGlobSegment(normalizedGlob: string): void {
  const literalSegments = normalizedGlob
    .split("/")
    .filter((segment) => segment && !/[*?[{]/.test(segment));
  if (
    literalSegments.some(
      (segment) =>
        segment === ".git" ||
        segment === ".bridge" ||
        segment === "node_modules" ||
        segment === "dist" ||
        segment === ".env" ||
        segment.startsWith(".env.")
    )
  ) {
    throw new Error(`Glob ${normalizedGlob} is sensitive and cannot be used through repo tools`);
  }
}

async function assertRealPathInside(root: string, resolved: string, repoPath: string): Promise<void> {
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(resolved)]);
  const relative = path.relative(realRoot, realTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path ${repoPath} escapes the repository root after resolving symlinks`);
  }
}
