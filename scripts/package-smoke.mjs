#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

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

assertSmokeRedaction();

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
  assertIncludes(help.stdout, "gptprouse onboard", "installed help output");
  assertIncludes(help.stdout, "gptprouse release status", "installed help output");
  assertIncludes(help.stdout, "gptprouse project prompt", "installed help output");
  assertIncludes(help.stdout, "gptprouse claude prompt", "installed help output");
  assertIncludes(help.stdout, "gptprouse claude config", "installed help output");
  assertIncludes(help.stdout, "gptprouse pro ask [--dry-run] [--file path]", "installed help output");
  assertIncludes(help.stdout, "gptprouse pro browser login [--dry-run]", "installed help output");
  assertIncludes(help.stdout, "gptprouse pro latest", "installed help output");
  assertIncludes(help.stdout, "gptprouse pro list", "installed help output");
  assertIncludes(help.stdout, "gptprouse pro show <task-id|latest>", "installed help output");
  assertIncludes(help.stdout, "gptprouse mcp [--cwd /absolute/path/to/repo]", "installed help output");
  assertIncludes(help.stdout, `gptprouse v${installedPackageJson.version}`, "installed help output");
  assertNotIncludes(help.stdout, "gptprouse ask-pro", "installed help output");
  assertNotIncludes(help.stdout, "gptprouse pro latest|list|show <task-id|latest>", "installed help output");
  assertNotIncludes(help.stdout, "gptprouse pro browser open|status", "installed help output");
  assertNotIncludes(help.stdout, "gptprouse chatgpt open|status|smoke", "installed help output");
  const freshDoctorDir = path.join(tmp, "fresh-doctor");
  await mkdir(freshDoctorDir, { recursive: true });
  const freshDoctor = await run(binPath, ["doctor"], { cwd: freshDoctorDir });
  assertIncludes(freshDoctor.stdout, "bridge: missing/incomplete", "installed fresh doctor output");
  assertNotIncludes((await readdir(freshDoctorDir)).join("\n"), ".bridge", "installed fresh doctor cwd entries");
  const installedPackageDir = path.join(consumerDir, "node_modules", "gptprouse");
  const releaseStatus = await run(binPath, ["release", "status", "--cwd", installedPackageDir], { cwd: consumerDir });
  assertIncludes(releaseStatus.stdout, "gptprouse release status", "installed release status output");
  assertIncludes(releaseStatus.stdout, "metadata: blocked", "installed release status output");
  assertIncludes(releaseStatus.stdout, "explicit license", "installed release status output");
  assertIncludes(releaseStatus.stdout, "pack:", "installed release status output");
  assertIncludes(releaseStatus.stdout, "git: blocked", "installed release status output");
  assertIncludes(releaseStatus.stdout, "not a git worktree", "installed release status output");
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
  const invalidLicenseDir = path.join(tmp, "invalid-license-release");
  await mkdir(invalidLicenseDir, { recursive: true });
  await writeFile(
    path.join(invalidLicenseDir, "package.json"),
    `${JSON.stringify({ name: "invalid-license-demo", version: "1.0.0", license: "MIT" }, null, 2)}\n`
  );
  await mkdir(path.join(invalidLicenseDir, "LICENSE"));
  const invalidLicenseReleaseStatus = await run(binPath, ["release", "status", "--cwd", invalidLicenseDir], { cwd: consumerDir });
  assertIncludes(invalidLicenseReleaseStatus.stdout, "metadata: blocked", "installed invalid LICENSE release status output");
  assertIncludes(invalidLicenseReleaseStatus.stdout, "license_file=invalid", "installed invalid LICENSE release status output");
  assertNotIncludes(invalidLicenseReleaseStatus.stdout, "metadata: ok", "installed invalid LICENSE release status output");
  await smokeInstalledReleaseGitReadiness(binPath, tmp, consumerDir);
  const onboard = await run(binPath, ["onboard", "--cwd", consumerDir], { cwd: path.dirname(consumerDir) });
  assertIncludes(onboard.stdout, "gptprouse onboarding", "installed onboard output");
  assertIncludes(onboard.stdout, `gptprouse init --cwd ${consumerDir}`, "installed onboard output");
  assertIncludes(onboard.stdout, `gptprouse doctor --cwd ${consumerDir}`, "installed onboard output");
  assertIncludes(onboard.stdout, `gptprouse claude config --cwd ${consumerDir}`, "installed onboard output");
  assertIncludes(onboard.stdout, `gptprouse claude prompt --cwd ${consumerDir}`, "installed onboard output");
  assertIncludes(onboard.stdout, `gptprouse setup --cwd ${consumerDir} --token-ttl-hours 24`, "installed onboard output");
  assertIncludes(
    onboard.stdout,
    "Keep this terminal open while ChatGPT uses the bridge; run the next commands in a second terminal.",
    "installed onboard output"
  );
  assertIncludes(onboard.stdout, `gptprouse project prompt --cwd ${consumerDir}`, "installed onboard output");
  assertAppearsBefore(
    onboard.stdout,
    "HTTP MCP uses a short-lived token",
    `gptprouse status --cwd ${consumerDir} --show-token --url-only`,
    "installed onboard output"
  );
  assertIncludes(onboard.stdout, `cd ${consumerDir}`, "installed onboard output");
  assertIncludes(onboard.stdout, 'gptprouse pro ask "Review this repo"  # dry-run/manual preview', "installed onboard output");
  assertNotIncludes(onboard.stdout, "--file README.md", "installed onboard output");
  assertIncludes(onboard.stdout, "gptprouse pro browser login --dry-run  # preview, no browser opens", "installed onboard output");
  assertIncludes(onboard.stdout, "gptprouse pro browser login  # opens visible browser", "installed onboard output");
  assertIncludes(onboard.stdout, 'gptprouse pro browser ask "Review this repo"  # visible-browser send', "installed onboard output");
  assertIncludes(onboard.stdout, "Cloudflare", "installed onboard output");
  assertIncludes(onboard.stdout, "usage-limit", "installed onboard output");
  assertNotIncludes(onboard.stdout, "gptprouse_token=", "installed onboard output");
  const missingCwd = path.join(consumerDir, "missing-repo");
  const missingCwdOnboard = await runExpectFailure(binPath, ["onboard", "--cwd", missingCwd], { cwd: path.dirname(consumerDir) });
  assertIncludes(missingCwdOnboard.stderr, `--cwd does not exist or is not accessible: ${missingCwd}`, "installed missing cwd output");
  assertNotIncludes(missingCwdOnboard.stderr, "ENOENT", "installed missing cwd output");
  const fileCwd = path.join(consumerDir, "not-a-repo-dir.txt");
  await writeFile(fileCwd, "not a directory\n", "utf8");
  const fileCwdStatus = await runExpectFailure(binPath, ["status", "--cwd", fileCwd], { cwd: path.dirname(consumerDir) });
  assertIncludes(fileCwdStatus.stderr, `--cwd must be a directory: ${fileCwd}`, "installed file cwd output");
  assertNotIncludes(fileCwdStatus.stderr, "ENOTDIR", "installed file cwd output");
  const missingSourceCli = path.join(consumerDir, "missing-dist-cli.js");
  const missingSourceCliConfig = await runExpectFailure(binPath, ["claude", "config", "--cwd", consumerDir, "--source-cli", missingSourceCli], {
    cwd: path.dirname(consumerDir)
  });
  assertIncludes(missingSourceCliConfig.stderr, `--source-cli does not exist or is not accessible: ${missingSourceCli}`, "installed missing source-cli output");
  assertNotIncludes(missingSourceCliConfig.stderr, "ENOENT", "installed missing source-cli output");
  const sourceCliDir = path.join(consumerDir, "dist");
  await mkdir(sourceCliDir, { recursive: true });
  const directorySourceCliConfig = await runExpectFailure(binPath, ["claude", "config", "--cwd", consumerDir, "--source-cli", sourceCliDir], {
    cwd: path.dirname(consumerDir)
  });
  assertIncludes(directorySourceCliConfig.stderr, `--source-cli must be a file: ${sourceCliDir}`, "installed directory source-cli output");
  const missingSetupStatus = await runExpectFailure(binPath, ["status"], { cwd: consumerDir });
  assertIncludes(missingSetupStatus.stderr, "Run `gptprouse setup` first.", "installed missing setup status output");
  assertNotIncludes(missingSetupStatus.stderr, "Run `gptprouse setup --token-ttl-hours <hours>` first.", "installed missing setup status output");
  const missingSetupTunnel = await runExpectFailure(
    binPath,
    ["tunnel", "url", "--public-url", "https://gptprouse-package-smoke.example", "--show-token", "--url-only"],
    { cwd: consumerDir }
  );
  assertIncludes(missingSetupTunnel.stderr, "tunnel url requires local MCP setup. Run `gptprouse setup` first.", "installed missing setup tunnel output");
  assertNotIncludes(missingSetupTunnel.stderr, "ENOENT", "installed missing setup tunnel output");
  const projectPrompt = await run(binPath, ["project", "prompt", "--cwd", consumerDir], { cwd: path.dirname(consumerDir) });
  assertIncludes(projectPrompt.stdout, "ChatGPT Project MCP verification prompt", "installed project prompt output");
  assertIncludes(projectPrompt.stdout, "bridge_create_task", "installed project prompt output");
  assertIncludes(projectPrompt.stdout, "bridge_list_tasks", "installed project prompt output");
  assertIncludes(projectPrompt.stdout, "bridge_get_task", "installed project prompt output");
  assertIncludes(projectPrompt.stdout, "gptprouse tasks list --status new", "installed project prompt output");
  assertNotIncludes(projectPrompt.stdout, "gptprouse_token=", "installed project prompt output");
  const claudePrompt = await run(binPath, ["claude", "prompt", "--cwd", consumerDir], { cwd: path.dirname(consumerDir) });
  assertIncludes(claudePrompt.stdout, "Claude MCP verification prompt", "installed Claude prompt output");
  assertIncludes(claudePrompt.stdout, "bridge_create_task", "installed Claude prompt output");
  assertIncludes(claudePrompt.stdout, "bridge_list_tasks", "installed Claude prompt output");
  assertIncludes(claudePrompt.stdout, "bridge_get_task", "installed Claude prompt output");
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
  assertIncludes(browserLoginGuide.stdout, "Dry run: no browser was opened.", "installed browser login guide");
  assertIncludes(browserLoginGuide.stdout, "Cloudflare", "installed browser login guide");
  assertIncludes(browserLoginGuide.stdout, "usage limit", "installed browser login guide");
  assertIncludes(browserLoginGuide.stdout, "gptprouse pro browser check", "installed browser login guide");
  assertIncludes(browserLoginGuide.stdout, "gptprouse pro browser smoke", "installed browser login guide");
  assertIncludes(
    browserLoginGuide.stdout,
    "Run `gptprouse pro browser login` without `--dry-run` to open the dedicated Chrome window.",
    "installed browser login guide"
  );
  assertNotIncludes(browserLoginGuide.stdout, "You can close this Chrome window after login", "installed browser login guide");
  assertNotIncludes(browserLoginGuide.stdout, "node dist/cli.js", "installed browser login guide");
  const browserHelp = await run(binPath, ["pro", "browser", "help"], { cwd: consumerDir });
  assertIncludes(browserHelp.stdout, "gptprouse pro browser login [--dry-run]", "installed browser help");
  assertIncludes(
    browserHelp.stdout,
    'gptprouse pro browser ask [--port 9333] [--timeout-ms 90000] [--target-url url --confirm-target] [--file path] "prompt"',
    "installed browser help"
  );
  const invalidBrowserPort = await runExpectFailure(binPath, ["pro", "browser", "check", "--port", "-1", "--timeout-ms", "10"], {
    cwd: consumerDir
  });
  assertIncludes(invalidBrowserPort.stderr, "--port must be an integer from 1 to 65535", "installed invalid browser port output");
  const invalidBrowserTimeout = await runExpectFailure(binPath, ["pro", "browser", "check", "--port", "65534", "--timeout-ms", "0"], {
    cwd: consumerDir
  });
  assertIncludes(invalidBrowserTimeout.stderr, "--timeout-ms must be greater than 0", "installed invalid browser timeout output");
  const invalidTokenTtl = await runExpectFailure(binPath, ["setup", "--token-ttl-hours", "0"], {
    cwd: consumerDir
  });
  assertIncludes(invalidTokenTtl.stderr, "--token-ttl-hours must be greater than 0", "installed invalid token TTL output");
  await assertMissingFile(path.join(consumerDir, ".bridge"), "installed consumer bridge after invalid token TTL");
  const invalidProAskPort = await runExpectFailure(binPath, ["pro", "browser", "ask", "--port", "-1", "--timeout-ms", "10", "Review this"], {
    cwd: consumerDir
  });
  assertIncludes(invalidProAskPort.stderr, "--port must be an integer from 1 to 65535", "installed invalid pro browser ask port output");
  await assertMissingFile(path.join(consumerDir, ".bridge"), "installed consumer bridge after invalid pro browser ask port");
  const invalidProAskTimeout = await runExpectFailure(binPath, ["pro", "browser", "ask", "--port", "65534", "--timeout-ms", "0", "Review this"], {
    cwd: consumerDir
  });
  assertIncludes(invalidProAskTimeout.stderr, "--timeout-ms must be greater than 0", "installed invalid pro browser ask timeout output");
  await assertMissingFile(path.join(consumerDir, ".bridge"), "installed consumer bridge after invalid pro browser ask timeout");
  const missingProAskFile = await runExpectFailure(binPath, ["pro", "ask", "--file", "missing.md", "Review this"], {
    cwd: consumerDir
  });
  assertIncludes(missingProAskFile.stderr, "Path missing.md was not found in the repo", "installed missing pro ask file output");
  assertNotIncludes(missingProAskFile.stderr, "ENOENT", "installed missing pro ask file output");
  assertNotIncludes(missingProAskFile.stderr, "realpath", "installed missing pro ask file output");
  await assertMissingFile(path.join(consumerDir, ".bridge"), "installed consumer bridge after missing pro ask file");
  await assertMissingFile(path.join(consumerDir, ".bridge"), "installed consumer bridge before pro ask alias guard");
  const proAskSendAlias = await runExpectFailure(binPath, ["pro", "ask", "--send", "--timeout-ms", "1", "Review this"], {
    cwd: consumerDir
  });
  assertIncludes(proAskSendAlias.stderr, "pro ask is a dry-run preview", "installed pro ask send alias guard");
  assertIncludes(proAskSendAlias.stderr, "pro browser ask", "installed pro ask send alias guard");
  const rawAskProSend = await runExpectFailure(binPath, ["ask-pro", "--send", "--timeout-ms", "1", "Review this"], {
    cwd: consumerDir
  });
  assertIncludes(rawAskProSend.stderr, "Direct ask-pro --send is disabled", "installed raw ask-pro send guard");
  assertIncludes(rawAskProSend.stderr, "pro browser ask", "installed raw ask-pro send guard");
  const conflictingProBrowserAsk = await runExpectFailure(binPath, ["pro", "browser", "ask", "--dry-run", "--send", "Review this"], {
    cwd: consumerDir
  });
  assertIncludes(conflictingProBrowserAsk.stderr, "cannot combine --dry-run and --send", "installed pro browser ask mode guard");
  const browserSmoke = await runExpectFailure(binPath, ["pro", "browser", "smoke", "--port", "65534", "--timeout-ms", "10"], {
    cwd: consumerDir,
    timeout: 60_000
  });
  assertIncludes(browserSmoke.stderr, "No Chrome DevTools endpoint is reachable", "installed pro browser smoke output");
  assertIncludes(browserSmoke.stderr, "gptprouse pro browser login", "installed pro browser smoke output");
  for (const [alias, replacement] of [
    ["open", "login"],
    ["status", "check"],
    ["doctor", "check"]
  ]) {
    const staleAlias = await runExpectFailure(binPath, ["pro", "browser", alias, "--port", "65534", "--timeout-ms", "1"], {
      cwd: consumerDir
    });
    assertIncludes(staleAlias.stderr, `Use \`gptprouse pro browser ${replacement}\``, `installed pro browser ${alias} alias guard`);
  }
  for (const command of [
    ["tasks", "list"],
    ["receipts", "list"],
    ["sessions", "list"],
    ["pro", "list"]
  ]) {
    await run(binPath, command, { cwd: consumerDir });
  }
  for (const [command, expectedMessage] of [
    [["tasks", "show", "latest"], "No tasks found"],
    [["results", "show", "latest"], "No results found"],
    [["results", "artifact", "latest"], "No results found"],
    [["receipts", "show", "latest"], "No receipts found"],
    [["sessions", "show", "latest"], "No sessions found"],
    [["pro", "show", "latest"], "No GPT Pro answers found"]
  ]) {
    const latestFailure = await runExpectFailure(binPath, command, { cwd: consumerDir });
    assertIncludes(latestFailure.stderr, expectedMessage, `installed empty ${command.join(" ")} output`);
  }
  for (const [command, expectedMessage] of [
    [["tasks", "show", "task_20990101_000000_missing"], "Task not found: task_20990101_000000_missing"],
    [["results", "show", "task_20990101_000000_missing"], "Result not found: task_20990101_000000_missing"],
    [["receipts", "show", "receipt_20990101_000000_missing"], "Receipt not found: receipt_20990101_000000_missing"],
    [["sessions", "show", "sess_20990101_000000_missing"], "Session not found: sess_20990101_000000_missing"]
  ]) {
    const missingRecord = await runExpectFailure(binPath, command, { cwd: consumerDir });
    assertIncludes(missingRecord.stderr, expectedMessage, `installed missing ${command.join(" ")} output`);
    assertNotIncludes(missingRecord.stderr, "ENOENT", `installed missing ${command.join(" ")} output`);
    assertNotIncludes(missingRecord.stderr, "lstat", `installed missing ${command.join(" ")} output`);
    assertNotIncludes(missingRecord.stderr, "no such file", `installed missing ${command.join(" ")} output`);
  }
  const legacyConsults = await runExpectFailure(binPath, ["consults", "list"], { cwd: consumerDir });
  assertIncludes(legacyConsults.stderr, "legacy `consults` alias is retired", "installed consults alias guard");
  assertIncludes(legacyConsults.stderr, "gptprouse pro list", "installed consults alias guard");
  await assertMissingFile(path.join(consumerDir, ".bridge"), "installed consumer bridge after pro ask alias guard");

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
  await smokeInstalledProBlockedConsult(binPath, consumerDir);

  const httpRepoDir = path.join(tmp, "http-repo");
  await mkdir(httpRepoDir, { recursive: true });
  await smokeInstalledHttpOnboarding(binPath, httpRepoDir);
  await assertInstalledDocsArePortable(consumerDir);
  await assertInstalledPackageImportBoundary(consumerDir, packed.files);

  const stdioRepoDir = path.join(tmp, "stdio-repo");
  await mkdir(stdioRepoDir, { recursive: true });
  const tools = await smokeStdioMcp(binPath, stdioRepoDir);
  for (const tool of REQUIRED_MCP_TOOLS) {
    if (!tools.includes(tool)) throw new Error(`Installed MCP catalog is missing ${tool}`);
  }
  await smokeInstalledStdioTaskFinalizers(binPath, consumerDir);

  console.log(
    `package_smoke: ok tarball=${path.basename(packed.filename)} http_onboarding=ok installed_http_mcp=ok http_write_flow=ok http_task_finalizers=ok http_result_artifact_flow=ok http_result_artifact_tamper=ok configured_doctor=ok tunnel_url=ok package_boundary=ok stdio_write_flow=ok stdio_task_flow=ok stdio_task_finalizers=ok stdio_result_artifact_flow=ok stdio_result_artifact_tamper=ok tools=${REQUIRED_MCP_TOOLS.join(",")}`
  );
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
  const installedDocs = [
    ["installed README", readme],
    ["installed HTTP MCP docs", httpMcpDoc],
    ["installed Claude docs", claudeDoc]
  ];
  for (const leakedPath of portablePathLeakCandidates()) {
    for (const [label, text] of installedDocs) {
      assertNotIncludes(text, leakedPath, label);
    }
  }
  assertIncludes(readme, "For an installed package", "installed README");
  assertIncludes(readme, "gptprouse onboard", "installed README");
  assertIncludes(readme, 'gptprouse pro ask "Review the project positioning"', "installed README");
  assertIncludes(readme, "gptprouse pro browser login --dry-run", "installed README");
  assertIncludes(readme, "gptprouse init", "installed README");
  assertIncludes(readme, "CLI-only", "installed README");
  assertIncludes(readme, "ripgrep", "installed README");
  assertIncludes(readme, "setup --cwd", "installed README");
  assertIncludes(readme, "mcp --cwd", "installed README");
  assertIncludes(readme, "gptprouse project prompt", "installed README");
  assertIncludes(readme, "gptprouse claude prompt", "installed README");
  assertIncludes(readme, "gptprouse claude config", "installed README");
  assertIncludes(readme, "gptprouse release status", "installed README");
  assertIncludes(readme, "pack file-mode or hard-link blockers", "installed README");
  assertIncludes(readme, "Run `pro ask` and `pro browser ask` from the repo root", "installed README");
  assertIncludes(readme, "npm run release:verify", "installed README");
  assertIncludes(readme, "regular file", "installed README");
  assertIncludes(readme, "hard link", "installed README");
  assertIncludes(readme, "unexpected executable modes", "installed README");
  assertNotIncludes(readme, "hard links outside the package `bin` entries", "installed README");
  assertIncludes(readme, "WSL/Windows mount", "installed README");
  assertIncludes(readme, "npm-publishable `name` and valid semver `version`", "installed README");
  assertIncludes(readme, "installed HTTP MCP repo write dry-run/apply/stage flow", "installed README");
  assertIncludes(readme, "installed HTTP MCP task completion/blocking/result/artifact fetch flow", "installed README");
  assertIncludes(readme, "installed stdio repo write dry-run/apply/stage flow", "installed README");
  assertIncludes(readme, "installed stdio task completion/blocking/result/artifact fetch flow", "installed README");
  assertIncludes(readme, "loopback-only", "installed README");
  assertIncludes(readme, "`start` reads the saved setup profile when the server process starts", "installed README");
  assertIncludes(readme, "restart `gptprouse start` so the running server uses the new profile", "installed README");
  assertIncludes(readme, "`tunnel url` formats your supplied public tunnel URL with the saved token", "installed README");
  assertNotIncludes(readme, "running server stay on the same host, port, and token", "installed README");
  assertIncludes(readme, "private: true", "installed README");
  assertIncludes(readme, "configured `doctor`", "installed README");
  assertIncludes(readme, ".bridge/artifacts/results/", "installed README");
  assertIncludes(readme, "generic MCP handoff artifacts", "installed README");
  assertIncludes(readme, "sha256 recorded at finalization", "installed README");
  assertIncludes(readme, "answer_artifact_warning", "installed README");
  assertIncludes(readme, "too large for `bridge_fetch_result_artifact`", "installed README");
  assertIncludes(readme, "more than one ChatGPT tab or window is visible", "installed README");
  assertIncludes(readme, "blocker code and next step", "installed README");
  assertIncludes(readme, "fatal finalization failures print the received answer", "installed README");
  assertIncludes(readme, "connects to the installed `/mcp` endpoint", "installed README");
  assertIncludes(readme, "verifies explicit `--cwd` task storage", "installed README");
  assertNotIncludes(readme, "ask-pro --send", "installed README");
  assertNotIncludes(readme, "start --host", "installed README");
  assertNotIncludes(readme, "Read-only result artifact fetch for Pro consult artifacts explicitly listed", "installed README");
  assertAppearsBefore(
    readme,
    "Token-bearing MCP URLs are secrets",
    "gptprouse status --show-token --url-only",
    "installed README token URL warning"
  );
  assertAppearsBefore(
    readme,
    "Public tunnel MCP URLs are also secrets",
    "gptprouse tunnel url --public-url \"https://your-tunnel.example\" --show-token --url-only",
    "installed README tunnel token URL warning"
  );
  assertIncludes(httpMcpDoc, "For an installed package", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, "ripgrep", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, "setup --cwd", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, "gptprouse setup --token-ttl-hours 24", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, "gptprouse project prompt", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, "Verify In ChatGPT", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, "Keep `gptprouse start` running", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, "loopback-only", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, "`start` reads the saved setup profile when the server process starts", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, "restart `gptprouse start` so the running server uses the new profile", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, "`tunnel url` formats your supplied public tunnel URL with the saved token", "installed HTTP MCP docs");
  assertNotIncludes(httpMcpDoc, "running server matches the URL printed by `status` and `tunnel url`", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, "CLI-only", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, ".bridge/artifacts/results/", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, "fetch rejects the artifact if its content changed afterward", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, "oversized result artifacts", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, "too large for `bridge_fetch_result_artifact`", "installed HTTP MCP docs");
  assertNotIncludes(httpMcpDoc, "start --host", "installed HTTP MCP docs");
  assertAppearsBefore(
    httpMcpDoc,
    "Token-bearing MCP URLs are secrets",
    "gptprouse status --show-token --url-only",
    "installed HTTP MCP docs token URL warning"
  );
  assertAppearsBefore(
    httpMcpDoc,
    "Token-bearing MCP URLs are secrets",
    "gptprouse status --cwd /absolute/path/to/your/repo --show-token --url-only",
    "installed HTTP MCP docs cwd token URL warning"
  );
  assertAppearsBefore(
    httpMcpDoc,
    "Public tunnel MCP URLs are also secrets",
    "gptprouse tunnel url --public-url \"https://your-tunnel.example\" --show-token --url-only",
    "installed HTTP MCP docs tunnel token URL warning"
  );
  assertAppearsBefore(
    httpMcpDoc,
    "Public tunnel MCP URLs are also secrets",
    "gptprouse tunnel url --cwd /absolute/path/to/your/repo --public-url \"https://your-tunnel.example\" --show-token --url-only",
    "installed HTTP MCP docs cwd tunnel token URL warning"
  );
  assertIncludes(claudeDoc, "CLI-only", "installed Claude docs");
  assertIncludes(claudeDoc, "ripgrep", "installed Claude docs");
  assertIncludes(claudeDoc, "mcp --cwd", "installed Claude docs");
  assertIncludes(claudeDoc, "gptprouse claude prompt", "installed Claude docs");
  assertIncludes(claudeDoc, "gptprouse claude config", "installed Claude docs");
  assertIncludes(claudeDoc, ".bridge/artifacts/results/", "installed Claude docs");
  assertIncludes(claudeDoc, "fetch rejects the artifact if its content changed afterward", "installed Claude docs");
  assertIncludes(claudeDoc, "oversized result artifacts", "installed Claude docs");
  assertIncludes(claudeDoc, "too large for `bridge_fetch_result_artifact`", "installed Claude docs");
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

async function smokeInstalledProBlockedConsult(binPath, cwd) {
  const created = await run(
    binPath,
    ["tasks", "create", "--title", "GPT Pro consult", "--prompt", "Installed blocked consult smoke"],
    { cwd }
  );
  const taskId = created.stdout.split("\t")[0];
  if (!taskId?.startsWith("task_")) {
    throw new Error(`Installed blocked consult smoke could not parse task id: ${created.stdout}`);
  }
  await run(binPath, ["tasks", "claim", taskId, "--by", "chatgpt-pro"], { cwd });
  await run(
    binPath,
    [
      "tasks",
      "block",
      taskId,
      "--summary",
      "Visible browser login is required.",
      "--code",
      "browser_send_failed",
      "--next-step",
      "Log in manually, then retry.",
      "--retryable",
      "--command",
      "visible ChatGPT browser consult"
    ],
    { cwd }
  );
  const latest = await run(binPath, ["pro", "latest"], { cwd });
  assertIncludes(latest.stdout, "status: blocked", "installed pro latest blocked output");
  assertIncludes(latest.stdout, "blocker:", "installed pro latest blocked output");
  assertIncludes(latest.stdout, "- code: browser_send_failed", "installed pro latest blocked output");
  assertIncludes(latest.stdout, "- retryable: true", "installed pro latest blocked output");
  assertIncludes(latest.stdout, "- next_step: Log in manually, then retry.", "installed pro latest blocked output");
  const check = await run(binPath, ["pro", "browser", "check", "--port", "65534", "--timeout-ms", "10"], { cwd, timeout: 60_000 });
  assertIncludes(check.stdout, `latest_pro: blocked ${taskId}`, "installed pro browser check blocked output");
  assertNotIncludes(check.stdout, `latest_pro: ok ${taskId} blocked`, "installed pro browser check blocked output");
}

async function smokeInstalledReleaseGitReadiness(binPath, tmp, launcherCwd) {
  const invalidNameDir = path.join(tmp, "release-invalid-name");
  await mkdir(invalidNameDir, { recursive: true });
  await writeFile(
    path.join(invalidNameDir, "package.json"),
    `${JSON.stringify({ name: "Bad Name", version: "1.0.0", license: "MIT" }, null, 2)}\n`
  );
  await writeFile(path.join(invalidNameDir, "LICENSE"), "MIT License\n");
  const invalidName = await run(binPath, ["release", "status", "--cwd", invalidNameDir], { cwd: launcherCwd });
  assertIncludes(invalidName.stdout, "metadata: blocked", "installed release status invalid name output");
  assertIncludes(invalidName.stdout, "name must be npm-publishable", "installed release status invalid name output");

  const reservedNameDir = path.join(tmp, "release-reserved-name");
  await mkdir(reservedNameDir, { recursive: true });
  await writeFile(
    path.join(reservedNameDir, "package.json"),
    `${JSON.stringify({ name: "node_modules", version: "1.0.0", license: "MIT" }, null, 2)}\n`
  );
  await writeFile(path.join(reservedNameDir, "LICENSE"), "MIT License\n");
  const reservedName = await run(binPath, ["release", "status", "--cwd", reservedNameDir], { cwd: launcherCwd });
  assertIncludes(reservedName.stdout, "metadata: blocked", "installed release status reserved name output");
  assertIncludes(reservedName.stdout, "name must be npm-publishable", "installed release status reserved name output");

  const invalidVersionDir = path.join(tmp, "release-invalid-version");
  await mkdir(invalidVersionDir, { recursive: true });
  await writeFile(
    path.join(invalidVersionDir, "package.json"),
    `${JSON.stringify({ name: "demo", version: "1.0", license: "MIT" }, null, 2)}\n`
  );
  await writeFile(path.join(invalidVersionDir, "LICENSE"), "MIT License\n");
  const invalidVersion = await run(binPath, ["release", "status", "--cwd", invalidVersionDir], { cwd: launcherCwd });
  assertIncludes(invalidVersion.stdout, "metadata: blocked", "installed release status invalid version output");
  assertIncludes(invalidVersion.stdout, "version must be valid semver", "installed release status invalid version output");

  const noRemoteDir = await createReleaseGitFixture(path.join(tmp, "release-no-remote"), { remote: false });
  const noRemote = await run(binPath, ["release", "status", "--cwd", noRemoteDir], { cwd: launcherCwd });
  assertIncludes(noRemote.stdout, "metadata: ok", "installed release status no-remote output");
  assertIncludes(noRemote.stdout, "git: blocked no remote", "installed release status no-remote output");

  const dirtyDir = await createReleaseGitFixture(path.join(tmp, "release-dirty"), { remote: true });
  await writeFile(path.join(dirtyDir, "README.md"), "dirty\n");
  const dirty = await run(binPath, ["release", "status", "--cwd", dirtyDir], { cwd: launcherCwd });
  assertIncludes(dirty.stdout, "git: blocked worktree has uncommitted changes", "installed release status dirty output");

  const detachedDir = await createReleaseGitFixture(path.join(tmp, "release-detached"), { remote: true });
  await execFileAsync("git", ["checkout", "--detach", "HEAD"], { cwd: detachedDir });
  const detached = await run(binPath, ["release", "status", "--cwd", detachedDir], { cwd: launcherCwd });
  assertIncludes(detached.stdout, "git: blocked detached HEAD", "installed release status detached output");

  const noUpstreamDir = await createReleaseGitFixture(path.join(tmp, "release-no-upstream"), {
    remote: true,
    upstream: false
  });
  const noUpstream = await run(binPath, ["release", "status", "--cwd", noUpstreamDir], { cwd: launcherCwd });
  assertIncludes(noUpstream.stdout, "git: blocked no upstream configured", "installed release status no-upstream output");

  const unpushedDir = await createReleaseGitFixture(path.join(tmp, "release-unpushed"), { remote: true });
  await writeFile(path.join(unpushedDir, "README.md"), "unpushed\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: unpushedDir });
  await execFileAsync("git", ["commit", "-m", "unpushed"], { cwd: unpushedDir });
  const unpushed = await run(binPath, ["release", "status", "--cwd", unpushedDir], { cwd: launcherCwd });
  assertIncludes(unpushed.stdout, "git: blocked branch has unpushed commits", "installed release status unpushed output");

  const okDir = await createReleaseGitFixture(path.join(tmp, "release-ok"), { remote: true });
  const ok = await run(binPath, ["release", "status", "--cwd", okDir], { cwd: launcherCwd });
  assertIncludes(ok.stdout, "metadata: ok", "installed release status ok output");
  assertIncludes(ok.stdout, "git: ok", "installed release status ok output");
  assertIncludes(ok.stdout, "upstream=origin/", "installed release status ok output");
}

async function createReleaseGitFixture(cwd, options) {
  await mkdir(cwd, { recursive: true });
  await writeFile(path.join(cwd, "package.json"), `${JSON.stringify({ name: path.basename(cwd), version: "1.0.0", license: "MIT" }, null, 2)}\n`);
  await writeFile(path.join(cwd, "LICENSE"), "MIT License\n");
  await execFileAsync("git", ["init"], { cwd });
  await execFileAsync("git", ["config", "user.email", "release@example.com"], { cwd });
  await execFileAsync("git", ["config", "user.name", "GPTProUse Package Smoke"], { cwd });
  await execFileAsync("git", ["add", "package.json", "LICENSE"], { cwd });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd });
  if (options.remote) {
    const remoteDir = path.join(path.dirname(cwd), `${path.basename(cwd)}-remote.git`);
    await execFileAsync("git", ["init", "--bare", remoteDir], { cwd: path.dirname(cwd) });
    await execFileAsync("git", ["remote", "add", "origin", remoteDir], { cwd });
    if (options.upstream !== false) {
      const branch = (await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd })).stdout.trim();
      await execFileAsync("git", ["push", "-u", "origin", branch], { cwd });
    }
  }
  return cwd;
}

async function smokeStdioMcp(binPath, cwd) {
  await writeFile(path.join(cwd, "search-smoke.txt"), "before\n--package-rg-literal ok\nafter\n", "utf8");
  await writeFile(path.join(cwd, "notes.md"), "old\n", "utf8");
  const head = await initPackageSmokeGitRepo(cwd, ["search-smoke.txt", "notes.md"]);
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
    const dryRun = await callJsonTool(client, "repo_write_file_dry_run", {
      path: "notes.md",
      content: "new\n",
      expected_head: head
    });
    if (dryRun.receipt?.kind !== "repo_write_dry_run") {
      throw new Error(`Installed stdio write dry-run returned unexpected receipt: ${JSON.stringify(dryRun.receipt)}`);
    }
    if (dryRun.preimage_sha256 !== sha256("old\n")) {
      throw new Error(`Installed stdio write dry-run returned unexpected preimage hash: ${dryRun.preimage_sha256}`);
    }
    assertIncludes(dryRun.diff, "-old", "installed stdio write dry-run diff");
    assertIncludes(dryRun.diff, "+new", "installed stdio write dry-run diff");
    const applied = await callJsonTool(client, "repo_write_file_apply", {
      receipt_id: dryRun.receipt.id,
      expected_head: head,
      preimage_sha256: dryRun.preimage_sha256
    });
    if (applied.receipt?.kind !== "repo_write_applied") {
      throw new Error(`Installed stdio write apply returned unexpected receipt: ${JSON.stringify(applied.receipt)}`);
    }
    assertIncludes(await readFile(path.join(cwd, "notes.md"), "utf8"), "new\n", "installed stdio write apply file");
    const staged = await callJsonTool(client, "repo_stage_reviewed_paths", {
      receipt_ids: [applied.receipt.id],
      expected_head: head
    });
    if (staged.receipt?.kind !== "repo_stage_reviewed_paths") {
      throw new Error(`Installed stdio stage returned unexpected receipt: ${JSON.stringify(staged.receipt)}`);
    }
    if (!Array.isArray(staged.paths) || staged.paths.join(",") !== "notes.md") {
      throw new Error(`Installed stdio stage returned unexpected paths: ${JSON.stringify(staged.paths)}`);
    }
    const { stdout: stagedNames } = await execFileAsync("git", ["diff", "--cached", "--name-only"], { cwd });
    if (stagedNames.trim() !== "notes.md") {
      throw new Error(`Installed stdio stage did not stage notes.md, got: ${stagedNames.trim()}`);
    }
    return result.tools.map((tool) => tool.name);
  } finally {
    await closeStdioClient(client, transport, "installed stdio MCP client");
  }
}

async function initPackageSmokeGitRepo(cwd, files) {
  await execFileAsync("git", ["init"], { cwd });
  await execFileAsync("git", ["config", "user.email", "package-smoke@example.com"], { cwd });
  await execFileAsync("git", ["config", "user.name", "GPTProUse Package Smoke"], { cwd });
  await execFileAsync("git", ["add", ...files], { cwd });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd });
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
  return stdout.trim();
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
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
    const resultArtifactPath = `.bridge/artifacts/results/${doneTask.task.id}.md`;
    const resultArtifactContent = "Installed stdio MCP artifact answer.\n";
    await mkdir(path.join(cwd, ".bridge", "artifacts", "results"), { recursive: true });
    await writeFile(path.join(cwd, resultArtifactPath), resultArtifactContent, "utf8");
    const completed = await callJsonTool(client, "bridge_complete_task", {
      task_id: doneTask.task.id,
      summary: "Completed by installed stdio MCP",
      commands: ["package stdio finalizer smoke"],
      artifacts: [{ path: resultArtifactPath, role: "result", bytes: Buffer.byteLength(resultArtifactContent, "utf8") }]
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
    const fetchedArtifact = await callJsonTool(client, "bridge_fetch_result_artifact", {
      task_id: doneTask.task.id,
      path: resultArtifactPath
    });
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
    if (fetchedArtifact.content !== resultArtifactContent) {
      throw new Error(`Installed stdio result artifact content mismatch: ${JSON.stringify(fetchedArtifact)}`);
    }
    if (fetchedArtifact.artifact?.sha256 !== sha256(resultArtifactContent)) {
      throw new Error(`Installed stdio result artifact sha256 mismatch: ${JSON.stringify(fetchedArtifact)}`);
    }
    if (fetchedArtifact.artifact?.bytes !== Buffer.byteLength(resultArtifactContent, "utf8")) {
      throw new Error(`Installed stdio result artifact byte count mismatch: ${JSON.stringify(fetchedArtifact)}`);
    }
    await writeFile(path.join(cwd, resultArtifactPath), "Tampered installed stdio MCP artifact answer.\n", "utf8");
    await callToolExpectFailure(client, "bridge_fetch_result_artifact", {
      task_id: doneTask.task.id,
      path: resultArtifactPath
    }, "sha256");
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
  await writeFile(path.join(cwd, "http-notes.md"), "old\n", "utf8");
  const writeHead = await initPackageSmokeGitRepo(cwd, ["http-notes.md"]);

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
  const nonExpiringStatus = await run(binPath, ["status", "--cwd", nonExpiringCwd], { cwd: launcherCwd });
  assertIncludes(nonExpiringStatus.stdout, '"token_status": "non_expiring"', "installed non-expiring status output");
  assertNotIncludes(nonExpiringStatus.stdout, '"token_status": "none"', "installed non-expiring status output");
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
  const expiredStart = await runExpectFailure(binPath, ["start", "--cwd", expiredCwd], { cwd: launcherCwd, timeout: 10_000 });
  const expiredStartOutput = `${expiredStart.stdout}\n${expiredStart.stderr}`;
  assertIncludes(expiredStartOutput, "token expired", "installed expired start refusal");
  assertNotIncludes(expiredStartOutput, expiredToken, "installed expired start refusal");

  const staleUrlCwd = path.join(launcherCwd, "stale-url-http");
  await mkdir(path.join(staleUrlCwd, ".bridge"), { recursive: true });
  await writeFile(
    path.join(staleUrlCwd, ".bridge", "config.local.json"),
    `${JSON.stringify(
      {
        schema_version: 1,
        host: "127.0.0.1",
        port: 8792,
        token: "real-package-smoke-token",
        server_url: "http://127.0.0.1:8792/mcp?gptprouse_token=stale-package-smoke-token",
        token_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  const staleUrlReveal = await runExpectFailure(binPath, ["status", "--cwd", staleUrlCwd, "--show-token", "--url-only"], { cwd: launcherCwd });
  const staleUrlRevealOutput = `${staleUrlReveal.stdout}\n${staleUrlReveal.stderr}`;
  assertIncludes(staleUrlRevealOutput, "server_url must match host, port, and token", "installed stale server URL refusal");
  assertNotIncludes(staleUrlRevealOutput, "stale-package-smoke-token", "installed stale server URL refusal");
  assertNotIncludes(staleUrlRevealOutput, "real-package-smoke-token", "installed stale server URL refusal");

  const configuredDoctor = await run(binPath, ["doctor", "--cwd", cwd], { cwd: launcherCwd, timeout: 60_000 });
  assertIncludes(configuredDoctor.stdout, "config: ok", "installed configured doctor output");
  assertIncludes(configuredDoctor.stdout, "token_status=valid", "installed configured doctor output");
  assertIncludes(configuredDoctor.stdout, "gptprouse_token=***", "installed configured doctor output");
  assertNotIncludes(configuredDoctor.stdout, token, "installed configured doctor output");

  const pasteReady = await run(binPath, ["status", "--cwd", cwd, "--show-token", "--url-only"], { cwd: launcherCwd });
  if (pasteReady.stdout.trim() !== expectedUrl) {
    throw new Error(
      `Installed status --show-token --url-only returned ${redactSmokeSecrets(pasteReady.stdout.trim())}, expected ${redactSmokeSecrets(expectedUrl)}`
    );
  }

  const tunnelUrl = await run(
    binPath,
    ["tunnel", "url", "--cwd", cwd, "--public-url", "https://gptprouse-package-smoke.example/ignored", "--show-token", "--url-only"],
    { cwd: launcherCwd }
  );
  const expectedTunnelUrl = `https://gptprouse-package-smoke.example/mcp?gptprouse_token=${token}`;
  if (tunnelUrl.stdout.trim() !== expectedTunnelUrl) {
    throw new Error(`Installed tunnel url returned ${redactSmokeSecrets(tunnelUrl.stdout.trim())}, expected ${redactSmokeSecrets(expectedTunnelUrl)}`);
  }
  const invalidTunnelScheme = await runExpectFailure(
    binPath,
    ["tunnel", "url", "--cwd", cwd, "--public-url", "ftp://localhost:7777/dev", "--show-token", "--url-only"],
    { cwd: launcherCwd }
  );
  assertIncludes(invalidTunnelScheme.stderr, "--public-url must use http or https", "installed tunnel url invalid scheme output");

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
  let smokeFailed = false;
  try {
    await waitForHttpHealth(`http://127.0.0.1:${port}/health`, 20_000);
    await smokeInstalledHttpMcpEndpoint(expectedUrl, cwd, writeHead);
  } catch (error) {
    smokeFailed = true;
    throw error;
  } finally {
    try {
      await terminateChild(child, stdout, stderr);
    } catch (error) {
      if (!smokeFailed) throw error;
    }
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

async function smokeInstalledHttpMcpEndpoint(mcpUrl, cwd, writeHead) {
  const client = new Client({ name: "gptprouse-package-http-smoke", version: "0.2.0" });
  let failed = false;
  try {
    await withTimeout(
      client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl))),
      20_000,
      "Timed out connecting to installed HTTP MCP server"
    );
    const result = await withTimeout(client.listTools(), 20_000, "Timed out listing installed HTTP MCP tools");
    const names = result.tools.map((tool) => tool.name);
    for (const tool of REQUIRED_MCP_TOOLS) {
      if (!names.includes(tool)) throw new Error(`Installed HTTP MCP catalog is missing ${tool}`);
    }
    const created = await callJsonTool(client, "bridge_create_task", {
      title: "Installed HTTP MCP",
      prompt: "Verify installed HTTP MCP endpoint"
    });
    await assertBridgeTaskStoredInCwd(cwd, created.task.id);
    const resultArtifactPath = ".bridge/artifacts/results/installed-http-answer.md";
    const resultArtifactContent = "Installed HTTP MCP artifact answer.\n";
    await mkdir(path.join(cwd, ".bridge", "artifacts", "results"), { recursive: true });
    await writeFile(path.join(cwd, resultArtifactPath), resultArtifactContent, "utf8");
    const completed = await callJsonTool(client, "bridge_complete_task", {
      task_id: created.task.id,
      summary: "Completed by installed HTTP MCP",
      commands: ["package http result smoke"],
      artifacts: [{ path: resultArtifactPath, role: "result", bytes: Buffer.byteLength(resultArtifactContent, "utf8") }]
    });
    const fetchedResult = await callJsonTool(client, "bridge_fetch_result", { task_id: created.task.id });
    const fetchedArtifact = await callJsonTool(client, "bridge_fetch_result_artifact", {
      task_id: created.task.id,
      path: resultArtifactPath
    });
    const blockedTask = await callJsonTool(client, "bridge_create_task", {
      title: "Installed HTTP MCP block",
      prompt: "Verify installed HTTP MCP blocking path"
    });
    await assertBridgeTaskStoredInCwd(cwd, blockedTask.task.id);
    const blocked = await callJsonTool(client, "bridge_block_task", {
      task_id: blockedTask.task.id,
      summary: "Blocked by installed HTTP MCP",
      code: "package_http_smoke_blocker",
      retryable: true,
      next_step: "Inspect installed HTTP smoke output."
    });
    const fetchedBlocked = await callJsonTool(client, "bridge_fetch_result", { task_id: blockedTask.task.id });
    const results = await callJsonTool(client, "bridge_list_results", {});
    assertResult(completed.result, {
      taskId: created.task.id,
      status: "done",
      summary: "Completed by installed HTTP MCP",
      commands: ["package http result smoke"]
    });
    assertResult(fetchedResult.result, {
      taskId: created.task.id,
      status: "done",
      summary: "Completed by installed HTTP MCP",
      commands: ["package http result smoke"]
    });
    assertResultInList(results.results, {
      taskId: created.task.id,
      status: "done",
      summary: "Completed by installed HTTP MCP"
    });
    assertResult(blocked.result, {
      taskId: blockedTask.task.id,
      status: "blocked",
      summary: "Blocked by installed HTTP MCP",
      blockerCode: "package_http_smoke_blocker",
      retryable: true,
      nextStep: "Inspect installed HTTP smoke output."
    });
    assertResult(fetchedBlocked.result, {
      taskId: blockedTask.task.id,
      status: "blocked",
      summary: "Blocked by installed HTTP MCP",
      blockerCode: "package_http_smoke_blocker",
      retryable: true,
      nextStep: "Inspect installed HTTP smoke output."
    });
    assertResultInList(results.results, {
      taskId: blockedTask.task.id,
      status: "blocked",
      summary: "Blocked by installed HTTP MCP"
    });
    if (fetchedArtifact.content !== resultArtifactContent) {
      throw new Error(`Installed HTTP result artifact content mismatch: ${JSON.stringify(fetchedArtifact)}`);
    }
    if (fetchedArtifact.artifact?.sha256 !== sha256(resultArtifactContent)) {
      throw new Error(`Installed HTTP result artifact sha256 mismatch: ${JSON.stringify(fetchedArtifact)}`);
    }
    if (fetchedArtifact.artifact?.bytes !== Buffer.byteLength(resultArtifactContent, "utf8")) {
      throw new Error(`Installed HTTP result artifact byte count mismatch: ${JSON.stringify(fetchedArtifact)}`);
    }
    await writeFile(path.join(cwd, resultArtifactPath), "Tampered installed HTTP MCP artifact answer.\n", "utf8");
    await callToolExpectFailure(client, "bridge_fetch_result_artifact", {
      task_id: created.task.id,
      path: resultArtifactPath
    }, "sha256");
    const dryRun = await callJsonTool(client, "repo_write_file_dry_run", {
      path: "http-notes.md",
      content: "new\n",
      expected_head: writeHead
    });
    if (dryRun.receipt?.kind !== "repo_write_dry_run") {
      throw new Error(`Installed HTTP write dry-run returned unexpected receipt: ${JSON.stringify(dryRun.receipt)}`);
    }
    if (dryRun.preimage_sha256 !== sha256("old\n")) {
      throw new Error(`Installed HTTP write dry-run returned unexpected preimage hash: ${dryRun.preimage_sha256}`);
    }
    assertIncludes(dryRun.diff, "-old", "installed HTTP write dry-run diff");
    assertIncludes(dryRun.diff, "+new", "installed HTTP write dry-run diff");
    const applied = await callJsonTool(client, "repo_write_file_apply", {
      receipt_id: dryRun.receipt.id,
      expected_head: writeHead,
      preimage_sha256: dryRun.preimage_sha256
    });
    if (applied.receipt?.kind !== "repo_write_applied") {
      throw new Error(`Installed HTTP write apply returned unexpected receipt: ${JSON.stringify(applied.receipt)}`);
    }
    assertIncludes(await readFile(path.join(cwd, "http-notes.md"), "utf8"), "new\n", "installed HTTP write apply file");
    const staged = await callJsonTool(client, "repo_stage_reviewed_paths", {
      receipt_ids: [applied.receipt.id],
      expected_head: writeHead
    });
    if (staged.receipt?.kind !== "repo_stage_reviewed_paths") {
      throw new Error(`Installed HTTP stage returned unexpected receipt: ${JSON.stringify(staged.receipt)}`);
    }
    if (!Array.isArray(staged.paths) || staged.paths.join(",") !== "http-notes.md") {
      throw new Error(`Installed HTTP stage returned unexpected paths: ${JSON.stringify(staged.paths)}`);
    }
    const { stdout: stagedNames } = await execFileAsync("git", ["diff", "--cached", "--name-only"], { cwd });
    if (stagedNames.trim() !== "http-notes.md") {
      throw new Error(`Installed HTTP stage did not stage http-notes.md, got: ${stagedNames.trim()}`);
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      await closeClient(client, "installed HTTP MCP client");
    } catch (error) {
      if (!failed) throw error;
    }
  }
}

async function terminateChild(child, stdout, stderr) {
  if (child.exitCode !== null) {
    if (child.exitCode !== 0) {
      throw new Error(`Installed HTTP server exited early with ${child.exitCode}. stdout:\n${redactSmokeSecrets(stdout)}\nstderr:\n${redactSmokeSecrets(stderr)}`);
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
    throw new Error(
      `Installed HTTP server exited unexpectedly with code=${result.code} signal=${result.signal}. stdout:\n${redactSmokeSecrets(stdout)}\nstderr:\n${redactSmokeSecrets(stderr)}`
    );
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
    throw new Error(
      `Expected command to fail but it exited successfully. stdout:\n${redactSmokeSecrets(result.stdout)}\nstderr:\n${redactSmokeSecrets(result.stderr)}`
    );
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
    `Timed out calling installed MCP tool ${name}`
  );
  const text = result.content.find((item) => item.type === "text")?.text;
  if (!text) throw new Error(`Installed MCP tool ${name} did not return text content`);
  return JSON.parse(text);
}

async function callToolExpectFailure(client, name, args, expectedText) {
  let result;
  try {
    result = await withTimeout(
      client.callTool({ name, arguments: args }),
      20_000,
      `Timed out calling installed MCP tool ${name}`
    );
  } catch (error) {
    const message = errorMessage(error);
    if (message.includes(expectedText)) return;
    throw error;
  }
  const text = result.content.find((item) => item.type === "text")?.text ?? "";
  if (result.isError === true) {
    assertIncludes(text, expectedText, `installed MCP ${name} failure output`);
    return;
  }
  throw new Error(`Installed MCP tool ${name} unexpectedly succeeded. Output was:\n${redactSmokeSecrets(text).slice(0, 1000)}`);
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

async function closeClient(client, label) {
  const closePromise = client.close();
  closePromise.catch(() => undefined);
  await withTimeout(closePromise, 10_000, `Timed out closing ${label}`);
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
    throw new Error(`${label} did not include ${redactSmokeSecrets(expected)}. Output was:\n${redactSmokeSecrets(text).slice(0, 1000)}`);
  }
}

function assertNotIncludes(text, unexpected, label) {
  if (text.includes(unexpected)) {
    throw new Error(`${label} unexpectedly included ${redactSmokeSecrets(unexpected)}. Output was:\n${redactSmokeSecrets(text).slice(0, 1000)}`);
  }
}

function redactSmokeSecrets(value) {
  return String(value)
    .replace(/gptprouse_token=([^&\s"'`<>]+)/g, "gptprouse_token=***")
    .replace(/\b(?:non-expiring-package-smoke-token|expired-package-smoke-token|package-smoke-token)\b/g, "***");
}

function assertSmokeRedaction() {
  const sample =
    "http://127.0.0.1:8787/mcp?gptprouse_token=package-smoke-token non-expiring-package-smoke-token expired-package-smoke-token";
  const redacted = redactSmokeSecrets(sample);
  if (redacted.includes("package-smoke-token") || redacted.includes("non-expiring-package-smoke-token") || redacted.includes("expired-package-smoke-token")) {
    throw new Error(`Smoke redaction failed: ${redacted}`);
  }
  if (!redacted.includes("gptprouse_token=***")) {
    throw new Error(`Smoke redaction did not preserve token marker: ${redacted}`);
  }
}

function portablePathLeakCandidates() {
  const candidates = [repoRoot, path.dirname(repoRoot), process.env.HOME, process.env.USERPROFILE];
  const useful = candidates.map(normalizeUsefulAbsolutePath).filter((candidate) => candidate !== undefined);
  return [...new Set(useful.flatMap((candidate) => [candidate, candidate.split(path.sep).join(path.posix.sep)]))];
}

function normalizeUsefulAbsolutePath(candidate) {
  if (typeof candidate !== "string") return undefined;
  const normalized = path.resolve(candidate);
  const parsed = path.parse(normalized);
  if (!path.isAbsolute(normalized) || normalized === parsed.root || normalized.length < 8) return undefined;
  return normalized;
}

function assertAppearsBefore(text, earlier, later, label) {
  const earlierIndex = text.indexOf(earlier);
  if (earlierIndex === -1) {
    throw new Error(`${label} did not include ${redactSmokeSecrets(earlier)}. Output was:\n${redactSmokeSecrets(text).slice(0, 1000)}`);
  }
  const laterIndex = text.indexOf(later);
  if (laterIndex === -1) {
    throw new Error(`${label} did not include ${redactSmokeSecrets(later)}. Output was:\n${redactSmokeSecrets(text).slice(0, 1000)}`);
  }
  if (earlierIndex >= laterIndex) {
    throw new Error(`${label} must put ${redactSmokeSecrets(earlier)} before ${redactSmokeSecrets(later)}`);
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
