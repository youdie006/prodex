import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

type SafeFileOperation = "read" | "write";

export type SafeFileTestHooks = {
  beforeOpen?: (filePath: string, operation: SafeFileOperation) => Promise<void> | void;
};

let testHooks: SafeFileTestHooks = {};

export function setSafeFileTestHooks(hooks: SafeFileTestHooks): void {
  testHooks = hooks;
}

export async function readVerifiedUtf8File(
  filePath: string,
  validate: () => Promise<void>,
  options: { maxBytes?: number } = {}
): Promise<string> {
  await validate();
  await testHooks.beforeOpen?.(filePath, "read");
  const handle = await openNoFollow(filePath, constants.O_RDONLY, "read");
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
  options: { create?: boolean; maxBytes?: number } = {}
): Promise<void> {
  if (options.maxBytes !== undefined && Buffer.byteLength(content, "utf8") > options.maxBytes) {
    throw new Error(`New content is too large (${Buffer.byteLength(content, "utf8")} bytes)`);
  }
  await validate();
  await testHooks.beforeOpen?.(filePath, "write");
  const createFlag = options.create ? constants.O_CREAT : 0;
  const handle = await openNoFollow(filePath, constants.O_WRONLY | constants.O_TRUNC | createFlag, "write");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error(`Path ${filePath} is not a regular file`);
    }
    await handle.writeFile(content, "utf8");
    await validate();
  } finally {
    await handle.close();
  }
}

async function openNoFollow(filePath: string, flags: number, operation: SafeFileOperation): Promise<FileHandle> {
  const noFollowFlag = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  try {
    return await open(filePath, flags | noFollowFlag);
  } catch (error) {
    const maybe = error as { code?: string };
    if (maybe.code === "ELOOP") {
      throw new Error(`Path ${filePath} is a symlink or changed during ${operation} file operation`);
    }
    throw error;
  }
}
