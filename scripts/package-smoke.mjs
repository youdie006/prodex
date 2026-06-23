#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execFileAsync = promisify(execFile);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED_MCP_TOOLS = [
  "bridge_create_task",
  "bridge_list_tasks",
  "bridge_get_task",
  "bridge_claim_task",
  "bridge_complete_task",
  "bridge_block_task",
  "bridge_list_results",
  "bridge_fetch_result",
  "bridge_fetch_result_artifact",
  "bridge_list_receipts",
  "bridge_get_receipt",
  "bridge_list_sessions",
  "bridge_get_session",
  "repo_read_file",
  "repo_search",
  "repo_write_file_dry_run",
  "repo_write_file_apply",
  "repo_stage_reviewed_paths"
];

const tmp = await mkdtemp(path.join(tmpdir(), "gptprouse-package-smoke-"));

try {
  const packed = await packPackage(tmp);
  await assertPackageFileScope(packed.files);
  const consumerDir = path.join(tmp, "consumer");
  await mkdir(consumerDir, { recursive: true });
  await writeFile(path.join(consumerDir, "package.json"), `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`);

  await run(npmCommand, ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", packed.filename], {
    cwd: consumerDir,
    timeout: 120_000
  });

  const binPath = path.join(consumerDir, "node_modules", ".bin", process.platform === "win32" ? "gptprouse.cmd" : "gptprouse");
  const installedPackageJson = JSON.parse(await readFile(path.join(consumerDir, "node_modules", "gptprouse", "package.json"), "utf8"));
  const version = await run(binPath, ["--version"], { cwd: consumerDir });
  if (version.stdout.trim() !== installedPackageJson.version) {
    throw new Error(`Installed --version returned ${version.stdout.trim()}, expected ${installedPackageJson.version}`);
  }
  const help = await run(binPath, ["help"], { cwd: consumerDir });
  assertIncludes(help.stdout, "gptprouse doctor", "installed help output");
  assertIncludes(help.stdout, `gptprouse v${installedPackageJson.version}`, "installed help output");
  const browserLoginGuide = await run(binPath, ["pro", "browser", "login", "--dry-run"], { cwd: consumerDir });
  assertIncludes(browserLoginGuide.stdout, "gptprouse pro browser check", "installed browser login guide");
  assertIncludes(browserLoginGuide.stdout, "gptprouse pro browser smoke", "installed browser login guide");
  assertNotIncludes(browserLoginGuide.stdout, "node dist/cli.js", "installed browser login guide");

  const init = await run(binPath, ["init"], { cwd: consumerDir });
  assertIncludes(init.stdout, "Initialized .bridge", "installed init output");

  const doctor = await run(binPath, ["doctor"], { cwd: consumerDir, timeout: 60_000 });
  assertIncludes(doctor.stdout, "mcp_write_smoke: ok", "installed doctor output");
  assertIncludes(doctor.stdout, "http_mcp_smoke: ok", "installed doctor output");

  await smokeInstalledHttpOnboarding(binPath, consumerDir);
  await assertInstalledDocsArePortable(consumerDir);

  const tools = await smokeStdioMcp(binPath, consumerDir);
  for (const tool of REQUIRED_MCP_TOOLS) {
    if (!tools.includes(tool)) throw new Error(`Installed MCP catalog is missing ${tool}`);
  }

  console.log(`package_smoke: ok tarball=${path.basename(packed.filename)} http_onboarding=ok tunnel_url=ok tools=${REQUIRED_MCP_TOOLS.join(",")}`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}

async function packPackage(destination) {
  const { stdout } = await run(npmCommand, ["pack", "--json", "--pack-destination", destination], {
    cwd: repoRoot,
    timeout: 120_000,
    maxBuffer: 20 * 1024 * 1024
  });
  const entries = JSON.parse(stdout);
  const entry = entries?.[0];
  const filename = entry?.filename;
  if (typeof filename !== "string" || !filename.endsWith(".tgz")) {
    throw new Error(`Could not determine npm pack tarball from output: ${stdout}`);
  }
  return { filename: path.join(destination, filename), files: entry.files ?? [] };
}

function assertPackageFileScope(files) {
  const paths = files.map((file) => file.path);
  assertArrayIncludes(paths, "README.md", "packed files");
  assertArrayIncludes(paths, "docs/http-mcp.md", "packed files");
  assertArrayIncludes(paths, "docs/claude.md", "packed files");
  assertArrayIncludes(paths, "scripts/release-check.mjs", "packed files");
  assertArrayNotIncludes(paths, "docs/research.md", "packed files");
  assertArrayNotIncludes(paths, "docs/todo.md", "packed files");
  if (paths.some((filePath) => filePath.startsWith("docs/superpowers/"))) {
    throw new Error("packed files unexpectedly included internal superpowers plans");
  }
}

async function assertInstalledDocsArePortable(consumerDir) {
  const packageDir = path.join(consumerDir, "node_modules", "gptprouse");
  const readme = await readFile(path.join(packageDir, "README.md"), "utf8");
  const httpMcpDoc = await readFile(path.join(packageDir, "docs", "http-mcp.md"), "utf8");
  const claudeDoc = await readFile(path.join(packageDir, "docs", "claude.md"), "utf8");
  assertNotIncludes(readme, "/absolute/path/to/project", "installed README");
  assertNotIncludes(httpMcpDoc, "/absolute/path/to/project", "installed HTTP MCP docs");
  assertNotIncludes(claudeDoc, "/absolute/path/to/project", "installed Claude docs");
  assertIncludes(readme, "For an installed package", "installed README");
  assertIncludes(readme, "gptprouse init", "installed README");
  assertIncludes(httpMcpDoc, "For an installed package", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, "gptprouse setup --token-ttl-hours 24", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, "Keep `gptprouse start` running", "installed HTTP MCP docs");
}

async function smokeStdioMcp(binPath, cwd) {
  const client = new Client({ name: "gptprouse-package-smoke", version: "0.2.0" });
  const transport = new StdioClientTransport({
    command: binPath,
    args: ["mcp"],
    cwd,
    stderr: "pipe"
  });
  try {
    await withTimeout(client.connect(transport), 20_000, "Timed out connecting to installed stdio MCP server");
    const result = await withTimeout(client.listTools(), 20_000, "Timed out listing installed stdio MCP tools");
    return result.tools.map((tool) => tool.name);
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function smokeInstalledHttpOnboarding(binPath, cwd) {
  const port = await getFreePort();
  const token = "package-smoke-token";
  const expectedUrl = `http://127.0.0.1:${port}/mcp?gptprouse_token=${token}`;

  const setup = await run(binPath, ["setup", "--port", String(port), "--token", token, "--token-ttl-hours", "1"], { cwd });
  const setupOutput = `${setup.stdout}\n${setup.stderr}`;
  assertIncludes(setupOutput, "gptprouse_token=***", "installed setup output");
  assertIncludes(setupOutput, "Token expires:", "installed setup output");
  assertNotIncludes(setupOutput, token, "installed setup output");

  const status = await run(binPath, ["status"], { cwd });
  const statusOutput = `${status.stdout}\n${status.stderr}`;
  assertIncludes(statusOutput, "gptprouse_token=***", "installed status output");
  assertIncludes(statusOutput, '"token_status": "valid"', "installed status output");
  assertIncludes(statusOutput, '"token_expires_at":', "installed status output");
  assertNotIncludes(statusOutput, token, "installed status output");

  const pasteReady = await run(binPath, ["status", "--show-token", "--url-only"], { cwd });
  if (pasteReady.stdout.trim() !== expectedUrl) {
    throw new Error(`Installed status --show-token --url-only returned ${pasteReady.stdout.trim()}, expected ${expectedUrl}`);
  }

  const tunnelUrl = await run(
    binPath,
    ["tunnel", "url", "--public-url", "https://gptprouse-package-smoke.example/ignored", "--show-token", "--url-only"],
    { cwd }
  );
  const expectedTunnelUrl = `https://gptprouse-package-smoke.example/mcp?gptprouse_token=${token}`;
  if (tunnelUrl.stdout.trim() !== expectedTunnelUrl) {
    throw new Error(`Installed tunnel url returned ${tunnelUrl.stdout.trim()}, expected ${expectedTunnelUrl}`);
  }

  const child = spawn(binPath, ["start"], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  try {
    await waitForHttpHealth(`http://127.0.0.1:${port}/health`, 20_000);
  } finally {
    await terminateChild(child, stdout, stderr);
  }
  const startOutput = `${stdout}\n${stderr}`;
  assertIncludes(startOutput, "gptprouse_token=***", "installed start output");
  assertIncludes(startOutput, "Token expires:", "installed start output");
  assertNotIncludes(startOutput, token, "installed start output");
}

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : undefined;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  if (!port) throw new Error("Could not allocate a free loopback port");
  return port;
}

async function waitForHttpHealth(url, timeoutMs) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        const body = await response.json();
        if (body?.ok === true && body?.name === "gptprouse") return;
        throw new Error(`Unexpected health body: ${JSON.stringify(body)}`);
      }
      throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`Timed out waiting for installed HTTP health at ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function terminateChild(child, stdout, stderr) {
  if (child.exitCode !== null) {
    if (child.exitCode !== 0) {
      throw new Error(`Installed HTTP server exited early with ${child.exitCode}. stdout:\n${stdout}\nstderr:\n${stderr}`);
    }
    return;
  }
  const exit = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  child.kill("SIGTERM");
  const result = await withTimeout(
    exit,
    10_000,
    "Timed out stopping installed HTTP server"
  );
  if (result.code !== 0 && result.signal !== "SIGTERM") {
    throw new Error(`Installed HTTP server exited unexpectedly with code=${result.code} signal=${result.signal}. stdout:\n${stdout}\nstderr:\n${stderr}`);
  }
}

async function run(command, args, options = {}) {
  return execFileAsync(command, args, {
    timeout: options.timeout ?? 30_000,
    maxBuffer: options.maxBuffer ?? 5 * 1024 * 1024,
    cwd: options.cwd
  });
}

async function withTimeout(promise, timeoutMs, message) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function assertIncludes(text, expected, label) {
  if (!text.includes(expected)) {
    throw new Error(`${label} did not include ${expected}. Output was:\n${text.slice(0, 1000)}`);
  }
}

function assertNotIncludes(text, unexpected, label) {
  if (text.includes(unexpected)) {
    throw new Error(`${label} unexpectedly included ${unexpected}. Output was:\n${text.slice(0, 1000)}`);
  }
}

function assertArrayIncludes(values, expected, label) {
  if (!values.includes(expected)) {
    throw new Error(`${label} did not include ${expected}. Values were:\n${values.slice(0, 80).join("\n")}`);
  }
}

function assertArrayNotIncludes(values, unexpected, label) {
  if (values.includes(unexpected)) {
    throw new Error(`${label} unexpectedly included ${unexpected}`);
  }
}
