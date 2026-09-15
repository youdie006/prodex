import { execFile } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function resolveNpmCliPath(options = {}) {
  const env = normalizeNpmEnvironment(options.env ?? process.env);
  const execPath = options.execPath ?? process.execPath;
  const cwd = options.cwd ?? process.cwd();
  const candidates = [];
  const npmExecPath = envValue(env, "npm_execpath");
  if (npmExecPath && !isCompetingPackageManagerCli(npmExecPath)) candidates.push(path.resolve(cwd, npmExecPath));

  const pathValue = envValue(env, "PATH");
  for (const entry of pathValue?.split(path.delimiter) ?? []) {
    if (!entry) continue;
    for (const commandName of process.platform === "win32" ? ["npm.cmd", "npm.exe", "npm"] : ["npm"]) {
      const commandPath = path.join(entry, commandName);
      const resolvedCommand = existingJavaScriptFile(commandPath);
      if (resolvedCommand) candidates.push(resolvedCommand);
    }
    candidates.push(path.join(entry, "node_modules", "npm", "bin", "npm-cli.js"));
    candidates.push(path.resolve(entry, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"));
  }

  const nodeDir = path.dirname(execPath);
  candidates.push(path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"));
  candidates.push(path.resolve(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"));

  for (const candidate of candidates) {
    const resolved = existingJavaScriptFile(candidate);
    if (resolved) return resolved;
  }
  throw new Error(`Could not locate npm's JavaScript CLI for ${execPath}`);
}

export function execNpm(args, options = {}) {
  const env = normalizeNpmEnvironment(options.env ?? process.env);
  const npmCliPath = resolveNpmCliPath({ cwd: options.cwd, env, execPath: process.execPath });
  return execFileAsync(process.execPath, [npmCliPath, ...args], { ...options, env, encoding: "utf8" });
}

export function normalizeNpmEnvironment(env, platform = process.platform) {
  if (platform !== "win32") return env;
  // Node otherwise sorts duplicate Windows names and can keep the inherited
  // spelling instead of an explicit override appended by the caller.
  const entries = new Map();
  for (const [name, value] of Object.entries(env)) entries.set(name.toLowerCase(), [name, value]);
  return Object.fromEntries(entries.values());
}

function envValue(env, name) {
  if (typeof env[name] === "string") return env[name];
  const entry = Object.entries(env).find(([key, value]) => key.toLowerCase() === name.toLowerCase() && typeof value === "string");
  return entry?.[1];
}

function isCompetingPackageManagerCli(candidate) {
  return /^(?:pnpm|pnpx|yarn|yarnpkg)(?:\.(?:cjs|mjs|js))?$/i.test(path.basename(candidate));
}

function existingJavaScriptFile(candidate) {
  try {
    const resolved = realpathSync(candidate);
    return /\.(?:cjs|mjs|js)$/i.test(resolved) && statSync(resolved).isFile() ? resolved : undefined;
  } catch {
    return undefined;
  }
}
