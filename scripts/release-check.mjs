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
  const license = packageJson.license.trim();
  if (license === "UNLICENSED") {
    throw new Error('release metadata failed: license "UNLICENSED" is not publishable');
  }
  if (license !== "MIT") {
    throw new Error("release metadata failed: package.json license must be MIT before publishing");
  }
  await assertRegularLicenseFile(rootDir, license);
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

async function assertRegularLicenseFile(rootDir, expectedLicense) {
  const licensePath = path.join(rootDir, "LICENSE");
  try {
    const stat = await lstat(licensePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("release metadata failed: LICENSE must be a regular file and must not be a symlink");
    }
    if (stat.nlink > 1) {
      throw new Error("release metadata failed: LICENSE must not have hard links. replace LICENSE with a non-hard-linked regular file, then rerun release:check.");
    }
    const raw = await readFile(licensePath, "utf8");
    if (expectedLicense === "MIT" && !isMitLicenseText(raw)) {
      throw new Error("release metadata failed: LICENSE content must match package.json license MIT");
    }
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new Error("release metadata failed: publishable packages must include a LICENSE file");
    }
    throw error;
  }
}

function isMitLicenseText(raw) {
  return /\bMIT License\b/.test(raw);
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
  const nonRegular = await findNonRegularPackedFiles(rootDir, packedFiles);
  if (nonRegular.length > 0) {
    throw new Error(
      `release metadata failed: packed files must be regular non-symlink files: ${formatPathList(nonRegular)}. ` +
        "replace them with regular files, then rerun release:check."
    );
  }
  const nonExecutableSourceBins = await findNonExecutableBinSourceFiles(rootDir, packageJson);
  if (nonExecutableSourceBins.length > 0) {
    throw new Error(
      `release metadata failed: package bin entries must be executable: ${formatPathList(nonExecutableSourceBins)}. ` +
        "restore executable mode on package bin files, then rerun release:check."
    );
  }
  const invalid = findExecutableNonBinPackedFiles(packedFiles, packageJson);
  if (invalid.length > 0) {
    throw new Error(
      `release metadata failed: packed files have unexpected executable modes outside package bin entries: ${formatPathList(invalid)}. ` +
        "fix file modes or publish from a filesystem that preserves executable bits, then rerun release:check."
    );
  }
  const nonExecutablePackedBins = findNonExecutableBinPackedFiles(packedFiles, packageJson);
  if (nonExecutablePackedBins.length > 0) {
    throw new Error(
      `release metadata failed: package bin entries must be executable: ${formatPathList(nonExecutablePackedBins)}. ` +
        "restore executable mode on package bin files, then rerun release:check."
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
    throw new Error(`release metadata failed: npm pack dry-run failed: ${commandFailureDetail(error)}`);
  }
  try {
    const entries = JSON.parse(stdout);
    // npm <=11 prints an array; npm 12 prints an object keyed by package name.
    const firstEntry = Array.isArray(entries) ? entries[0] : Object.values(entries ?? {})[0];
    const files = firstEntry?.files;
    if (!Array.isArray(files)) {
      throw new Error("release metadata failed: npm pack dry-run did not return a file list");
    }
    for (const file of files) {
      if (typeof file?.path !== "string" || file.path.trim() === "") {
        throw new Error("release metadata failed: npm pack dry-run file entry is missing a path");
      }
      if (typeof file.mode !== "number") {
        throw new Error(`release metadata failed: npm pack dry-run file entry is missing mode metadata: ${normalizePackagePath(file.path)}`);
      }
    }
    return files;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("release metadata failed:")) {
      throw error;
    }
    throw new Error("release metadata failed: npm pack dry-run did not return valid JSON");
  }
}

async function findNonRegularPackedFiles(rootDir, files) {
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
      if (stat.isSymbolicLink() || !stat.isFile()) invalid.push(packagePath);
    } catch (error) {
      if (isMissingFileError(error)) invalid.push(packagePath);
      else throw error;
    }
  }
  return invalid;
}

function findExecutableNonBinPackedFiles(files, packageJson) {
  const binPaths = packageBinPaths(packageJson);
  return files
    .filter((file) => typeof file?.path === "string" && typeof file?.mode === "number")
    .filter((file) => (file.mode & 0o111) !== 0)
    .map((file) => normalizePackagePath(file.path))
    .filter((filePath) => !binPaths.has(filePath));
}

function findNonExecutableBinPackedFiles(files, packageJson) {
  const filesByPath = new Map(
    files
      .filter((file) => typeof file?.path === "string")
      .map((file) => [normalizePackagePath(file.path), file])
  );
  return [...packageBinPaths(packageJson)].filter((filePath) => {
    const file = filesByPath.get(filePath);
    return !file || typeof file.mode !== "number" || (file.mode & 0o111) === 0;
  });
}

async function findNonExecutableBinSourceFiles(rootDir, packageJson) {
  const invalid = [];
  for (const packagePath of packageBinPaths(packageJson)) {
    const filePath = path.join(rootDir, packagePath);
    const relative = path.relative(rootDir, filePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      invalid.push(packagePath);
      continue;
    }
    try {
      const stat = await lstat(filePath);
      if ((stat.mode & 0o111) === 0) invalid.push(packagePath);
    } catch (error) {
      if (isMissingFileError(error)) invalid.push(packagePath);
      else throw error;
    }
  }
  return invalid;
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
  const commandLine = [command, ...commandArgs].join(" ");
  console.log(`release_check: ${commandLine}`);
  try {
    await execFileAsync(command, commandArgs, {
      cwd,
      timeout: 180_000,
      maxBuffer: 20 * 1024 * 1024
    });
  } catch (error) {
    // Surface the real failure: the one-line detail used to show the FIRST
    // stderr line, which npm noise ("npm warn ...") could occupy while the
    // actual test failure sat in stdout and was silently dropped.
    printCapturedOutputTail(error, commandLine);
    throw new Error(`release verification failed: ${commandLine}: ${commandFailureDetail(error)}`);
  }
}

function printCapturedOutputTail(error, commandLine) {
  const failed = error && typeof error === "object" ? error : {};
  for (const [label, value] of [
    ["stdout", failed.stdout],
    ["stderr", failed.stderr]
  ]) {
    if (typeof value !== "string" || value.trim().length === 0) continue;
    const tail = value.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(-40);
    console.error(`release_check: ${commandLine} ${label} tail:`);
    for (const line of tail) console.error(`  ${line}`);
  }
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
      throw new Error(`release check flags failed: ${unknownOptionMessage(arg, ["--root", "--metadata-only", "--verification-only"])}`);
    }
    throw new Error(`release check flags failed: unexpected argument ${arg}`);
  }
  return parsed;
}

function unknownOptionMessage(option, candidates) {
  const suggestion = closestFlagSuggestion(option, candidates);
  return `unknown option ${option}${suggestion ? `. Did you mean \`${suggestion}\`?` : ""}`;
}

function closestFlagSuggestion(option, candidates) {
  let best;
  for (const candidate of candidates) {
    const distance = editDistance(option, candidate);
    const prefixMatch = candidate.startsWith(option);
    if (!best || prefixMatch || distance < best.distance) {
      best = { candidate, distance, prefixMatch };
    }
  }
  return best && (best.prefixMatch || best.distance <= 2) ? best.candidate : undefined;
}

function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = Array.from({ length: right.length + 1 }, () => 0);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        previous[rightIndex - 1] + substitutionCost
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

function isMissingFileError(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function commandFailureDetail(error) {
  const failed = error && typeof error === "object" ? error : {};
  const stderr = firstOutputLine(failed.stderr);
  if (stderr) return stderr;
  const stdout = firstOutputLine(failed.stdout);
  if (stdout) return stdout;
  if (typeof failed.code === "number") return `exit code ${failed.code}`;
  if (typeof failed.signal === "string" && failed.signal) return `signal ${failed.signal}`;
  return "failed without output";
}

function firstOutputLine(value) {
  if (typeof value !== "string") return undefined;
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    // npm chatter is never the failure - skip it so the one-line summary shows
    // the real error instead of "npm warn Unknown user config ...".
    .find((line) => Boolean(line) && !/^npm (warn|notice)\b/i.test(line));
}
