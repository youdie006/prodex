import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");

describe("release-check", () => {
  it("fails release metadata when package license is missing", async () => {
    const root = await copyPackageJsonToTemp();

    const result = await runReleaseCheck(root);

    expect(result.code).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/license/i);
  });

  it("passes release metadata when package license and LICENSE file are explicit", async () => {
    const root = await copyPackageJsonToTemp();
    const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    packageJson.license = "MIT";
    await writeFile(path.join(root, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
    await writeFile(path.join(root, "LICENSE"), "MIT License\n", "utf8");

    const result = await runReleaseCheck(root);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("release_metadata=ok");
  });
});

async function copyPackageJsonToTemp(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gptprouse-release-check-"));
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "package.json"), await readFile(path.join(repoRoot, "package.json"), "utf8"), "utf8");
  return root;
}

async function runReleaseCheck(root: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync("node", [path.join(repoRoot, "scripts", "release-check.mjs"), "--metadata-only", "--root", root], {
      cwd: repoRoot
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failed.code === "number" ? failed.code : 1,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? ""
    };
  }
}
