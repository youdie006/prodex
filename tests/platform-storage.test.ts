import { mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import * as fileSystem from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadLocalConfig, writeLocalConfig } from "../src/config.js";
import { BridgeStore } from "../src/store.js";
import { setSafeFileTestHooks } from "../src/safe-file.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>()
}));

const roots: string[] = [];
async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "prodex-platform-storage-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  setSafeFileTestHooks({});
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("native platform storage", () => {
  for (const initializer of ["store", "config"] as const) {
    const initialize = (root: string) => initializer === "store"
      ? new BridgeStore(root).ensure()
      : writeLocalConfig(root, { port: 9797, token: "test" });

    it(`${initializer} restores a complete gitignore removed just after its verified read`, async () => {
      const root = await temporaryRoot();
      await new BridgeStore(root).ensure();
      const ignorePath = path.join(root, ".bridge", ".gitignore");
      const originalOpen = fileSystem.open;
      let removed = false;
      vi.spyOn(fileSystem, "open").mockImplementation(async (...args) => {
        const handle = await originalOpen(...args);
        if (!removed && path.basename(String(args[0])) === ".gitignore") {
          const close = handle.close.bind(handle);
          vi.spyOn(handle, "close").mockImplementation(async () => {
            await close();
            if (!removed) {
              removed = true;
              await rm(ignorePath);
            }
          });
        }
        return handle;
      });
      await initialize(root);
      expect(removed).toBe(true);
      expect(await readFile(ignorePath, "utf8")).toContain("config.local.json\n");
    });

    it(`${initializer} accepts a Windows replacement conflict only when the complete gitignore is already installed`, async () => {
      const root = await temporaryRoot();
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      let conflicted = false;
      setSafeFileTestHooks({
        beforeRename: async (filePath, temporaryPath) => {
          if (path.basename(filePath) !== ".gitignore") return;
          conflicted = true;
          await rename(temporaryPath, filePath);
          throw Object.assign(new Error("another initializer installed the file"), { code: "EPERM" });
        }
      });
      await initialize(root);
      expect(conflicted).toBe(true);
      expect(await readFile(path.join(root, ".bridge", ".gitignore"), "utf8")).toContain("config.local.json\n");
    });

    it.each(["different", "missing", "permission"])(`${initializer} does not suppress an unresolved gitignore failure: %s`, async (failure) => {
      const root = await temporaryRoot();
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      setSafeFileTestHooks({
        beforeRename: async (filePath, temporaryPath) => {
          if (path.basename(filePath) !== ".gitignore") return;
          if (failure === "different") await writeFile(filePath, "incomplete\n");
          if (failure === "permission") await rename(temporaryPath, filePath);
          throw Object.assign(new Error("unresolved replacement"), { code: failure === "permission" ? "EACCES" : "EPERM" });
        }
      });
      await expect(initialize(root)).rejects.toThrow("unresolved replacement");
    });
  }

  it("does not replace an already complete bridge gitignore on repeated initialization", async () => {
    const root = await temporaryRoot();
    const store = new BridgeStore(root);
    await store.ensure();
    setSafeFileTestHooks({
      beforeWrite: (filePath) => {
        if (path.basename(filePath) === ".gitignore") throw new Error("unnecessary replacement");
      }
    });
    await expect(store.ensure()).resolves.toBeUndefined();
    await expect(writeLocalConfig(root, { port: 9797, token: "test" })).resolves.toBeDefined();
  });
  it("persists local settings and a verified receipt without POSIX directory handles", async () => {
    const root = await temporaryRoot();
    await writeLocalConfig(root, { port: 9797, token: "platform-test-token" });
    expect((await loadLocalConfig(root))?.token).toBe("platform-test-token");
    const store = new BridgeStore(root);
    await store.ensure();
    const receipt = await store.writeReceipt({ kind: "consult_preview", summary: "Native storage check" });
    const stored = JSON.parse(await readFile(path.join(root, ".bridge", "receipts", `${receipt.id}.json`), "utf8"));
    expect(stored.summary).toBe(receipt.summary);
  });

  it("rejects redirected bridge roots including Windows junctions", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await symlink(outside, path.join(root, ".bridge"), process.platform === "win32" ? "junction" : "dir");
    await expect(new BridgeStore(root).ensure()).rejects.toThrow(/symlink|real directory/i);
    await expect(writeLocalConfig(root, { port: 9797, token: "test" })).rejects.toThrow(/symlink|real directory/i);
    expect(await readdir(outside)).toEqual([]);
  });
});
