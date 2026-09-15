import { chmod, copyFile, link, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { execNpm, normalizeNpmEnvironment } from "../scripts/npm-command.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
const fakeNpmCliFilename = "npm-cli.mjs";

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

  it("suggests close release-pack flag matches before inspecting metadata", async () => {
    const result = await runReleasePack(["--pack-dest", "/tmp/out"]);

    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.code).toBe(1);
    expect(output).toContain("release pack failed");
    expect(output).toContain("release pack flags failed: unknown option --pack-dest. Did you mean `--pack-destination`?");
    expect(output).not.toContain("release metadata failed");
    expect(output).not.toContain("Node.js v");
  });

  it("fails with a friendly message when package.json is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-release-pack-missing-"));
    const destination = path.join(root, "packed");

    const result = await runReleasePack(["--root", root, "--pack-destination", destination]);

    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.code).toBe(1);
    expect(output).toContain("release pack failed");
    expect(output).toContain("package.json not found");
    expect(output).not.toContain("ENOENT");
    expect(output).not.toContain("SyntaxError");
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails with a friendly message when package.json is malformed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-release-pack-malformed-"));
    const destination = await mkdtemp(path.join(tmpdir(), "prodex-release-pack-dest-"));
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
    const destination = await mkdtemp(path.join(tmpdir(), "prodex-release-pack-dest-"));
    const fakeBin = await mkdtemp(path.join(tmpdir(), "prodex-release-pack-fake-bin-"));
    await writeFile(
      path.join(fakeBin, fakeNpmCliFilename),
      `process.stdout.write(${JSON.stringify("not json\n")});\n`,
      "utf8"
    );

    const result = await runReleasePack(["--root", root, "--pack-destination", destination], {
      env: { npm_execpath: path.join(fakeBin, fakeNpmCliFilename) }
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

  it("fails with a friendly message when npm pack dry-run exits nonzero", async () => {
    const root = await createReleasePackFixture();
    const destination = await mkdtemp(path.join(tmpdir(), "prodex-release-pack-dest-"));
    const fakeBin = await mkdtemp(path.join(tmpdir(), "prodex-release-pack-fake-bin-"));
    await writeFile(
      path.join(fakeBin, fakeNpmCliFilename),
      `process.stderr.write(${JSON.stringify("npm dry-run exploded\n")});\nprocess.exit(23);\n`,
      "utf8"
    );

    const result = await runReleasePack(["--root", root, "--pack-destination", destination], {
      env: { npm_execpath: path.join(fakeBin, fakeNpmCliFilename) }
    });

    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.code).toBe(1);
    expect(output).toContain("release pack failed");
    expect(output).toContain("npm pack dry-run failed: npm dry-run exploded");
    expect(output).not.toContain("Command failed:");
    expect(output).not.toContain("npm pack --json --dry-run");
    expect((await readdir(destination)).filter((entry) => entry.endsWith(".tgz"))).toEqual([]);
  });

  it("fails with a friendly message when npm pack dry-run exits silently", async () => {
    const root = await createReleasePackFixture();
    const destination = await mkdtemp(path.join(tmpdir(), "prodex-release-pack-dest-"));
    const fakeBin = await mkdtemp(path.join(tmpdir(), "prodex-release-pack-fake-bin-"));
    await writeFile(
      path.join(fakeBin, fakeNpmCliFilename),
      "process.exit(23);\n",
      "utf8"
    );

    const result = await runReleasePack(["--root", root, "--pack-destination", destination], {
      env: { npm_execpath: path.join(fakeBin, fakeNpmCliFilename) }
    });

    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.code).toBe(1);
    expect(output).toContain("release pack failed");
    expect(output).toContain("npm pack dry-run failed: exit code 23");
    expect(output).not.toContain("Command failed:");
    expect(output).not.toContain("npm pack --json --dry-run");
    expect((await readdir(destination)).filter((entry) => entry.endsWith(".tgz"))).toEqual([]);
  });

  it("fails with a friendly message when npm pack dry-run includes a file entry without a path", async () => {
    const root = await createReleasePackFixture();
    const destination = await mkdtemp(path.join(tmpdir(), "prodex-release-pack-dest-"));
    const fakeBin = await mkdtemp(path.join(tmpdir(), "prodex-release-pack-fake-bin-"));
    await writeFile(
      path.join(fakeBin, fakeNpmCliFilename),
      [
        'if (!process.argv.slice(2).includes("--dry-run")) { process.stderr.write("final pack should not run\\n"); process.exit(24); }',
        `process.stdout.write(process.cwd() === ${JSON.stringify(root)} ? ${JSON.stringify('[{"files":[{"path":"package.json","mode":420},{"path":"README.md","mode":420},{"path":"LICENSE","mode":420},{"path":"demo-bin.js","mode":493},{"path":"dist/cli.js","mode":420},{"path":"scripts/npm-command.mjs","mode":420},{"path":"scripts/release-check.mjs","mode":420},{"mode":420}]}]\n')} : ${JSON.stringify('[{"files":[{"path":"package.json","mode":420},{"path":"README.md","mode":420},{"path":"LICENSE","mode":420},{"path":"demo-bin.js","mode":493},{"path":"dist/cli.js","mode":420},{"path":"scripts/npm-command.mjs","mode":420},{"path":"scripts/release-check.mjs","mode":420}]}]\n')});`
      ].join("\n"),
      "utf8"
    );

    const result = await runReleasePack(["--root", root, "--pack-destination", destination], {
      env: { npm_execpath: path.join(fakeBin, fakeNpmCliFilename) }
    });

    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.code).toBe(1);
    expect(output).toContain("release pack failed");
    expect(output).toContain("npm pack dry-run file entry is missing a path");
    expect(output).not.toContain("final pack should not run");
    expect(output).not.toContain("release_pack=ok");
    expect((await readdir(destination)).filter((entry) => entry.endsWith(".tgz"))).toEqual([]);
  });

  it("fails with a friendly message when npm pack lists a missing package file", async () => {
    const root = await createReleasePackFixture();
    const destination = await mkdtemp(path.join(tmpdir(), "prodex-release-pack-dest-"));
    const fakeBin = await mkdtemp(path.join(tmpdir(), "prodex-release-pack-fake-bin-"));
    await writeFile(
      path.join(fakeBin, fakeNpmCliFilename),
      `process.stdout.write(${JSON.stringify('[{"files":[{"path":"package.json"},{"path":"README.md"},{"path":"LICENSE"},{"path":"demo-bin.js"},{"path":"dist/cli.js"},{"path":"scripts/npm-command.mjs"},{"path":"scripts/release-check.mjs"},{"path":"missing.md"}]}]\n')});\n`,
      "utf8"
    );

    const result = await runReleasePack(["--root", root, "--pack-destination", destination], {
      env: { npm_execpath: path.join(fakeBin, fakeNpmCliFilename) }
    });

    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.code).toBe(1);
    expect(output).toContain("release pack failed");
    expect(output).toContain("packed file listed by npm was not found: missing.md");
    expect(output).not.toContain("ENOENT");
    expect(output).not.toContain("no such file");
    expect((await readdir(destination)).filter((entry) => entry.endsWith(".tgz"))).toEqual([]);
  });

  it("fails with a friendly message when final npm pack returns malformed JSON", async () => {
    const root = await createReleasePackFixture();
    const destination = await mkdtemp(path.join(tmpdir(), "prodex-release-pack-dest-"));
    const fakeBin = await mkdtemp(path.join(tmpdir(), "prodex-release-pack-fake-bin-"));
    await writeFile(
      path.join(fakeBin, fakeNpmCliFilename),
      `process.stdout.write(process.argv.slice(2).includes("--dry-run") ? ${JSON.stringify('[{"files":[{"path":"package.json","mode":420},{"path":"README.md","mode":420},{"path":"LICENSE","mode":420},{"path":"demo-bin.js","mode":493},{"path":"dist/cli.js","mode":420},{"path":"scripts/npm-command.mjs","mode":420},{"path":"scripts/release-check.mjs","mode":420}]}]\n')} : ${JSON.stringify("not json\n")});\n`,
      "utf8"
    );

    const result = await runReleasePack(["--root", root, "--pack-destination", destination], {
      env: { npm_execpath: path.join(fakeBin, fakeNpmCliFilename) }
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

  it("fails with a friendly message when final npm pack exits nonzero", async () => {
    const root = await createReleasePackFixture();
    const destination = await mkdtemp(path.join(tmpdir(), "prodex-release-pack-dest-"));
    const fakeBin = await mkdtemp(path.join(tmpdir(), "prodex-release-pack-fake-bin-"));
    await writeFile(
      path.join(fakeBin, fakeNpmCliFilename),
      [
        `if (process.argv.slice(2).includes("--dry-run")) process.stdout.write(${JSON.stringify('[{"files":[{"path":"package.json","mode":420},{"path":"README.md","mode":420},{"path":"LICENSE","mode":420},{"path":"demo-bin.js","mode":493},{"path":"dist/cli.js","mode":420},{"path":"scripts/npm-command.mjs","mode":420},{"path":"scripts/release-check.mjs","mode":420}]}]\n')});`,
        'else { process.stderr.write("npm final pack exploded\\n"); process.exit(24); }'
      ].join("\n"),
      "utf8"
    );

    const result = await runReleasePack(["--root", root, "--pack-destination", destination], {
      env: { npm_execpath: path.join(fakeBin, fakeNpmCliFilename) }
    });

    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.code).toBe(1);
    expect(output).toContain("release pack failed");
    expect(output).toContain("npm pack failed: npm final pack exploded");
    expect(output).not.toContain("Command failed:");
    expect(output).not.toContain("npm pack --json --ignore-scripts");
    expect((await readdir(destination)).filter((entry) => entry.endsWith(".tgz"))).toEqual([]);
  });

  it("fails with a friendly message when final npm pack reports a missing tarball", async () => {
    const root = await createReleasePackFixture();
    const destination = await mkdtemp(path.join(tmpdir(), "prodex-release-pack-dest-"));
    const fakeBin = await mkdtemp(path.join(tmpdir(), "prodex-release-pack-fake-bin-"));
    await writeFile(
      path.join(fakeBin, fakeNpmCliFilename),
      `process.stdout.write(process.argv.slice(2).includes("--dry-run") ? ${JSON.stringify('[{"files":[{"path":"package.json","mode":420},{"path":"README.md","mode":420},{"path":"LICENSE","mode":420},{"path":"demo-bin.js","mode":493},{"path":"dist/cli.js","mode":420},{"path":"scripts/npm-command.mjs","mode":420},{"path":"scripts/release-check.mjs","mode":420}]}]\n')} : ${JSON.stringify('[{"filename":"demo-release-pack-1.0.0.tgz"}]\n')});\n`,
      "utf8"
    );

    const result = await runReleasePack(["--root", root, "--pack-destination", destination], {
      env: { npm_execpath: path.join(fakeBin, fakeNpmCliFilename) }
    });

    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.code).toBe(1);
    expect(output).toContain("release pack failed");
    expect(output).toContain("npm pack did not create expected tarball:");
    expect(output).toContain("demo-release-pack-1.0.0.tgz");
    expect(output).not.toContain("ENOENT");
    expect(output).not.toContain("no such file");
    expect((await readdir(destination)).filter((entry) => entry.endsWith(".tgz"))).toEqual([]);
  });

  it("fails with a friendly message when final npm pack reports a tarball outside the destination", async () => {
    const root = await createReleasePackFixture();
    const destination = await mkdtemp(path.join(tmpdir(), "prodex-release-pack-dest-"));
    const outside = await mkdtemp(path.join(tmpdir(), "prodex-release-pack-outside-"));
    const outsideTarball = path.join(outside, "demo-release-pack-1.0.0.tgz");
    await writeFile(outsideTarball, "not a real package\n", "utf8");
    const fakeBin = await mkdtemp(path.join(tmpdir(), "prodex-release-pack-fake-bin-"));
    await writeFile(
      path.join(fakeBin, fakeNpmCliFilename),
      `process.stdout.write(process.argv.slice(2).includes("--dry-run") ? ${JSON.stringify('[{"files":[{"path":"package.json","mode":420},{"path":"README.md","mode":420},{"path":"LICENSE","mode":420},{"path":"demo-bin.js","mode":493},{"path":"dist/cli.js","mode":420},{"path":"scripts/npm-command.mjs","mode":420},{"path":"scripts/release-check.mjs","mode":420}]}]\n')} : ${JSON.stringify(`[{"filename":${JSON.stringify(outsideTarball)}}]\n`)});\n`,
      "utf8"
    );

    const result = await runReleasePack(["--root", root, "--pack-destination", destination], {
      env: { npm_execpath: path.join(fakeBin, fakeNpmCliFilename) }
    });

    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.code).toBe(1);
    expect(output).toContain("release pack failed");
    expect(output).toContain("npm pack reported tarball outside pack destination:");
    expect(output).toContain(outsideTarball);
    expect(output).not.toContain("release_pack=ok");
    expect((await readdir(destination)).filter((entry) => entry.endsWith(".tgz"))).toEqual([]);
  });

  it("fails with a friendly message when packed files omit the release check script", async () => {
    const root = await createReleasePackFixture();
    const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    packageJson.files = ["README.md", "LICENSE", "demo-bin.js", "dist/cli.js"];
    await writeFile(path.join(root, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
    const destination = await mkdtemp(path.join(tmpdir(), "prodex-release-pack-dest-"));

    const result = await runReleasePack(["--root", root, "--pack-destination", destination]);

    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.code).toBe(1);
    expect(output).toContain("release pack failed");
    expect(output).toContain("packed files must include scripts/release-check.mjs");
    expect(output).not.toContain("MODULE_NOT_FOUND");
    expect(output).not.toContain("Node.js v");
    expect((await readdir(destination)).filter((entry) => entry.endsWith(".tgz"))).toEqual([]);
  });

  it("fails with a friendly message when staging release metadata check fails", async () => {
    const root = await createReleasePackFixture();
    const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    delete packageJson.license;
    await writeFile(path.join(root, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
    const destination = await mkdtemp(path.join(tmpdir(), "prodex-release-pack-dest-"));

    const result = await runReleasePack(["--root", root, "--pack-destination", destination]);

    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.code).toBe(1);
    expect(output).toContain("release pack failed");
    expect(output).toContain("release metadata failed: package.json must include an explicit license before publishing");
    expect(output).not.toContain("Command failed:");
    expect(output).not.toContain("scripts/release-check.mjs --metadata-only");
    expect((await readdir(destination)).filter((entry) => entry.endsWith(".tgz"))).toEqual([]);
  });

  it("creates a sanitized tarball from a package with executable non-bin file modes", async () => {
    const root = await createReleasePackFixture();
    await chmod(path.join(root, "README.md"), 0o755);
    await chmod(path.join(root, "scripts", "release-check.mjs"), 0o755);
    const destinationRoot = await mkdtemp(path.join(tmpdir(), "prodex-release-pack-dest-"));
    const destination = path.join(destinationRoot, "O'Brien $release");

    const result = await runReleasePack(["--root", root, "--pack-destination", destination]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("release_pack=ok");
    expect(result.stdout).toContain("file_modes=ok");
    const tarballs = (await readdir(destination)).filter((entry) => entry.endsWith(".tgz"));
    expect(tarballs).toHaveLength(1);
    const tarballPath = path.join(destination, tarballs[0]);
    const quotedTarballPath = expectedShellQuote(tarballPath);
    expect(result.stdout).toContain(`release_pack_verify: npm publish --dry-run ${quotedTarballPath}`);
    expect(result.stdout).toContain("release_pack_publish_blocked: fix git readiness before npm publish");
    expect(result.stdout).not.toContain("release_pack_publish: npm publish");

    const consumer = await mkdtemp(path.join(tmpdir(), "prodex-release-pack-consumer-"));
    await writeFile(path.join(consumer, "package.json"), `${JSON.stringify({ private: true }, null, 2)}\n`, "utf8");
    await execNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", tarballPath], {
      cwd: consumer,
      timeout: 120_000
    });
    if (process.platform === "win32") {
      const executed = await execNpm(["exec", "--offline", "--no", "--", "demo", "literal & value"], {
        cwd: consumer,
        env: envWithCurrentNodeOnPath(),
        timeout: 120_000
      });
      expect(executed.stdout).toContain('["literal & value"]');
    } else {
      const installedRoot = path.join(consumer, "node_modules", "demo-release-pack");
      // npm applies the installing user's umask, so the contract is executable
      // bits only on package bins rather than exact 0644/0755 modes.
      const modeOf = async (...segments: string[]) => (await stat(path.join(installedRoot, ...segments))).mode & 0o777;
      expect(await modeOf("README.md") & 0o111).toBe(0);
      expect(await modeOf("scripts", "release-check.mjs") & 0o111).toBe(0);
      expect(await modeOf("dist", "cli.js") & 0o111).toBe(0);
      expect(await modeOf("demo-bin.js") & 0o111).not.toBe(0);
    }
  });

  it("prints git readiness before publish commands", async () => {
    const root = await createReleasePackFixture();
    await execFileAsync("git", ["init"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "release@example.com"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Release Test"], { cwd: root });
    await execFileAsync("git", ["add", "package.json", "README.md", "LICENSE", "demo-bin.js", "dist/cli.js", "scripts/npm-command.mjs", "scripts/release-check.mjs"], {
      cwd: root
    });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root });
    const branch = (await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root })).stdout.trim();
    const commit = (await execFileAsync("git", ["rev-parse", "--short", "HEAD"], { cwd: root })).stdout.trim();
    const destination = await mkdtemp(path.join(tmpdir(), "prodex-release-pack-dest-"));

    const result = await runReleasePack(["--root", root, "--pack-destination", destination]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`release_pack_git: blocked no remote configured branch=${branch} commit=${commit}`);
    expect(result.stdout).toContain(
      `release_pack_git_next: add a remote, then push with upstream tracking: git remote add origin <git-url>; git push -u origin ${branch}`
    );
    expect(result.stdout.indexOf("release_pack_git:")).toBeLessThan(result.stdout.indexOf("release_pack_verify:"));
    expect(result.stdout.indexOf("release_pack_git_next:")).toBeLessThan(result.stdout.indexOf("release_pack_publish_blocked:"));
    expect(result.stdout).toContain("release_pack_publish_blocked: fix git readiness before npm publish");
    expect(result.stdout).not.toContain("release_pack_publish: npm publish");
  });

  it("reports deleted upstream branches as gone instead of missing upstream", async () => {
    const root = await createReleasePackFixture();
    await execFileAsync("git", ["init"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "release@example.com"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Release Test"], { cwd: root });
    await execFileAsync("git", ["add", "package.json", "README.md", "LICENSE", "demo-bin.js", "dist/cli.js", "scripts/npm-command.mjs", "scripts/release-check.mjs"], {
      cwd: root
    });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root });
    const remote = await mkdtemp(path.join(tmpdir(), "prodex-release-pack-remote-"));
    await execFileAsync("git", ["init", "--bare"], { cwd: remote });
    await execFileAsync("git", ["remote", "add", "origin", remote], { cwd: root });
    const branch = (await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root })).stdout.trim();
    await execFileAsync("git", ["push", "-u", "origin", branch], { cwd: root });
    await execFileAsync("git", ["--git-dir", remote, "config", "receive.denyDeleteCurrent", "ignore"], { cwd: root });
    await execFileAsync("git", ["push", "origin", "--delete", branch], { cwd: root });
    await execFileAsync("git", ["fetch", "--prune", "origin"], { cwd: root });
    const commit = (await execFileAsync("git", ["rev-parse", "--short", "HEAD"], { cwd: root })).stdout.trim();
    const destination = await mkdtemp(path.join(tmpdir(), "prodex-release-pack-dest-"));

    const result = await runReleasePack(["--root", root, "--pack-destination", destination]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`release_pack_git: blocked upstream is gone branch=${branch} commit=${commit} remote=origin upstream=origin/${branch}`);
    expect(result.stdout).toContain("release_pack_git_next: restore upstream tracking before public release");
    expect(result.stdout).toContain("release_pack_publish_blocked: fix git readiness before npm publish");
    expect(result.stdout).not.toContain("release_pack_git: blocked no upstream configured");
    expect(result.stdout).not.toContain("release_pack_publish: npm publish");
  });

  it("prints the publish command only when git readiness is clear", async () => {
    const root = await createReleasePackFixture();
    await execFileAsync("git", ["init"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "release@example.com"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Release Test"], { cwd: root });
    await execFileAsync("git", ["add", "package.json", "README.md", "LICENSE", "demo-bin.js", "dist/cli.js", "scripts/npm-command.mjs", "scripts/release-check.mjs"], {
      cwd: root
    });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root });
    const remote = await mkdtemp(path.join(tmpdir(), "prodex-release-pack-remote-"));
    await execFileAsync("git", ["init", "--bare"], { cwd: remote });
    await execFileAsync("git", ["remote", "add", "origin", remote], { cwd: root });
    const branch = (await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root })).stdout.trim();
    await execFileAsync("git", ["push", "-u", "origin", branch], { cwd: root });
    const commit = (await execFileAsync("git", ["rev-parse", "--short", "HEAD"], { cwd: root })).stdout.trim();
    const destination = await mkdtemp(path.join(tmpdir(), "prodex-release-pack-dest-"));

    const result = await runReleasePack(["--root", root, "--pack-destination", destination]);

    const tarballs = (await readdir(destination)).filter((entry) => entry.endsWith(".tgz"));
    expect(tarballs).toHaveLength(1);
    const tarballPath = path.join(destination, tarballs[0]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`release_pack_git: ok branch=${branch} commit=${commit}`);
    expect(result.stdout).toContain(`release_pack_verify: npm publish --dry-run ${expectedShellQuote(tarballPath)}`);
    expect(result.stdout).toContain(
      "release_pack_publish_guard: npm publish <tarball> bypasses prepublishOnly; run the release_pack_verify command first, then publish only that verified tarball if it succeeds."
    );
    expect(result.stdout).toContain(`release_pack_publish: npm publish ${expectedShellQuote(tarballPath)}`);
    expect(result.stdout.indexOf("release_pack_verify:")).toBeLessThan(result.stdout.indexOf("release_pack_publish_guard:"));
    expect(result.stdout.indexOf("release_pack_publish_guard:")).toBeLessThan(result.stdout.indexOf("release_pack_publish:"));
    expect(result.stdout).not.toContain("release_pack_publish_blocked");
  });

  it("rejects hard-linked source package files instead of hiding them in the staging copy", async () => {
    const root = await createReleasePackFixture();
    const outside = path.join(path.dirname(root), "outside-readme.md");
    await writeFile(outside, "# Outside README\n", "utf8");
    await rm(path.join(root, "README.md"));
    await link(outside, path.join(root, "README.md"));
    const destination = await mkdtemp(path.join(tmpdir(), "prodex-release-pack-dest-"));

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
  const root = await mkdtemp(path.join(tmpdir(), "prodex-release-pack-"));
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
        bin: { demo: "demo-bin.js" },
        files: ["README.md", "LICENSE", "demo-bin.js", "dist/cli.js", "scripts/npm-command.mjs", "scripts/release-check.mjs"]
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(path.join(root, "README.md"), "# Demo\n", "utf8");
  await writeFile(path.join(root, "LICENSE"), "MIT License\n", "utf8");
  await writeFile(path.join(root, "demo-bin.js"), "#!/usr/bin/env node\nimport './dist/cli.js';\n", "utf8");
  await chmod(path.join(root, "demo-bin.js"), 0o755);
  await writeFile(path.join(root, "dist", "cli.js"), "console.log(JSON.stringify(process.argv.slice(2)));\n", "utf8");
  await chmod(path.join(root, "dist", "cli.js"), 0o644);
  await copyFile(path.join(repoRoot, "scripts", "npm-command.mjs"), path.join(root, "scripts", "npm-command.mjs"));
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
      env: normalizeNpmEnvironment({ ...process.env, ...options.env }),
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

function expectedShellQuote(value: string): string {
  const shellSafe = /^[A-Za-z0-9_./:@=-]+$/.test(value);
  if (shellSafe && (process.platform !== "win32" || !value.startsWith("@"))) return value;
  return process.platform === "win32"
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", "'\\''")}'`;
}

function envWithCurrentNodeOnPath(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "path")
  );
  env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`;
  return env;
}
