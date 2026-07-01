import { constants } from "node:fs";
import { lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import path from "node:path";
import { z } from "zod";
import { SCHEMA_VERSION } from "./schema.js";
import { readVerifiedUtf8File, writeVerifiedUtf8File } from "./safe-file.js";

const BRIDGE_DIRECTORY_MODE = 0o700;

const BrowserDefaultsSchema = z.object({
  model: z.string().min(1).optional(),
  pro_mode: z.enum(["기본", "확장"]).optional(),
  effort: z.enum(["즉시", "중간", "높음", "매우 높음"]).optional(),
  project: z.string().min(1).optional()
});

const LocalConfigSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  host: z.string().min(1),
  port: z.number().int().positive(),
  token: z.string().min(1),
  server_url: z.string().url(),
  token_expires_at: z.string().datetime().optional(),
  browser_defaults: BrowserDefaultsSchema.optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
});

export type LocalConfig = z.infer<typeof LocalConfigSchema>;
export type BrowserDefaults = z.infer<typeof BrowserDefaultsSchema>;
export type TokenExpiryStatus =
  | { status: "non_expiring"; token_expires_at?: undefined; warning: string }
  | { status: "valid"; token_expires_at: string; warning?: undefined }
  | { status: "expired"; token_expires_at: string; warning: string };

const LOCAL_CONFIG_CORRUPT_MESSAGE = "local MCP config is corrupt. Run `prodex setup` to replace .bridge/config.local.json.";

class LocalConfigCorruptError extends Error {
  constructor(cause: unknown) {
    super(LOCAL_CONFIG_CORRUPT_MESSAGE, { cause });
    this.name = "LocalConfigCorruptError";
  }
}

export interface WriteLocalConfigInput {
  host?: string;
  port?: number;
  token?: string;
  tokenTtlHours?: number;
  browserDefaults?: {
    model?: string;
    proMode?: "기본" | "확장";
    effort?: "즉시" | "중간" | "높음" | "매우 높음";
    project?: string;
  };
}

// Merge new browser defaults onto the existing ones so setting one field never
// wipes the others. Passing a field explicitly as undefined clears it.
function mergeBrowserDefaults(
  existing: BrowserDefaults | undefined,
  input: WriteLocalConfigInput["browserDefaults"]
): BrowserDefaults | undefined {
  if (input === undefined) return existing;
  const merged: BrowserDefaults = { ...existing };
  const apply = <K extends keyof BrowserDefaults>(key: K, value: BrowserDefaults[K] | undefined): void => {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  };
  if ("model" in input) apply("model", input.model);
  if ("proMode" in input) apply("pro_mode", input.proMode);
  if ("effort" in input) apply("effort", input.effort);
  if ("project" in input) apply("project", input.project);
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function localConfigPath(cwd: string): string {
  return path.join(cwd, ".bridge", "config.local.json");
}

export function makeServerUrl(host: string, port: number, token: string): string {
  return `http://${host}:${port}/mcp?prodex_token=${encodeURIComponent(token)}`;
}

export function normalizeLoopbackHttpHost(host: string): string {
  const normalized = host.trim().toLowerCase();
  const isLocalhost = normalized === "localhost";
  const isIpv4Loopback = isIP(normalized) === 4 && normalized.startsWith("127.");
  if (isLocalhost || isIpv4Loopback) return normalized;
  throw new Error(
    "HTTP MCP host must be loopback-only, such as 127.0.0.1 or localhost. Keep prodex local and put your own tunnel in front of it when needed."
  );
}

export function assertLoopbackHttpHost(host: string): void {
  normalizeLoopbackHttpHost(host);
}

export async function writeLocalConfig(cwd: string, input: WriteLocalConfigInput = {}): Promise<LocalConfig> {
  await ensureBridgeLocalFiles(cwd);
  await assertLocalConfigTargetSafe(cwd);
  const now = new Date().toISOString();
  const host = normalizeLoopbackHttpHost(input.host ?? "127.0.0.1");
  const port = input.port ?? 8787;
  const token = input.token ?? randomBytes(24).toString("hex");
  const tokenExpiresAt = computeTokenExpiresAt(input.tokenTtlHours, now);
  const existing = await readExistingConfig(cwd);
  const browserDefaults = mergeBrowserDefaults(existing?.browser_defaults, input.browserDefaults);
  const config = LocalConfigSchema.parse({
    schema_version: SCHEMA_VERSION,
    host,
    port,
    token,
    server_url: makeServerUrl(host, port, token),
    ...(tokenExpiresAt ? { token_expires_at: tokenExpiresAt } : {}),
    ...(browserDefaults ? { browser_defaults: browserDefaults } : {}),
    created_at: existing?.created_at ?? now,
    updated_at: now
  });
  await writeVerifiedUtf8File(localConfigPath(cwd), `${JSON.stringify(config, null, 2)}\n`, () => assertLocalConfigTargetSafe(cwd), {
    create: true,
    mode: 0o600
  });
  return config;
}

export async function loadLocalConfig(cwd: string): Promise<LocalConfig> {
  await assertLocalConfigTargetSafe(cwd, { allowMissing: false });
  await chmodPrivateBridgeDirectory(cwd);
  const raw = await readVerifiedUtf8File(localConfigPath(cwd), () => assertLocalConfigTargetSafe(cwd, { allowMissing: false }), {
    mode: 0o600
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new LocalConfigCorruptError(error);
  }
  let config: LocalConfig;
  try {
    config = LocalConfigSchema.parse(parsed);
  } catch (error) {
    if (error instanceof z.ZodError) throw new LocalConfigCorruptError(error);
    throw error;
  }
  assertLoopbackHttpHost(config.host);
  assertLoopbackHttpHost(new URL(config.server_url).hostname);
  assertServerUrlMatchesConfig(config);
  return config;
}

// Read persisted browser-selection defaults without failing when the local
// config is absent or unrelated to this cwd (defaults are optional convenience).
export async function loadBrowserDefaults(cwd: string): Promise<BrowserDefaults | undefined> {
  try {
    const config = await loadLocalConfig(cwd);
    return config.browser_defaults;
  } catch {
    return undefined;
  }
}

export function getTokenExpiryStatus(config: Pick<LocalConfig, "token_expires_at">, now: Date = new Date()): TokenExpiryStatus {
  if (!config.token_expires_at) {
    return {
      status: "non_expiring",
      warning: "Token has no expiry. Keep this local-only, or rerun `prodex setup --token-ttl-hours <hours>` before using a tunnel."
    };
  }
  return isTokenExpired(config.token_expires_at, now)
    ? {
        status: "expired",
        token_expires_at: config.token_expires_at,
        warning: `Token expired at ${config.token_expires_at}. Run \`prodex setup\` to create a new URL.`
      }
    : { status: "valid", token_expires_at: config.token_expires_at };
}

export function assertTokenNotExpired(config: Pick<LocalConfig, "token_expires_at">, now: Date = new Date()): void {
  const status = getTokenExpiryStatus(config, now);
  if (status.status === "expired") {
    throw new Error(status.warning.toLowerCase());
  }
}

function computeTokenExpiresAt(tokenTtlHours: number | undefined, nowIso: string): string | undefined {
  if (tokenTtlHours === undefined) return undefined;
  if (!Number.isFinite(tokenTtlHours) || tokenTtlHours <= 0) {
    throw new Error("token ttl must be a positive number of hours");
  }
  const expiresAtMs = Date.parse(nowIso) + tokenTtlHours * 60 * 60 * 1000;
  if (!Number.isFinite(expiresAtMs)) {
    throw new Error("token ttl produced an invalid expiry time");
  }
  return new Date(expiresAtMs).toISOString();
}

function isTokenExpired(tokenExpiresAt: string, now: Date): boolean {
  const expiresAtMs = Date.parse(tokenExpiresAt);
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= now.getTime();
}

function assertServerUrlMatchesConfig(config: LocalConfig): void {
  const serverUrl = new URL(config.server_url);
  const tokenParams = serverUrl.searchParams.getAll("prodex_token");
  const hostMatches = normalizeLoopbackHttpHost(serverUrl.hostname) === normalizeLoopbackHttpHost(config.host);
  const portMatches = effectiveUrlPort(serverUrl) === config.port;
  const tokenMatches = tokenParams.length === 1 && tokenParams[0] === config.token;
  const shapeMatches = serverUrl.protocol === "http:" && serverUrl.pathname === "/mcp" && Array.from(serverUrl.searchParams.keys()).length === 1;
  if (!hostMatches || !portMatches || !tokenMatches || !shapeMatches) {
    throw new Error(".bridge/config.local.json server_url must match host, port, and token. Run `prodex setup` to replace it.");
  }
}

function effectiveUrlPort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === "http:" ? 80 : Number.NaN;
}

async function readExistingConfig(cwd: string): Promise<LocalConfig | undefined> {
  try {
    return LocalConfigSchema.parse(
      JSON.parse(await readVerifiedUtf8File(localConfigPath(cwd), () => assertLocalConfigTargetSafe(cwd, { allowMissing: false })))
    );
  } catch {
    return undefined;
  }
}

async function ensureBridgeLocalFiles(cwd: string): Promise<void> {
  const bridgeDir = path.join(cwd, ".bridge");
  await ensurePrivateBridgeDirectory(cwd);
  const ignorePath = path.join(bridgeDir, ".gitignore");
  let current = "";
  try {
    current = await readVerifiedUtf8File(ignorePath, () => assertBridgeGitignoreTargetSafe(cwd));
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
  const required = [
    "tasks/*.json",
    "results/*.json",
    "sessions/*.json",
    "receipts/*.json",
    "artifacts/*",
    "config.local.json",
    "receipt-key.local",
    "!.gitignore"
  ];
  const lines = new Set(current.split(/\r?\n/).filter(Boolean));
  for (const line of required) lines.add(line);
  await writeVerifiedUtf8File(ignorePath, `${Array.from(lines).join("\n")}\n`, () => assertBridgeGitignoreTargetSafe(cwd), {
    create: true
  });
}

async function ensurePrivateBridgeDirectory(cwd: string): Promise<void> {
  await mkdir(path.join(cwd, ".bridge"), { recursive: true, mode: BRIDGE_DIRECTORY_MODE });
  await chmodPrivateBridgeDirectory(cwd);
}

async function chmodPrivateBridgeDirectory(cwd: string): Promise<void> {
  const bridgeDir = path.join(cwd, ".bridge");
  const handle = await openNoFollowDirectory(bridgeDir, ".bridge");
  try {
    await handle.chmod(BRIDGE_DIRECTORY_MODE);
    await assertDirectoryHandle(handle, ".bridge");
  } finally {
    await handle.close();
  }
}

async function assertLocalConfigTargetSafe(cwd: string, options: { allowMissing?: boolean } = { allowMissing: true }): Promise<void> {
  await assertRealBridgeDirectory(cwd);
  try {
    const stat = await lstat(localConfigPath(cwd));
    if (stat.isSymbolicLink()) {
      throw new Error(".bridge/config.local.json must not be a symlink");
    }
    if (!stat.isFile()) {
      throw new Error(".bridge/config.local.json must be a regular file");
    }
  } catch (error) {
    if (isMissingFileError(error) && options.allowMissing !== false) return;
    throw error;
  }
}

async function assertBridgeGitignoreTargetSafe(cwd: string, options: { allowMissing?: boolean } = { allowMissing: true }): Promise<void> {
  await assertRealBridgeDirectory(cwd);
  const ignorePath = path.join(cwd, ".bridge", ".gitignore");
  try {
    const stat = await lstat(ignorePath);
    if (stat.isSymbolicLink()) {
      throw new Error(".bridge/.gitignore must not be a symlink");
    }
    if (!stat.isFile()) {
      throw new Error(".bridge/.gitignore must be a regular file");
    }
  } catch (error) {
    if (isMissingFileError(error) && options.allowMissing !== false) return;
    throw error;
  }
}

async function assertRealBridgeDirectory(cwd: string): Promise<void> {
  const bridgeDir = path.join(cwd, ".bridge");
  const stat = await lstat(bridgeDir);
  if (stat.isSymbolicLink()) {
    throw new Error(".bridge must be a real directory, not a symlink");
  }
  if (!stat.isDirectory()) {
    throw new Error(".bridge must be a real directory");
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

async function openNoFollowDirectory(dirPath: string, label: string): Promise<FileHandle> {
  const noFollowFlag = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const directoryFlag = typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0;
  try {
    const handle = await open(dirPath, constants.O_RDONLY | directoryFlag | noFollowFlag);
    try {
      await assertDirectoryHandle(handle, label);
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

async function assertDirectoryHandle(handle: FileHandle, label: string): Promise<void> {
  const stat = await handle.stat();
  if (!stat.isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }
}
