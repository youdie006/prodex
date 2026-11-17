import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { applyRepoWriteDryRun, createRepoWriteDryRun } from "../src/repo-write.js";
import { setSafeFileTestHooks } from "../src/safe-file.js";
import { BridgeStore } from "../src/store.js";

const execFileAsync = promisify(execFile);
const git = async (root: string, ...args: string[]) => (await execFileAsync("git", args, { cwd: root })).stdout.trim();

async function repo(files: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), "prodex-repo-write-names-"));
  await git(root, "init");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test User");
  for (const [file, content] of Object.entries(files)) await writeFile(path.join(root, file), content);
  await git(root, "add", "-A");
  await git(root, "commit", "-m", "initial");
  const head = await git(root, "rev-parse", "HEAD");
  return { root, head, store: new BridgeStore(root, { registerRoot: false }) };
}

// Windows limits a whole path to 260 characters unless long paths are enabled,
// which a 255-character name in a temp directory alone exceeds.
describe.skipIf(process.platform === "win32")("repo writes to files with long names", () => {
  afterEach(() => {
    setSafeFileTestHooks({});
  });

  // Found 2026-11-09: a 203-byte name passed repo_write_file_dry_run and failed
  // repo_write_file_apply with "ENAMETOOLONG: name too long, open
  // '/proc/self/fd/21/.aaaa....md.876367.1794186099151.<uuid>.tmp'".
  it.each([200, 255])("applies a write to a %i-byte name", async (bytes) => {
    const name = `${"a".repeat(bytes - 3)}.md`;
    const { root, head, store } = await repo({ [name]: "old\n" });
    const dryRun = await createRepoWriteDryRun(root, store, { path: name, content: "new\n", expected_head: head });
    await applyRepoWriteDryRun(root, store, { receipt_id: dryRun.receipt.id, expected_head: head, preimage_sha256: dryRun.preimage_sha256 });
    await expect(readFile(path.join(root, name), "utf8")).resolves.toBe("new\n");
    expect((await readdir(root)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses a name too long for the file system in the dry run, naming the repo path", async () => {
    const { root, head, store } = await repo({ "x.md": "x\n" });
    for (const name of [`${"a".repeat(297)}.md`, `${"d".repeat(300)}/x.md`]) {
      const refusal = createRepoWriteDryRun(root, store, { path: name, content: "y\n", expected_head: head });
      await expect(refusal).rejects.toThrow(`Path ${name} has a file or folder name too long for the file system`);
      await expect(refusal).rejects.not.toThrow(root);
    }
  });

  it("names the repo path, not a descriptor path, when the apply hits the limit", async () => {
    const { root, head, store } = await repo({ "notes.md": "old\n" });
    const dryRun = await createRepoWriteDryRun(root, store, { path: "notes.md", content: "new\n", expected_head: head });
    // A file system with a lower limit than 255 bytes still refuses the
    // temporary name; this is the error the kernel gives through the fd path.
    setSafeFileTestHooks({
      beforeRename: async (_filePath, tmpPath) => {
        throw Object.assign(new Error(`ENAMETOOLONG: name too long, open '/proc/self/fd/21/${path.basename(tmpPath)}'`), { code: "ENAMETOOLONG" });
      }
    });
    const refusal = applyRepoWriteDryRun(root, store, { receipt_id: dryRun.receipt.id, expected_head: head, preimage_sha256: dryRun.preimage_sha256 });
    await expect(refusal).rejects.toThrow("Path notes.md has a file or folder name too long for the file system");
    await expect(refusal).rejects.not.toThrow("/proc/self/fd");
    await expect(readFile(path.join(root, "notes.md"), "utf8")).resolves.toBe("old\n");
  });
});
