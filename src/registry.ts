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
// In-process serialization: concurrent registrations from ONE process (e.g.
// several BridgeStores ensuring at once) would interleave read-modify-write
// even with the verify-retry below. Cross-process races remain bounded by the
// verify-retry plus the self-heal on every later ensure().
let registryQueue: Promise<void> = Promise.resolve();

export function registerBridgeRoot(root: string): Promise<void> {
  const next = registryQueue.then(() => registerBridgeRootInner(root));
  // Keep the chain alive even if an inner registration rejects.
  registryQueue = next.catch(() => {});
  return next;
}

async function registerBridgeRootInner(root: string): Promise<void> {
  try {
    const file = bridgesRegistryPath();
    const abs = path.resolve(root);
    // Read-modify-write with a bounded verify-retry: rename gives torn-write
    // atomicity but not lost-update safety - two processes registering
    // DIFFERENT roots at the same instant would each read the old list and
    // the last rename would win. Re-reading after the write and retrying
    // (re-merging into whatever the winner wrote) bounds that race; the
    // registry also self-heals on the next ensure() of the losing repo.
    for (let attempt = 0; attempt < 5; attempt++) {
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
      const tmp = `${file}.${process.pid}.${attempt}.tmp`;
      await fs.writeFile(tmp, `${JSON.stringify({ schema_version: SCHEMA_VERSION, roots }, null, 2)}\n`, "utf8");
      await fs.rename(tmp, file);
      // Verify our root survived a concurrent writer's rename.
      try {
        const check = JSON.parse(await fs.readFile(file, "utf8")) as { roots?: unknown };
        if (Array.isArray(check?.roots) && (check.roots as unknown[]).includes(abs)) return;
      } catch {
        // Unreadable right after our rename: a concurrent writer - retry.
      }
    }
  } catch {
    // Advisory registry - never let it fail a bridge operation.
  }
}
