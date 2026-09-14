import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, realpath, rename, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";

type SafeFileOperation = "read" | "write";

export type SafeFileTestHooks = {
  afterLockReapClaim?: (filePath: string) => Promise<void> | void;
  afterWrite?: (filePath: string, operation: SafeFileOperation) => Promise<void> | void;
  beforeChmod?: (filePath: string, operation: SafeFileOperation) => Promise<void> | void;
  beforeOpen?: (filePath: string, operation: SafeFileOperation) => Promise<void> | void;
  beforeRename?: (filePath: string, tmpPath: string) => Promise<void> | void;
  beforeReplace?: (filePath: string) => Promise<void> | void;
  beforeWrite?: (filePath: string, operation: SafeFileOperation) => Promise<void> | void;
};

export interface CrossProcessFileLockHolder {
  pid?: number;
  started_at?: string;
}

export interface CrossProcessFileLockOptions {
  waitMs: number;
  retryMs?: number;
  privateParent?: boolean;
  onWait?: (holder: CrossProcessFileLockHolder) => void;
  busyError: (holder: CrossProcessFileLockHolder) => Error;
  unavailableError: () => Error;
}

let testHooks: SafeFileTestHooks = {};

interface ParentSnapshot {
  path: string;
  realPath: string;
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

interface FileLockOwner extends CrossProcessFileLockHolder {
  pid: number;
  nonce: string;
}

interface FileLockSnapshot {
  identity: FileIdentity;
  holder: CrossProcessFileLockHolder;
  owner?: FileLockOwner;
  unsafe?: boolean;
}

interface FileLockLease {
  owner: FileLockOwner;
  tokenPath: string;
}

export function setSafeFileTestHooks(hooks: SafeFileTestHooks): void {
  testHooks = hooks;
}

/**
 * Serialize cooperating processes through a complete, atomically published
 * lock record. A live process is never evicted based on elapsed time: callers
 * must cancel their own work before releasing the lease.
 */
export async function withCrossProcessFileLock<T>(
  filePath: string,
  options: CrossProcessFileLockOptions,
  fn: () => Promise<T>
): Promise<T> {
  const parentSnapshot = await prepareFileLockParent(filePath, options.privateParent === true);
  const deadline = Date.now() + Math.max(0, options.waitMs);
  const retryMs = Math.max(1, options.retryMs ?? 50);
  let waited = false;
  let retriedMissingAtDeadline = false;
  let lease: FileLockLease | undefined;
  for (;;) {
    lease = await tryAcquireFileLock(filePath, parentSnapshot);
    if (lease) break;

    const snapshot = await readFileLockSnapshot(filePath, parentSnapshot);
    if (!snapshot) {
      // The holder commonly disappears between our failed link and inspection.
      // Retry that acquisition once even at the deadline, but do not let a
      // rapidly flapping path bypass a bounded caller's wait budget forever.
      if (Date.now() >= deadline) {
        if (retriedMissingAtDeadline) throw options.unavailableError();
        retriedMissingAtDeadline = true;
      } else {
        await delay(Math.min(10, Math.max(1, deadline - Date.now())));
      }
      continue;
    }
    retriedMissingAtDeadline = false;
    const holderAlive = snapshot.holder.pid !== undefined && processIsAlive(snapshot.holder.pid);
    if (!holderAlive && (await reapFileLockSnapshot(filePath, snapshot, parentSnapshot))) continue;

    if (Date.now() >= deadline) {
      throw holderAlive ? options.busyError(snapshot.holder) : options.unavailableError();
    }
    if (!waited) {
      waited = true;
      options.onWait?.(snapshot.holder);
    }
    await delay(Math.min(retryMs, Math.max(1, deadline - Date.now())));
  }

  try {
    return await fn();
  } finally {
    await releaseFileLockLease(filePath, lease, parentSnapshot);
  }
}

export async function readVerifiedUtf8File(
  filePath: string,
  validate: () => Promise<void>,
  options: { maxBytes?: number; mode?: number } = {}
): Promise<string> {
  await validate();
  const parentSnapshot = await captureParentSnapshot(filePath);
  await testHooks.beforeOpen?.(filePath, "read");
  const handle = await openStableNoFollow(filePath, constants.O_RDONLY, "read", parentSnapshot);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error("Target path is not a regular file");
    }
    assertNotHardLinked(filePath, stat.nlink);
    if (options.maxBytes !== undefined && stat.size > options.maxBytes) {
      throw new Error(`Target file is too large (${stat.size} bytes)`);
    }
    const content = await readHandleUtf8(handle, filePath, options.maxBytes);
    if (options.mode !== undefined) {
      await testHooks.beforeChmod?.(filePath, "read");
      await handle.chmod(options.mode);
    }
    await validate();
    return content;
  } finally {
    await handle.close();
  }
}

export async function writeVerifiedUtf8File(
  filePath: string,
  content: string,
  validate: () => Promise<void>,
  options: { create?: boolean; exclusive?: boolean; maxBytes?: number; mode?: number } = {}
): Promise<void> {
  if (options.maxBytes !== undefined && Buffer.byteLength(content, "utf8") > options.maxBytes) {
    throw new Error(`New content is too large (${Buffer.byteLength(content, "utf8")} bytes)`);
  }
  if (!options.exclusive) {
    await replaceByVerifiedTempFile(filePath, content, validate, options);
    return;
  }
  await validate();
  const parentSnapshot = await captureParentSnapshot(filePath);
  await testHooks.beforeOpen?.(filePath, "write");
  const createFlag = options.create || options.exclusive ? constants.O_CREAT : 0;
  const exclusiveFlag = options.exclusive ? constants.O_EXCL : 0;
  const handle = await openStableNoFollow(
    filePath,
    constants.O_WRONLY | createFlag | exclusiveFlag,
    "write",
    parentSnapshot,
    options.mode
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error("Target path is not a regular file");
    }
    assertNotHardLinked(filePath, stat.nlink);
    await testHooks.beforeWrite?.(filePath, "write");
    await writeHandleUtf8(handle, filePath, content);
    await testHooks.afterWrite?.(filePath, "write");
    if (options.mode !== undefined) {
      await testHooks.beforeChmod?.(filePath, "write");
      await handle.chmod(options.mode);
    }
    await validate();
  } finally {
    await handle.close();
  }
}

export async function replaceVerifiedUtf8File(
  filePath: string,
  content: string,
  validate: () => Promise<void>,
  verifyCurrentContent: (currentContent: string) => Promise<void> | void,
  options: { maxBytes?: number; mode?: number } = {}
): Promise<void> {
  if (options.maxBytes !== undefined && Buffer.byteLength(content, "utf8") > options.maxBytes) {
    throw new Error(`New content is too large (${Buffer.byteLength(content, "utf8")} bytes)`);
  }
  await validate();
  const parentSnapshot = await captureParentSnapshot(filePath);
  await testHooks.beforeOpen?.(filePath, "write");
  const handle = await openStableNoFollow(filePath, constants.O_RDWR, "write", parentSnapshot, options.mode);
  try {
    const currentContent = await readHandleUtf8(handle, filePath, options.maxBytes);
    await verifyCurrentContent(currentContent);
    await testHooks.beforeReplace?.(filePath);
    const latestContent = await readHandleUtf8(handle, filePath, options.maxBytes);
    await verifyCurrentContent(latestContent);
    await testHooks.beforeWrite?.(filePath, "write");
    await replaceByVerifiedTempFile(filePath, content, validate, options, {
      beforeOpenAlreadyRan: true,
      beforeWriteAlreadyRan: true,
      parentSnapshot,
      skipExistingTargetCheck: true
    });
  } finally {
    await handle.close();
  }
}

async function replaceByVerifiedTempFile(
  filePath: string,
  content: string,
  validate: () => Promise<void>,
  options: { create?: boolean; maxBytes?: number; mode?: number } = {},
  hookState: {
    beforeOpenAlreadyRan?: boolean;
    beforeWriteAlreadyRan?: boolean;
    parentSnapshot?: ParentSnapshot;
    skipExistingTargetCheck?: boolean;
  } = {}
): Promise<void> {
  await validate();
  if (!hookState.skipExistingTargetCheck) {
    await assertExistingTargetNotHardLinked(filePath);
  }
  const parentSnapshot = hookState.parentSnapshot ?? (await captureParentSnapshot(filePath));
  if (!hookState.beforeOpenAlreadyRan) {
    await testHooks.beforeOpen?.(filePath, "write");
  }
  await assertParentSnapshotStable(parentSnapshot);
  const tmpPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
  try {
    const tmpHandle = await openStableNoFollow(tmpPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, "write", parentSnapshot, options.mode);
    try {
      await writeHandleUtf8(tmpHandle, tmpPath, content);
      if (options.mode !== undefined) {
        await testHooks.beforeChmod?.(filePath, "write");
        await tmpHandle.chmod(options.mode);
      }
    } finally {
      await tmpHandle.close();
    }
    if (!hookState.beforeWriteAlreadyRan) {
      await testHooks.beforeWrite?.(filePath, "write");
    }
    await validate();
    await assertParentSnapshotStable(parentSnapshot);
    await testHooks.beforeRename?.(filePath, tmpPath);
    await assertExistingTargetNotHardLinked(tmpPath);
    await rename(tmpPath, filePath);
    await validate();
    await testHooks.afterWrite?.(filePath, "write");
  } catch (error) {
    await cleanupTempIfParentStable(tmpPath, parentSnapshot);
    throw error;
  }
}

async function readHandleUtf8(handle: FileHandle, filePath: string, maxBytes?: number): Promise<string> {
  const stat = await handle.stat();
  if (!stat.isFile()) {
    throw new Error("Target path is not a regular file");
  }
  assertNotHardLinked(filePath, stat.nlink);
  if (maxBytes !== undefined && stat.size > maxBytes) {
    throw new Error(`Target file is too large (${stat.size} bytes)`);
  }
  const buffer = Buffer.alloc(maxBytes === undefined ? stat.size : maxBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
    if (maxBytes !== undefined && offset > maxBytes) {
      throw new Error(`Target file is too large (${offset} bytes)`);
    }
  }
  return buffer.subarray(0, offset).toString("utf8");
}

async function writeHandleUtf8(handle: FileHandle, filePath: string, content: string): Promise<void> {
  const replacement = Buffer.from(content, "utf8");
  await assertSafeOpenFile(handle, filePath);
  await handle.truncate(0);
  let offset = 0;
  while (offset < replacement.length) {
    const { bytesWritten } = await handle.write(replacement, offset, replacement.length - offset, offset);
    if (bytesWritten === 0) {
      throw new Error("Could not write content to target file");
    }
    offset += bytesWritten;
  }
}

async function assertSafeOpenFile(handle: FileHandle, filePath: string): Promise<void> {
  const stat = await handle.stat();
  if (!stat.isFile()) {
    throw new Error("Target path is not a regular file");
  }
  assertNotHardLinked(filePath, stat.nlink);
}

function assertNotHardLinked(filePath: string, linkCount: number): void {
  if (linkCount > 1) {
    throw new Error("Target path is hard linked and cannot be used through safe file operations");
  }
}

async function assertExistingTargetNotHardLinked(filePath: string): Promise<void> {
  try {
    const stat = await lstat(filePath);
    if (stat.isSymbolicLink()) {
      throw new Error("Target path is a symlink and cannot be used through safe file operations");
    }
    if (!stat.isFile()) {
      throw new Error("Target path is not a regular file");
    }
    assertNotHardLinked(filePath, stat.nlink);
  } catch (error) {
    if (isMissingFileError(error)) return;
    throw error;
  }
}

async function assertParentSnapshotStable(parentSnapshot: ParentSnapshot | undefined): Promise<void> {
  if (!parentSnapshot) return;
  if ((await realpath(parentSnapshot.path)) !== parentSnapshot.realPath) {
    throw new Error("Parent directory changed during write file operation");
  }
}

async function cleanupTempIfParentStable(tmpPath: string, parentSnapshot: ParentSnapshot | undefined): Promise<void> {
  try {
    await assertParentSnapshotStable(parentSnapshot);
    await rm(tmpPath, { force: true });
  } catch {
    // If the parent moved or was swapped, do not follow the unstable path for cleanup.
  }
}

async function captureParentSnapshot(filePath: string): Promise<ParentSnapshot | undefined> {
  const parentPath = path.dirname(filePath);
  if (parentPath.startsWith("/proc/self/fd/")) return undefined;
  return {
    path: parentPath,
    realPath: await realpath(parentPath)
  };
}

async function openStableNoFollow(
  filePath: string,
  flags: number,
  operation: SafeFileOperation,
  parentSnapshot?: ParentSnapshot,
  mode?: number
): Promise<FileHandle> {
  if (!parentSnapshot) return openNoFollow(filePath, flags, operation, mode);
  if (process.platform !== "linux") {
    const actualParentBeforeOpen = await realpath(parentSnapshot.path);
    if (actualParentBeforeOpen !== parentSnapshot.realPath) {
      throw new Error(`Parent directory changed before ${operation} file operation`);
    }
    const handle = await openNoFollow(filePath, flags, operation, mode);
    try {
      const actualParentAfterOpen = await realpath(parentSnapshot.path);
      if (actualParentAfterOpen !== parentSnapshot.realPath) {
        throw new Error(`Parent directory changed during ${operation} file operation`);
      }
      return handle;
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }
  const parentHandle = await openNoFollowDirectory(parentSnapshot.path, operation);
  try {
    const parentFdPath = procFdPath(parentHandle.fd);
    const actualParent = await realpath(parentFdPath);
    if (actualParent !== parentSnapshot.realPath) {
      throw new Error(`Parent directory changed during ${operation} file operation`);
    }
    return await openNoFollow(path.join(parentFdPath, path.basename(filePath)), flags, operation, mode);
  } finally {
    await parentHandle.close();
  }
}

async function openNoFollowDirectory(dirPath: string, operation: SafeFileOperation): Promise<FileHandle> {
  const noFollowFlag = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const directoryFlag = typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0;
  try {
    const handle = await open(dirPath, constants.O_RDONLY | directoryFlag | noFollowFlag);
    const stat = await handle.stat();
    if (!stat.isDirectory()) {
      await handle.close().catch(() => undefined);
      throw new Error("Target parent is not a directory");
    }
    return handle;
  } catch (error) {
    const maybe = error as { code?: string };
    if (maybe.code === "ELOOP") {
      throw new Error(`Target parent is a symlink or changed during ${operation} file operation`);
    }
    throw error;
  }
}

async function openNoFollow(filePath: string, flags: number, operation: SafeFileOperation, mode?: number): Promise<FileHandle> {
  const noFollowFlag = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  try {
    return await open(filePath, flags | noFollowFlag, mode);
  } catch (error) {
    const maybe = error as { code?: string };
    if (maybe.code === "ELOOP") {
      throw new Error(`Target path is a symlink or changed during ${operation} file operation`);
    }
    throw error;
  }
}

async function prepareFileLockParent(filePath: string, makePrivate: boolean): Promise<ParentSnapshot> {
  const parentPath = path.dirname(filePath);
  await mkdir(parentPath, { recursive: true, mode: 0o700 });
  const parentStat = await lstat(parentPath);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new Error("Lock parent must be a real directory and must not be a symlink");
  }
  if (makePrivate) await chmod(parentPath, 0o700);
  const snapshot = await captureParentSnapshot(filePath);
  if (!snapshot) throw new Error("Lock files cannot use a descriptor-backed parent path");
  await assertParentSnapshotStable(snapshot);
  return snapshot;
}

async function tryAcquireFileLock(filePath: string, parentSnapshot: ParentSnapshot): Promise<FileLockLease | undefined> {
  const owner: FileLockOwner = {
    pid: process.pid,
    nonce: randomUUID(),
    started_at: new Date().toISOString()
  };
  const tokenPath = fileLockTokenPath(filePath, owner);
  const handle = await openStableNoFollow(
    tokenPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    "write",
    parentSnapshot,
    0o600
  );
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
  try {
    await assertParentSnapshotStable(parentSnapshot);
    await link(tokenPath, filePath);
    return { owner, tokenPath };
  } catch (error) {
    await rm(tokenPath, { force: true }).catch(() => undefined);
    if (isErrorCode(error, "EEXIST")) return undefined;
    throw error;
  }
}

async function readFileLockSnapshot(
  filePath: string,
  parentSnapshot: ParentSnapshot
): Promise<FileLockSnapshot | undefined> {
  let pathIdentity: FileIdentity;
  try {
    const pathStat = await lstat(filePath, { bigint: true });
    pathIdentity = { dev: pathStat.dev, ino: pathStat.ino };
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
      return { identity: pathIdentity, holder: {}, unsafe: true };
    }
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
  let handle: FileHandle;
  try {
    handle = await openStableNoFollow(filePath, constants.O_RDONLY, "read", parentSnapshot);
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    return { identity: pathIdentity, holder: {}, unsafe: true };
  }
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) return { identity: pathIdentity, holder: {}, unsafe: true };
    const identity = { dev: stat.dev, ino: stat.ino };
    if (stat.size > 16_384n) return { identity, holder: {} };
    const content = await handle.readFile({ encoding: "utf8" });
    const holder = parseFileLockHolder(content);
    return { identity, holder, owner: parseFileLockOwner(holder) };
  } catch {
    return { identity: pathIdentity, holder: {} };
  } finally {
    await handle.close();
  }
}

function parseFileLockHolder(content: string): CrossProcessFileLockHolder & { nonce?: string } {
  try {
    const parsed = JSON.parse(content) as { pid?: unknown; nonce?: unknown; started_at?: unknown };
    return {
      pid: Number.isSafeInteger(parsed.pid) && Number(parsed.pid) > 0 ? Number(parsed.pid) : undefined,
      nonce:
        typeof parsed.nonce === "string" && /^[A-Za-z0-9-]{1,128}$/.test(parsed.nonce) ? parsed.nonce : undefined,
      started_at: typeof parsed.started_at === "string" ? parsed.started_at : undefined
    };
  } catch {
    return {};
  }
}

function parseFileLockOwner(holder: CrossProcessFileLockHolder & { nonce?: string }): FileLockOwner | undefined {
  if (holder.pid === undefined || holder.nonce === undefined) return undefined;
  return { pid: holder.pid, nonce: holder.nonce, started_at: holder.started_at };
}

async function releaseFileLockLease(
  filePath: string,
  lease: FileLockLease,
  parentSnapshot: ParentSnapshot
): Promise<void> {
  try {
    const [current, tokenIdentity] = await Promise.all([
      readFileLockSnapshot(filePath, parentSnapshot),
      readRegularFileIdentity(lease.tokenPath)
    ]);
    if (
      current?.owner?.pid === lease.owner.pid &&
      current.owner.nonce === lease.owner.nonce &&
      tokenIdentity &&
      sameFileIdentity(current.identity, tokenIdentity)
    ) {
      await rm(filePath, { force: true });
    }
  } catch {
    // A release is best-effort; the unique token cleanup below cannot affect a successor.
  } finally {
    await rm(lease.tokenPath, { force: true }).catch(() => undefined);
  }
}

async function reapFileLockSnapshot(
  filePath: string,
  snapshot: FileLockSnapshot,
  parentSnapshot: ParentSnapshot
): Promise<boolean> {
  if (snapshot.unsafe) return false;
  return reapClaimedFileLock(filePath, snapshot, parentSnapshot);
}

async function reapClaimedFileLock(
  filePath: string,
  snapshot: FileLockSnapshot,
  parentSnapshot: ParentSnapshot
): Promise<boolean> {
  const claimPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.reap`);
  try {
    await link(filePath, claimPath);
  } catch (error) {
    if (isMissingFileError(error)) return true;
    // An interrupted reaper requires manual cleanup after all users stop.
    // Reaping this claim recursively would reintroduce successor-unlink races.
    if (isErrorCode(error, "EEXIST")) return false;
    throw error;
  }
  try {
    await testHooks.afterLockReapClaim?.(filePath);
    const [claimIdentity, current, ownerTokenIdentity] = await Promise.all([
      readRegularFileIdentity(claimPath),
      readFileLockSnapshot(filePath, parentSnapshot),
      snapshot.owner ? readRegularFileIdentity(fileLockTokenPath(filePath, snapshot.owner)) : undefined
    ]);
    if (
      !claimIdentity ||
      !current ||
      !sameFileIdentity(claimIdentity, snapshot.identity) ||
      !sameFileIdentity(current.identity, snapshot.identity)
    ) {
      return false;
    }
    await rm(filePath, { force: true });
    if (snapshot.owner && ownerTokenIdentity && sameFileIdentity(ownerTokenIdentity, snapshot.identity)) {
      await rm(fileLockTokenPath(filePath, snapshot.owner), { force: true }).catch(() => undefined);
    }
    return true;
  } finally {
    await rm(claimPath, { force: true }).catch(() => undefined);
  }
}

async function readRegularFileIdentity(filePath: string): Promise<FileIdentity | undefined> {
  try {
    const stat = await lstat(filePath, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isFile()) return undefined;
    return { dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
}

function fileLockTokenPath(filePath: string, owner: FileLockOwner): string {
  return path.join(path.dirname(filePath), `.${path.basename(filePath)}.${owner.pid}.${owner.nonce}.owner`);
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function procFdPath(fd: number): string {
  return `/proc/self/fd/${fd}`;
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}
