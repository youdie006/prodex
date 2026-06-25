import { execFile } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");

describe("release-check", () => {
  it("fails release metadata with a friendly message when package.json is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gptprouse-release-check-missing-"));

    const result = await runReleaseCheck(root);

    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.code).toBe(1);
    expect(output).toContain("release metadata failed");
    expect(output).toContain("package.json not found");
    expect(output).not.toContain("ENOENT");
  });

  it("rejects release-check --root without a value before inspecting metadata", async () => {
    const missingValue = await runReleaseCheckArgs(["--metadata-only", "--root"]);

    expect(missingValue.code).toBe(1);
    expect(`${missingValue.stdout}\n${missingValue.stderr}`).toContain("release check flags failed: --root requires a value");
    expect(`${missingValue.stdout}\n${missingValue.stderr}`).not.toContain("release metadata failed");
    expect(`${missingValue.stdout}\n${missingValue.stderr}`).not.toContain("at parseArgs");
    expect(`${missingValue.stdout}\n${missingValue.stderr}`).not.toContain("Node.js v");

    const optionValue = await runReleaseCheckArgs(["--root", "--metadata-only"]);

    expect(optionValue.code).toBe(1);
    expect(`${optionValue.stdout}\n${optionValue.stderr}`).toContain("release check flags failed: --root requires a value");
    expect(`${optionValue.stdout}\n${optionValue.stderr}`).not.toContain("release metadata failed");
    expect(`${optionValue.stdout}\n${optionValue.stderr}`).not.toContain("at parseArgs");
    expect(`${optionValue.stdout}\n${optionValue.stderr}`).not.toContain("Node.js v");
  });

  it("rejects unknown release-check options before inspecting metadata", async () => {
    const result = await runReleaseCheckArgs(["--metadata-only", "--bogus"]);

    expect(result.code).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain("release check flags failed: unknown option --bogus");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("release metadata failed");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("at parseArgs");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("Node.js v");
  });

  it("fails release metadata when package license is missing", async () => {
    const root = await copyPackageJsonToTemp();

    const result = await runReleaseCheck(root);

    expect(result.code).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/license/i);
  });

  it("fails release metadata when package name or version is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gptprouse-release-check-identity-"));
    await writeFile(path.join(root, "package.json"), `${JSON.stringify({ license: "MIT" }, null, 2)}\n`, "utf8");
    await writeFile(path.join(root, "LICENSE"), "MIT License\n", "utf8");

    const result = await runReleaseCheck(root);

    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.code).toBe(1);
    expect(output).toContain("release metadata failed");
    expect(output).toContain("package.json must include non-empty string name and version");
    expect(output).not.toContain("npm pack dry-run failed");
    expect(result.stdout).not.toContain("release_metadata=ok");
  });

  it("fails release metadata when package name or version is not publishable by npm", async () => {
    const invalidNameRoot = await mkdtemp(path.join(tmpdir(), "gptprouse-release-check-identity-"));
    await writeFile(path.join(invalidNameRoot, "package.json"), `${JSON.stringify({ name: "Bad Name", version: "1.0.0", license: "MIT" }, null, 2)}\n`, "utf8");
    await writeFile(path.join(invalidNameRoot, "LICENSE"), "MIT License\n", "utf8");

    const invalidNameResult = await runReleaseCheck(invalidNameRoot);

    const invalidNameOutput = `${invalidNameResult.stdout}\n${invalidNameResult.stderr}`;
    expect(invalidNameResult.code).toBe(1);
    expect(invalidNameOutput).toContain("release metadata failed");
    expect(invalidNameOutput).toContain("package.json name must be npm-publishable");
    expect(invalidNameOutput).not.toContain("npm pack dry-run failed");
    expect(invalidNameResult.stdout).not.toContain("release_metadata=ok");

    const reservedNameRoot = await mkdtemp(path.join(tmpdir(), "gptprouse-release-check-identity-"));
    await writeFile(
      path.join(reservedNameRoot, "package.json"),
      `${JSON.stringify({ name: "node_modules", version: "1.0.0", license: "MIT" }, null, 2)}\n`,
      "utf8"
    );
    await writeFile(path.join(reservedNameRoot, "LICENSE"), "MIT License\n", "utf8");

    const reservedNameResult = await runReleaseCheck(reservedNameRoot);

    const reservedNameOutput = `${reservedNameResult.stdout}\n${reservedNameResult.stderr}`;
    expect(reservedNameResult.code).toBe(1);
    expect(reservedNameOutput).toContain("release metadata failed");
    expect(reservedNameOutput).toContain("package.json name must be npm-publishable");
    expect(reservedNameOutput).not.toContain("npm pack dry-run failed");
    expect(reservedNameResult.stdout).not.toContain("release_metadata=ok");

    const invalidVersionRoot = await mkdtemp(path.join(tmpdir(), "gptprouse-release-check-identity-"));
    await writeFile(path.join(invalidVersionRoot, "package.json"), `${JSON.stringify({ name: "demo", version: "1.0", license: "MIT" }, null, 2)}\n`, "utf8");
    await writeFile(path.join(invalidVersionRoot, "LICENSE"), "MIT License\n", "utf8");

    const invalidVersionResult = await runReleaseCheck(invalidVersionRoot);

    const invalidVersionOutput = `${invalidVersionResult.stdout}\n${invalidVersionResult.stderr}`;
    expect(invalidVersionResult.code).toBe(1);
    expect(invalidVersionOutput).toContain("release metadata failed");
    expect(invalidVersionOutput).toContain("package.json version must be valid semver");
    expect(invalidVersionOutput).not.toContain("npm pack dry-run failed");
    expect(invalidVersionResult.stdout).not.toContain("release_metadata=ok");
  });

  it("fails release metadata with a friendly message when package.json is malformed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gptprouse-release-check-malformed-"));
    await writeFile(path.join(root, "package.json"), "{ broken json\n", "utf8");

    const result = await runReleaseCheck(root);

    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.code).toBe(1);
    expect(output).toContain("release metadata failed");
    expect(output).toContain("package.json is not valid JSON");
    expect(output).not.toContain("SyntaxError");
    expect(result.stdout).not.toContain("release_metadata=ok");
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

  it("fails release metadata when npm pack dry-run omits the file list", async () => {
    const root = await copyPackageJsonToTemp();
    const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    packageJson.license = "MIT";
    await writeFile(path.join(root, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
    await writeFile(path.join(root, "LICENSE"), "MIT License\n", "utf8");
    const fakeCommands = await createFakeReleaseCommands(root, {
      packStdout: JSON.stringify([{}])
    });

    const result = await runReleaseCheck(root, { pathPrefix: fakeCommands.binDir, logPath: fakeCommands.logPath });

    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.code).toBe(1);
    expect(output).toContain("release metadata failed");
    expect(output).toContain("npm pack dry-run did not return a file list");
    expect(output).not.toContain("release_metadata=ok");
    expect(output).not.toContain("TypeError");
  });

  it("fails release metadata when npm pack dry-run omits file mode metadata", async () => {
    const root = await copyPackageJsonToTemp();
    const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    packageJson.license = "MIT";
    await writeFile(path.join(root, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
    await writeFile(path.join(root, "LICENSE"), "MIT License\n", "utf8");
    const fakeCommands = await createFakeReleaseCommands(root, {
      packStdout: JSON.stringify([{ files: [{ path: "package.json" }, { path: "LICENSE" }] }])
    });

    const result = await runReleaseCheck(root, { pathPrefix: fakeCommands.binDir, logPath: fakeCommands.logPath });

    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.code).toBe(1);
    expect(output).toContain("release metadata failed");
    expect(output).toContain("npm pack dry-run file entry is missing mode metadata: package.json");
    expect(output).not.toContain("release_metadata=ok");
    expect(output).not.toContain("TypeError");
  });

  it("fails release metadata with a friendly message when npm pack dry-run exits silently", async () => {
    const root = await copyPackageJsonToTemp();
    const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    packageJson.license = "MIT";
    await writeFile(path.join(root, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
    await writeFile(path.join(root, "LICENSE"), "MIT License\n", "utf8");
    const npmCommand = expectedNpmCommand();
    const fakeCommands = await createFakeReleaseCommands(root, {
      failCommand: `${npmCommand}\tpack --json --dry-run --ignore-scripts`,
      silentFail: true
    });

    const result = await runReleaseCheck(root, { pathPrefix: fakeCommands.binDir, logPath: fakeCommands.logPath });

    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.code).toBe(1);
    expect(output).toContain("release metadata failed");
    expect(output).toContain("npm pack dry-run failed: exit code 42");
    expect(output).not.toContain("Command failed:");
    expect(output).not.toContain("pack --json --dry-run --ignore-scripts");
    expect(result.stdout).not.toContain("release_metadata=ok");
  });

  it("fails release metadata when packed non-bin files are executable", async () => {
    const root = await createPackModeFixture({
      packageJson: {
        name: "demo-pack-mode",
        version: "1.0.0",
        license: "MIT",
        files: ["README.md"]
      },
      executableReadme: true
    });

    const result = await runReleaseCheck(root);

    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.code).toBe(1);
    expect(output).toContain("release metadata failed");
    expect(output).toContain("packed files have unexpected executable modes");
    expect(output).toContain("README.md");
    expect(output).toContain("fix file modes or publish from a filesystem that preserves executable bits");
    expect(result.stdout).not.toContain("release_metadata=ok");
  });

  it("allows executable package bin files in release metadata pack checks", async () => {
    const root = await createPackModeFixture({
      packageJson: {
        name: "demo-pack-bin",
        version: "1.0.0",
        license: "MIT",
        bin: { demo: "cli.js" },
        files: ["cli.js", "README.md"]
      },
      executableBin: true
    });

    const result = await runReleaseCheck(root);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("release_metadata=ok");
  });

  it("fails release metadata when LICENSE is not a regular file", async () => {
    const root = await copyPackageJsonToTemp();
    const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    packageJson.license = "MIT";
    await writeFile(path.join(root, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
    await mkdir(path.join(root, "LICENSE"));

    const directoryResult = await runReleaseCheck(root);

    expect(directoryResult.code).toBe(1);
    expect(`${directoryResult.stdout}\n${directoryResult.stderr}`).toContain("LICENSE");
    expect(`${directoryResult.stdout}\n${directoryResult.stderr}`).toMatch(/regular file|symlink/i);
    expect(directoryResult.stdout).not.toContain("release_metadata=ok");

    const symlinkRoot = await copyPackageJsonToTemp();
    const symlinkPackageJson = JSON.parse(await readFile(path.join(symlinkRoot, "package.json"), "utf8"));
    symlinkPackageJson.license = "MIT";
    await writeFile(path.join(symlinkRoot, "package.json"), `${JSON.stringify(symlinkPackageJson, null, 2)}\n`, "utf8");
    await writeFile(path.join(symlinkRoot, "ACTUAL_LICENSE"), "MIT License\n", "utf8");
    await symlink(path.join(symlinkRoot, "ACTUAL_LICENSE"), path.join(symlinkRoot, "LICENSE"));

    const symlinkResult = await runReleaseCheck(symlinkRoot);

    expect(symlinkResult.code).toBe(1);
    expect(`${symlinkResult.stdout}\n${symlinkResult.stderr}`).toContain("LICENSE");
    expect(`${symlinkResult.stdout}\n${symlinkResult.stderr}`).toMatch(/regular file|symlink/i);
    expect(symlinkResult.stdout).not.toContain("release_metadata=ok");
  });

  it("fails release metadata when packed files are hard linked", async () => {
    const root = await copyPackageJsonToTemp();
    const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    packageJson.license = "MIT";
    await writeFile(path.join(root, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
    const outside = path.join(path.dirname(root), "outside-license.txt");
    await writeFile(outside, "MIT License from outside\n", "utf8");
    await link(outside, path.join(root, "LICENSE"));

    const result = await runReleaseCheck(root);

    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.code).toBe(1);
    expect(output).toContain("release metadata failed");
    expect(output).toContain("hard links");
    expect(output).toContain("LICENSE");
    expect(output).toContain("replace LICENSE with a non-hard-linked regular file");
    expect(result.stdout).not.toContain("release_metadata=ok");
  });

  it("fails release metadata when packed non-license files are hard linked", async () => {
    const root = await copyPackageJsonToTemp();
    const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    packageJson.license = "MIT";
    packageJson.files = ["README.md"];
    await writeFile(path.join(root, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
    await writeFile(path.join(root, "LICENSE"), "MIT License\n", "utf8");
    const outside = path.join(path.dirname(root), "outside-readme.md");
    await writeFile(outside, "# Outside README\n", "utf8");
    await link(outside, path.join(root, "README.md"));

    const result = await runReleaseCheck(root);

    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.code).toBe(1);
    expect(output).toContain("release metadata failed");
    expect(output).toContain("hard links");
    expect(output).toContain("README.md");
    expect(output).toContain("replace hard-linked packed files with independent files");
    expect(result.stdout).not.toContain("release_metadata=ok");
  });

  it("fails release metadata when packed non-license files are symlinks", async () => {
    const root = await copyPackageJsonToTemp();
    const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    packageJson.license = "MIT";
    packageJson.files = ["README.md"];
    await writeFile(path.join(root, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
    await writeFile(path.join(root, "LICENSE"), "MIT License\n", "utf8");
    const outside = path.join(path.dirname(root), "outside-readme.md");
    await writeFile(outside, "# Outside README\n", "utf8");
    await symlink(outside, path.join(root, "README.md"));
    const fakeCommands = await createFakeReleaseCommands(root, {
      packStdout: JSON.stringify([{ files: [{ path: "package.json", mode: 420 }, { path: "LICENSE", mode: 420 }, { path: "README.md", mode: 420 }] }])
    });

    const result = await runReleaseCheck(root, { pathPrefix: fakeCommands.binDir, logPath: fakeCommands.logPath });

    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.code).toBe(1);
    expect(output).toContain("release metadata failed");
    expect(output).toContain("packed files must be regular non-symlink files");
    expect(output).toContain("README.md");
    expect(result.stdout).not.toContain("release_metadata=ok");
  });

  it("fails release metadata when package is private even with a public license", async () => {
    const root = await copyPackageJsonToTemp();
    const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    packageJson.license = "MIT";
    packageJson.private = true;
    await writeFile(path.join(root, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
    await writeFile(path.join(root, "LICENSE"), "MIT License\n", "utf8");

    const result = await runReleaseCheck(root);

    expect(result.code).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/private/i);
    expect(result.stdout).not.toContain("release_metadata=ok");
  });

  it("fails release metadata when license is unlicensed", async () => {
    const root = await copyPackageJsonToTemp();
    const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    packageJson.license = "UNLICENSED";
    await writeFile(path.join(root, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");

    const result = await runReleaseCheck(root);

    expect(result.code).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain("UNLICENSED");
    expect(`${result.stdout}\n${result.stderr}`).toContain("not publishable");
    expect(result.stdout).not.toContain("release_metadata=ok");
  });

  it("runs the full release verification command sequence", async () => {
    const root = await copyPackageJsonToTemp();
    const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    packageJson.license = "MIT";
    await writeFile(path.join(root, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
    await writeFile(path.join(root, "LICENSE"), "MIT License\n", "utf8");
    const fakeCommands = await createFakeReleaseCommands(root);
    const npmCommand = expectedNpmCommand();

    const result = await runReleaseCheck(root, { metadataOnly: false, pathPrefix: fakeCommands.binDir, logPath: fakeCommands.logPath });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`release_check: ${npmCommand} test`);
    expect(result.stdout).toContain(`release_check: ${npmCommand} run typecheck`);
    expect(result.stdout).toContain(`release_check: ${npmCommand} run build`);
    expect(result.stdout).toContain(`release_check: ${npmCommand} run smoke:package`);
    expect(result.stdout).toContain("release_check: node dist/cli.js doctor");
    expect(result.stdout).toContain("release_verification=ok");
    await expect(readFile(fakeCommands.logPath, "utf8")).resolves.toBe(
      [
        `${npmCommand}\tpack --json --dry-run --ignore-scripts\t${root}`,
        `${npmCommand}\ttest\t${root}`,
        `${npmCommand}\trun typecheck\t${root}`,
        `${npmCommand}\trun build\t${root}`,
        `${npmCommand}\trun smoke:package\t${root}`,
        `node\tdist/cli.js doctor\t${root}`,
        ""
      ].join("\n")
    );
  });

  it("runs release verification without license metadata when explicitly requested", async () => {
    const root = await copyPackageJsonToTemp();
    const fakeCommands = await createFakeReleaseCommands(root);
    const npmCommand = expectedNpmCommand();

    const result = await runReleaseCheck(root, { verificationOnly: true, pathPrefix: fakeCommands.binDir, logPath: fakeCommands.logPath });

    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("release_metadata=ok");
    expect(result.stdout).toContain(`release_check: ${npmCommand} test`);
    expect(result.stdout).toContain("release_verification=ok");
    await expect(readFile(fakeCommands.logPath, "utf8")).resolves.toBe(
      [
        `${npmCommand}\ttest\t${root}`,
        `${npmCommand}\trun typecheck\t${root}`,
        `${npmCommand}\trun build\t${root}`,
        `${npmCommand}\trun smoke:package\t${root}`,
        `node\tdist/cli.js doctor\t${root}`,
        ""
      ].join("\n")
    );
  });

  it("stops the full release verification sequence when a child check fails", async () => {
    const root = await copyPackageJsonToTemp();
    const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    packageJson.license = "MIT";
    await writeFile(path.join(root, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
    await writeFile(path.join(root, "LICENSE"), "MIT License\n", "utf8");
    const npmCommand = expectedNpmCommand();
    const fakeCommands = await createFakeReleaseCommands(root, { failCommand: `${npmCommand}\trun typecheck` });

    const result = await runReleaseCheck(root, { metadataOnly: false, pathPrefix: fakeCommands.binDir, logPath: fakeCommands.logPath });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain(`release_check: ${npmCommand} test`);
    expect(result.stdout).toContain(`release_check: ${npmCommand} run typecheck`);
    expect(result.stdout).not.toContain(`release_check: ${npmCommand} run build`);
    expect(result.stderr).toContain(`release verification failed: ${npmCommand} run typecheck: fake release-check command failed`);
    expect(result.stderr).not.toContain("Command failed:");
    expect(result.stderr).not.toContain("Node.js v");
    await expect(readFile(fakeCommands.logPath, "utf8")).resolves.toBe(
      [`${npmCommand}\tpack --json --dry-run --ignore-scripts\t${root}`, `${npmCommand}\ttest\t${root}`, `${npmCommand}\trun typecheck\t${root}`, ""].join("\n")
    );
  });

  it("reports silent release verification child failures without raw execFile output", async () => {
    const root = await copyPackageJsonToTemp();
    const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    packageJson.license = "MIT";
    await writeFile(path.join(root, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
    await writeFile(path.join(root, "LICENSE"), "MIT License\n", "utf8");
    const npmCommand = expectedNpmCommand();
    const fakeCommands = await createFakeReleaseCommands(root, {
      failCommand: `${npmCommand}\trun typecheck`,
      silentFail: true
    });

    const result = await runReleaseCheck(root, { metadataOnly: false, pathPrefix: fakeCommands.binDir, logPath: fakeCommands.logPath });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain(`release_check: ${npmCommand} run typecheck`);
    expect(result.stdout).not.toContain(`release_check: ${npmCommand} run build`);
    expect(result.stderr).toContain(`release verification failed: ${npmCommand} run typecheck: exit code 42`);
    expect(result.stderr).not.toContain("Command failed:");
    expect(result.stderr).not.toContain("Node.js v");
  });
});

async function copyPackageJsonToTemp(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gptprouse-release-check-"));
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "package.json"), await readFile(path.join(repoRoot, "package.json"), "utf8"), "utf8");
  return root;
}

async function createPackModeFixture(options: {
  packageJson: Record<string, unknown>;
  executableReadme?: boolean;
  executableBin?: boolean;
}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gptprouse-release-check-pack-mode-"));
  await writeFile(path.join(root, "package.json"), `${JSON.stringify(options.packageJson, null, 2)}\n`, "utf8");
  await writeFile(path.join(root, "LICENSE"), "MIT License\n", "utf8");
  await writeFile(path.join(root, "README.md"), "# Demo\n", "utf8");
  await chmod(path.join(root, "README.md"), options.executableReadme ? 0o755 : 0o644);
  if (options.packageJson.bin) {
    await writeFile(path.join(root, "cli.js"), "#!/usr/bin/env node\nconsole.log('demo')\n", "utf8");
    await chmod(path.join(root, "cli.js"), options.executableBin ? 0o755 : 0o644);
  }
  return root;
}

function expectedNpmCommand(): "npm" | "npm.cmd" {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

async function createFakeReleaseCommands(
  root: string,
  options: { failCommand?: string; packStdout?: string; silentFail?: boolean } = {}
): Promise<{ binDir: string; logPath: string }> {
  const binDir = path.join(root, "fake-bin");
  const logPath = path.join(root, "release-check-commands.log");
  await mkdir(binDir, { recursive: true });
  await mkdir(path.join(root, "dist"), { recursive: true });
  await writeFile(path.join(root, "dist", "cli.js"), "#!/usr/bin/env node\nconsole.log('doctor')\n", "utf8");
  await Promise.all([
    writeFakeCommand(path.join(binDir, "npm"), "npm", logPath, options.failCommand, options.packStdout, options.silentFail),
    writeFakeCommand(path.join(binDir, "npm.cmd.mjs"), "npm.cmd", logPath, options.failCommand, options.packStdout, options.silentFail),
    writeFakeCommand(path.join(binDir, "node"), "node", logPath, options.failCommand, undefined, options.silentFail),
    writeFakeCommand(path.join(binDir, "node.cmd.mjs"), "node", logPath, options.failCommand, undefined, options.silentFail),
    writeWindowsCommandWrapper(path.join(binDir, "npm.cmd"), "npm.cmd.mjs"),
    writeWindowsCommandWrapper(path.join(binDir, "node.cmd"), "node.cmd.mjs")
  ]);
  return { binDir, logPath };
}

async function writeFakeCommand(filePath: string, command: string, logPath: string, failCommand?: string, packStdout?: string, silentFail = false): Promise<void> {
  await writeFile(
    filePath,
    [
      `#!${process.execPath}`,
      'import { appendFileSync } from "node:fs";',
      `const commandLine = ${JSON.stringify(`${command}\t`)} + process.argv.slice(2).join(" ");`,
      `appendFileSync(${JSON.stringify(logPath)}, commandLine + "\\t" + process.cwd() + "\\n");`,
      `if (commandLine === ${JSON.stringify(failCommand ?? "")}) {`,
      ...(silentFail ? [] : [`  console.error("fake release-check command failed: " + commandLine);`]),
      "  process.exit(42);",
      "}",
      `if (${JSON.stringify(command === "npm" || command === "npm.cmd")} && process.argv[2] === "pack") {`,
      `  console.log(${JSON.stringify(packStdout ?? JSON.stringify([{ files: [{ path: "package.json", mode: 420 }, { path: "LICENSE", mode: 420 }, { path: "dist/cli.js", mode: 493 }] }]))});`,
      "}"
    ].join("\n"),
    "utf8"
  );
  await chmod(filePath, 0o755);
}

async function writeWindowsCommandWrapper(filePath: string, moduleFileName: string): Promise<void> {
  await writeFile(filePath, `@echo off\r\n"${process.execPath}" "%~dp0${moduleFileName}" %*\r\n`, "utf8");
}

async function runReleaseCheck(
  root: string,
  options: { metadataOnly?: boolean; verificationOnly?: boolean; pathPrefix?: string; logPath?: string } = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  const args = [path.join(repoRoot, "scripts", "release-check.mjs")];
  if (options.verificationOnly) args.push("--verification-only");
  if (!options.verificationOnly && (options.metadataOnly ?? true)) args.push("--metadata-only");
  args.push("--root", root);
  const env = {
    ...process.env,
    ...(options.pathPrefix ? { PATH: `${options.pathPrefix}${path.delimiter}${process.env.PATH ?? ""}` } : {}),
    ...(options.logPath ? { GPTPROUSE_RELEASE_CHECK_LOG: options.logPath } : {})
  };
  try {
    const result = await execFileAsync(process.execPath, args, {
      cwd: repoRoot,
      env
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

async function runReleaseCheckArgs(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(process.execPath, [path.join(repoRoot, "scripts", "release-check.mjs"), ...args], {
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
