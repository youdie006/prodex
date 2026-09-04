// Write a bridge record into a directory the kernel has pinned for us.
//
// The store's normal path renders an open directory handle as /proc/self/fd/N
// and joins the file name onto it, so the write lands in the directory that was
// validated rather than in one a symlink swap redirected. macOS has no
// traversable equivalent - /dev/fd/N stands in for the descriptor, not for a
// walkable directory - so that path fails there with a bare ENOENT and takes the
// whole ledger with it.
//
// This process buys the same guarantee a different way. It is spawned with its
// cwd already set to the directory to descend from, it refuses to continue
// unless "." is the very inode the parent validated, and it descends by chdir
// one no-symlink segment at a time, re-checking the inode after each step. The
// kernel holds the cwd's vnode, so once a step is confirmed nothing can redirect
// the relative paths that follow. That is precisely what the fd path bought.
//
// Everything after the anchoring uses the same helpers the in-process path uses,
// on relative names.
import { closeSync, constants, fstatSync, openSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { link, lstat, readdir, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import { writeVerifiedUtf8File } from "./safe-file.js";

/** An inode identity, carried as strings because dev/ino can exceed a float. */
export type DirectoryIdentity = { dev: string; ino: string };

export type AnchoredWriteJob = {
  /** Identity of the directory the parent validated and set as our cwd. */
  anchor: DirectoryIdentity;
  /** Directory names to descend, each of which must not be a symlink. */
  segments: string[];
  fileName: string;
  mode: number;
  op: "writeByRename" | "linkIfAbsent" | "deleteIfPresent" | "cleanupTempHardLinks";
  /** Present for the two writing operations. */
  content?: string;
};

export type AnchoredWriteOutcome = { ok: true; created?: boolean } | { ok: false; error: string; code?: string };

function identityOfOpenDirectory(fd: number): DirectoryIdentity {
  const stat = fstatSync(fd, { bigint: true });
  if (!stat.isDirectory()) throw new Error("Anchored writer expected a directory");
  return { dev: stat.dev.toString(), ino: stat.ino.toString() };
}

function sameIdentity(a: DirectoryIdentity, b: DirectoryIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/** Open a name relative to the cwd, refusing symlinks and non-directories. */
function openDirectoryHere(name: string): number {
  const directoryFlag = typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0;
  const noFollowFlag = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  return openSync(name, constants.O_RDONLY | directoryFlag | noFollowFlag);
}

function currentDirectoryIdentity(): DirectoryIdentity {
  const fd = openDirectoryHere(".");
  try {
    return identityOfOpenDirectory(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Confirm the cwd is the directory the parent meant, then descend the segments
 * so that the cwd ends up pinned to the directory the record belongs in.
 */
export function anchorCurrentDirectory(anchor: DirectoryIdentity, segments: string[]): DirectoryIdentity {
  let here = currentDirectoryIdentity();
  if (!sameIdentity(here, anchor)) {
    throw new Error("Anchored writer was not started in the directory the caller validated");
  }
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === ".." || segment.includes("/")) {
      throw new Error(`Anchored writer refuses to descend into ${JSON.stringify(segment)}`);
    }
    // O_NOFOLLOW proves the name is a real directory rather than a symlink, and
    // the identity check after chdir proves we landed on that same directory
    // and not on something swapped in between the two calls.
    const fd = openDirectoryHere(segment);
    let expected: DirectoryIdentity;
    try {
      expected = identityOfOpenDirectory(fd);
    } finally {
      closeSync(fd);
    }
    process.chdir(segment);
    here = currentDirectoryIdentity();
    if (!sameIdentity(here, expected)) {
      throw new Error(`Anchored writer landed somewhere other than ${JSON.stringify(segment)}`);
    }
  }
  return here;
}

async function assertRegularFileIfExists(name: string): Promise<void> {
  try {
    const stat = await lstat(name);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("Bridge record path must be a regular file and must not be a symlink");
    }
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
}

function temporaryName(fileName: string): string {
  return `.${fileName}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
}

export async function runAnchoredJob(job: AnchoredWriteJob): Promise<AnchoredWriteOutcome> {
  const pinned = anchorCurrentDirectory(job.anchor, job.segments);
  const stillPinned = async (): Promise<void> => {
    if (!sameIdentity(currentDirectoryIdentity(), pinned)) {
      throw new Error("Anchored writer's directory changed underneath it");
    }
  };
  const { fileName } = job;
  if (fileName.length === 0 || fileName.includes("/") || fileName === "." || fileName === "..") {
    throw new Error(`Anchored writer refuses the file name ${JSON.stringify(fileName)}`);
  }

  if (job.op === "deleteIfPresent") {
    let stat;
    try {
      stat = await lstat(fileName);
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return { ok: true };
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("Bridge record path must be a regular file and must not be a symlink");
    }
    await rm(fileName, { force: true });
    return { ok: true };
  }

  if (job.op === "cleanupTempHardLinks") {
    let targetStat;
    try {
      targetStat = await lstat(fileName);
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return { ok: true };
      throw error;
    }
    if (targetStat.isSymbolicLink() || !targetStat.isFile() || targetStat.nlink <= 1) return { ok: true };
    const prefix = `.${fileName}.`;
    for (const entry of await readdir(".", { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith(".tmp")) continue;
      const tempStat = await lstat(entry.name).catch(() => undefined);
      if (!tempStat?.isFile() || tempStat.isSymbolicLink()) continue;
      if (tempStat.dev === targetStat.dev && tempStat.ino === targetStat.ino) {
        await rm(entry.name, { force: true });
      }
    }
    return { ok: true };
  }

  const content = job.content ?? "";
  const tmpName = temporaryName(fileName);

  if (job.op === "writeByRename") {
    await assertRegularFileIfExists(fileName);
    try {
      await writeVerifiedUtf8File(tmpName, content, stillPinned, { create: true, mode: job.mode });
      await rename(tmpName, fileName);
      await assertRegularFileIfExists(fileName);
    } catch (error) {
      await rm(tmpName, { force: true }).catch(() => undefined);
      throw error;
    }
    return { ok: true };
  }

  // linkIfAbsent: the hard link is what makes "create only if absent" atomic.
  let linked = false;
  try {
    await writeVerifiedUtf8File(tmpName, content, stillPinned, { create: true, exclusive: true, mode: job.mode });
    try {
      await link(tmpName, fileName);
    } catch (error) {
      if ((error as { code?: string }).code === "EEXIST") {
        await rm(tmpName, { force: true }).catch(() => undefined);
        return { ok: true, created: false };
      }
      throw error;
    }
    linked = true;
    await rm(tmpName, { force: true });
    await assertRegularFileIfExists(fileName);
  } catch (error) {
    if (!linked) await rm(tmpName, { force: true }).catch(() => undefined);
    throw error;
  }
  return { ok: true, created: true };
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  let outcome: AnchoredWriteOutcome;
  try {
    outcome = await runAnchoredJob(JSON.parse(await readAllStdin()) as AnchoredWriteJob);
  } catch (error) {
    const maybe = error as { message?: string; code?: string };
    outcome = { ok: false, error: maybe.message ?? String(error), code: maybe.code };
  }
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
  if (!outcome.ok) process.exitCode = 1;
}

// Only run when this file is the entry point, so the exported pieces stay
// importable from tests without the process trying to read stdin.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
