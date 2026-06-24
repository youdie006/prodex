import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readVerifiedUtf8File } from "./safe-file.js";

const execFileAsync = promisify(execFile);
const MAX_REPO_READ_BYTES = 1_000_000;
const MAX_GLOB_BRACE_EXPANSIONS = 64;
const MAX_GLOB_BRACE_DEPTH = 8;
const ENV_LIKE_GLOB_PROBES = [".env", ".envrc", ".env.local", ".envoy"];
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

interface RipgrepJsonMatch {
  type: "match";
  data: {
    path: { text: string };
    line_number: number;
    lines: { text: string };
  };
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
  await assertResolvedRepoPathAllowed(root, resolved, repoPath);
  const text = await readVerifiedUtf8File(resolved, () => assertResolvedRepoPathAllowed(root, resolved, repoPath), {
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
    "--no-config",
    "--no-follow",
    "--json",
    ...(glob ? ["--glob", glob] : []),
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
    "-e",
    query
  ];
  args.push(".");
  try {
    const { stdout } = await execFileAsync("rg", args, {
      cwd: root,
      timeout: 10_000,
      maxBuffer: 1024 * 1024
    });
    const parsedMatches = stdout
      .split("\n")
      .filter(Boolean)
      .map(parseRipgrepJsonMatch)
      .filter((match): match is SearchResult => match !== undefined);
    const allowedMatches: SearchResult[] = [];
    for (const match of parsedMatches) {
      if (await isAllowedRepoSearchResult(root, match.path)) {
        allowedMatches.push(match);
      }
      if (allowedMatches.length >= 100) break;
    }
    return allowedMatches;
  } catch (error) {
    const maybe = error as { code?: number | string; stdout?: string };
    if (maybe.code === "ENOENT") {
      throw new Error("ripgrep (rg) is required on PATH for repo_search");
    }
    if (maybe.code === 1) return [];
    throw error;
  }
}

function parseRipgrepJsonMatch(line: string): SearchResult | undefined {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRipgrepJsonMatch(event)) return undefined;
  return {
    path: event.data.path.text.replace(/^\.\//, ""),
    line: event.data.line_number,
    text: stripOneTrailingLineEnding(event.data.lines.text)
  };
}

function isRipgrepJsonMatch(value: unknown): value is RipgrepJsonMatch {
  if (!isRecord(value) || value.type !== "match" || !isRecord(value.data)) return false;
  const { path: matchPath, line_number: lineNumber, lines } = value.data;
  return (
    isRecord(matchPath) &&
    typeof matchPath.text === "string" &&
    typeof lineNumber === "number" &&
    Number.isFinite(lineNumber) &&
    isRecord(lines) &&
    typeof lines.text === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stripOneTrailingLineEnding(value: string): string {
  return value.replace(/\r?\n$/, "");
}

function assertNotSensitiveRepoPath(normalizedPath: string): void {
  const segments = normalizedPath.split("/");
  if (segments.some(isEnvLikeSegment)) {
    throw new Error(`Path ${normalizedPath} is sensitive and cannot be read through repo tools`);
  }
  if (segments.some(isSensitiveRepoSegment)) {
    throw new Error(`Path ${normalizedPath} is sensitive and cannot be read through repo tools`);
  }
}

function assertRepoRelativeGlob(glob: string): void {
  const normalized = path.posix.normalize(glob.replaceAll("\\", "/").replace(/^!/, ""));
  if (normalized.startsWith("../") || normalized === ".." || path.isAbsolute(normalized)) {
    throw new Error("Glob must stay inside the repo-relative root");
  }
  assertNoSensitiveGlobSegment(normalized);
  const concretePrefix = normalized.replace(/[*?[{].*$/, "").replace(/\/+$/, "");
  if (concretePrefix) {
    assertNotSensitiveRepoPath(concretePrefix);
  }
}

function assertNoSensitiveGlobSegment(normalizedGlob: string): void {
  const segments = normalizedGlob.split("/").filter(Boolean);
  if (
    segments.some(
      (segment) =>
        isSensitiveRepoSegment(segment) ||
        isEnvLikeGlobSegment(segment)
    )
  ) {
    throw new Error(`Glob ${normalizedGlob} is sensitive and cannot be used through repo tools`);
  }
}

async function isAllowedRepoSearchResult(root: string, repoPath: string): Promise<boolean> {
  try {
    const normalized = path.posix.normalize(repoPath.replaceAll("\\", "/"));
    const resolved = resolveRepoPath(root, normalized);
    await assertResolvedRepoPathAllowed(root, resolved, normalized);
    const stat = await lstat(resolved);
    return stat.isFile() && !stat.isSymbolicLink() && stat.nlink <= 1;
  } catch {
    return false;
  }
}

function isSensitiveRepoSegment(segment: string): boolean {
  const folded = foldSensitiveSegment(segment);
  return folded === ".bridge" || folded === ".git" || folded === "node_modules" || folded === "dist";
}

function isEnvLikeSegment(segment: string): boolean {
  return foldSensitiveSegment(segment).startsWith(".env");
}

function isEnvLikeGlobSegment(segment: string): boolean {
  const variants = expandBraceGlobSegment(segment);
  if (variants === null) return true;
  return variants.some(isEnvLikeGlobVariant);
}

function isEnvLikeGlobVariant(segment: string): boolean {
  if (isBroadWildcardOnlyGlobVariant(segment)) return false;
  const folded = foldSensitiveSegment(segment);
  return ENV_LIKE_GLOB_PROBES.some((probe) => globSegmentMatches(folded, probe));
}

function isBroadWildcardOnlyGlobVariant(segment: string): boolean {
  return /^[*?]+$/.test(segment);
}

function globSegmentMatches(pattern: string, value: string): boolean {
  const regexSource = globSegmentToRegexSource(pattern);
  if (regexSource === null) return true;
  try {
    return new RegExp(`^${regexSource}$`, "u").test(value);
  } catch {
    return true;
  }
}

function globSegmentToRegexSource(pattern: string): string | null {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      source += ".*";
      continue;
    }
    if (char === "?") {
      source += ".";
      continue;
    }
    if (char === "[") {
      const charClass = readGlobCharClass(pattern, index);
      if (charClass === null) return null;
      source += charClass.source;
      index = charClass.end;
      continue;
    }
    source += escapeRegexLiteral(char);
  }
  return source;
}

function readGlobCharClass(pattern: string, start: number): { source: string; end: number } | null {
  let end = start + 1;
  if (pattern[end] === "]") end += 1;
  while (end < pattern.length && pattern[end] !== "]") {
    end += 1;
  }
  if (end >= pattern.length) return null;
  let content = pattern.slice(start + 1, end);
  let negated = "";
  if (content.startsWith("!") || content.startsWith("^")) {
    negated = "^";
    content = content.slice(1);
  }
  if (!content) return null;
  const escaped = content.replaceAll("\\", "\\\\").replaceAll("]", "\\]");
  return { source: `[${negated}${escaped}]`, end };
}

function escapeRegexLiteral(char: string): string {
  return char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function foldSensitiveSegment(segment: string): string {
  return segment.toLowerCase();
}

function expandBraceGlobSegment(segment: string, depth = 0): string[] | null {
  if (depth > MAX_GLOB_BRACE_DEPTH) return null;
  const open = segment.indexOf("{");
  if (open === -1) return [segment];
  const close = findMatchingBrace(segment, open);
  if (close === -1) return [segment];
  const before = segment.slice(0, open);
  const after = segment.slice(close + 1);
  const alternatives = splitBraceAlternatives(segment.slice(open + 1, close));
  const variants: string[] = [];
  for (const alternative of alternatives) {
    const expanded = expandBraceGlobSegment(`${before}${alternative}${after}`, depth + 1);
    if (expanded === null) return null;
    variants.push(...expanded);
    if (variants.length > MAX_GLOB_BRACE_EXPANSIONS) return null;
  }
  return variants;
}

function findMatchingBrace(input: string, open: number): number {
  let depth = 0;
  for (let index = open; index < input.length; index += 1) {
    const char = input[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function splitBraceAlternatives(input: string): string[] {
  const alternatives: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of input) {
    if (char === "{") {
      depth += 1;
      current += char;
      continue;
    }
    if (char === "}") {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }
    if (char === "," && depth === 0) {
      alternatives.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  alternatives.push(current);
  return alternatives;
}

export async function assertResolvedRepoPathAllowed(root: string, resolved: string, repoPath: string): Promise<void> {
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(resolved)]);
  const relative = path.relative(realRoot, realTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path ${repoPath} escapes the repository root after resolving symlinks`);
  }
  if (relative) {
    assertNotSensitiveRepoPath(path.posix.normalize(relative.split(path.sep).join("/")));
  }
}
