#!/usr/bin/env node
import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESERVED_PACKAGE_NAMES = new Set(["node_modules", "favicon.ico"]);

try {
  const args = parseArgs(process.argv.slice(2));
  const root = args.root ?? repoRoot;
  const metadataOnly = args.metadataOnly;
  const verificationOnly = args.verificationOnly;
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
  const identityError = packageIdentityError(packageJson);
  if (identityError) throw new Error(`release metadata failed: ${identityError}`);
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
  await assertPackedFileModes(rootDir, packageJson);
}

function parseReleasePackageJson(raw, packageJsonPath) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`release metadata failed: package.json is not valid JSON at ${packageJsonPath}`);
  }
}

function packageIdentityError(packageJson) {
  if (!isNonEmptyString(packageJson?.name) || !isNonEmptyString(packageJson?.version)) {
    return "package.json must include non-empty string name and version";
  }
  if (!isNpmPublishablePackageName(packageJson.name)) {
    return "package.json name must be npm-publishable";
  }
  if (!isValidSemverVersion(packageJson.version)) {
    return "package.json version must be valid semver";
  }
  return undefined;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isNpmPublishablePackageName(value) {
  if (!isNonEmptyString(value) || value.length > 214 || value !== value.toLowerCase()) return false;
  if (RESERVED_PACKAGE_NAMES.has(value)) return false;
  if (value.startsWith("@")) {
    const parts = value.slice(1).split("/");
    return parts.length === 2 && parts.every(isPackageNameSegment);
  }
  return !value.includes("/") && isPackageNameSegment(value);
}

function isPackageNameSegment(value) {
  return /^(?![._])[a-z0-9][a-z0-9._~-]*$/.test(value);
}

function isValidSemverVersion(value) {
  if (!isNonEmptyString(value)) return false;
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value);
}

async function assertRegularLicenseFile(rootDir) {
  const licensePath = path.join(rootDir, "LICENSE");
  try {
    const stat = await lstat(licensePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("release metadata failed: LICENSE must be a regular file and must not be a symlink");
    }
    if (stat.nlink > 1) {
      throw new Error("release metadata failed: LICENSE must not have hard links. replace LICENSE with a non-hard-linked regular file, then rerun release:check.");
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

async function assertPackedFileModes(rootDir, packageJson) {
  const packedFiles = await readPackedFiles(rootDir);
  const invalid = findExecutableNonBinPackedFiles(packedFiles, packageJson);
  if (invalid.length > 0) {
    throw new Error(
      `release metadata failed: packed files have unexpected executable modes outside package bin entries: ${formatPathList(invalid)}. ` +
        "fix file modes or publish from a filesystem that preserves executable bits, then rerun release:check."
    );
  }
  const hardLinked = await findHardLinkedPackedFiles(rootDir, packedFiles);
  if (hardLinked.length > 0) {
    throw new Error(
      `release metadata failed: packed files must not have hard links: ${formatPathList(hardLinked)}. ` +
        "replace hard-linked packed files with independent files, then rerun release:check."
    );
  }
}

async function readPackedFiles(rootDir) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(commandForPlatform("npm"), ["pack", "--json", "--dry-run", "--ignore-scripts"], {
      cwd: rootDir,
      timeout: 120_000,
      maxBuffer: 20 * 1024 * 1024
    }));
  } catch (error) {
    const failed = error;
    const detail = typeof failed?.stderr === "string" && failed.stderr.trim() ? failed.stderr.trim().split(/\r?\n/)[0] : failed?.message ?? String(error);
    throw new Error(`release metadata failed: npm pack dry-run failed: ${detail}`);
  }
  try {
    const entries = JSON.parse(stdout);
    const files = entries?.[0]?.files;
    return Array.isArray(files) ? files : [];
  } catch {
    throw new Error("release metadata failed: npm pack dry-run did not return valid JSON");
  }
}

function findExecutableNonBinPackedFiles(files, packageJson) {
  const binPaths = packageBinPaths(packageJson);
  return files
    .filter((file) => typeof file?.path === "string" && typeof file?.mode === "number")
    .filter((file) => (file.mode & 0o111) !== 0)
    .map((file) => normalizePackagePath(file.path))
    .filter((filePath) => !binPaths.has(filePath));
}

async function findHardLinkedPackedFiles(rootDir, files) {
  const invalid = [];
  for (const file of files) {
    if (typeof file?.path !== "string") continue;
    const packagePath = normalizePackagePath(file.path);
    const filePath = path.join(rootDir, packagePath);
    const relative = path.relative(rootDir, filePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      invalid.push(packagePath);
      continue;
    }
    try {
      const stat = await lstat(filePath);
      if (stat.nlink > 1) invalid.push(packagePath);
    } catch (error) {
      if (isMissingFileError(error)) invalid.push(packagePath);
      else throw error;
    }
  }
  return invalid;
}

function packageBinPaths(packageJson) {
  const paths = new Set();
  const bin = packageJson?.bin;
  if (typeof bin === "string") {
    paths.add(normalizePackagePath(bin));
  } else if (bin && typeof bin === "object") {
    for (const value of Object.values(bin)) {
      if (typeof value === "string") paths.add(normalizePackagePath(value));
    }
  }
  return paths;
}

function normalizePackagePath(value) {
  return value.replaceAll("\\", "/").replace(/^\.\/+/, "");
}

function formatPathList(paths) {
  const shown = paths.slice(0, 8).join(", ");
  return paths.length > 8 ? `${shown}, ... (${paths.length} files)` : shown;
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

function parseArgs(values) {
  const parsed = {
    root: undefined,
    metadataOnly: false,
    verificationOnly: false
  };
  for (let index = 0; index < values.length; index += 1) {
    const arg = values[index];
    if (arg === "--metadata-only") {
      parsed.metadataOnly = true;
      continue;
    }
    if (arg === "--verification-only") {
      parsed.verificationOnly = true;
      continue;
    }
    if (arg === "--root") {
      const value = values[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("release check flags failed: --root requires a value");
      }
      parsed.root = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`release check flags failed: unknown option ${arg}`);
    }
    throw new Error(`release check flags failed: unexpected argument ${arg}`);
  }
  return parsed;
}

function isMissingFileError(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
