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
  assertIncludes(help.stdout, "gptprouse release status", "installed help output");
  assertIncludes(help.stdout, "gptprouse project prompt", "installed help output");
  assertIncludes(help.stdout, "gptprouse claude prompt", "installed help output");
  assertIncludes(help.stdout, "gptprouse claude config", "installed help output");
  assertIncludes(help.stdout, `gptprouse v${installedPackageJson.version}`, "installed help output");
  const installedPackageDir = path.join(consumerDir, "node_modules", "gptprouse");
  const releaseStatus = await run(binPath, ["release", "status", "--cwd", installedPackageDir], { cwd: consumerDir });
  assertIncludes(releaseStatus.stdout, "gptprouse release status", "installed release status output");
  assertIncludes(releaseStatus.stdout, "metadata: blocked", "installed release status output");
  assertIncludes(releaseStatus.stdout, "explicit license", "installed release status output");
  assertIncludes(releaseStatus.stdout, "git:", "installed release status output");
  const privatePackageDir = path.join(tmp, "private-release");
  await mkdir(privatePackageDir, { recursive: true });
  await writeFile(
    path.join(privatePackageDir, "package.json"),
    `${JSON.stringify({ name: "private-demo", version: "1.0.0", license: "MIT", private: true }, null, 2)}\n`
  );
  await writeFile(path.join(privatePackageDir, "LICENSE"), "MIT License\n");
  const privateReleaseStatus = await run(binPath, ["release", "status", "--cwd", privatePackageDir], { cwd: consumerDir });
  assertIncludes(privateReleaseStatus.stdout, "metadata: blocked", "installed private release status output");
  assertIncludes(privateReleaseStatus.stdout, "private: true", "installed private release status output");
  assertNotIncludes(privateReleaseStatus.stdout, "metadata: ok", "installed private release status output");
  const projectPrompt = await run(binPath, ["project", "prompt", "--cwd", consumerDir], { cwd: path.dirname(consumerDir) });
  assertIncludes(projectPrompt.stdout, "ChatGPT Project MCP verification prompt", "installed project prompt output");
  assertIncludes(projectPrompt.stdout, "bridge_create_task", "installed project prompt output");
  assertIncludes(projectPrompt.stdout, "gptprouse tasks list --status new", "installed project prompt output");
  assertNotIncludes(projectPrompt.stdout, "gptprouse_token=", "installed project prompt output");
  const claudePrompt = await run(binPath, ["claude", "prompt", "--cwd", consumerDir], { cwd: path.dirname(consumerDir) });
  assertIncludes(claudePrompt.stdout, "Claude MCP verification prompt", "installed Claude prompt output");
  assertIncludes(claudePrompt.stdout, "bridge_create_task", "installed Claude prompt output");
  assertIncludes(claudePrompt.stdout, "gptprouse tasks list --status new", "installed Claude prompt output");
  assertNotIncludes(claudePrompt.stdout, "gptprouse_token=", "installed Claude prompt output");
  const claudeConfig = await run(binPath, ["claude", "config", "--cwd", consumerDir], { cwd: path.dirname(consumerDir) });
  const parsedClaudeConfig = JSON.parse(claudeConfig.stdout);
  if (parsedClaudeConfig?.mcpServers?.gptprouse?.command !== "gptprouse") {
    throw new Error(`Installed Claude config command mismatch: ${claudeConfig.stdout}`);
  }
  if (JSON.stringify(parsedClaudeConfig?.mcpServers?.gptprouse?.args) !== JSON.stringify(["mcp", "--cwd", consumerDir])) {
    throw new Error(`Installed Claude config args mismatch: ${claudeConfig.stdout}`);
  }
  assertNotIncludes(claudeConfig.stdout, "gptprouse_token=", "installed Claude config output");
  const browserLoginGuide = await run(binPath, ["pro", "browser", "login", "--dry-run"], { cwd: consumerDir });
  assertIncludes(browserLoginGuide.stdout, "gptprouse pro browser check", "installed browser login guide");
  assertIncludes(browserLoginGuide.stdout, "gptprouse pro browser smoke", "installed browser login guide");
  assertNotIncludes(browserLoginGuide.stdout, "node dist/cli.js", "installed browser login guide");

  const launcherDir = path.dirname(consumerDir);
  const init = await run(binPath, ["init", "--cwd", consumerDir], { cwd: launcherDir });
  assertIncludes(init.stdout, "Initialized .bridge", "installed init output");
  assertIncludes(await readFile(path.join(consumerDir, ".bridge", ".gitignore"), "utf8"), "tasks/*.json", "installed explicit --cwd init gitignore");
  await assertMissingFile(path.join(launcherDir, ".bridge", ".gitignore"), "installed launcher cwd bridge gitignore");

  const doctor = await run(binPath, ["doctor"], { cwd: consumerDir, timeout: 60_000 });
  assertIncludes(doctor.stdout, "mcp_write_smoke: ok", "installed doctor output");
  assertIncludes(doctor.stdout, "http_mcp_smoke: ok", "installed doctor output");
  assertIncludes(doctor.stdout, "task_flow=ok", "installed doctor output");
  assertIncludes(doctor.stdout, "finalizers=ok", "installed doctor output");

  await smokeInstalledHttpOnboarding(binPath, consumerDir);
  await assertInstalledDocsArePortable(consumerDir);
  await assertInstalledPackageImportBoundary(consumerDir, packed.files);

  const tools = await smokeStdioMcp(binPath, consumerDir);
  for (const tool of REQUIRED_MCP_TOOLS) {
    if (!tools.includes(tool)) throw new Error(`Installed MCP catalog is missing ${tool}`);
  }
  await smokeInstalledStdioTaskFinalizers(binPath, consumerDir);

  console.log(`package_smoke: ok tarball=${path.basename(packed.filename)} http_onboarding=ok configured_doctor=ok tunnel_url=ok package_boundary=ok stdio_task_flow=ok stdio_task_finalizers=ok tools=${REQUIRED_MCP_TOOLS.join(",")}`);
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
  assertIncludes(readme, "CLI-only", "installed README");
  assertIncludes(readme, "ripgrep", "installed README");
  assertIncludes(readme, "setup --cwd", "installed README");
  assertIncludes(readme, "mcp --cwd", "installed README");
  assertIncludes(readme, "gptprouse project prompt", "installed README");
  assertIncludes(readme, "gptprouse claude prompt", "installed README");
  assertIncludes(readme, "gptprouse claude config", "installed README");
  assertIncludes(readme, "gptprouse release status", "installed README");
  assertIncludes(readme, "npm run release:verify", "installed README");
  assertIncludes(readme, "private: true", "installed README");
  assertIncludes(readme, "configured `doctor`", "installed README");
  assertIncludes(httpMcpDoc, "For an installed package", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, "ripgrep", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, "setup --cwd", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, "gptprouse setup --token-ttl-hours 24", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, "gptprouse project prompt", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, "Verify In ChatGPT", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, "Keep `gptprouse start` running", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, "CLI-only", "installed HTTP MCP docs");
  assertIncludes(claudeDoc, "CLI-only", "installed Claude docs");
  assertIncludes(claudeDoc, "ripgrep", "installed Claude docs");
  assertIncludes(claudeDoc, "mcp --cwd", "installed Claude docs");
  assertIncludes(claudeDoc, "gptprouse claude prompt", "installed Claude docs");
  assertIncludes(claudeDoc, "gptprouse claude config", "installed Claude docs");
}

async function assertInstalledPackageImportBoundary(consumerDir, packedFiles) {
  const unsupportedSpecifiers = [
    "gptprouse",
    ...packedFiles
      .map((file) => file.path)
      .filter((filePath) => filePath.startsWith("dist/") && filePath.endsWith(".js"))
      .sort()
      .map((filePath) => `gptprouse/${filePath}`)
  ];
  assertArrayIncludes(unsupportedSpecifiers, "gptprouse/dist/cli.js", "installed package boundary specifiers");
  assertArrayIncludes(unsupportedSpecifiers, "gptprouse/dist/index.js", "installed package boundary specifiers");
  for (const specifier of unsupportedSpecifiers) {
    await assertPackageImportBlocked(consumerDir, specifier);
    await assertPackageRequireBlocked(consumerDir, specifier);
  }
}

async function assertPackageImportBlocked(consumerDir, specifier) {
  await assertPackageSpecifierBlocked(consumerDir, specifier, "import", ["--input-type=module", "--eval", `await import(${JSON.stringify(specifier)});`]);
}

async function assertPackageRequireBlocked(consumerDir, specifier) {
  await assertPackageSpecifierBlocked(consumerDir, specifier, "require", ["--eval", `require(${JSON.stringify(specifier)});`]);
}

async function assertPackageSpecifierBlocked(consumerDir, specifier, mode, nodeArgs) {
  try {
    await run(process.execPath, nodeArgs, {
      cwd: consumerDir
    });
  } catch (error) {
    const output = `${error.stdout ?? ""}\n${error.stderr ?? ""}\n${error.message ?? ""}`;
    assertIncludes(output, "ERR_PACKAGE_PATH_NOT_EXPORTED", `installed package ${mode} failure for ${specifier}`);
    return;
  }
  throw new Error(`Installed package unexpectedly allowed ${mode}(${specifier}); the npm package should expose only the CLI for now`);
}

async function smokeStdioMcp(binPath, cwd) {
  await writeFile(path.join(cwd, "search-smoke.txt"), "before\n--package-rg-literal ok\nafter\n", "utf8");
  const client = new Client({ name: "gptprouse-package-smoke", version: "0.2.0" });
  const transport = new StdioClientTransport({
    command: binPath,
    args: ["mcp", "--cwd", cwd],
    cwd: path.dirname(cwd),
    stderr: "pipe"
  });
  try {
    await withTimeout(client.connect(transport), 20_000, "Timed out connecting to installed stdio MCP server");
    const result = await withTimeout(client.listTools(), 20_000, "Timed out listing installed stdio MCP tools");
    const search = await callJsonTool(client, "repo_search", {
      query: "--package-rg-literal"
    });
    assertSearchResult(search, {
      path: "search-smoke.txt",
      line: 2,
      text: "--package-rg-literal ok"
    });
    return result.tools.map((tool) => tool.name);
  } finally {
    await closeStdioClient(client, transport, "installed stdio MCP client");
  }
}

async function smokeInstalledStdioTaskFinalizers(binPath, cwd) {
  const client = new Client({ name: "gptprouse-package-finalizers-smoke", version: "0.2.0" });
  const transport = new StdioClientTransport({
    command: binPath,
    args: ["mcp", "--cwd", cwd],
    cwd: path.dirname(cwd),
    stderr: "pipe"
  });
  try {
    await withTimeout(client.connect(transport), 20_000, "Timed out connecting to installed stdio MCP server for task finalizer smoke");
    const doneTask = await callJsonTool(client, "bridge_create_task", {
      title: "Package stdio complete smoke",
      prompt: "Complete this task over installed stdio MCP"
    });
    assertTask(doneTask.task, {
      taskId: doneTask.task.id,
      status: "new",
      title: "Package stdio complete smoke"
    });
    const fetchedTask = await callJsonTool(client, "bridge_get_task", {
      task_id: doneTask.task.id
    });
    const newTasks = await callJsonTool(client, "bridge_list_tasks", {
      status: "new"
    });
    assertTask(fetchedTask.task, {
      taskId: doneTask.task.id,
      status: "new",
      title: "Package stdio complete smoke"
    });
    assertTaskInList(newTasks.tasks, {
      taskId: doneTask.task.id,
      status: "new"
    });
    const claimedTask = await callJsonTool(client, "bridge_claim_task", {
      task_id: doneTask.task.id,
      claimed_by: "package-stdio-smoke"
    });
    const claimedTasks = await callJsonTool(client, "bridge_list_tasks", {
      status: "claimed"
    });
    assertTask(claimedTask.task, {
      taskId: doneTask.task.id,
      status: "claimed",
      title: "Package stdio complete smoke",
      claimedBy: "package-stdio-smoke"
    });
    assertTaskInList(claimedTasks.tasks, {
      taskId: doneTask.task.id,
      status: "claimed"
    });
    const completed = await callJsonTool(client, "bridge_complete_task", {
      task_id: doneTask.task.id,
      summary: "Completed by installed stdio MCP",
      commands: ["package stdio finalizer smoke"]
    });
    const blockedTask = await callJsonTool(client, "bridge_create_task", {
      title: "Package stdio block smoke",
      prompt: "Block this task over installed stdio MCP"
    });
    const blocked = await callJsonTool(client, "bridge_block_task", {
      task_id: blockedTask.task.id,
      summary: "Blocked by installed stdio MCP",
      code: "package_smoke_blocker",
      retryable: true,
      next_step: "Inspect package smoke output."
    });
    const fetchedDone = await callJsonTool(client, "bridge_fetch_result", { task_id: doneTask.task.id });
    const fetchedBlocked = await callJsonTool(client, "bridge_fetch_result", { task_id: blockedTask.task.id });
    const doneTasks = await callJsonTool(client, "bridge_list_tasks", { status: "done" });
    const blockedTasks = await callJsonTool(client, "bridge_list_tasks", { status: "blocked" });
    const results = await callJsonTool(client, "bridge_list_results", {});

    assertResult(completed.result, {
      taskId: doneTask.task.id,
      status: "done",
      summary: "Completed by installed stdio MCP",
      commands: ["package stdio finalizer smoke"]
    });
    assertResult(fetchedDone.result, {
      taskId: doneTask.task.id,
      status: "done",
      summary: "Completed by installed stdio MCP",
      commands: ["package stdio finalizer smoke"]
    });
    assertResult(blocked.result, {
      taskId: blockedTask.task.id,
      status: "blocked",
      summary: "Blocked by installed stdio MCP",
      blockerCode: "package_smoke_blocker",
      retryable: true,
      nextStep: "Inspect package smoke output."
    });
    assertResult(fetchedBlocked.result, {
      taskId: blockedTask.task.id,
      status: "blocked",
      summary: "Blocked by installed stdio MCP",
      blockerCode: "package_smoke_blocker",
      retryable: true,
      nextStep: "Inspect package smoke output."
    });
    assertTaskInList(doneTasks.tasks, {
      taskId: doneTask.task.id,
      status: "done"
    });
    assertTaskInList(blockedTasks.tasks, {
      taskId: blockedTask.task.id,
      status: "blocked"
    });
    assertResultInList(results.results, {
      taskId: doneTask.task.id,
      status: "done",
      summary: "Completed by installed stdio MCP"
    });
    assertResultInList(results.results, {
      taskId: blockedTask.task.id,
      status: "blocked",
      summary: "Blocked by installed stdio MCP"
    });
    await assertBridgeTaskStoredInCwd(cwd, doneTask.task.id);
    await assertBridgeTaskStoredInCwd(cwd, blockedTask.task.id);
  } finally {
    await closeStdioClient(client, transport, "installed stdio MCP client for task finalizer smoke");
  }
}

async function assertBridgeTaskStoredInCwd(cwd, taskId) {
  const raw = await readFile(path.join(cwd, ".bridge", "tasks", `${taskId}.json`), "utf8");
  const task = JSON.parse(raw);
  if (task.id !== taskId) {
    throw new Error(`Expected task ${taskId} to be stored under explicit MCP --cwd, got ${task.id}`);
  }
}

async function smokeInstalledHttpOnboarding(binPath, cwd) {
  const launcherCwd = path.dirname(cwd);
  const port = await getFreePort();
  const token = "package-smoke-token";
  const expectedUrl = `http://127.0.0.1:${port}/mcp?gptprouse_token=${token}`;

  const setup = await run(binPath, ["setup", "--cwd", cwd, "--port", String(port), "--token", token, "--token-ttl-hours", "1"], { cwd: launcherCwd });
  const setupOutput = `${setup.stdout}\n${setup.stderr}`;
  assertIncludes(setupOutput, "gptprouse_token=***", "installed setup output");
  assertIncludes(setupOutput, "Token expires:", "installed setup output");
  assertNotIncludes(setupOutput, token, "installed setup output");
  assertIncludes(await readFile(path.join(cwd, ".bridge", "config.local.json"), "utf8"), token, "installed explicit --cwd config file");
  await assertMissingFile(path.join(launcherCwd, ".bridge", "config.local.json"), "installed launcher cwd config file");

  const status = await run(binPath, ["status", "--cwd", cwd], { cwd: launcherCwd });
  const statusOutput = `${status.stdout}\n${status.stderr}`;
  assertIncludes(statusOutput, "gptprouse_token=***", "installed status output");
  assertIncludes(statusOutput, '"token_status": "valid"', "installed status output");
  assertIncludes(statusOutput, '"token_expires_at":', "installed status output");
  assertNotIncludes(statusOutput, token, "installed status output");

  const nonExpiringCwd = path.join(launcherCwd, "non-expiring-http");
  const nonExpiringToken = "non-expiring-package-smoke-token";
  await mkdir(nonExpiringCwd, { recursive: true });
  await run(binPath, ["setup", "--cwd", nonExpiringCwd, "--port", "8790", "--token", nonExpiringToken], { cwd: launcherCwd });
  const nonExpiringReveal = await runExpectFailure(binPath, ["status", "--cwd", nonExpiringCwd, "--show-token", "--url-only"], { cwd: launcherCwd });
  const nonExpiringRevealOutput = `${nonExpiringReveal.stdout}\n${nonExpiringReveal.stderr}`;
  assertIncludes(nonExpiringRevealOutput, "status --show-token requires a token with expiry", "installed non-expiring status reveal refusal");
  assertNotIncludes(nonExpiringRevealOutput, nonExpiringToken, "installed non-expiring status reveal refusal");

  const expiredCwd = path.join(launcherCwd, "expired-http");
  const expiredToken = "expired-package-smoke-token";
  await mkdir(path.join(expiredCwd, ".bridge"), { recursive: true });
  await writeFile(
    path.join(expiredCwd, ".bridge", "config.local.json"),
    `${JSON.stringify(
      {
        schema_version: 1,
        host: "127.0.0.1",
        port: 8791,
        token: expiredToken,
        server_url: `http://127.0.0.1:8791/mcp?gptprouse_token=${expiredToken}`,
        token_expires_at: new Date(Date.now() - 1000).toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  const expiredReveal = await runExpectFailure(binPath, ["status", "--cwd", expiredCwd, "--show-token", "--url-only"], { cwd: launcherCwd });
  const expiredRevealOutput = `${expiredReveal.stdout}\n${expiredReveal.stderr}`;
  assertIncludes(expiredRevealOutput, "token expired", "installed expired status reveal refusal");
  assertNotIncludes(expiredRevealOutput, expiredToken, "installed expired status reveal refusal");

  const configuredDoctor = await run(binPath, ["doctor", "--cwd", cwd], { cwd: launcherCwd, timeout: 60_000 });
  assertIncludes(configuredDoctor.stdout, "config: ok", "installed configured doctor output");
  assertIncludes(configuredDoctor.stdout, "token_status=valid", "installed configured doctor output");
  assertIncludes(configuredDoctor.stdout, "gptprouse_token=***", "installed configured doctor output");
  assertNotIncludes(configuredDoctor.stdout, token, "installed configured doctor output");

  const pasteReady = await run(binPath, ["status", "--cwd", cwd, "--show-token", "--url-only"], { cwd: launcherCwd });
  if (pasteReady.stdout.trim() !== expectedUrl) {
    throw new Error(`Installed status --show-token --url-only returned ${pasteReady.stdout.trim()}, expected ${expectedUrl}`);
  }

  const tunnelUrl = await run(
    binPath,
    ["tunnel", "url", "--cwd", cwd, "--public-url", "https://gptprouse-package-smoke.example/ignored", "--show-token", "--url-only"],
    { cwd: launcherCwd }
  );
  const expectedTunnelUrl = `https://gptprouse-package-smoke.example/mcp?gptprouse_token=${token}`;
  if (tunnelUrl.stdout.trim() !== expectedTunnelUrl) {
    throw new Error(`Installed tunnel url returned ${tunnelUrl.stdout.trim()}, expected ${expectedTunnelUrl}`);
  }

  const child = spawn(binPath, ["start", "--cwd", cwd], {
    cwd: launcherCwd,
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

async function assertMissingFile(filePath, label) {
  try {
    await readFile(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} unexpectedly exists at ${filePath}`);
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

async function runExpectFailure(command, args, options = {}) {
  try {
    const result = await run(command, args, options);
    throw new Error(`Expected command to fail but it exited successfully. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  } catch (error) {
    if (error && typeof error === "object" && "stdout" in error && "stderr" in error) {
      return {
        stdout: String(error.stdout ?? ""),
        stderr: String(error.stderr ?? "")
      };
    }
    throw error;
  }
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

async function callJsonTool(client, name, args) {
  const result = await withTimeout(
    client.callTool({ name, arguments: args }),
    20_000,
    `Timed out calling installed stdio MCP tool ${name}`
  );
  const text = result.content.find((item) => item.type === "text")?.text;
  if (!text) throw new Error(`Installed stdio MCP tool ${name} did not return text content`);
  return JSON.parse(text);
}

async function closeStdioClient(client, transport, label) {
  const processRef = captureStdioTransportProcess(transport);
  const closePromise = client.close();
  closePromise.catch(() => undefined);
  try {
    await withTimeout(closePromise, 10_000, `Timed out closing ${label}`);
  } catch (error) {
    forceKillStdioProcess(processRef);
    await waitForStdioProcessExit(processRef, 2_000).catch(() => undefined);
    throw error;
  }
}

function captureStdioTransportProcess(transport) {
  return { child: transport._process, pid: transport.pid };
}

function forceKillStdioProcess(processRef) {
  const child = processRef.child;
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    return;
  }
  if (processRef.pid) {
    try {
      process.kill(processRef.pid, "SIGKILL");
    } catch {
      // Process already exited.
    }
  }
}

async function waitForStdioProcessExit(processRef, timeoutMs) {
  const child = processRef.child;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await withTimeout(
    new Promise((resolve) => child.once("exit", resolve)),
    timeoutMs,
    "Timed out waiting for killed stdio MCP process"
  );
}

function assertResult(result, expected) {
  if (result?.task_id !== expected.taskId || result?.status !== expected.status || result?.summary !== expected.summary) {
    throw new Error(`Unexpected result record: ${JSON.stringify(result)} expected ${JSON.stringify(expected)}`);
  }
  if (expected.commands && JSON.stringify(result?.commands) !== JSON.stringify(expected.commands)) {
    throw new Error(`Unexpected result commands: ${JSON.stringify(result?.commands)} expected ${JSON.stringify(expected.commands)}`);
  }
  if (expected.blockerCode && result?.blocker?.code !== expected.blockerCode) {
    throw new Error(`Unexpected result blocker: ${JSON.stringify(result?.blocker)} expected code ${expected.blockerCode}`);
  }
  if (expected.retryable !== undefined && result?.blocker?.retryable !== expected.retryable) {
    throw new Error(`Unexpected result blocker retryable: ${JSON.stringify(result?.blocker)} expected ${expected.retryable}`);
  }
  if (expected.nextStep !== undefined && result?.blocker?.next_step !== expected.nextStep) {
    throw new Error(`Unexpected result blocker next_step: ${JSON.stringify(result?.blocker)} expected ${expected.nextStep}`);
  }
}

function assertSearchResult(result, expected) {
  if (
    !Array.isArray(result?.matches) ||
    result.matches.length !== 1 ||
    result.matches[0]?.path !== expected.path ||
    result.matches[0]?.line !== expected.line ||
    result.matches[0]?.text !== expected.text
  ) {
    throw new Error(`Unexpected search result: ${JSON.stringify(result)} expected ${JSON.stringify(expected)}`);
  }
}

function assertTask(task, expected) {
  if (task?.id !== expected.taskId || task?.status !== expected.status) {
    throw new Error(`Unexpected task record: ${JSON.stringify(task)} expected ${JSON.stringify(expected)}`);
  }
  if (expected.title !== undefined && task?.title !== expected.title) {
    throw new Error(`Unexpected task title: ${JSON.stringify(task)} expected ${expected.title}`);
  }
  if (expected.claimedBy !== undefined && task?.claimed_by !== expected.claimedBy) {
    throw new Error(`Unexpected task claimer: ${JSON.stringify(task)} expected ${expected.claimedBy}`);
  }
}

function assertTaskInList(tasks, expected) {
  if (!Array.isArray(tasks)) {
    throw new Error(`Unexpected task list: ${JSON.stringify(tasks)}`);
  }
  if (!tasks.some((task) => task?.id === expected.taskId && task?.status === expected.status)) {
    throw new Error(`Missing task in list: ${JSON.stringify(expected)} from ${JSON.stringify(tasks)}`);
  }
}

function assertResultInList(results, expected) {
  if (!Array.isArray(results)) {
    throw new Error(`Unexpected result list: ${JSON.stringify(results)}`);
  }
  if (!results.some((result) => result?.task_id === expected.taskId && result?.status === expected.status && result?.summary === expected.summary)) {
    throw new Error(`Missing result in list: ${JSON.stringify(expected)} from ${JSON.stringify(results)}`);
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
