import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { applyRepoWriteDryRun, createRepoWriteDryRun } from "../src/repo-write.js";
import { BridgeStore } from "../src/store.js";

const execFileAsync = promisify(execFile);

// Measured 2026-10-21: repo_read_file hands an agent a CRLF file with "\n"
// endings, so writing the edited text back turned every line of the file into
// a change. A UTF-8 BOM was dropped the same way. Writes keep what the file
// already uses, as an editor does.
async function writeAndApply(initial: Buffer, content: string): Promise<{ bytes: Buffer }> {
  const root = await mkdtemp(path.join(tmpdir(), "prodex-repo-write-eol-"));
  await writeFile(path.join(root, "notes.md"), initial);
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: root });
  await execFileAsync("git", ["config", "core.autocrlf", "false"], { cwd: root });
  await execFileAsync("git", ["add", "notes.md"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root });
  const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  const store = new BridgeStore(root, { registerRoot: false });
  const dryRun = await createRepoWriteDryRun(root, store, { path: "notes.md", content, expected_head: head });
  await applyRepoWriteDryRun(root, store, { receipt_id: dryRun.receipt.id, expected_head: head, preimage_sha256: dryRun.preimage_sha256 });
  return { bytes: await readFile(path.join(root, "notes.md")) };
}

describe("writing a file through repo tools", () => {
  it("keeps CRLF line endings when the new content uses LF", async () => {
    const { bytes } = await writeAndApply(Buffer.from("line1\r\nline2\r\n"), "line1\nline2 changed\n");
    expect(bytes.toString("utf8")).toBe("line1\r\nline2 changed\r\n");
  });

  it("keeps a UTF-8 BOM the new content leaves out", async () => {
    const { bytes } = await writeAndApply(Buffer.from("\uFEFFbom text\n", "utf8"), "bom text changed\n");
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.subarray(3).toString("utf8")).toBe("bom text changed\n");
  });

  it("does not double a BOM the new content already carries", async () => {
    const { bytes } = await writeAndApply(Buffer.from("\uFEFFbom text\n", "utf8"), "\uFEFFbom text changed\n");
    expect(bytes.toString("utf8")).toBe("\uFEFFbom text changed\n");
  });

  it("leaves LF files and mixed-ending files as written", async () => {
    expect((await writeAndApply(Buffer.from("a\nb\n"), "a\nc\n")).bytes.toString("utf8")).toBe("a\nc\n");
    // Mixed endings: no single convention to keep, so the content is not rewritten.
    expect((await writeAndApply(Buffer.from("a\r\nb\n"), "a\nc\n")).bytes.toString("utf8")).toBe("a\nc\n");
  });

  it("does not convert content that already carries CR characters", async () => {
    expect((await writeAndApply(Buffer.from("a\r\nb\r\n"), "a\r\nc\r\n")).bytes.toString("utf8")).toBe("a\r\nc\r\n");
  });
});
