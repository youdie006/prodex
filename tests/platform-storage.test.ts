import { mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadLocalConfig, writeLocalConfig } from "../src/config.js";
import { BridgeStore } from "../src/store.js";
import { setSafeFileTestHooks } from "../src/safe-file.js";

const roots: string[] = [];
async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "prodex-platform-storage-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  setSafeFileTestHooks({});
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("native platform storage", () => {
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
