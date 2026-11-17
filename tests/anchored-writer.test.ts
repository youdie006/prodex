import { link, lstat, mkdtemp, readFile, readdir, rename, symlink } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BridgeStore, setBridgeStoreTestHooks } from "../src/store.js";
import { anchorCurrentDirectory, runAnchoredJob } from "../src/store-writer.js";

// The store writes a record by rendering an open directory handle as a path -
// /proc/self/fd/N - and joining the file name onto it, so the write lands in the
// directory it validated rather than one a symlink swap redirected. macOS has no
// traversable stand-in for that, so every bridge write there died:
//
//   ENOENT: no such file or directory, open '/dev/fd/11/tasks'
//
// measured on two Macs against the published 0.38.0. That took out tasks,
// results and receipts - the whole ledger - on the platform.
//
// The replacement keeps the same guarantee by other means: a child process is
// spawned with its cwd set to the target directory, it checks that "." is the
// very inode the parent validated, and it then works through relative paths.
// The kernel pins the cwd, so relative resolution cannot be redirected
// afterwards - which is what the fd path was buying.
describe("writing records without traversable directory fd paths", () => {
  afterEach(() => {
    setBridgeStoreTestHooks({});
  });

  it("still writes the record, into the directory it validated", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-anchored-"));
    const store = new BridgeStore(root);
    await store.ensure();
    setBridgeStoreTestHooks({ disableDirectoryFdPaths: true });

    const receipt = await store.writeReceipt({ kind: "consult_preview", summary: "Written without fd paths" });

    const entries = await readdir(path.join(root, ".bridge", "receipts"));
    expect(entries).toHaveLength(1);
    const written = JSON.parse(await readFile(path.join(root, ".bridge", "receipts", entries[0]), "utf8"));
    expect(written.summary).toBe("Written without fd paths");
    expect(written.id).toBe(receipt.id);
  });
});

// A record read first removes a temp hard link a crashed linkIfAbsent left
// beside the record. Without fd paths that cleanup always started the
// anchored writer, even with nothing to clean: found 2026-11-09, listing 200
// receipts took 1956 ms against 264 ms on the fd path, one process each.
describe("reading records without traversable directory fd paths", () => {
  afterEach(() => {
    setBridgeStoreTestHooks({});
  });

  async function storeWithReceipts(count: number): Promise<{ root: string; store: BridgeStore; ids: string[] }> {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-anchored-read-"));
    const store = new BridgeStore(root, { registerRoot: false });
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      ids.push((await store.writeReceipt({ kind: "consult_preview", summary: `Receipt ${index}` })).id);
    }
    return { root, store, ids };
  }

  it("lists receipts without starting a process per receipt", async () => {
    const { store } = await storeWithReceipts(12);
    const started: string[] = [];
    setBridgeStoreTestHooks({ disableDirectoryFdPaths: true, beforeAnchoredWriterStart: (op) => started.push(op) });

    await expect(store.listReceipts()).resolves.toHaveLength(12);

    expect(started).toEqual([]);
  });

  it("still removes a leftover temp hard link of the record it reads", async () => {
    const { root, store, ids } = await storeWithReceipts(3);
    const receiptsDir = path.join(root, ".bridge", "receipts");
    const staleTemp = path.join(receiptsDir, `.${ids[1]}.json.stale.tmp`);
    await link(path.join(receiptsDir, `${ids[1]}.json`), staleTemp);
    const started: string[] = [];
    setBridgeStoreTestHooks({ disableDirectoryFdPaths: true, beforeAnchoredWriterStart: (op) => started.push(op) });

    await expect(store.listReceipts()).resolves.toHaveLength(3);

    expect(started).toEqual(["cleanupTempHardLinks"]);
    await expect(lstat(staleTemp)).rejects.toThrow(/ENOENT/);
  });
});

describe("anchoring the writer's working directory", () => {
  afterEach(() => {
    setBridgeStoreTestHooks({});
  });

  it.each(["..\\outside", "nested\\file", ...(process.platform === "win32" ? ["C:outside", "file:stream"] : [])])("rejects Windows path syntax: %s", async (name) => {
    const here = statSync(process.cwd(), { bigint: true });
    const anchor = { dev: here.dev.toString(), ino: here.ino.toString() };
    expect(() => anchorCurrentDirectory(anchor, [name])).toThrow(/refuses to descend/i);
    await expect(runAnchoredJob({ anchor, segments: [], fileName: name, mode: 0o600, op: "deleteIfPresent" }))
      .rejects.toThrow(/refuses the file name/i);
  });

  it("refuses a storage directory that has been swapped for a symlink", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-anchored-"));
    const outside = await mkdtemp(path.join(tmpdir(), "prodex-outside-"));
    const store = new BridgeStore(root);
    await store.ensure();
    await rename(path.join(root, ".bridge", "receipts"), path.join(root, ".bridge", "receipts-real"));
    await symlink(outside, path.join(root, ".bridge", "receipts"), process.platform === "win32" ? "junction" : "dir");
    setBridgeStoreTestHooks({ disableDirectoryFdPaths: true });

    await expect(store.writeReceipt({ kind: "consult_preview", summary: "Should not land outside" })).rejects.toThrow(
      /symlink|ELOOP|real directory|Bridge storage directory/i
    );
    expect(await readdir(outside)).toEqual([]);
  });

  it("will not start work in a directory the caller did not validate", () => {
    // The child's cwd is handed to it by path, which is the one lookup an
    // attacker could still redirect, so the inode is checked before anything is
    // written. Neither call below moves the process: the mismatch is rejected
    // before any descent happens.
    const here = statSync(process.cwd(), { bigint: true });
    const truth = { dev: here.dev.toString(), ino: here.ino.toString() };
    expect(() => anchorCurrentDirectory(truth, [])).not.toThrow();
    expect(() => anchorCurrentDirectory({ dev: truth.dev, ino: "1" }, [])).toThrow(/was not started in the directory/i);
  });
});

// Artifacts are written by absolute path, so only their removal went through
// the descriptor path - and it sits deeper than a record, under
// .bridge/artifacts/<role>/, so the descent is more than one segment.
describe("removing an artifact without traversable directory fd paths", () => {
  afterEach(() => {
    setBridgeStoreTestHooks({});
  });

  it.skipIf(process.platform === "win32")("removes a POSIX artifact containing a colon", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-anchored-colon-"));
    const store = new BridgeStore(root);
    await store.ensure();
    setBridgeStoreTestHooks({ disableDirectoryFdPaths: true });
    const artifact = await store.writeArtifactText(".bridge/artifacts/colon:file.txt", "local artifact");
    await store.deleteArtifactTextIfPresent(artifact);
    expect(await store.hasArtifactText(artifact)).toBe(false);
  });

  it("descends to the artifact's own directory and removes only it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-anchored-"));
    const store = new BridgeStore(root);
    await store.ensure();
    setBridgeStoreTestHooks({ disableDirectoryFdPaths: true });

    const kept = await store.writeArtifactText(".bridge/artifacts/results/kept.md", "kept");
    const doomed = await store.writeArtifactText(".bridge/artifacts/results/doomed.md", "x".repeat(400_000));
    expect(await store.readArtifactText(doomed)).toHaveLength(400_000);

    await store.deleteArtifactTextIfPresent(doomed);
    expect(await store.hasArtifactText(doomed)).toBe(false);
    expect(await store.hasArtifactText(kept)).toBe(true);

    // Removing what is already gone is how cleanup paths call this.
    await expect(store.deleteArtifactTextIfPresent(doomed)).resolves.toBeUndefined();
  });
});
