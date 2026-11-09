import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
