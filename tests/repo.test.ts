import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readRepoFile, resolveRepoPath, searchRepo } from "../src/repo.js";

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

  it("blocks local bridge, git, and env files from repo reads", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gptprouse-repo-"));
    await mkdir(path.join(root, ".bridge"), { recursive: true });
    await mkdir(path.join(root, ".git"), { recursive: true });
    await writeFile(path.join(root, ".bridge", "config.local.json"), '{"token":"secret"}\n', "utf8");
    await writeFile(path.join(root, ".git", "config"), "[remote]\n", "utf8");
    await writeFile(path.join(root, ".env"), "TOKEN=secret\n", "utf8");

    await expect(readRepoFile(root, ".bridge/config.local.json")).rejects.toThrow(/sensitive/);
    await expect(readRepoFile(root, ".git/config")).rejects.toThrow(/sensitive/);
    await expect(readRepoFile(root, ".env")).rejects.toThrow(/sensitive/);
  });

  it("excludes sensitive local files from repo search results", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gptprouse-repo-"));
    await mkdir(path.join(root, ".bridge"), { recursive: true });
    await writeFile(path.join(root, ".bridge", "config.local.json"), '{"token":"needle"}\n', "utf8");
    await writeFile(path.join(root, "README.md"), "needle\n", "utf8");

    const matches = await searchRepo(root, "needle");

    expect(matches).toEqual([{ path: "README.md", line: 1, text: "needle" }]);
    await expect(searchRepo(root, "needle", ".bridge/**")).rejects.toThrow(/sensitive/);
  });

  it("rejects large files before reading them into the response", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gptprouse-repo-"));
    await writeFile(path.join(root, "large.txt"), "x".repeat(1_100_000), "utf8");

    await expect(readRepoFile(root, "large.txt")).rejects.toThrow(/large/);
  });
});
