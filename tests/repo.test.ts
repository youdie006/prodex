import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readRepoFile, resolveRepoPath } from "../src/repo.js";

describe("repo path policy", () => {
  it("reads repo-relative files with line metadata", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gptprouse-repo-"));
    await writeFile(path.join(root, "README.md"), "one\ntwo\nthree\n", "utf8");

    const result = await readRepoFile(root, "README.md", { startLine: 2, maxLines: 1 });

    expect(result.path).toBe("README.md");
    expect(result.start_line).toBe(2);
    expect(result.content).toBe("two");
  });

  it("rejects traversal, absolute paths, and symlink escapes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gptprouse-repo-"));
    const outside = await mkdtemp(path.join(tmpdir(), "gptprouse-outside-"));
    await writeFile(path.join(outside, "file.txt"), "outside\n", "utf8");
    await mkdir(path.join(root, "links"));
    await symlink(outside, path.join(root, "links", "outside"));

    expect(() => resolveRepoPath(root, "../secret.txt")).toThrow(/repo-relative/);
    expect(() => resolveRepoPath(root, path.join(root, "README.md"))).toThrow(/repo-relative/);
    await expect(readRepoFile(root, "links/outside/file.txt")).rejects.toThrow(/escapes/);
  });
});
