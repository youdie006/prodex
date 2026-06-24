#!/usr/bin/env node
import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const root = readFlag(args, "--root") ?? repoRoot;
const metadataOnly = args.includes("--metadata-only");
const verificationOnly = args.includes("--verification-only");

try {
  if (metadataOnly && verificationOnly) {
    throw new Error("release check flags failed: --metadata-only and --verification-only cannot be combined");
  }
  if (!verificationOnly) {
    await checkReleaseMetadata(root);
    console.log("release_metadata=ok");
  }
  if (!metadataOnly) {
    await runFullReleaseVerification(root);
    console.log("release_verification=ok");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function checkReleaseMetadata(rootDir) {
  const packageJsonPath = path.join(rootDir, "package.json");
  const packageJson = parseReleasePackageJson(await readRequiredPackageJson(packageJsonPath), packageJsonPath);
  if (packageJson.private === true) {
    throw new Error("release metadata failed: package.json private: true prevents npm publish");
  }
  if (typeof packageJson.license !== "string" || packageJson.license.trim() === "") {
    throw new Error("release metadata failed: package.json must include an explicit license before publishing");
  }
  if (packageJson.license === "UNLICENSED") {
    throw new Error('release metadata failed: license "UNLICENSED" is not publishable');
  }
  await assertRegularLicenseFile(rootDir);
}

function parseReleasePackageJson(raw, packageJsonPath) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`release metadata failed: package.json is not valid JSON at ${packageJsonPath}`);
  }
}

async function assertRegularLicenseFile(rootDir) {
  const licensePath = path.join(rootDir, "LICENSE");
  try {
    const stat = await lstat(licensePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("release metadata failed: LICENSE must be a regular file and must not be a symlink");
    }
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new Error("release metadata failed: publishable packages must include a LICENSE file");
    }
    throw error;
  }
}

async function readRequiredPackageJson(packageJsonPath) {
  try {
    return await readFile(packageJsonPath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new Error(`release metadata failed: package.json not found at ${packageJsonPath}`);
    }
    throw error;
  }
}

async function runFullReleaseVerification(rootDir) {
  const checks = [
    ["npm", ["test"]],
    ["npm", ["run", "typecheck"]],
    ["npm", ["run", "build"]],
    ["npm", ["run", "smoke:package"]],
    ["node", ["dist/cli.js", "doctor"]]
  ];
  for (const [command, commandArgs] of checks) {
    await run(commandForPlatform(command), commandArgs, rootDir);
  }
}

async function run(command, commandArgs, cwd) {
  console.log(`release_check: ${[command, ...commandArgs].join(" ")}`);
  await execFileAsync(command, commandArgs, {
    cwd,
    timeout: 180_000,
    maxBuffer: 20 * 1024 * 1024
  });
}

function commandForPlatform(command) {
  return process.platform === "win32" && command === "npm" ? "npm.cmd" : command;
}

function readFlag(values, flag) {
  const index = values.indexOf(flag);
  return index === -1 ? undefined : values[index + 1];
}

function isMissingFileError(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
