import { lstat } from "node:fs/promises";
import { readVerifiedUtf8File, writeVerifiedUtf8File } from "./safe-file.js";

const required = [
  "tasks/*.json", "results/*.json", "sessions/*.json", "receipts/*.json",
  "artifacts/*", "config.local.json", "receipt-key.local", "last-browser-send", "!.gitignore"
];

export async function ensureBridgeGitignore(filePath: string, validate: () => Promise<void>): Promise<void> {
  let current = "";
  try {
    current = await readVerifiedUtf8File(filePath, validate);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  const updated = `${Array.from(new Set([...current.split(/\r?\n/).filter(Boolean), ...required])).join("\n")}\n`;
  if (updated === current) {
    try {
      await validate();
      const stat = await lstat(filePath);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) {
        throw new Error("Bridge gitignore must be a regular file without links");
      }
      return;
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
  }
  try {
    await writeVerifiedUtf8File(filePath, updated, validate, { create: true });
  } catch (error) {
    // Windows may refuse replacement while another initializer holds the file.
    // A verified, identical completed write already satisfies this operation.
    if (process.platform === "win32" && hasCode(error, "EPERM")) {
      const installed = await readVerifiedUtf8File(filePath, validate).catch(() => undefined);
      if (installed === updated) return;
    }
    throw error;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
