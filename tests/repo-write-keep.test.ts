import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { applyRepoWriteDryRun, createRepoWriteDryRun, stageReviewedPaths } from "../src/repo-write.js";
import { BridgeStore } from "../src/store.js";

const execFileAsync = promisify(execFile);
const git = async (root: string, ...args: string[]) => (await execFileAsync("git", args, { cwd: root })).stdout.trim();

async function repo(files: Record<string, string | Buffer>, modes: Record<string, number> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "prodex-repo-write-keep-"));
  await git(root, "init");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test User");
  await git(root, "config", "core.autocrlf", "false");
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  for (const [file, mode] of Object.entries(modes)) await chmod(path.join(root, file), mode);
  await git(root, "add", "-A");
  await git(root, "commit", "-m", "initial");
  const head = await git(root, "rev-parse", "HEAD");
  const store = new BridgeStore(root, { registerRoot: false });
  const write = async (file: string, content: string) => {
    const dryRun = await createRepoWriteDryRun(root, store, { path: file, content, expected_head: head });
    return applyRepoWriteDryRun(root, store, { receipt_id: dryRun.receipt.id, expected_head: head, preimage_sha256: dryRun.preimage_sha256 });
  };
  return { root, head, store, write };
}

describe("writing a file through repo tools keeps what the file was", () => {
  // Found 2026-11-09: the replacement is a new file renamed into place, created
  // with the default mode, so an edited script lost its executable bit and
  // repo_stage_reviewed_paths staged "mode change 100755 => 100644".
  it.skipIf(process.platform === "win32")("keeps the file mode", async () => {
    const { root, head, store, write } = await repo(
      { "build.sh": "#!/bin/sh\necho old\n", "private.conf": "token=abc\n" },
      { "build.sh": 0o755, "private.conf": 0o600 }
    );
    const applied = [await write("build.sh", "#!/bin/sh\necho new\n"), await write("private.conf", "token=xyz\n")];
    expect((await stat(path.join(root, "build.sh"))).mode & 0o777).toBe(0o755);
    expect((await stat(path.join(root, "private.conf"))).mode & 0o777).toBe(0o600);
    await stageReviewedPaths(root, store, { receipt_ids: applied.map((result) => result.receipt.id), expected_head: head });
    expect(await git(root, "diff", "--cached", "--summary")).not.toMatch(/mode change/);
  });

  // Repo tools hand an agent lines joined by "\n" with no newline after the
  // last one, so writing back what was read dropped the file's final newline.
  it("keeps the final newline", async () => {
    const { root, write } = await repo({ "notes.md": "alpha\nbeta\n", "dos.txt": "alpha\r\nbeta\r\n", "bare.txt": "alpha\nbeta" });
    await write("notes.md", "alpha\nBETA");
    await write("dos.txt", "alpha\nBETA");
    await write("bare.txt", "alpha\nBETA");
    expect(await readFile(path.join(root, "notes.md"), "utf8")).toBe("alpha\nBETA\n");
    expect(await readFile(path.join(root, "dos.txt"), "utf8")).toBe("alpha\r\nBETA\r\n");
    expect(await readFile(path.join(root, "bare.txt"), "utf8")).toBe("alpha\nBETA");
  });

  it("can still empty a file", async () => {
    const { root, write } = await repo({ "notes.md": "alpha\n" });
    await write("notes.md", "");
    expect(await readFile(path.join(root, "notes.md"), "utf8")).toBe("");
  });

  // A file that is not UTF-8 was read with its bytes replaced by U+FFFD and
  // written back that way: an EUC-KR "한글" line came back as replacement
  // characters while the diff showed the line as unchanged. UTF-16 files were
  // re-encoded as UTF-8 without their BOM.
  it("refuses a file that is not UTF-8 rather than re-encoding it", async () => {
    const euckr = Buffer.from([0x6d, 0x73, 0x67, 0x3d, 0xc7, 0xd1, 0xb1, 0xdb, 0x0a, 0x76, 0x3d, 0x31, 0x0a]);
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("a=1\r\n", "utf16le")]);
    const { root, head, store } = await repo({ "legacy.properties": euckr, "settings.reg": utf16 });
    for (const file of ["legacy.properties", "settings.reg"]) {
      await expect(createRepoWriteDryRun(root, store, { path: file, content: "v=2\n", expected_head: head })).rejects.toThrow(
        new RegExp(`${file.replace(".", "\\.")} is not UTF-8 text`)
      );
    }
    expect(await readFile(path.join(root, "legacy.properties"))).toEqual(euckr);
  });

  it("refuses at the dry run content that only goes over the size limit once CRLF is restored", async () => {
    const { root, head, store } = await repo({ "big.txt": "a\r\nb\r\n" });
    const content = "x\n".repeat(400_000); // 800,000 bytes, 1,200,000 with CRLF
    await expect(createRepoWriteDryRun(root, store, { path: "big.txt", content, expected_head: head })).rejects.toThrow(/too large/);
  });
});

describe("staging reviewed paths", () => {
  // Found 2026-11-09: paths went to git as pathspecs, so a reviewed
  // "pages/[id].tsx" also staged an unreviewed "pages/i.tsx", and a reviewed
  // "x[0-9].txt" next to "x1.txt" got x1.txt's blob written under its name.
  it("stages exactly the reviewed paths, even when a name reads as a pattern", async () => {
    const { root, head, store, write } = await repo({ "pages/[id].tsx": "one\n", "pages/i.tsx": "two\n", "x[0-9].txt": "x\n", "x1.txt": "x1\n" });
    const applied = [await write("pages/[id].tsx", "one changed\n"), await write("x[0-9].txt", "x changed\n")];
    await writeFile(path.join(root, "pages/i.tsx"), "two unreviewed\n");
    await writeFile(path.join(root, "x1.txt"), "x1 unreviewed\n");
    const result = await stageReviewedPaths(root, store, { receipt_ids: applied.map((r) => r.receipt.id), expected_head: head });
    expect(result.paths).toEqual(["pages/[id].tsx", "x[0-9].txt"]);
    expect((await git(root, "diff", "--cached", "--name-only")).split("\n").sort()).toEqual(["pages/[id].tsx", "x[0-9].txt"]);
    expect(await git(root, "show", ":x[0-9].txt")).toBe("x changed");
    expect(await git(root, "show", ":x1.txt")).toBe("x1");
  });

  it.skipIf(process.platform === "win32")("stages a file whose name starts with pathspec magic", async () => {
    const { root, head, store, write } = await repo({ ":!draft.md": "draft\n", "other.md": "other\n" });
    const applied = await write(":!draft.md", "draft changed\n");
    await writeFile(path.join(root, "other.md"), "other unreviewed\n");
    await stageReviewedPaths(root, store, { receipt_ids: [applied.receipt.id], expected_head: head });
    expect(await git(root, "diff", "--cached", "--name-only")).toBe(":!draft.md");
  });
});
