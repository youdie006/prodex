import { constants } from "node:fs";
import { open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";

type SafeFileOperation = "read" | "write";

export type SafeFileTestHooks = {
  beforeOpen?: (filePath: string, operation: SafeFileOperation) => Promise<void> | void;
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
  options: { maxBytes?: number } = {}
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
    if (options.maxBytes !== undefined && stat.size > options.maxBytes) {
      throw new Error(`Path ${filePath} is too large (${stat.size} bytes)`);
    }
    const content = await handle.readFile("utf8");
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
  options: { create?: boolean; maxBytes?: number; mode?: number } = {}
): Promise<void> {
  if (options.maxBytes !== undefined && Buffer.byteLength(content, "utf8") > options.maxBytes) {
    throw new Error(`New content is too large (${Buffer.byteLength(content, "utf8")} bytes)`);
  }
  await validate();
  const parentSnapshot = await captureParentSnapshot(filePath);
  await testHooks.beforeOpen?.(filePath, "write");
  const createFlag = options.create ? constants.O_CREAT : 0;
  const handle = await openStableNoFollow(
    filePath,
    constants.O_WRONLY | constants.O_TRUNC | createFlag,
    "write",
    parentSnapshot,
    options.mode
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error(`Path ${filePath} is not a regular file`);
    }
    await handle.writeFile(content, "utf8");
    if (options.mode !== undefined) {
      await handle.chmod(options.mode);
    }
    await validate();
  } finally {
    await handle.close();
  }
}

async function captureParentSnapshot(filePath: string): Promise<ParentSnapshot | undefined> {
  if (process.platform !== "linux") return undefined;
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
