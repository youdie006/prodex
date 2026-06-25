import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";

type SafeFileOperation = "read" | "write";

export type SafeFileTestHooks = {
  afterWrite?: (filePath: string, operation: SafeFileOperation) => Promise<void> | void;
  beforeChmod?: (filePath: string, operation: SafeFileOperation) => Promise<void> | void;
  beforeOpen?: (filePath: string, operation: SafeFileOperation) => Promise<void> | void;
  beforeRename?: (filePath: string, tmpPath: string) => Promise<void> | void;
  beforeReplace?: (filePath: string) => Promise<void> | void;
  beforeWrite?: (filePath: string, operation: SafeFileOperation) => Promise<void> | void;
};

let testHooks: SafeFileTestHooks = {};

interface ParentSnapshot {
  path: string;
  realPath: string;
}

export function setSafeFileTestHooks(hooks: SafeFileTestHooks): void {
  testHooks = hooks;
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
      throw new Error(`Path ${filePath} is not a regular file`);
    }
    assertNotHardLinked(filePath, stat.nlink);
    if (options.maxBytes !== undefined && stat.size > options.maxBytes) {
      throw new Error(`Path ${filePath} is too large (${stat.size} bytes)`);
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
      throw new Error(`Path ${filePath} is not a regular file`);
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
    throw new Error(`Path ${filePath} is not a regular file`);
  }
  assertNotHardLinked(filePath, stat.nlink);
  if (maxBytes !== undefined && stat.size > maxBytes) {
    throw new Error(`Path ${filePath} is too large (${stat.size} bytes)`);
  }
  const buffer = Buffer.alloc(maxBytes === undefined ? stat.size : maxBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
    if (maxBytes !== undefined && offset > maxBytes) {
      throw new Error(`Path ${filePath} is too large (${offset} bytes)`);
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
      throw new Error(`Could not write content to ${filePath}`);
    }
    offset += bytesWritten;
  }
}

async function assertSafeOpenFile(handle: FileHandle, filePath: string): Promise<void> {
  const stat = await handle.stat();
  if (!stat.isFile()) {
    throw new Error(`Path ${filePath} is not a regular file`);
  }
  assertNotHardLinked(filePath, stat.nlink);
}

function assertNotHardLinked(filePath: string, linkCount: number): void {
  if (linkCount > 1) {
    throw new Error(`Path ${filePath} is hard linked and cannot be used through safe file operations`);
  }
}

async function assertExistingTargetNotHardLinked(filePath: string): Promise<void> {
  try {
    const stat = await lstat(filePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Path ${filePath} is a symlink and cannot be used through safe file operations`);
    }
    if (!stat.isFile()) {
      throw new Error(`Path ${filePath} is not a regular file`);
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
    throw new Error(`Path ${parentSnapshot.path} changed during write file operation`);
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
      throw new Error(`Path ${filePath} changed during ${operation} file operation`);
    }
    const handle = await openNoFollow(filePath, flags, operation, mode);
    try {
      const actualParentAfterOpen = await realpath(parentSnapshot.path);
      if (actualParentAfterOpen !== parentSnapshot.realPath) {
        throw new Error(`Path ${filePath} changed during ${operation} file operation`);
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
      throw new Error(`Path ${filePath} changed during ${operation} file operation`);
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
      throw new Error(`Path ${dirPath} is not a directory`);
    }
    return handle;
  } catch (error) {
    const maybe = error as { code?: string };
    if (maybe.code === "ELOOP") {
      throw new Error(`Path ${dirPath} is a symlink or changed during ${operation} file operation`);
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
      throw new Error(`Path ${filePath} is a symlink or changed during ${operation} file operation`);
    }
    throw error;
  }
}

function procFdPath(fd: number): string {
  return `/proc/self/fd/${fd}`;
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}
