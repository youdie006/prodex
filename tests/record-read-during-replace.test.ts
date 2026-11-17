import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renameReplacingFile } from "../src/safe-file.js";
import { BridgeStore, readReplacedFileText } from "../src/store.js";

// Found 2026-11-09: records are replaced by renaming a new file over them, and
// a read that opened the old file then found the new one at the path failed as
// "Target path changed during read file operation". With another process
// rewriting a session, 115 of 908 reads failed; `tasks list` and MCP
// bridge_list_tasks failed the same way during a consult.
const replaced = () => new Error("Target path changed during read file operation");

describe("reading a record that is being replaced", () => {
  it("reads again when the file was replaced during the read", async () => {
    let calls = 0;
    const text = await readReplacedFileText(async () => {
      calls += 1;
      if (calls < 3) throw replaced();
      return "new record";
    });
    expect(text).toBe("new record");
    expect(calls).toBe(3);
  });

  it("does not read again for any other failure", async () => {
    let calls = 0;
    await expect(
      readReplacedFileText(async () => {
        calls += 1;
        throw new Error("Target path is a symlink or changed during read file operation");
      })
    ).rejects.toThrow(/symlink/);
    expect(calls).toBe(1);
  });

  it("gives up after a few attempts", async () => {
    let calls = 0;
    await expect(
      readReplacedFileText(async () => {
        calls += 1;
        throw replaced();
      })
    ).rejects.toThrow(/changed during read/);
    expect(calls).toBe(5);
  });

  // POSIX renames over a file another handle is reading. Windows refuses that
  // rename with EPERM while the reader has the file open (CI, 2026-11-09), so
  // the writer tries it again for a moment; see below.
  it("lists sessions while another store keeps rewriting one", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-record-replace-"));
    const writer = new BridgeStore(root, { registerRoot: false });
    const reader = new BridgeStore(root, { registerRoot: false });
    const session = await writer.writeSession({ direction: "codex_to_chatgpt", backend: "chatgpt-control", status: "running" });
    let writing = true;
    const rewrites = (async () => {
      for (let tick = 0; writing; tick += 1) {
        await writer.writeSession({ id: session.id, direction: "codex_to_chatgpt", backend: "chatgpt-control", status: "running", warnings: [`tick ${tick}`] });
      }
    })();
    const failures: string[] = [];
    try {
      for (let read = 0; read < 150; read += 1) {
        await reader.getSessionReadOnly(session.id).catch((error: Error) => failures.push(error.message));
      }
    } finally {
      writing = false;
      await rewrites;
    }
    expect(failures).toEqual([]);
  });
});

// Windows fails a rename over a file another handle has open with EPERM,
// EACCES or EBUSY until that handle closes. CI on Windows failed the race
// above from the writer side that way (2026-11-09).
describe("replacing a file another process has open on Windows", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const inUse = (code: string) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });

  it("renames again while Windows reports the target in use", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const codes = ["EPERM", "EACCES", "EBUSY"];
    let calls = 0;
    await renameReplacingFile("from.tmp", "to.json", {
      rename: async (fromPath, toPath) => {
        expect([fromPath, toPath]).toEqual(["from.tmp", "to.json"]);
        calls += 1;
        if (calls <= codes.length) throw inUse(codes[calls - 1]!);
      }
    });
    expect(calls).toBe(4);
  });

  it("gives the rename's own error once the retry time is used up", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const failure = inUse("EPERM");
    let calls = 0;
    const started = Date.now();
    await expect(
      renameReplacingFile("from.tmp", "to.json", {
        retryForMs: 200,
        rename: async () => {
          calls += 1;
          throw failure;
        }
      })
    ).rejects.toBe(failure);
    expect(calls).toBeGreaterThan(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("does not rename again for any other failure", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    let calls = 0;
    await expect(
      renameReplacingFile("from.tmp", "to.json", {
        rename: async () => {
          calls += 1;
          throw Object.assign(new Error("ENOENT: no such file or directory, rename"), { code: "ENOENT" });
        }
      })
    ).rejects.toThrow(/ENOENT/);
    expect(calls).toBe(1);
  });

  it("does not rename again on other platforms, where EPERM is not a reader", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    let calls = 0;
    await expect(
      renameReplacingFile("from.tmp", "to.json", {
        rename: async () => {
          calls += 1;
          throw inUse("EPERM");
        }
      })
    ).rejects.toThrow(/EPERM/);
    expect(calls).toBe(1);
  });
});
