#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  "bridge_list_results",
  "bridge_fetch_result",
  "repo_read_file",
  "repo_search",
  "repo_write_file_dry_run",
  "repo_write_file_apply",
  "repo_stage_reviewed_paths"
];

const tmp = await mkdtemp(path.join(tmpdir(), "gptprouse-package-smoke-"));

try {
  const tarball = await packPackage(tmp);
  const consumerDir = path.join(tmp, "consumer");
  await mkdir(consumerDir, { recursive: true });
  await writeFile(path.join(consumerDir, "package.json"), `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`);

  await run(npmCommand, ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", tarball], {
    cwd: consumerDir,
    timeout: 120_000
  });

  const binPath = path.join(consumerDir, "node_modules", ".bin", process.platform === "win32" ? "gptprouse.cmd" : "gptprouse");
  const help = await run(binPath, ["help"], { cwd: consumerDir });
  assertIncludes(help.stdout, "gptprouse doctor", "installed help output");

  const init = await run(binPath, ["init"], { cwd: consumerDir });
  assertIncludes(init.stdout, "Initialized .bridge", "installed init output");

  const doctor = await run(binPath, ["doctor"], { cwd: consumerDir, timeout: 60_000 });
  assertIncludes(doctor.stdout, "mcp_write_smoke: ok", "installed doctor output");
  assertIncludes(doctor.stdout, "http_mcp_smoke: ok", "installed doctor output");

  const tools = await smokeStdioMcp(binPath, consumerDir);
  for (const tool of REQUIRED_MCP_TOOLS) {
    if (!tools.includes(tool)) throw new Error(`Installed MCP catalog is missing ${tool}`);
  }

  console.log(`package_smoke: ok tarball=${path.basename(tarball)} tools=${REQUIRED_MCP_TOOLS.join(",")}`);
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
  const filename = entries?.[0]?.filename;
  if (typeof filename !== "string" || !filename.endsWith(".tgz")) {
    throw new Error(`Could not determine npm pack tarball from output: ${stdout}`);
  }
  return path.join(destination, filename);
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
