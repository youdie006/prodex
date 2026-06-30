import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readRepoFile, resolveRepoPath, searchRepo, searchRepoWithMetadata } from "../src/repo.js";
import { setSafeFileTestHooks } from "../src/safe-file.js";

describe("repo path policy", () => {
  afterEach(() => {
    setSafeFileTestHooks({});
  });

  it("reads repo-relative files with line metadata", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-repo-"));
    await writeFile(path.join(root, "README.md"), "one\ntwo\nthree\n", "utf8");

    const result = await readRepoFile(root, "README.md", { startLine: 2, maxLines: 1 });

    expect(result.path).toBe("README.md");
    expect(result.start_line).toBe(2);
    expect(result.content).toBe("two");
  });

  it("rejects repo reads whose requested range starts past EOF", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-repo-"));
    await writeFile(path.join(root, "README.md"), "one\ntwo\n", "utf8");

    await expect(readRepoFile(root, "README.md", { startLine: 5, maxLines: 2 })).rejects.toThrow(
      "start_line 5 is beyond the end of README.md (2 lines)"
    );
  });

  it("reports stable line metadata for empty repo files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-repo-"));
    await writeFile(path.join(root, "README.md"), "", "utf8");

    const result = await readRepoFile(root, "README.md");

    expect(result.start_line).toBe(1);
    expect(result.end_line).toBe(1);
    expect(result.total_lines).toBe(0);
    expect(result.content).toBe("");
  });

  it("reports missing repo files without leaking raw filesystem paths", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-repo-"));

    await expect(readRepoFile(root, "missing.md")).rejects.toThrow("Path missing.md was not found in the repo");
    await expect(readRepoFile(root, "missing.md")).rejects.not.toThrow(/ENOENT|realpath|no such file/i);
  });

  it("rejects traversal, absolute paths, and symlink escapes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-repo-"));
    const outside = await mkdtemp(path.join(tmpdir(), "prodex-outside-"));
    await writeFile(path.join(outside, "file.txt"), "outside\n", "utf8");
    await mkdir(path.join(root, "links"));
    await symlink(outside, path.join(root, "links", "outside"));

    expect(() => resolveRepoPath(root, "../secret.txt")).toThrow(/repo-relative/);
    expect(() => resolveRepoPath(root, path.join(root, "README.md"))).toThrow(/repo-relative/);
    await expect(readRepoFile(root, "links/outside/file.txt")).rejects.toThrow(/escapes/);
  });

  it("rejects reads when the target is swapped to a symlink before open", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-repo-"));
    const outside = await mkdtemp(path.join(tmpdir(), "prodex-outside-"));
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
    const root = await mkdtemp(path.join(tmpdir(), "prodex-repo-"));
    const outside = await mkdtemp(path.join(tmpdir(), "prodex-outside-"));
    const outsideFile = path.join(outside, "secret.txt");
    await writeFile(outsideFile, "outside secret\n", "utf8");
    await mkdir(path.join(root, "links"));
    await link(outsideFile, path.join(root, "links", "hard.txt"));

    await expect(readRepoFile(root, "links/hard.txt")).rejects.toThrow(/linked|hard link/i);
  });

  it("rejects unsafe repo reads without leaking raw filesystem paths", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-repo-"));
    const outside = await mkdtemp(path.join(tmpdir(), "prodex-outside-"));
    const outsideFile = path.join(outside, "secret.txt");
    await writeFile(outsideFile, "outside secret\n", "utf8");
    await mkdir(path.join(root, "links"));
    await link(outsideFile, path.join(root, "links", "hard.txt"));

    await expect(readRepoFile(root, "links/hard.txt")).rejects.toThrow(/linked|hard link/i);
    await expect(readRepoFile(root, "links/hard.txt")).rejects.not.toThrow(root);
    await expect(readRepoFile(root, "links/hard.txt")).rejects.not.toThrow(outside);
  });

  it("does not return repo search matches from hard-linked files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-repo-"));
    const outside = await mkdtemp(path.join(tmpdir(), "prodex-outside-"));
    const outsideFile = path.join(outside, "secret.txt");
    await writeFile(outsideFile, "TOKEN=outside\n", "utf8");
    await link(outsideFile, path.join(root, "public.txt"));
    await writeFile(path.join(root, "README.md"), "TOKEN=public\n", "utf8");

    await expect(readRepoFile(root, "public.txt")).rejects.toThrow(/linked|hard link/i);
    await expect(searchRepo(root, "TOKEN")).resolves.toEqual([{ path: "README.md", line: 1, text: "TOKEN=public" }]);
  });

  it("blocks local bridge, git, and env files from repo reads", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-repo-"));
    await mkdir(path.join(root, ".bridge"), { recursive: true });
    await mkdir(path.join(root, ".git"), { recursive: true });
    await writeFile(path.join(root, ".bridge", "config.local.json"), '{"token":"secret"}\n', "utf8");
    await writeFile(path.join(root, ".git", "config"), "[remote]\n", "utf8");
    await writeFile(path.join(root, ".env"), "TOKEN=secret\n", "utf8");

    await expect(readRepoFile(root, ".bridge/config.local.json")).rejects.toThrow(/sensitive/);
    await expect(readRepoFile(root, ".git/config")).rejects.toThrow(/sensitive/);
    await expect(readRepoFile(root, ".env")).rejects.toThrow(/sensitive/);
  });

  it("blocks repo reads through symlink aliases to sensitive directories", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-repo-"));
    await mkdir(path.join(root, ".bridge"), { recursive: true });
    await writeFile(path.join(root, ".bridge", "config.local.json"), '{"token":"secret"}\n', "utf8");
    await symlink(path.join(root, ".bridge"), path.join(root, "bridge-alias"));

    await expect(readRepoFile(root, "bridge-alias/config.local.json")).rejects.toThrow(/sensitive/);
  });

  it("excludes sensitive local files from repo search results", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-repo-"));
    await mkdir(path.join(root, ".bridge"), { recursive: true });
    await writeFile(path.join(root, ".bridge", "config.local.json"), '{"token":"needle"}\n', "utf8");
    await writeFile(path.join(root, "README.md"), "needle\n", "utf8");

    const matches = await searchRepo(root, "needle");

    expect(matches).toEqual([{ path: "README.md", line: 1, text: "needle" }]);
    await expect(searchRepo(root, "needle", ".bridge/**")).rejects.toThrow(/sensitive/);
  });

  it("treats search queries that start with dashes as literal text", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-repo-"));
    await writeFile(path.join(root, "README.md"), "before\n--not-a-real-rg-option literal flag text\nafter\n", "utf8");

    await expect(searchRepo(root, "--not-a-real-rg-option")).resolves.toEqual([
      { path: "README.md", line: 2, text: "--not-a-real-rg-option literal flag text" }
    ]);
  });

  it("parses search matches in files whose paths contain colons", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-repo-"));
    await writeFile(path.join(root, "notes:today.md"), "needle:with:colon\n", "utf8");

    await expect(searchRepo(root, "needle")).resolves.toEqual([
      { path: "notes:today.md", line: 1, text: "needle:with:colon" }
    ]);
  });

  it("reports search truncation metadata when more than the returned limit matches", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-repo-"));
    await writeFile(
      path.join(root, "README.md"),
      `${Array.from({ length: 101 }, (_, index) => `needle ${index + 1}`).join("\n")}\n`,
      "utf8"
    );

    const result = await searchRepoWithMetadata(root, "needle");

    expect(result.matches).toHaveLength(100);
    expect(result.truncated).toBe(true);
    expect(result.limit).toBe(100);
  });

  it("resolves ripgrep via fallback dirs even when PATH is narrowed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-repo-"));
    const emptyPath = await mkdtemp(path.join(tmpdir(), "prodex-empty-path-"));
    await writeFile(path.join(root, "README.md"), "needle\n", "utf8");
    const previousPath = process.env.PATH;
    process.env.PATH = emptyPath;
    try {
      // A narrowed PATH (e.g. an MCP server spawned with a minimal environment) no
      // longer breaks repo_search: findRipgrep falls back to common install dirs.
      const result = await searchRepo(root, "needle");
      expect(result.some((match) => match.path === "README.md")).toBe(true);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it("reports oversized repo search output without leaking raw Node maxBuffer details", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-repo-"));
    await writeFile(path.join(root, "huge.txt"), `${"needle ".repeat(200_000)}\n`, "utf8");

    await expect(searchRepo(root, "needle")).rejects.toThrow(/too many matches|narrow/i);
    await expect(searchRepo(root, "needle")).rejects.not.toThrow(/maxBuffer|stdout|ERR_CHILD_PROCESS/i);
  });

  it("blocks nested env files from repo reads and searches", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-repo-"));
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
    const root = await mkdtemp(path.join(tmpdir(), "prodex-repo-"));
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
    const root = await mkdtemp(path.join(tmpdir(), "prodex-repo-"));
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
    const root = await mkdtemp(path.join(tmpdir(), "prodex-repo-"));
    await mkdir(path.join(root, "services", "api", ".bridge"), { recursive: true });
    await writeFile(path.join(root, "services", "api", ".bridge", "config.local.json"), "SECRET=needle\n", "utf8");
    await writeFile(path.join(root, "services", "api", "README.md"), "needle docs\n", "utf8");

    await expect(readRepoFile(root, "services/api/.bridge/config.local.json")).rejects.toThrow(/sensitive/);
    await expect(searchRepo(root, "SECRET")).resolves.toEqual([]);
    await expect(searchRepo(root, "SECRET", "services/api/.bridge/**")).rejects.toThrow(/sensitive/);
  });

  it("blocks case-folded sensitive paths from repo reads and searches", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-repo-"));
    await mkdir(path.join(root, ".Bridge"), { recursive: true });
    await mkdir(path.join(root, "Services", "API", ".GIT"), { recursive: true });
    await mkdir(path.join(root, "Services", "API"), { recursive: true });
    await mkdir(path.join(root, "Packages", "A", "Node_Modules", "pkg"), { recursive: true });
    await mkdir(path.join(root, "Packages", "A", "DIST"), { recursive: true });
    await writeFile(path.join(root, ".Bridge", "config.local.json"), "SECRET=bridge\n", "utf8");
    await writeFile(path.join(root, "Services", "API", ".GIT", "config"), "SECRET=git\n", "utf8");
    await writeFile(path.join(root, "Services", "API", ".ENV.Local"), "SECRET=env\n", "utf8");
    await writeFile(path.join(root, "Packages", "A", "Node_Modules", "pkg", "secret.txt"), "SECRET=dependency\n", "utf8");
    await writeFile(path.join(root, "Packages", "A", "DIST", "build.txt"), "SECRET=build\n", "utf8");
    await writeFile(path.join(root, "README.md"), "SECRET=public\n", "utf8");

    await expect(readRepoFile(root, ".Bridge/config.local.json")).rejects.toThrow(/sensitive/);
    await expect(readRepoFile(root, "Services/API/.GIT/config")).rejects.toThrow(/sensitive/);
    await expect(readRepoFile(root, "Services/API/.ENV.Local")).rejects.toThrow(/sensitive/);
    await expect(readRepoFile(root, "Packages/A/Node_Modules/pkg/secret.txt")).rejects.toThrow(/sensitive/);
    await expect(readRepoFile(root, "Packages/A/DIST/build.txt")).rejects.toThrow(/sensitive/);
    await expect(searchRepo(root, "SECRET")).resolves.toEqual([{ path: "README.md", line: 1, text: "SECRET=public" }]);
    await expect(searchRepo(root, "SECRET", "**/.Bridge/**")).rejects.toThrow(/sensitive/);
    await expect(searchRepo(root, "SECRET", "**/.GIT/**")).rejects.toThrow(/sensitive/);
    await expect(searchRepo(root, "SECRET", "**/.ENV*")).rejects.toThrow(/sensitive/);
    await expect(searchRepo(root, "SECRET", "**/Node_Modules/**")).rejects.toThrow(/sensitive/);
    await expect(searchRepo(root, "SECRET", "**/DIST/**")).rejects.toThrow(/sensitive/);
  });

  it("ignores user ripgrep config that would follow symlinks outside the repo", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-repo-"));
    const outside = await mkdtemp(path.join(tmpdir(), "prodex-outside-"));
    const rgConfig = path.join(await mkdtemp(path.join(tmpdir(), "prodex-rg-config-")), "ripgreprc");
    await writeFile(path.join(outside, "secret.txt"), "SECRET=outside\n", "utf8");
    await symlink(outside, path.join(root, "outside-link"));
    await writeFile(rgConfig, "--follow\n", "utf8");
    const previousConfig = process.env.RIPGREP_CONFIG_PATH;
    process.env.RIPGREP_CONFIG_PATH = rgConfig;
    try {
      await expect(searchRepo(root, "SECRET")).resolves.toEqual([]);
    } finally {
      if (previousConfig === undefined) delete process.env.RIPGREP_CONFIG_PATH;
      else process.env.RIPGREP_CONFIG_PATH = previousConfig;
    }
  });

  it("rejects large files before reading them into the response", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-repo-"));
    await writeFile(path.join(root, "large.txt"), "x".repeat(1_100_000), "utf8");

    await expect(readRepoFile(root, "large.txt")).rejects.toThrow(/large/);
  });
});
