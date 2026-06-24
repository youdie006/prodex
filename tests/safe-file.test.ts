import { open, mkdtemp, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readVerifiedUtf8File, setSafeFileTestHooks } from "../src/safe-file.js";

describe("safe file reads", () => {
  afterEach(() => {
    setSafeFileTestHooks({});
  });

  it("rejects reads when a file grows beyond maxBytes after the pre-read stat", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gptprouse-safe-file-"));
    const filePath = path.join(root, "note.txt");
    await writeFile(filePath, "a", "utf8");
    const probe = await open(filePath, "r");
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      stat: () => Promise<Stats>;
    };
    const originalStat = fileHandlePrototype.stat;
    let grew = false;
    fileHandlePrototype.stat = async function statWithGrowth() {
      const stat = await originalStat.call(this);
      if (!grew && stat.isFile() && stat.size === 1) {
        grew = true;
        await writeFile(filePath, "x".repeat(100), "utf8");
      }
      return stat;
    };
    await probe.close();

    try {
      await expect(readVerifiedUtf8File(filePath, async () => undefined, { maxBytes: 1 })).rejects.toThrow(/too large/);
    } finally {
      fileHandlePrototype.stat = originalStat;
    }
  });

  it("rejects reads when a file grows beyond maxBytes immediately before the handle read", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gptprouse-safe-file-"));
    const filePath = path.join(root, "note.txt");
    await writeFile(filePath, "a", "utf8");
    const probe = await open(filePath, "r");
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      read: (
        buffer: Buffer,
        offset: number,
        length: number,
        position: number
      ) => Promise<{ bytesRead: number; buffer: Buffer }>;
    };
    const originalRead = fileHandlePrototype.read;
    let grew = false;
    fileHandlePrototype.read = async function readWithGrowth(buffer, offset, length, position) {
      if (!grew) {
        grew = true;
        await writeFile(filePath, "x".repeat(100), "utf8");
      }
      return originalRead.call(this, buffer, offset, length, position);
    };
    await probe.close();

    try {
      await expect(readVerifiedUtf8File(filePath, async () => undefined, { maxBytes: 1 })).rejects.toThrow(/too large/);
    } finally {
      fileHandlePrototype.read = originalRead;
    }
  });
});
