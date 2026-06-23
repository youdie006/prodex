import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { SCHEMA_VERSION } from "./schema.js";

const LocalConfigSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  host: z.string().min(1),
  port: z.number().int().positive(),
  token: z.string().min(1),
  server_url: z.string().url(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
});

export type LocalConfig = z.infer<typeof LocalConfigSchema>;

export interface WriteLocalConfigInput {
  host?: string;
  port?: number;
  token?: string;
}

export function localConfigPath(cwd: string): string {
  return path.join(cwd, ".bridge", "config.local.json");
}

export function makeServerUrl(host: string, port: number, token: string): string {
  return `http://${host}:${port}/mcp?gptprouse_token=${encodeURIComponent(token)}`;
}

export async function writeLocalConfig(cwd: string, input: WriteLocalConfigInput = {}): Promise<LocalConfig> {
  await ensureBridgeLocalFiles(cwd);
  const now = new Date().toISOString();
  const host = input.host ?? "127.0.0.1";
  const port = input.port ?? 8787;
  const token = input.token ?? randomBytes(24).toString("hex");
  const existing = await readExistingConfig(cwd);
  const config = LocalConfigSchema.parse({
    schema_version: SCHEMA_VERSION,
    host,
    port,
    token,
    server_url: makeServerUrl(host, port, token),
    created_at: existing?.created_at ?? now,
    updated_at: now
  });
  await writeFile(localConfigPath(cwd), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return config;
}

export async function loadLocalConfig(cwd: string): Promise<LocalConfig> {
  return LocalConfigSchema.parse(JSON.parse(await readFile(localConfigPath(cwd), "utf8")));
}

async function readExistingConfig(cwd: string): Promise<LocalConfig | undefined> {
  try {
    return LocalConfigSchema.parse(JSON.parse(await readFile(localConfigPath(cwd), "utf8")));
  } catch {
    return undefined;
  }
}

async function ensureBridgeLocalFiles(cwd: string): Promise<void> {
  const bridgeDir = path.join(cwd, ".bridge");
  await mkdir(bridgeDir, { recursive: true });
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
