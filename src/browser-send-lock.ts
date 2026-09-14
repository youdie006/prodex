import os from "node:os";
import path from "node:path";
import { withCrossProcessFileLock } from "./safe-file.js";

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

/**
 * Serialize visible-browser sends across processes. Waits up to waitMs for a
 * live holder to finish (0 = fail fast); a lock whose holder process is dead
 * is reaped immediately.
 */
export async function withBrowserSendLock<T>(waitMs: number, onWait: (detail: string) => void, fn: () => Promise<T>): Promise<T> {
  const file = lockPath();
  const reapClaim = path.join(path.dirname(file), `.${path.basename(file)}.reap`);
  return withCrossProcessFileLock(
    file,
    {
      waitMs,
      retryMs: 2_000,
      privateParent: true,
      onWait: (holder) => onWait(`another prodex send holds the browser (pid ${holder.pid ?? "unknown"}); waiting`),
      busyError: (holder) =>
        new Error(
          `Another prodex browser send is in progress (pid ${holder.pid ?? "unknown"}) and did not finish within the wait budget. Retry once it finishes, or raise --timeout-ms (which is also the queue budget).`
        ),
      unavailableError: () =>
        new Error(
          `A prodex browser send lock at ${file} is held by nothing and could not be removed, so no send can start. Stop all prodex senders and verify no request is active before deleting that file and the abandoned reaper claim at ${reapClaim}, then retry.`
        )
    },
    fn
  );
}
