import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { SCHEMA_VERSION } from "./schema.js";
import { readVerifiedUtf8File, writeVerifiedUtf8File } from "./safe-file.js";

const LocalConfigSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  host: z.string().min(1),
  port: z.number().int().positive(),
  token: z.string().min(1),
  server_url: z.string().url(),
  token_expires_at: z.string().datetime().optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
});

export type LocalConfig = z.infer<typeof LocalConfigSchema>;
export type TokenExpiryStatus =
  | { status: "none"; token_expires_at?: undefined; warning: string }
  | { status: "valid"; token_expires_at: string; warning?: undefined }
  | { status: "expired"; token_expires_at: string; warning: string };

export interface WriteLocalConfigInput {
  host?: string;
  port?: number;
  token?: string;
  tokenTtlHours?: number;
}

export function localConfigPath(cwd: string): string {
  return path.join(cwd, ".bridge", "config.local.json");
}

export function makeServerUrl(host: string, port: number, token: string): string {
  return `http://${host}:${port}/mcp?gptprouse_token=${encodeURIComponent(token)}`;
}

export async function writeLocalConfig(cwd: string, input: WriteLocalConfigInput = {}): Promise<LocalConfig> {
  await ensureBridgeLocalFiles(cwd);
  await assertLocalConfigTargetSafe(cwd);
  const now = new Date().toISOString();
  const host = input.host ?? "127.0.0.1";
  const port = input.port ?? 8787;
  const token = input.token ?? randomBytes(24).toString("hex");
  const tokenExpiresAt = computeTokenExpiresAt(input.tokenTtlHours, now);
  const existing = await readExistingConfig(cwd);
  const config = LocalConfigSchema.parse({
    schema_version: SCHEMA_VERSION,
    host,
    port,
    token,
    server_url: makeServerUrl(host, port, token),
    ...(tokenExpiresAt ? { token_expires_at: tokenExpiresAt } : {}),
    created_at: existing?.created_at ?? now,
    updated_at: now
  });
  await writeVerifiedUtf8File(localConfigPath(cwd), `${JSON.stringify(config, null, 2)}\n`, () => assertLocalConfigTargetSafe(cwd), {
    create: true,
    mode: 0o600
  });
  await chmod(localConfigPath(cwd), 0o600);
  return config;
}

export async function loadLocalConfig(cwd: string): Promise<LocalConfig> {
  await assertLocalConfigTargetSafe(cwd, { allowMissing: false });
  const config = LocalConfigSchema.parse(
    JSON.parse(await readVerifiedUtf8File(localConfigPath(cwd), () => assertLocalConfigTargetSafe(cwd, { allowMissing: false })))
  );
  await chmod(localConfigPath(cwd), 0o600);
  return config;
}

export function getTokenExpiryStatus(config: Pick<LocalConfig, "token_expires_at">, now: Date = new Date()): TokenExpiryStatus {
  if (!config.token_expires_at) {
    return {
      status: "none",
      warning: "Token has no expiry. Keep this local-only, or rerun `gptprouse setup --token-ttl-hours <hours>` before using a tunnel."
    };
  }
  return isTokenExpired(config.token_expires_at, now)
    ? {
        status: "expired",
        token_expires_at: config.token_expires_at,
        warning: `Token expired at ${config.token_expires_at}. Run \`gptprouse setup\` to create a new URL.`
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
  await mkdir(bridgeDir, { recursive: true });
  await assertRealBridgeDirectory(cwd);
  const ignorePath = path.join(bridgeDir, ".gitignore");
  let current = "";
  try {
    current = await readFile(ignorePath, "utf8");
  } catch {
    // Missing .bridge/.gitignore is fine on first setup.
  }
  const required = [
    "tasks/*.json",
    "results/*.json",
    "sessions/*.json",
    "receipts/*.json",
    "artifacts/*",
    "config.local.json",
    "!.gitignore"
  ];
  const lines = new Set(current.split(/\r?\n/).filter(Boolean));
  for (const line of required) lines.add(line);
  await writeFile(ignorePath, `${Array.from(lines).join("\n")}\n`, "utf8");
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
