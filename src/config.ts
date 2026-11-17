import { constants } from "node:fs";
import { lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import path from "node:path";
import { z } from "zod";
import { SCHEMA_VERSION } from "./schema.js";
import { ensureBridgeGitignore } from "./bridge-gitignore.js";
import { readVerifiedUtf8File, writeVerifiedUtf8File } from "./safe-file.js";

const BRIDGE_DIRECTORY_MODE = 0o700;

const BrowserDefaultsSchema = z.object({
  model: z.string().min(1).optional(),
  pro_mode: z.enum(["기본", "확장"]).optional(),
  // Pro is the slider's fifth step, so a saved default may name it.
  effort: z.enum(["즉시", "중간", "높음", "매우 높음", "Max", "Ultra", "Pro"]).optional(),
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
    effort?: "즉시" | "중간" | "높음" | "매우 높음" | "Max" | "Ultra" | "Pro";
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

/**
 * The endpoint WITHOUT the token, which is what gets persisted. The token used
 * to be stored twice - as `token` and inside `server_url` - so an operator's
 * redaction that masked the key still leaked the secret from the URL (field
 * report). One field is the only shape where masking the token masks it.
 */
export function makeServerUrlBase(host: string, port: number): string {
  return `http://${host}:${port}/mcp`;
}

/** The token-bearing URL, composed on demand for clients that need it. */
export function composeServerUrlWithToken(config: Pick<LocalConfig, "server_url" | "token">): string {
  const url = new URL(config.server_url);
  url.searchParams.set("prodex_token", config.token);
  return url.toString();
}

/** Strip a token that an older config (or a hand edit) left in the URL. */
export function stripTokenFromServerUrl(serverUrl: string): string {
  try {
    const url = new URL(serverUrl);
    url.searchParams.delete("prodex_token");
    url.search = url.searchParams.toString();
    return url.toString();
  } catch {
    return serverUrl;
  }
}

/**
 * `savedIn` names the config field the host was read from. A hand-edited host
 * was a dead end: status, start and plain setup all refused it with the same
 * sentence, and nothing said that `setup --host 127.0.0.1` replaces it or that
 * the value came from the config file (found 2026-11-09).
 */
export function normalizeLoopbackHttpHost(host: string, savedIn?: "host" | "server_url"): string {
  const normalized = host.trim().toLowerCase();
  const isLocalhost = normalized === "localhost";
  const isIpv4Loopback = isIP(normalized) === 4 && normalized.startsWith("127.");
  if (isLocalhost || isIpv4Loopback) return normalized;
  // ::1 IS loopback; it was refused as if it were not. The listener and every
  // URL prodex prints are IPv4-shaped, so say that rather than "loopback-only".
  const isIpv6Loopback = normalized.replace(/^\[|\]$/g, "") === "::1";
  if (savedIn) {
    const origin = `HTTP MCP host ${JSON.stringify(host)}, ${savedIn === "host" ? "saved as host" : "saved in server_url"} in .bridge/config.local.json,`;
    // server_url is rebuilt from host and port, so plain setup replaces it.
    const fix = savedIn === "host" ? "`prodex setup --host 127.0.0.1`" : "`prodex setup`";
    throw new Error(
      isIpv6Loopback
        ? `${origin} is IPv6 loopback, which prodex does not serve: it prints and serves IPv4 URLs. Run ${fix} to replace it.`
        : `${origin} is not loopback-only. prodex listens only on loopback hosts such as 127.0.0.1 or localhost; run ${fix} to replace it. Keep prodex local and put your own tunnel in front of it when needed.`
    );
  }
  if (isIpv6Loopback) {
    throw new Error("HTTP MCP host ::1 (IPv6 loopback) is not supported: prodex prints and serves IPv4 URLs. Use --host 127.0.0.1 or localhost.");
  }
  throw new Error(
    "HTTP MCP host must be loopback-only, such as 127.0.0.1 or localhost. Keep prodex local and put your own tunnel in front of it when needed."
  );
}

/**
 * What setup could not keep from an existing config that failed validation.
 * Undefined when there was no config or it was valid.
 */
export interface LocalConfigRecovery {
  /** The file was not a prodex config at all (not JSON, not an object, another schema version), so nothing in it was kept. */
  unreadable: boolean;
  /** Fields left out because their saved value was missing or invalid, such as "browser_defaults.effort". */
  dropped: string[];
  /** The saved token could not be kept and setup made a new one the caller did not ask for. */
  tokenReplaced: boolean;
}

export async function writeLocalConfig(cwd: string, input: WriteLocalConfigInput = {}): Promise<LocalConfig> {
  return (await writeLocalConfigWithRecovery(cwd, input)).config;
}

/** writeLocalConfig, also saying what it could not keep from an invalid existing config. */
export async function writeLocalConfigWithRecovery(
  cwd: string,
  input: WriteLocalConfigInput = {}
): Promise<{ config: LocalConfig; recovery?: LocalConfigRecovery }> {
  await ensureBridgeLocalFiles(cwd);
  await assertLocalConfigTargetSafe(cwd);
  const now = new Date().toISOString();
  const read = await readExistingConfig(cwd);
  const existing = read?.config;
  const host =
    input.host !== undefined
      ? normalizeLoopbackHttpHost(input.host)
      : normalizeLoopbackHttpHost(existing?.host ?? "127.0.0.1", existing?.host !== undefined ? "host" : undefined);
  const port = input.port ?? existing?.port ?? 8787;
  // A setup re-run that only adjusts defaults/host/port must NOT rotate the
  // token - that would silently 401 every client holding the old MCP URL.
  // Rotation happens only when the caller explicitly asks for a token
  // (--token) or a fresh expiry (--token-ttl-hours).
  const tokenExplicitlyRequested = input.token !== undefined || input.tokenTtlHours !== undefined;
  const token = input.token ?? (tokenExplicitlyRequested ? undefined : existing?.token) ?? randomBytes(24).toString("hex");
  const tokenExpiresAt = tokenExplicitlyRequested || !existing ? computeTokenExpiresAt(input.tokenTtlHours, now) : existing.token_expires_at;
  const browserDefaults = mergeBrowserDefaults(existing?.browser_defaults, input.browserDefaults);
  const config = LocalConfigSchema.parse({
    schema_version: SCHEMA_VERSION,
    host,
    port,
    token,
    server_url: makeServerUrlBase(host, port),
    ...(tokenExpiresAt ? { token_expires_at: tokenExpiresAt } : {}),
    ...(browserDefaults ? { browser_defaults: browserDefaults } : {}),
    created_at: existing?.created_at ?? now,
    updated_at: now
  });
  await writeVerifiedUtf8File(localConfigPath(cwd), `${JSON.stringify(config, null, 2)}\n`, () => assertLocalConfigTargetSafe(cwd), {
    create: true,
    mode: 0o600
  });
  if (!read || (!read.unreadable && read.dropped.length === 0)) return { config };
  return {
    config,
    recovery: { unreadable: read.unreadable, dropped: read.dropped, tokenReplaced: !tokenExplicitlyRequested && existing?.token === undefined }
  };
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
  normalizeLoopbackHttpHost(config.host, "host");
  normalizeLoopbackHttpHost(new URL(config.server_url).hostname, "server_url");
  // Configs written before the split still carry the token in the URL. Drop it
  // in memory AND rewrite the file: leaving it on disk is the whole problem
  // being fixed - an operator reading config.local.json would still find the
  // secret twice, and any redaction keyed to `token` would miss one copy.
  const strippedServerUrl = stripTokenFromServerUrl(config.server_url);
  const carriedDuplicate = strippedServerUrl !== config.server_url;
  config = { ...config, server_url: strippedServerUrl };
  assertServerUrlMatchesConfig(config);
  if (carriedDuplicate) {
    // Best effort: a read-only checkout or a concurrent writer must not turn
    // a working config into a failed command.
    try {
      await writeVerifiedUtf8File(localConfigPath(cwd), `${JSON.stringify(config, null, 2)}\n`, () => assertLocalConfigTargetSafe(cwd), {
        mode: 0o600
      });
    } catch {
      // The in-memory strip above already keeps prodex from printing it.
    }
  }
  return config;
}

// Global browser-selection defaults from the environment, used when a repo has
// no per-repo default for a field. The MCP server (pro_consult) frequently runs
// as `prodex mcp` with no --cwd, so it reads whatever directory the agent
// launched in - a per-repo default set elsewhere is then missed. Setting e.g.
// PRODEX_DEFAULT_PROJECT=Codex PRODEX_DEFAULT_MODEL=Pro pins a default that
// applies from ANY cwd so consults stop landing in the general chat.
export function envBrowserDefaults(): BrowserDefaults | undefined {
  const model = process.env.PRODEX_DEFAULT_MODEL?.trim() || undefined;
  const project = process.env.PRODEX_DEFAULT_PROJECT?.trim() || undefined;
  const raw: Record<string, string> = {};
  if (model) raw.model = model;
  if (project) raw.project = project;
  const proMode = process.env.PRODEX_DEFAULT_PRO_MODE?.trim();
  if (proMode) raw.pro_mode = proMode;
  const effort = process.env.PRODEX_DEFAULT_EFFORT?.trim();
  if (effort) raw.effort = effort;
  if (Object.keys(raw).length === 0) return undefined;
  const parsed = BrowserDefaultsSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  // A bad enum in pro_mode/effort must not drop a valid model/project.
  const freeText = BrowserDefaultsSchema.safeParse({
    ...(model ? { model } : {}),
    ...(project ? { project } : {})
  });
  return (model || project) && freeText.success ? freeText.data : undefined;
}

/**
 * Combine the global env defaults with this repo's.
 *
 * The project is independent of the rest, so the repo's wins that field and
 * the env fills it in. The model and the two reasoning fields are NOT
 * independent: an effort is a step ChatGPT deselects the model to reach, and a
 * pro_mode only refines Pro. Merging those field-by-field built a request
 * neither side asked for - a repo pinning `model: Pro` next to
 * PRODEX_DEFAULT_EFFORT ran at the effort and dropped Pro - so whichever side
 * names the reasoning selection provides all of it.
 */
export function mergeBrowserDefaultSources(
  env: BrowserDefaults | undefined,
  repo: BrowserDefaults | undefined
): BrowserDefaults | undefined {
  if (!repo && !env) return undefined;
  const namesSelection = (defaults: BrowserDefaults | undefined): boolean =>
    Boolean(defaults && (defaults.model !== undefined || defaults.pro_mode !== undefined || defaults.effort !== undefined));
  const selection = namesSelection(repo) ? repo : env;
  const merged: BrowserDefaults = {
    ...(selection?.model !== undefined ? { model: selection.model } : {}),
    ...(selection?.pro_mode !== undefined ? { pro_mode: selection.pro_mode } : {}),
    ...(selection?.effort !== undefined ? { effort: selection.effort } : {})
  };
  const project = repo?.project ?? env?.project;
  if (project !== undefined) merged.project = project;
  return Object.keys(merged).length > 0 ? merged : undefined;
}

// Read persisted browser-selection defaults without failing when the local
// config is absent or unrelated to this cwd (defaults are optional convenience).
// The repo's config provides the project and, if it names any of them, the
// reasoning selection; PRODEX_DEFAULT_* env vars are the global fallback so a
// pinned default project/model applies from any cwd.
export async function loadBrowserDefaults(cwd: string): Promise<BrowserDefaults | undefined> {
  const env = envBrowserDefaults();
  let repo: BrowserDefaults | undefined;
  try {
    repo = (await loadLocalConfig(cwd)).browser_defaults;
  } catch (error) {
    // Having no config is the ordinary case - browser sends work without one -
    // and stays silent. A config that EXISTS and cannot be read is a different
    // thing, and swallowing it was the quiet failure: the defaults it pins
    // stop applying with nothing said, so a consult that should have landed in
    // a project lands in the general chat and looks like it worked.
    if (!isMissingFileError(error)) {
      // Say only what is true. Passing the flags explicitly does NOT get past
      // this - the config is read before any of them are looked at - and
      // advice that does not work is worse than none. Moving the file aside
      // does work: a repo with no config has no defaults and sends fine.
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} Until then prodex will not apply the browser defaults ` +
          `pinned there (project, model), and every send from this repo stops here. Move .bridge/config.local.json aside ` +
          `if this repo does not need the HTTP MCP surface.`,
        { cause: error }
      );
    }
    repo = undefined;
  }
  return mergeBrowserDefaultSources(env, repo);
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
        warning: `Token expired at ${config.token_expires_at}. Run \`prodex setup --token-ttl-hours <hours>\` to create a new URL, then restart \`prodex start\`.`
      }
    : { status: "valid", token_expires_at: config.token_expires_at };
}

/**
 * "Token expired ..." reads as "failed token expired ..." after a status
 * prefix. Only the first letter: lowercasing the whole message printed the
 * expiry as "2026-10-26t00:00:00.000z", which is no longer an ISO time.
 */
export function lowercaseFirst(message: string): string {
  return message.charAt(0).toLowerCase() + message.slice(1);
}

export function assertTokenNotExpired(config: Pick<LocalConfig, "token_expires_at">, now: Date = new Date()): void {
  const status = getTokenExpiryStatus(config, now);
  if (status.status === "expired") {
    throw new Error(lowercaseFirst(status.warning));
  }
}

const MAX_TOKEN_EXPIRES_AT_MS = Date.parse("9999-12-31T23:59:59.999Z");

function computeTokenExpiresAt(tokenTtlHours: number | undefined, nowIso: string): string | undefined {
  if (tokenTtlHours === undefined) return undefined;
  if (!Number.isFinite(tokenTtlHours) || tokenTtlHours <= 0) {
    throw new Error("token ttl must be a positive number of hours");
  }
  const expiresAtMs = Date.parse(nowIso) + tokenTtlHours * 60 * 60 * 1000;
  if (!Number.isFinite(expiresAtMs)) {
    throw new Error("token ttl produced an invalid expiry time");
  }
  // Past year 9999 the ISO date gains a sign and six-digit year, which the
  // config schema rejects with a raw validation dump (measured 2026-10-21).
  if (expiresAtMs > MAX_TOKEN_EXPIRES_AT_MS) {
    throw new Error("--token-ttl-hours is too large: the token would expire after year 9999. Use a smaller value, such as 8760 for a year.");
  }
  // The expiry is kept to the millisecond, so a TTL under one (1e-9 hours)
  // made a token that had expired when setup reported it saved (found
  // 2026-11-09), with a hint for a token that never expires.
  const expiresAt = new Date(expiresAtMs);
  if (expiresAt.getTime() <= Date.parse(nowIso)) {
    throw new Error("--token-ttl-hours is too small: the token would expire the moment it is created. Use a larger value, such as 1 for an hour.");
  }
  return expiresAt.toISOString();
}

function isTokenExpired(tokenExpiresAt: string, now: Date): boolean {
  const expiresAtMs = Date.parse(tokenExpiresAt);
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= now.getTime();
}

function assertServerUrlMatchesConfig(config: LocalConfig): void {
  const serverUrl = new URL(config.server_url);
  const hostMatches = normalizeLoopbackHttpHost(serverUrl.hostname) === normalizeLoopbackHttpHost(config.host);
  const portMatches = effectiveUrlPort(serverUrl) === config.port;
  // The persisted URL must carry NO query at all: the token lives in `token`
  // and nowhere else.
  const shapeMatches =
    serverUrl.protocol === "http:" && serverUrl.pathname === "/mcp" && Array.from(serverUrl.searchParams.keys()).length === 0;
  if (!hostMatches || !portMatches || !shapeMatches) {
    throw new Error(".bridge/config.local.json server_url must be the token-free endpoint for host and port. Run `prodex setup` to replace it.");
  }
}

function effectiveUrlPort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === "http:" ? 80 : Number.NaN;
}

type SalvagedConfig = Partial<Pick<LocalConfig, "host" | "port" | "token" | "token_expires_at" | "browser_defaults" | "created_at">>;

/**
 * The existing config's fields that are still valid. Any failure used to count
 * as no config at all, so one invalid optional field (an effort of "Extra
 * High") made setup rotate the token, drop the valid defaults and the expiry
 * and reset created_at, without a word (found 2026-11-09). server_url and
 * updated_at are rebuilt on every write and are not salvaged.
 */
async function readExistingConfig(cwd: string): Promise<{ config: SalvagedConfig; dropped: string[]; unreadable: boolean } | undefined> {
  const unreadable = { config: {}, dropped: [], unreadable: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readVerifiedUtf8File(localConfigPath(cwd), () => assertLocalConfigTargetSafe(cwd, { allowMissing: false })));
  } catch (error) {
    return isMissingFileError(error) ? undefined : unreadable;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return unreadable;
  const raw = parsed as Record<string, unknown>;
  if (raw.schema_version !== SCHEMA_VERSION) return unreadable;
  const whole = LocalConfigSchema.safeParse(raw);
  if (whole.success) return { config: whole.data, dropped: [], unreadable: false };

  const config: SalvagedConfig = {};
  const dropped: string[] = [];
  const keep = <K extends keyof SalvagedConfig & keyof typeof LocalConfigSchema.shape>(key: K, required: boolean): void => {
    if (raw[key] === undefined) {
      if (required) dropped.push(key);
      return;
    }
    const field = LocalConfigSchema.shape[key].safeParse(raw[key]);
    if (field.success) config[key] = field.data as SalvagedConfig[K];
    else dropped.push(key);
  };
  keep("host", true);
  keep("port", true);
  keep("token", true);
  keep("token_expires_at", false);
  keep("created_at", true);
  // A token is kept only together with the expiry it was saved with: keeping
  // it without one would turn a token meant to lapse into one that never does.
  if (dropped.includes("token") || dropped.includes("token_expires_at")) {
    delete config.token;
    delete config.token_expires_at;
  }
  const defaults = raw.browser_defaults;
  if (typeof defaults === "object" && defaults !== null && !Array.isArray(defaults)) {
    const kept: BrowserDefaults = {};
    for (const key of Object.keys(BrowserDefaultsSchema.shape) as Array<keyof BrowserDefaults>) {
      const value = (defaults as Record<string, unknown>)[key];
      if (value === undefined) continue;
      const field = BrowserDefaultsSchema.shape[key].safeParse(value);
      if (field.success) (kept as Record<string, unknown>)[key] = field.data;
      else dropped.push(`browser_defaults.${key}`);
    }
    if (Object.keys(kept).length > 0) config.browser_defaults = kept;
  } else if (defaults !== undefined) {
    dropped.push("browser_defaults");
  }
  return { config, dropped, unreadable: false };
}

async function ensureBridgeLocalFiles(cwd: string): Promise<void> {
  const bridgeDir = path.join(cwd, ".bridge");
  await ensurePrivateBridgeDirectory(cwd);
  const ignorePath = path.join(bridgeDir, ".gitignore");
  await ensureBridgeGitignore(ignorePath, () => assertBridgeGitignoreTargetSafe(cwd));
}

async function ensurePrivateBridgeDirectory(cwd: string): Promise<void> {
  await mkdir(path.join(cwd, ".bridge"), { recursive: true, mode: BRIDGE_DIRECTORY_MODE });
  await chmodPrivateBridgeDirectory(cwd);
}

async function chmodPrivateBridgeDirectory(cwd: string): Promise<void> {
  const bridgeDir = path.join(cwd, ".bridge");
  const handle = await openNoFollowDirectory(bridgeDir, ".bridge");
  try {
    // Windows uses inherited ACLs; POSIX modes do not restrict Windows access.
    if (process.platform !== "win32") await handle.chmod(BRIDGE_DIRECTORY_MODE);
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
    const before = await lstat(dirPath, { bigint: true });
    if (before.isSymbolicLink() || !before.isDirectory()) {
      throw new Error(`${label} must be a real directory and must not be a symlink`);
    }
    const handle = await open(dirPath, constants.O_RDONLY | directoryFlag | noFollowFlag);
    try {
      await assertDirectoryHandle(handle, label);
      const opened = await handle.stat({ bigint: true });
      if (opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new Error(`${label} changed while opening the directory`);
      }
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

/**
 * The repo prodex should operate on. Defaults to the process working
 * directory, but PRODEX_CWD (absolute paths only) wins: the MCP server takes
 * no flags, so when an agent harness starts it from a pipe path or a deleted
 * directory, the env var is the only way an operator can pin the repo without
 * changing how that harness spawns the server.
 */
export function resolveProdexCwd(
  fallback: string = process.cwd(),
  env: Record<string, string | undefined> = process.env
): string {
  const raw = (env.PRODEX_CWD ?? "").trim();
  if (raw.length === 0 || !path.isAbsolute(raw)) return fallback;
  return raw;
}
