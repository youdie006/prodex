import { link, open, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readVerifiedUtf8File, replaceVerifiedUtf8File, setSafeFileTestHooks, writeVerifiedUtf8File } from "../src/safe-file.js";

describe("safe file reads", () => {
  afterEach(() => {
    setSafeFileTestHooks({});
  });

  it("rejects reads when a file grows beyond maxBytes after the pre-read stat", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-safe-file-"));
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
    const root = await mkdtemp(path.join(tmpdir(), "prodex-safe-file-"));
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

  it("does not mutate a hard link that appears after the file handle is open", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-safe-file-"));
    const filePath = path.join(root, "note.txt");
    const hardLinkPath = path.join(root, "outside-link.txt");
    await writeFile(filePath, "old\n", "utf8");
    setSafeFileTestHooks({
      beforeWrite: async () => {
        await link(filePath, hardLinkPath);
      }
    });

    await expect(writeVerifiedUtf8File(filePath, "new\n", async () => undefined)).resolves.toBeUndefined();
    await expect(readFile(filePath, "utf8")).resolves.toBe("new\n");
    await expect(readFile(hardLinkPath, "utf8")).resolves.toBe("old\n");
  });

  it("does not mutate a hard link that appears before replacement", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-safe-file-"));
    const filePath = path.join(root, "note.txt");
    const hardLinkPath = path.join(root, "outside-link.txt");
    await writeFile(filePath, "old\n", "utf8");
    setSafeFileTestHooks({
      beforeWrite: async () => {
        await link(filePath, hardLinkPath);
      }
    });

    await expect(
      replaceVerifiedUtf8File(filePath, "new\n", async () => undefined, (currentContent) => {
        expect(currentContent).toBe("old\n");
      })
    ).resolves.toBeUndefined();
    await expect(readFile(filePath, "utf8")).resolves.toBe("new\n");
    await expect(readFile(hardLinkPath, "utf8")).resolves.toBe("old\n");
  });

  it("rejects writes when the temporary replacement file is hard linked before rename", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-safe-file-"));
    const filePath = path.join(root, "note.txt");
    const hardLinkPath = path.join(root, "temp-link.txt");
    await writeFile(filePath, "old\n", "utf8");
    setSafeFileTestHooks({
      beforeRename: async (_filePath, tmpPath) => {
        await link(tmpPath, hardLinkPath);
      }
    });

    await expect(writeVerifiedUtf8File(filePath, "new\n", async () => undefined)).rejects.toThrow(/hard link|linked/i);
    await expect(readFile(filePath, "utf8")).resolves.toBe("old\n");
    await expect(readFile(hardLinkPath, "utf8")).resolves.toBe("new\n");
  });
});

describe("the temporary file a replacement is written to", () => {
  afterEach(() => {
    setSafeFileTestHooks({});
  });

  // Found 2026-11-09: the temporary name adds about 63 bytes to the target's,
  // so a file whose name was over about 192 bytes passed repo_write_file_dry_run
  // and failed repo_write_file_apply with ENAMETOOLONG. Names are limited to
  // 255 bytes, counted in UTF-8, where a Hangul syllable takes 3.
  it.skipIf(process.platform === "win32").each([
    ["a 255-byte name", `${"a".repeat(252)}.md`],
    ["a 255-byte Hangul name", `${"\uD55C".repeat(84)}.md`],
    ["a short name", "note.txt"]
  ])("fits the name limit for %s", async (_name, fileName) => {
    expect(Buffer.byteLength(fileName)).toBeLessThanOrEqual(255);
    const root = await mkdtemp(path.join(tmpdir(), "prodex-safe-file-"));
    const filePath = path.join(root, fileName);
    await writeFile(filePath, "old\n", "utf8");
    const temporary: string[] = [];
    setSafeFileTestHooks({
      beforeRename: async (_filePath, tmpPath) => {
        temporary.push(path.basename(tmpPath));
      }
    });

    await replaceVerifiedUtf8File(filePath, "new\n", async () => undefined, () => undefined);

    await expect(readFile(filePath, "utf8")).resolves.toBe("new\n");
    expect(await readdir(root)).toEqual([fileName]);
    expect(temporary).toHaveLength(1);
    expect(Buffer.byteLength(temporary[0]!)).toBeLessThanOrEqual(255);
    // Still a hidden ".tmp" file that starts with the target's name.
    expect(temporary[0]!.startsWith(`.${[...fileName].slice(0, 20).join("")}`)).toBe(true);
    expect(temporary[0]!.endsWith(".tmp")).toBe(true);
    expect(temporary[0]!.includes("\ufffd")).toBe(false);
  });
});
