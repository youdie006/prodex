import { mkdir, open, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// One visible-browser send at a time per machine: the dedicated Chrome is a
// single shared tab, and two concurrent prodex clients interleave composer
// input and navigation, silently cross-contaminating each other's threads
// (measured live: one client's token prompt landed inside the other client's
// consult thread, and a 15-minute consult never actually posted).
function lockPath(): string {
  const override = process.env.PRODEX_SEND_LOCK_FILE;
  if (override) return override;
  return path.join(os.homedir(), ".local", "share", "prodex", "browser-send.lock");
}

function holderIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readHolderPid(file: string): Promise<number | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as { pid?: unknown };
    return typeof parsed.pid === "number" ? parsed.pid : undefined;
  } catch {
    return undefined;
  }
}

async function tryAcquire(file: string): Promise<boolean> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    const handle = await open(file, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })}\n`);
    await handle.close();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return false;
  }
}

/**
 * Serialize visible-browser sends across processes. Waits up to waitMs for a
 * live holder to finish (0 = fail fast); a lock whose holder process is dead
 * is reaped immediately.
 */
export async function withBrowserSendLock<T>(waitMs: number, onWait: (detail: string) => void, fn: () => Promise<T>): Promise<T> {
  const file = lockPath();
  const deadline = Date.now() + Math.max(0, waitMs);
  let waited = false;
  for (;;) {
    if (await tryAcquire(file)) break;
    const holder = await readHolderPid(file);
    if (holder === undefined || !holderIsAlive(holder)) {
      await rm(file, { force: true }).catch(() => undefined);
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Another prodex browser send is in progress (pid ${holder}). Wait for it to finish, or pass --busy-wait-ms to queue behind it.`
      );
    }
    if (!waited) {
      waited = true;
      onWait(`another prodex send holds the browser (pid ${holder}); waiting`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  try {
    return await fn();
  } finally {
    await rm(file, { force: true }).catch(() => undefined);
  }
}
