import { chmod, copyFile, link, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

describe("release-pack", () => {
  it("prints usage without inspecting package metadata", async () => {
    const result = await runReleasePack(["--help"]);

    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.code).toBe(0);
    expect(output).toContain("Usage: npm run release:pack -- --pack-destination <dir>");
    expect(output).toContain("--root <dir>");
    expect(output).toContain("--keep-workdir");
    expect(output).not.toContain("release pack failed");
    expect(output).not.toContain("release metadata failed");
  });

  it("requires an explicit pack destination before creating a tarball", async () => {
    const root = await createReleasePackFixture();

    const result = await runReleasePack(["--root", root]);

    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.code).toBe(1);
    expect(output).toContain("release pack failed");
    expect(output).toContain("--pack-destination is required");
    expect((await readdir(root)).filter((entry) => entry.endsWith(".tgz"))).toEqual([]);
  });

  it("fails with a friendly message when package.json is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gptprouse-release-pack-missing-"));
    const destination = await mkdtemp(path.join(tmpdir(), "gptprouse-release-pack-dest-"));

    const result = await runReleasePack(["--root", root, "--pack-destination", destination]);

    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.code).toBe(1);
    expect(output).toContain("release pack failed");
    expect(output).toContain("package.json not found");
    expect(output).not.toContain("ENOENT");
    expect(output).not.toContain("SyntaxError");
    expect((await readdir(destination)).filter((entry) => entry.endsWith(".tgz"))).toEqual([]);
  });

  it("fails with a friendly message when package.json is malformed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gptprouse-release-pack-malformed-"));
    const destination = await mkdtemp(path.join(tmpdir(), "gptprouse-release-pack-dest-"));
    await writeFile(path.join(root, "package.json"), "{ broken json\n", "utf8");

    const result = await runReleasePack(["--root", root, "--pack-destination", destination]);

    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.code).toBe(1);
    expect(output).toContain("release pack failed");
    expect(output).toContain("package.json is not valid JSON");
    expect(output).not.toContain("SyntaxError");
    expect(output).not.toContain("at JSON.parse");
    expect((await readdir(destination)).filter((entry) => entry.endsWith(".tgz"))).toEqual([]);
  });

  it("fails with a friendly message when npm pack dry-run returns malformed JSON", async () => {
    const root = await createReleasePackFixture();
    const destination = await mkdtemp(path.join(tmpdir(), "gptprouse-release-pack-dest-"));
    const fakeBin = await mkdtemp(path.join(tmpdir(), "gptprouse-release-pack-fake-bin-"));
    await writeFile(
      path.join(fakeBin, npmCommand),
      "#!/bin/sh\nprintf 'not json\\n'\n",
      "utf8"
    );
    await chmod(path.join(fakeBin, npmCommand), 0o755);

    const result = await runReleasePack(["--root", root, "--pack-destination", destination], {
      env: { PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}` }
    });

    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.code).toBe(1);
    expect(output).toContain("release pack failed");
    expect(output).toContain("npm pack dry-run did not return valid JSON");
    expect(output).not.toContain("Unexpected token");
    expect(output).not.toContain("not valid JSON");
    expect(output).not.toContain("at JSON.parse");
    expect((await readdir(destination)).filter((entry) => entry.endsWith(".tgz"))).toEqual([]);
  });

  it("fails with a friendly message when final npm pack returns malformed JSON", async () => {
    const root = await createReleasePackFixture();
    const destination = await mkdtemp(path.join(tmpdir(), "gptprouse-release-pack-dest-"));
    const fakeBin = await mkdtemp(path.join(tmpdir(), "gptprouse-release-pack-fake-bin-"));
    await writeFile(
      path.join(fakeBin, npmCommand),
      `#!/bin/sh
case " $* " in
  *" --dry-run "*) printf '[{"files":[{"path":"package.json"},{"path":"README.md"},{"path":"LICENSE"},{"path":"dist/cli.js"},{"path":"scripts/release-check.mjs"}]}]\\n' ;;
  *) printf 'not json\\n' ;;
esac
`,
      "utf8"
    );
    await chmod(path.join(fakeBin, npmCommand), 0o755);

    const result = await runReleasePack(["--root", root, "--pack-destination", destination], {
      env: { PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}` }
    });

    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.code).toBe(1);
    expect(output).toContain("release pack failed");
    expect(output).toContain("npm pack did not return valid JSON");
    expect(output).not.toContain("Unexpected token");
    expect(output).not.toContain("not valid JSON");
    expect(output).not.toContain("at JSON.parse");
    expect((await readdir(destination)).filter((entry) => entry.endsWith(".tgz"))).toEqual([]);
  });

  it("creates a sanitized tarball from a package with executable non-bin file modes", async () => {
    const root = await createReleasePackFixture();
    await chmod(path.join(root, "README.md"), 0o755);
    await chmod(path.join(root, "scripts", "release-check.mjs"), 0o755);
    const destination = await mkdtemp(path.join(tmpdir(), "gptprouse-release-pack-dest-"));

    const result = await runReleasePack(["--root", root, "--pack-destination", destination]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("release_pack=ok");
    expect(result.stdout).toContain("file_modes=ok");
    const tarballs = (await readdir(destination)).filter((entry) => entry.endsWith(".tgz"));
    expect(tarballs).toHaveLength(1);

    const consumer = await mkdtemp(path.join(tmpdir(), "gptprouse-release-pack-consumer-"));
    await writeFile(path.join(consumer, "package.json"), `${JSON.stringify({ private: true }, null, 2)}\n`, "utf8");
    await execFileAsync(npmCommand, ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", path.join(destination, tarballs[0])], {
      cwd: consumer,
      timeout: 120_000
    });
    const installedRoot = path.join(consumer, "node_modules", "demo-release-pack");
    expect((await stat(path.join(installedRoot, "README.md"))).mode & 0o777).toBe(0o644);
    expect((await stat(path.join(installedRoot, "scripts", "release-check.mjs"))).mode & 0o777).toBe(0o644);
    expect((await stat(path.join(installedRoot, "dist", "cli.js"))).mode & 0o777).toBe(0o755);
  });

  it("rejects hard-linked source package files instead of hiding them in the staging copy", async () => {
    const root = await createReleasePackFixture();
    const outside = path.join(path.dirname(root), "outside-readme.md");
    await writeFile(outside, "# Outside README\n", "utf8");
    await rm(path.join(root, "README.md"));
    await link(outside, path.join(root, "README.md"));
    const destination = await mkdtemp(path.join(tmpdir(), "gptprouse-release-pack-dest-"));

    const result = await runReleasePack(["--root", root, "--pack-destination", destination]);

    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.code).toBe(1);
    expect(output).toContain("release pack failed");
    expect(output).toContain("hard links");
    expect(output).toContain("README.md");
    expect((await readdir(destination)).filter((entry) => entry.endsWith(".tgz"))).toEqual([]);
  });
});

async function createReleasePackFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gptprouse-release-pack-"));
  await mkdir(path.join(root, "dist"), { recursive: true });
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "demo-release-pack",
        version: "1.0.0",
        license: "MIT",
        type: "module",
        bin: { demo: "dist/cli.js" },
        files: ["README.md", "LICENSE", "dist/cli.js", "scripts/release-check.mjs"]
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(path.join(root, "README.md"), "# Demo\n", "utf8");
  await writeFile(path.join(root, "LICENSE"), "MIT License\n", "utf8");
  await writeFile(path.join(root, "dist", "cli.js"), "#!/usr/bin/env node\nconsole.log('demo')\n", "utf8");
  await chmod(path.join(root, "dist", "cli.js"), 0o755);
  await copyFile(path.join(repoRoot, "scripts", "release-check.mjs"), path.join(root, "scripts", "release-check.mjs"));
  return root;
}

async function runReleasePack(
  args: string[],
  options: { env?: NodeJS.ProcessEnv } = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(process.execPath, [path.join(repoRoot, "scripts", "release-pack.mjs"), ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...options.env },
      timeout: 120_000,
      maxBuffer: 20 * 1024 * 1024
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
