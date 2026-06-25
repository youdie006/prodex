#!/usr/bin/env node
import { execFile } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(formatHelp());
    process.exit(0);
  }
  await releasePack(args);
} catch (error) {
  console.error(`release pack failed: ${errorMessage(error)}`);
  process.exitCode = 1;
}

async function releasePack(args) {
  const root = path.resolve(args.root ?? repoRoot);
  const destination = path.resolve(args.packDestination ?? root);

  const packageJson = await readPackageJson(root);
  const binPaths = packageBinPaths(packageJson.bin);
  const files = await readPackedFiles(root);
  const staging = await mkdtemp(path.join(tmpdir(), "gptprouse-release-pack-"));
  let packedTarball;
  try {
    await copyPackedFilesToStaging(root, staging, files, binPaths);
    assertPackedReleaseCheck(files);
    await runReleaseMetadataCheck(staging);
    await mkdir(destination, { recursive: true });
    const { stdout } = await runNpmPack(["pack", "--json", "--ignore-scripts", "--pack-destination", destination], staging, "npm pack");
    packedTarball = resolvePackedTarball(destination, stdout);
    await assertPackedTarballCreated(packedTarball);
  } finally {
    if (!args.keepWorkdir) {
      await rm(staging, { recursive: true, force: true });
    }
  }

  console.log(`release_pack=ok tarball=${packedTarball} file_modes=ok staging=${args.keepWorkdir ? staging : "removed"}`);
  console.log("release_pack_next: run `npm run release:verify` and `gptprouse release status` before publishing this tarball.");
  const gitStatus = await readReleaseGitStatus(root);
  console.log(`release_pack_${gitStatus.line}`);
  if (gitStatus.next) console.log(`release_pack_git_next: ${gitStatus.next}`);
  console.log(`release_pack_verify: npm publish --dry-run ${shellQuote(packedTarball)}`);
  if (isReleaseGitReady(gitStatus)) {
    console.log(`release_pack_publish: npm publish ${shellQuote(packedTarball)}`);
  } else {
    console.log("release_pack_publish_blocked: fix git readiness before npm publish; run `gptprouse release status`, then rerun release pack after blockers are clear.");
  }
}

function isReleaseGitReady(gitStatus) {
  return gitStatus.line.startsWith("git: ok ");
}

function assertPackedReleaseCheck(files) {
  const hasReleaseCheck = files.some((file) => normalizePackagePath(file.path) === "scripts/release-check.mjs");
  if (!hasReleaseCheck) {
    throw new Error("packed files must include scripts/release-check.mjs for release metadata validation");
  }
}

async function copyPackedFilesToStaging(root, staging, files, binPaths) {
  for (const file of files) {
    const packagePath = normalizePackagePath(file.path);
    const source = path.join(root, packagePath);
    const sourceRelative = path.relative(root, source);
    if (sourceRelative.startsWith("..") || path.isAbsolute(sourceRelative)) {
      throw new Error(`packed file path escapes package root: ${packagePath}`);
    }
    let sourceStat;
    try {
      sourceStat = await lstat(source);
    } catch (error) {
      if (isMissingFileError(error)) {
        throw new Error(`packed file listed by npm was not found: ${packagePath}`);
      }
      throw error;
    }
    if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
      throw new Error(`packed file must be a regular non-symlink file: ${packagePath}`);
    }
    if (sourceStat.nlink > 1) {
      throw new Error(`packed files must not have hard links: ${packagePath}`);
    }
    const target = path.join(staging, packagePath);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
    await chmod(target, binPaths.has(packagePath) ? 0o755 : 0o644);
  }
}

async function readPackedFiles(root) {
  const { stdout } = await runNpmPack(["pack", "--json", "--dry-run", "--ignore-scripts"], root, "npm pack dry-run");
  let entries;
  try {
    entries = JSON.parse(stdout);
  } catch {
    throw new Error("npm pack dry-run did not return valid JSON");
  }
  const files = entries?.[0]?.files;
  if (!Array.isArray(files)) {
    throw new Error("npm pack dry-run did not return a file list");
  }
  for (const file of files) {
    if (typeof file?.path !== "string" || file.path.trim() === "") {
      throw new Error("npm pack dry-run file entry is missing a path");
    }
  }
  return files;
}

async function readPackageJson(root) {
  const packageJsonPath = path.join(root, "package.json");
  let raw;
  try {
    raw = await readFile(packageJsonPath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new Error(`release metadata failed: package.json not found at ${packageJsonPath}`);
    }
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`release metadata failed: package.json is not valid JSON at ${packageJsonPath}`);
  }
}

function resolvePackedTarball(destination, stdout) {
  let entries;
  try {
    entries = JSON.parse(stdout);
  } catch {
    throw new Error("npm pack did not return valid JSON");
  }
  const filename = entries?.[0]?.filename;
  if (typeof filename !== "string" || !filename.endsWith(".tgz")) {
    throw new Error(`could not determine npm pack tarball from output: ${stdout}`);
  }
  const resolvedDestination = path.resolve(destination);
  const tarballPath = path.isAbsolute(filename) ? path.resolve(filename) : path.resolve(resolvedDestination, filename);
  const relative = path.relative(resolvedDestination, tarballPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`npm pack reported tarball outside pack destination: ${filename}`);
  }
  return tarballPath;
}

async function assertPackedTarballCreated(packedTarball) {
  let tarballStat;
  try {
    tarballStat = await lstat(packedTarball);
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new Error(`npm pack did not create expected tarball: ${packedTarball}`);
    }
    throw error;
  }
  if (tarballStat.isSymbolicLink() || !tarballStat.isFile()) {
    throw new Error(`npm pack did not create a regular tarball file: ${packedTarball}`);
  }
}

async function run(command, commandArgs, cwd) {
  return execFileAsync(command, commandArgs, {
    cwd,
    timeout: 120_000,
    maxBuffer: 20 * 1024 * 1024
  });
}

async function runNpmPack(commandArgs, cwd, label) {
  try {
    return await run(npmCommand, commandArgs, cwd);
  } catch (error) {
    throw new Error(`${label} failed: ${commandFailureDetail(error)}`);
  }
}

async function runReleaseMetadataCheck(staging) {
  try {
    await run(process.execPath, [path.join(staging, "scripts", "release-check.mjs"), "--metadata-only", "--root", staging], staging);
  } catch (error) {
    throw new Error(commandFailureDetail(error));
  }
}

function packageBinPaths(bin) {
  const paths = new Set();
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

function parseArgs(values) {
  const parsed = {
    root: undefined,
    packDestination: undefined,
    keepWorkdir: false,
    help: false
  };
  for (let index = 0; index < values.length; index += 1) {
    const arg = values[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--root") {
      const value = values[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("release pack flags failed: --root requires a value");
      }
      parsed.root = value;
      index += 1;
      continue;
    }
    if (arg === "--pack-destination") {
      const value = values[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("release pack flags failed: --pack-destination requires a value");
      }
      parsed.packDestination = value;
      index += 1;
      continue;
    }
    if (arg === "--keep-workdir") {
      parsed.keepWorkdir = true;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`release pack flags failed: unknown option ${arg}`);
    }
    throw new Error(`release pack flags failed: unexpected argument ${arg}`);
  }
  if (!parsed.help && !parsed.packDestination) {
    throw new Error("release pack flags failed: --pack-destination is required");
  }
  return parsed;
}

function formatHelp() {
  return `Usage: npm run release:pack -- --pack-destination <dir> [options]

Create a publish tarball from a temporary staging directory with normalized package file modes.

Options:
  --pack-destination <dir>  Directory where the .tgz tarball is written
  --root <dir>              Package root to pack (default: current gptprouse checkout)
  --keep-workdir            Keep the temporary staging directory for inspection
  --help, -h                Show this help text
`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function shellQuote(value) {
  return /^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

async function readReleaseGitStatus(root) {
  try {
    const insideWorkTree = (await gitStdout(root, ["rev-parse", "--is-inside-work-tree"])).trim();
    if (insideWorkTree !== "true") {
      return {
        line: "git: blocked not a git worktree",
        next: "initialize a git repo and commit the release state before public release"
      };
    }
  } catch {
    return {
      line: "git: blocked not a git worktree",
      next: "initialize a git repo and commit the release state before public release"
    };
  }

  const [branch, commit, statusOutput, branchStatusOutput, remoteOutput, upstream] = await Promise.all([
    gitStdout(root, ["rev-parse", "--abbrev-ref", "HEAD"]).then((value) => value.trim() || "unknown", () => "unknown"),
    gitStdout(root, ["rev-parse", "--short", "HEAD"]).then((value) => value.trim() || "unknown", () => "unknown"),
    gitStdout(root, ["status", "--porcelain"]).then((value) => value.trim(), () => ""),
    gitStdout(root, ["status", "--porcelain=v1", "--branch"]).then((value) => value.trim(), () => ""),
    gitStdout(root, ["remote"]).then((value) => value.trim(), () => ""),
    gitStdout(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).then(
      (value) => value.trim(),
      () => ""
    )
  ]);
  const dirtyCount = statusOutput ? statusOutput.split(/\r?\n/).filter(Boolean).length : 0;
  const remotes = remoteOutput ? remoteOutput.split(/\r?\n/).map((remote) => remote.trim()).filter(Boolean) : [];
  const remoteText = remotes.length > 0 ? remotes.join(",") : "none";
  const gitContext = `branch=${branch} commit=${commit}`;

  if (dirtyCount > 0) {
    return {
      line: `git: blocked worktree has uncommitted changes files=${dirtyCount} ${gitContext} remote=${remoteText}`,
      next: "commit or stash local changes before release"
    };
  }

  if (branch === "HEAD") {
    return {
      line: `git: blocked detached HEAD commit=${commit} remote=${remoteText}`,
      next: "check out a release branch before public release"
    };
  }

  if (remotes.length === 0) {
    return {
      line: `git: blocked no remote configured ${gitContext}`,
      next: `add a remote, then push with upstream tracking: git remote add origin <git-url>; ${formatGitPushUpstreamCommand(branch)}`
    };
  }

  if (!upstream) {
    return {
      line: `git: blocked no upstream configured ${gitContext} remote=${remoteText}`,
      next: `push the branch with upstream tracking: ${formatGitPushUpstreamCommand(branch)}`
    };
  }

  const relation = parseGitBranchRelation(branchStatusOutput);
  if (relation.gone) {
    return {
      line: `git: blocked upstream is gone ${gitContext} remote=${remoteText} upstream=${upstream}`,
      next: "restore upstream tracking before public release"
    };
  }
  if (relation.ahead > 0 && relation.behind > 0) {
    return {
      line: `git: blocked branch diverged ahead=${relation.ahead} behind=${relation.behind} ${gitContext} remote=${remoteText} upstream=${upstream}`,
      next: "sync the branch with upstream before public release"
    };
  }
  if (relation.ahead > 0) {
    return {
      line: `git: blocked branch has unpushed commits ahead=${relation.ahead} ${gitContext} remote=${remoteText} upstream=${upstream}`,
      next: "push local commits before public release"
    };
  }
  if (relation.behind > 0) {
    return {
      line: `git: blocked branch is behind upstream behind=${relation.behind} ${gitContext} remote=${remoteText} upstream=${upstream}`,
      next: "sync the branch with upstream before public release"
    };
  }

  return {
    line: `git: ok ${gitContext} remote=${remoteText} upstream=${upstream}`
  };
}

function formatGitPushUpstreamCommand(branch) {
  return `git push -u origin ${shellQuote(branch)}`;
}

function parseGitBranchRelation(statusOutput) {
  const branchLine = statusOutput.split(/\r?\n/).find((line) => line.startsWith("## ")) ?? "";
  const relationText = /\[([^\]]+)\]/.exec(branchLine)?.[1] ?? "";
  const ahead = Number(/\bahead (\d+)\b/.exec(relationText)?.[1] ?? 0);
  const behind = Number(/\bbehind (\d+)\b/.exec(relationText)?.[1] ?? 0);
  return { ahead, behind, gone: /\bgone\b/.test(relationText) };
}

async function gitStdout(root, args) {
  const { stdout } = await execFileAsync("git", args, { cwd: root });
  return stdout;
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
    .find(Boolean);
}

function isMissingFileError(error) {
  return error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
