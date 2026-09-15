import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readVerifiedUtf8File,
  replaceVerifiedUtf8File,
  setSafeFileTestHooks,
  withCrossProcessFileLock
} from "../src/safe-file.js";

describe("safe file link swaps", () => {
  afterEach(() => {
    setSafeFileTestHooks({});
  });

  it("rejects a file symlink swapped in immediately before a verified read", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-safe-file-link-swap-"));
    const filePath = path.join(root, "inside.txt");
    const externalPath = path.join(root, "external.txt");
    await writeFile(filePath, "inside\n", "utf8");
    await writeFile(externalPath, "external\n", "utf8");
    let swapped = false;
    setSafeFileTestHooks({
      beforeOpen: async () => {
        await rm(filePath);
        await symlink(externalPath, filePath, "file");
        swapped = true;
      }
    });

    await expect(readVerifiedUtf8File(filePath, async () => undefined, { mode: 0o600 })).rejects.toThrow(/symlink|changed/i);
    expect(swapped, "the host must actually create the security-test symlink").toBe(true);
    await expect(readFile(externalPath, "utf8")).resolves.toBe("external\n");
  });

  it("rejects a file symlink swapped in immediately before chmod", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-safe-file-link-swap-"));
    const filePath = path.join(root, "inside.txt");
    const externalPath = path.join(root, "external.txt");
    await writeFile(filePath, "inside\n", "utf8");
    await writeFile(externalPath, "external\n", "utf8");
    let swapped = false;
    setSafeFileTestHooks({
      beforeChmod: async () => {
        await rm(filePath);
        await symlink(externalPath, filePath, "file");
        swapped = true;
      }
    });

    await expect(readVerifiedUtf8File(filePath, async () => undefined, { mode: 0o600 })).rejects.toThrow(/symlink|changed/i);
    expect(swapped, "the host must actually create the security-test symlink").toBe(true);
    await expect(readFile(externalPath, "utf8")).resolves.toBe("external\n");
  });

  it("rejects a file symlink before exposing its content to a replacement verifier", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-safe-file-link-swap-"));
    const filePath = path.join(root, "inside.txt");
    const externalPath = path.join(root, "external.txt");
    const verifiedContent: string[] = [];
    await writeFile(filePath, "inside\n", "utf8");
    await writeFile(externalPath, "external\n", "utf8");
    let swapped = false;
    setSafeFileTestHooks({
      beforeOpen: async () => {
        await rm(filePath);
        await symlink(externalPath, filePath, "file");
        swapped = true;
      }
    });

    await expect(
      replaceVerifiedUtf8File(filePath, "replacement\n", async () => undefined, (content) => {
        verifiedContent.push(content);
      })
    ).rejects.toThrow(/symlink|changed/i);
    expect(swapped, "the host must actually create the security-test symlink").toBe(true);
    expect(verifiedContent).toEqual([]);
    await expect(readFile(externalPath, "utf8")).resolves.toBe("external\n");
  });

  it("releases an intentionally hard-linked lock record", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-safe-file-lock-"));
    const lockPath = path.join(root, "operation.lock");

    await withCrossProcessFileLock(
      lockPath,
      {
        waitMs: 50,
        busyError: () => new Error("lock busy"),
        unavailableError: () => new Error("lock unavailable")
      },
      async () => undefined
    );

    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
