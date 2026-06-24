import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readRepoFile, resolveRepoPath, searchRepo } from "../src/repo.js";
import { setSafeFileTestHooks } from "../src/safe-file.js";

describe("repo path policy", () => {
  afterEach(() => {
    setSafeFileTestHooks({});
  });

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

  it("rejects reads when the target is swapped to a symlink before open", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gptprouse-repo-"));
    const outside = await mkdtemp(path.join(tmpdir(), "gptprouse-outside-"));
    const outsideFile = path.join(outside, "secret.txt");
    const repoFile = path.join(root, "README.md");
    await writeFile(outsideFile, "outside\n", "utf8");
    await writeFile(repoFile, "inside\n", "utf8");
    let swapped = false;
    setSafeFileTestHooks({
      beforeOpen: async (filePath) => {
        if (!swapped && filePath === repoFile) {
          swapped = true;
          await rm(repoFile);
          await symlink(outsideFile, repoFile);
        }
      }
    });

    await expect(readRepoFile(root, "README.md")).rejects.toThrow(/symlink|changed|escapes/i);
    expect(await readFile(outsideFile, "utf8")).toBe("outside\n");
  });

  it("rejects repo reads through hard-linked files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gptprouse-repo-"));
    const outside = await mkdtemp(path.join(tmpdir(), "gptprouse-outside-"));
    const outsideFile = path.join(outside, "secret.txt");
    await writeFile(outsideFile, "outside secret\n", "utf8");
    await mkdir(path.join(root, "links"));
    await link(outsideFile, path.join(root, "links", "hard.txt"));

    await expect(readRepoFile(root, "links/hard.txt")).rejects.toThrow(/linked|hard link/i);
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

  it("blocks nested env files from repo reads and searches", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gptprouse-repo-"));
    await mkdir(path.join(root, "services", "api"), { recursive: true });
    await writeFile(path.join(root, "services", "api", ".env"), "SECRET=needle\n", "utf8");
    await writeFile(path.join(root, "services", "api", ".env.local"), "SECRET=needle\n", "utf8");
    await writeFile(path.join(root, "services", "api", ".envrc"), "SECRET=needle\n", "utf8");
    await writeFile(path.join(root, "services", "api", ".envrc.local"), "SECRET=needle\n", "utf8");
    await writeFile(path.join(root, "services", "api", "README.md"), "needle\n", "utf8");

    await expect(readRepoFile(root, "services/api/.env")).rejects.toThrow(/sensitive/);
    await expect(readRepoFile(root, "services/api/.env.local")).rejects.toThrow(/sensitive/);
    await expect(readRepoFile(root, "services/api/.envrc")).rejects.toThrow(/sensitive/);
    await expect(readRepoFile(root, "services/api/.envrc.local")).rejects.toThrow(/sensitive/);
    await expect(searchRepo(root, "SECRET")).resolves.toEqual([]);
    await expect(searchRepo(root, "SECRET", "services/api/.env.local")).rejects.toThrow(/sensitive/);
    await expect(searchRepo(root, "SECRET", "services/api/.envrc")).rejects.toThrow(/sensitive/);
  });

  it("does not let wildcard search globs re-include env files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gptprouse-repo-"));
    await mkdir(path.join(root, "services", "api"), { recursive: true });
    await writeFile(path.join(root, ".env"), "SECRET=root-needle\n", "utf8");
    await writeFile(path.join(root, "services", "api", ".env.local"), "SECRET=nested-needle\n", "utf8");
    await writeFile(path.join(root, "services", "api", ".envrc"), "SECRET=envrc-needle\n", "utf8");
    await writeFile(path.join(root, "services", "api", ".envoy"), "SECRET=envoy-needle\n", "utf8");
    await writeFile(path.join(root, "README.md"), "SECRET=public-needle\n", "utf8");

    await expect(searchRepo(root, "SECRET", "*.env*")).rejects.toThrow(/sensitive/);
    await expect(searchRepo(root, "SECRET", "**/.env*")).rejects.toThrow(/sensitive/);
    await expect(searchRepo(root, "SECRET", "**/.envrc*")).rejects.toThrow(/sensitive/);
    await expect(searchRepo(root, "SECRET", "services/api/{README.md,.envrc}")).rejects.toThrow(/sensitive/);
    await expect(searchRepo(root, "SECRET", "services/api/.envoy")).rejects.toThrow(/sensitive/);
    await expect(searchRepo(root, "SECRET", "**/.[e]nv*")).rejects.toThrow(/sensitive/);
    await expect(searchRepo(root, "SECRET", "**/[.]env*")).rejects.toThrow(/sensitive/);
    await expect(searchRepo(root, "SECRET", "**/?env*")).rejects.toThrow(/sensitive/);
    await expect(searchRepo(root, "SECRET", "**/.e?v*")).rejects.toThrow(/sensitive/);
    await expect(searchRepo(root, "SECRET", "**/*")).resolves.toEqual([{ path: "README.md", line: 1, text: "SECRET=public-needle" }]);
  });

  it("blocks nested git, dependency, and build output paths from repo reads and searches", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gptprouse-repo-"));
    await mkdir(path.join(root, "services", "api", ".git"), { recursive: true });
    await mkdir(path.join(root, "packages", "a", "node_modules", "pkg"), { recursive: true });
    await mkdir(path.join(root, "packages", "a", "dist"), { recursive: true });
    await writeFile(path.join(root, "services", "api", ".git", "config"), "needle git\n", "utf8");
    await writeFile(path.join(root, "packages", "a", "node_modules", "pkg", "secret.txt"), "needle dependency\n", "utf8");
    await writeFile(path.join(root, "packages", "a", "dist", "build.txt"), "needle build\n", "utf8");
    await writeFile(path.join(root, "packages", "a", "README.md"), "needle docs\n", "utf8");

    await expect(readRepoFile(root, "services/api/.git/config")).rejects.toThrow(/sensitive/);
    await expect(readRepoFile(root, "packages/a/node_modules/pkg/secret.txt")).rejects.toThrow(/sensitive/);
    await expect(readRepoFile(root, "packages/a/dist/build.txt")).rejects.toThrow(/sensitive/);

    await expect(searchRepo(root, "needle")).resolves.toEqual([{ path: "packages/a/README.md", line: 1, text: "needle docs" }]);
    await expect(searchRepo(root, "needle", "packages/a/node_modules/**")).rejects.toThrow(/sensitive/);
    await expect(searchRepo(root, "needle", "packages/**/node_modules/**")).rejects.toThrow(/sensitive/);
    await expect(searchRepo(root, "needle", "packages/a/dist/**")).rejects.toThrow(/sensitive/);
  });

  it("blocks nested bridge paths from repo reads and searches", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gptprouse-repo-"));
    await mkdir(path.join(root, "services", "api", ".bridge"), { recursive: true });
    await writeFile(path.join(root, "services", "api", ".bridge", "config.local.json"), "SECRET=needle\n", "utf8");
    await writeFile(path.join(root, "services", "api", "README.md"), "needle docs\n", "utf8");

    await expect(readRepoFile(root, "services/api/.bridge/config.local.json")).rejects.toThrow(/sensitive/);
    await expect(searchRepo(root, "SECRET")).resolves.toEqual([]);
    await expect(searchRepo(root, "SECRET", "services/api/.bridge/**")).rejects.toThrow(/sensitive/);
  });

  it("rejects large files before reading them into the response", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gptprouse-repo-"));
    await writeFile(path.join(root, "large.txt"), "x".repeat(1_100_000), "utf8");

    await expect(readRepoFile(root, "large.txt")).rejects.toThrow(/large/);
  });
});
