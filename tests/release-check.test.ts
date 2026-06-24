import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
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
    expect(result.stderr).toContain("fake release-check command failed");
    await expect(readFile(fakeCommands.logPath, "utf8")).resolves.toBe(
      [`${npmCommand}\ttest\t${root}`, `${npmCommand}\trun typecheck\t${root}`, ""].join("\n")
    );
  });
});

async function copyPackageJsonToTemp(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gptprouse-release-check-"));
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "package.json"), await readFile(path.join(repoRoot, "package.json"), "utf8"), "utf8");
  return root;
}

function expectedNpmCommand(): "npm" | "npm.cmd" {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

async function createFakeReleaseCommands(
  root: string,
  options: { failCommand?: string } = {}
): Promise<{ binDir: string; logPath: string }> {
  const binDir = path.join(root, "fake-bin");
  const logPath = path.join(root, "release-check-commands.log");
  await mkdir(binDir, { recursive: true });
  await Promise.all([
    writeFakeCommand(path.join(binDir, "npm"), "npm", logPath, options.failCommand),
    writeFakeCommand(path.join(binDir, "npm.cmd.mjs"), "npm.cmd", logPath, options.failCommand),
    writeFakeCommand(path.join(binDir, "node"), "node", logPath, options.failCommand),
    writeFakeCommand(path.join(binDir, "node.cmd.mjs"), "node", logPath, options.failCommand),
    writeWindowsCommandWrapper(path.join(binDir, "npm.cmd"), "npm.cmd.mjs"),
    writeWindowsCommandWrapper(path.join(binDir, "node.cmd"), "node.cmd.mjs")
  ]);
  return { binDir, logPath };
}

async function writeFakeCommand(filePath: string, command: string, logPath: string, failCommand?: string): Promise<void> {
  await writeFile(
    filePath,
    [
      `#!${process.execPath}`,
      'import { appendFileSync } from "node:fs";',
      `const commandLine = ${JSON.stringify(`${command}\t`)} + process.argv.slice(2).join(" ");`,
      `appendFileSync(${JSON.stringify(logPath)}, commandLine + "\\t" + process.cwd() + "\\n");`,
      `if (commandLine === ${JSON.stringify(failCommand ?? "")}) {`,
      `  console.error("fake release-check command failed: " + commandLine);`,
      "  process.exit(42);",
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
