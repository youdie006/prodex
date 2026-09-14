import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
// @ts-expect-error - the packaging helper is a dependency-free Node script
import { publishTarballDryRun } from "../scripts/npm-dry-run.mjs";

const run = promisify(execFile);

it("checks a published-version tarball against an isolated read-only registry", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "prodex-dry-run-test-"));
  try {
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({
      name: "@youdie006/prodex", version: "0.40.6", license: "MIT",
      publishConfig: { access: "public" }
    }));
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const packed = await run(npm, ["pack", "--json", "--ignore-scripts"], { cwd, timeout: 30_000 });
    const tarball = path.join(cwd, JSON.parse(packed.stdout)[0].filename);
    const result = await publishTarballDryRun(tarball);
    expect(`${result.stdout}\n${result.stderr}`).toContain("prodex@0.40.6");
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/Publishing to http:\/\/127\.0\.0\.1:\d+.*\(dry-run\)/);
    expect(result.requests.every((request: { method: string }) => request.method === "GET")).toBe(true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
