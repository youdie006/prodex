import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { readRepoFile, searchRepo, searchRepoWithMetadata } from "../src/repo.js";

// Found 2026-11-09 driving the MCP repo tools against throwaway repos.
async function repo(files: Record<string, string | Buffer>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "prodex-repo-search-"));
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  return root;
}

describe("repo search", () => {
  // repo_read_file reads .github/workflows/ci.yml, but ripgrep skips hidden
  // files unless asked, so a search never found anything in it.
  it("searches dot-files and dot-directories that repo_read_file can read", async () => {
    const root = await repo({ ".github/workflows/ci.yml": "run: echo needle\n", ".eslintrc.cjs": "// needle\n", "src/a.ts": "needle\n" });
    const paths = (await searchRepo(root, "needle")).map((match) => match.path).sort();
    expect(paths).toEqual([".eslintrc.cjs", ".github/workflows/ci.yml", "src/a.ts"]);
    expect((await searchRepo(root, "needle", ".github/**")).map((match) => match.path)).toEqual([".github/workflows/ci.yml"]);
  });

  it("still keeps sensitive dot-files out of the results", async () => {
    const root = await repo({ ".env": "needle\n", ".git/config": "needle\n", ".bridge/x.json": "needle\n", ".ssh/id": "needle\n", "ok.md": "needle\n" });
    expect((await searchRepo(root, "needle")).map((match) => match.path)).toEqual(["ok.md"]);
  });

  // ripgrep reports a line that is not UTF-8 as base64 "bytes" instead of
  // "text", and such matches were dropped.
  it("returns a match on a line that is not UTF-8", async () => {
    const root = await repo({ "legacy.properties": Buffer.concat([Buffer.from("label=caf"), Buffer.from([0xe9]), Buffer.from(" needle\nother needle\n")]) });
    const matches = await searchRepo(root, "needle");
    expect(matches.map((match) => match.line)).toEqual([1, 2]);
    expect(matches[0].text).toBe("label=caf� needle");
  });

  // One unreadable directory (a docker volume, say) made ripgrep exit 2, and
  // every match it had found was thrown away with the raw command line.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("returns the matches it found when a directory cannot be read", async () => {
    const root = await repo({ "pgdata/base": "needle\n", "src/a.ts": "needle\n" });
    await chmod(path.join(root, "pgdata"), 0o000);
    try {
      expect((await searchRepo(root, "needle")).map((match) => match.path)).toEqual(["src/a.ts"]);
    } finally {
      await chmod(path.join(root, "pgdata"), 0o755);
    }
  });

  it("explains that a query cannot span lines", async () => {
    const root = await repo({ "a.ts": "const\nneedle\n" });
    await expect(searchRepo(root, "const\nneedle")).rejects.toThrow(/one line at a time/);
  });

  // ripgrep's output for a broad query outgrew the 1 MB buffer, and the search
  // failed instead of returning its first matches marked truncated.
  it("returns the first matches of a broad search, marked truncated", async () => {
    const root = await repo({ "big.txt": `${Array.from({ length: 6000 }, (_, index) => `needle line ${index + 1}`).join("\n")}\n` });
    const result = await searchRepoWithMetadata(root, "needle");
    expect(result.matches).toHaveLength(100);
    expect(result.truncated).toBe(true);
  });
});

describe("repo paths", () => {
  it("reads a top-level file whose name starts with two dots", async () => {
    const root = await repo({ "..notes.md": "hello\n" });
    await expect(readRepoFile(root, "..notes.md")).resolves.toMatchObject({ content: "hello" });
  });
});
