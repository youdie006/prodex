import { link, mkdir, open, readFile, rm } from "node:fs/promises";
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
  } catch (error) {
    // EPERM: the process exists but is owned by another user -> alive. Only
    // ESRCH (no such process) means the holder is truly dead and reapable.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface LockHolder {
  pid?: number;
  started_at?: string;
}

async function readHolder(file: string): Promise<LockHolder | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as { pid?: unknown; started_at?: unknown };
    return {
      pid: typeof parsed.pid === "number" ? parsed.pid : undefined,
      started_at: typeof parsed.started_at === "string" ? parsed.started_at : undefined
    };
  } catch {
    return undefined;
  }
}

// A holder whose process is alive but has held the lock far longer than any real
// send (default 60 min, well beyond the 15-min Pro timeout) is treated as wedged
// and reapable, so a hung browser cannot block every send on the machine forever.
// Deliberately generous so it never reaps a genuinely in-flight send; override
// with PRODEX_SEND_LOCK_STALE_MS.
function staleMs(): number {
  const raw = Number(process.env.PRODEX_SEND_LOCK_STALE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 3_600_000;
}

function holderIsStale(startedAt: string | undefined): boolean {
  if (!startedAt) return false;
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return false;
  return Date.now() - started > staleMs();
}

// Release only our own lock: if ours was already reaped (e.g. as stale) and a
// new holder took over, we must not delete their lock on the way out.
async function releaseIfOwned(file: string): Promise<void> {
  const holder = await readHolder(file);
  if (holder?.pid === process.pid) {
    await rm(file, { force: true }).catch(() => undefined);
  }
}

let acquireSeq = 0;

async function tryAcquire(file: string): Promise<boolean> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  // Publish atomically: write the pid into a temp file, then hard-link it into
  // place. link() fails with EEXIST when a holder already exists (our exclusivity
  // check) and, unlike open("wx")+writeFile, the lock file is never observed
  // empty - so a concurrent waiter can never mistake a mid-publish lock for a
  // dead one and reap it out from under us (which let two clients send at once).
  // The temp name is unique per acquisition (pid + seq) so two concurrent
  // same-process acquires never share a temp inode and truncate each other.
  const temp = `${file}.${process.pid}.${(acquireSeq += 1)}.tmp`;
  const handle = await open(temp, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })}\n`);
  } finally {
    await handle.close();
  }
  try {
    await link(temp, file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return false;
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
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
    const holder = await readHolder(file);
    const reapable =
      holder === undefined || holder.pid === undefined || !holderIsAlive(holder.pid) || holderIsStale(holder.started_at);
    if (reapable) {
      // Re-verify the same holder still owns the file before removing it, so we
      // don't delete a fresh lock another reaper just acquired in between.
      const current = await readHolder(file);
      if (current?.pid === holder?.pid) {
        await rm(file, { force: true }).catch(() => undefined);
      }
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Another prodex browser send is in progress (pid ${holder.pid}). Wait for it to finish, or pass --busy-wait-ms to queue behind it.`
      );
    }
    if (!waited) {
      waited = true;
      onWait(`another prodex send holds the browser (pid ${holder.pid}); waiting`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  try {
    return await fn();
  } finally {
    await releaseIfOwned(file);
  }
}
