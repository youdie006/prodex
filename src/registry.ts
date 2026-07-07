import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const SCHEMA_VERSION = 1;

/**
 * Central registry of every bridge root on this machine, so local indexers
 * (e.g. sessionwiki's prodex adapter) can find scattered per-repo `.bridge`
 * directories from one well-known file. Advisory data only - it holds
 * absolute directory paths, never task contents or secrets.
 */
export function bridgesRegistryPath(): string {
  const override = process.env.PRODEX_BRIDGES_REGISTRY;
  if (override && override.length > 0) return override;
  return path.join(os.homedir(), ".local", "share", "prodex", "bridges.json");
}

/**
 * Record `root` as a bridge location. Best-effort by design: the registry is
 * advisory, so a failure here (permissions, races, corrupt file) must never
 * break the task flow - errors are swallowed. A corrupt registry is rebuilt
 * from scratch. Writes are atomic (temp + rename).
 */
export async function registerBridgeRoot(root: string): Promise<void> {
  try {
    const file = bridgesRegistryPath();
    const abs = path.resolve(root);
    let roots: string[] = [];
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf8")) as { roots?: unknown };
      if (Array.isArray(parsed?.roots)) {
        roots = parsed.roots.filter((r): r is string => typeof r === "string");
      }
    } catch {
      // First write, or an unreadable/corrupt registry: start fresh.
    }
    if (roots.includes(abs)) return;
    roots.push(abs);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify({ schema_version: SCHEMA_VERSION, roots }, null, 2)}\n`, "utf8");
    await fs.rename(tmp, file);
  } catch {
    // Advisory registry - never let it fail a bridge operation.
  }
}
