#!/usr/bin/env node
import { createHash, createHmac } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
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

const tmp = await mkdtemp(path.join(tmpdir(), "prodex-package-smoke-"));

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

  const installedPackageDir = path.join(consumerDir, "node_modules", "@youdie006", "prodex");
  const binPath = path.join(consumerDir, "node_modules", ".bin", process.platform === "win32" ? "prodex.cmd" : "prodex");
  const installedPackageJson = JSON.parse(await readFile(path.join(installedPackageDir, "package.json"), "utf8"));
  if (installedPackageJson.scripts?.prepublishOnly !== "node scripts/release-check.mjs") {
    throw new Error("installed package.json must keep prepublishOnly wired to release-check");
  }
  const installedSourceCli = path.join(installedPackageDir, "dist", "cli.js");
  const sourcePrefix = `node ${installedSourceCli}`;
  const version = await run(binPath, ["--version"], { cwd: consumerDir });
  if (version.stdout.trim() !== installedPackageJson.version) {
    throw new Error(`Installed --version returned ${version.stdout.trim()}, expected ${installedPackageJson.version}`);
  }
  const help = await run(binPath, ["help"], { cwd: consumerDir });
  assertIncludes(help.stdout, "prodex doctor [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js]", "installed help output");
  assertIncludes(help.stdout, "prodex start [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js]", "installed help output");
  assertIncludes(
    help.stdout,
    "prodex status [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js]",
    "installed help output"
  );
  assertIncludes(
    help.stdout,
    "prodex tunnel url [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js]",
    "installed help output"
  );
  assertIncludes(help.stdout, "prodex onboard [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js]", "installed help output");
  assertIncludes(
    help.stdout,
    "prodex release status [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js]",
    "installed help output"
  );
  assertIncludes(
    help.stdout,
    "prodex release pack [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js] --pack-destination /absolute/path [--keep-workdir]",
    "installed help output"
  );
  assertIncludes(help.stdout, "prodex project prompt", "installed help output");
  assertIncludes(help.stdout, "prodex claude prompt", "installed help output");
  assertIncludes(help.stdout, "prodex claude config", "installed help output");
  assertIncludes(help.stdout, "prodex pro ask [--dry-run] [--cwd /absolute/path/to/repo] [--file path]", "installed help output");
  assertIncludes(
    help.stdout,
    "prodex pro browser login [--cwd /absolute/path/to/repo] [--dry-run] [--source-cli /absolute/path/to/dist/cli.js] [--profile-dir path] [--port 9333] [--url https://chatgpt.com/...] [--launch-timeout-ms 5000]",
    "installed help output"
  );
  assertIncludes(
    help.stdout,
    "prodex pro browser check [--source-cli /absolute/path/to/dist/cli.js] [--cwd /absolute/path/to/repo] [--port 9333] [--timeout-ms 1500]",
    "installed help output"
  );
  assertIncludes(
    help.stdout,
    "prodex pro browser smoke [--source-cli /absolute/path/to/dist/cli.js] [--cwd /absolute/path/to/repo] [--port 9333] [--timeout-ms 90000]",
    "installed help output"
  );
  assertIncludes(
    help.stdout,
    'prodex pro browser ask [--source-cli /absolute/path/to/dist/cli.js] [--cwd /absolute/path/to/repo] [--port 9333] [--timeout-ms 90000] [--target-url url --confirm-target] [--file path] "prompt"',
    "installed help output"
  );
  assertIncludes(help.stdout, "prodex pro browser help [--source-cli /absolute/path/to/dist/cli.js]", "installed help output");
  assertIncludes(help.stdout, "prodex pro latest [--source-cli /absolute/path/to/dist/cli.js] [--cwd /absolute/path/to/repo]", "installed help output");
  assertIncludes(help.stdout, "prodex pro list [--source-cli /absolute/path/to/dist/cli.js] [--cwd /absolute/path/to/repo]", "installed help output");
  assertIncludes(help.stdout, "prodex pro show <task-id|latest> [--source-cli /absolute/path/to/dist/cli.js] [--cwd /absolute/path/to/repo]", "installed help output");
  assertIncludes(help.stdout, "prodex mcp [--cwd /absolute/path/to/repo]", "installed help output");
  assertIncludes(help.stdout, `prodex v${installedPackageJson.version}`, "installed help output");
  assertNotIncludes(help.stdout, "prodex ask-pro", "installed help output");
  assertNotIncludes(help.stdout, "prodex pro latest|list|show <task-id|latest>", "installed help output");
  assertNotIncludes(help.stdout, "prodex pro browser open|status", "installed help output");
  assertNotIncludes(help.stdout, "prodex chatgpt open|status|smoke", "installed help output");
  const proHelp = await run(binPath, ["pro", "--help"], { cwd: consumerDir });
  assertIncludes(proHelp.stdout, "prodex pro", "installed pro help output");
  assertIncludes(proHelp.stdout, "prodex pro browser help [--source-cli /absolute/path/to/dist/cli.js]", "installed pro help output");
  assertIncludes(proHelp.stdout, "prodex pro latest [--source-cli /absolute/path/to/dist/cli.js] [--cwd /absolute/path/to/repo]", "installed pro help output");
  assertIncludes(proHelp.stdout, "prodex pro list [--source-cli /absolute/path/to/dist/cli.js] [--cwd /absolute/path/to/repo]", "installed pro help output");
  assertIncludes(proHelp.stdout, "prodex pro show <task-id|latest> [--source-cli /absolute/path/to/dist/cli.js] [--cwd /absolute/path/to/repo]", "installed pro help output");
  const releaseHelp = await run(binPath, ["release", "--help"], { cwd: consumerDir });
  assertIncludes(releaseHelp.stdout, "prodex release", "installed release help output");
  assertIncludes(
    releaseHelp.stdout,
    "prodex release pack [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js] --pack-destination /absolute/path [--keep-workdir]",
    "installed release help output"
  );
  assertIncludes(
    releaseHelp.stdout,
    "Release commands are local checks and package preparation helpers; they do not publish or push.",
    "installed release help output"
  );
  const initHelp = await run(binPath, ["init", "--help"], { cwd: consumerDir });
  assertIncludes(initHelp.stdout, "prodex init [--cwd /absolute/path/to/repo]", "installed init help output");
  const setupHelp = await run(binPath, ["setup", "--help"], { cwd: consumerDir });
  assertIncludes(
    setupHelp.stdout,
    "prodex setup [--cwd /absolute/path/to/repo] [--host 127.0.0.1] [--port 8787] [--token-ttl-hours <hours>]",
    "installed setup help output"
  );
  const startHelp = await run(binPath, ["start", "--help"], { cwd: consumerDir });
  assertIncludes(startHelp.stdout, "prodex start [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js]", "installed start help output");
  const statusHelp = await run(binPath, ["status", "--help"], { cwd: consumerDir });
  assertIncludes(
    statusHelp.stdout,
    "prodex status [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js] [--show-token] [--url-only] [--unsafe-show-non-expiring-token]",
    "installed status help output"
  );
  const tunnelHelp = await run(binPath, ["tunnel", "--help"], { cwd: consumerDir });
  assertIncludes(tunnelHelp.stdout, "prodex tunnel url [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js]", "installed tunnel help output");
  const tunnelUrlHelp = await run(binPath, ["tunnel", "url", "--help"], { cwd: consumerDir });
  assertIncludes(tunnelUrlHelp.stdout, "This command does not create a tunnel.", "installed tunnel url help output");
  const doctorHelp = await run(binPath, ["doctor", "--help"], { cwd: consumerDir });
  assertIncludes(doctorHelp.stdout, "prodex doctor [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js]", "installed doctor help output");
  const onboardHelp = await run(binPath, ["onboard", "--help"], { cwd: consumerDir });
  assertIncludes(onboardHelp.stdout, "prodex onboard [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js]", "installed onboard help output");
  const mcpHelp = await run(binPath, ["mcp", "--help"], { cwd: consumerDir });
  assertIncludes(mcpHelp.stdout, "prodex mcp [--cwd /absolute/path/to/repo]", "installed MCP help output");
  const projectHelp = await run(binPath, ["project", "--help"], { cwd: consumerDir });
  assertIncludes(projectHelp.stdout, "prodex project", "installed project help output");
  assertIncludes(projectHelp.stdout, "prodex project prompt [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js]", "installed project help output");
  const claudeHelp = await run(binPath, ["claude", "--help"], { cwd: consumerDir });
  assertIncludes(claudeHelp.stdout, "prodex claude", "installed Claude help output");
  assertIncludes(claudeHelp.stdout, "prodex claude prompt [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js]", "installed Claude help output");
  assertIncludes(claudeHelp.stdout, "prodex claude config [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js]", "installed Claude help output");
  const tasksHelp = await run(binPath, ["tasks", "--help"], { cwd: consumerDir });
  assertIncludes(tasksHelp.stdout, "prodex tasks", "installed tasks help output");
  assertIncludes(
    tasksHelp.stdout,
    'prodex tasks create [--cwd /absolute/path/to/repo] --title "Title" --prompt "Prompt"',
    "installed tasks help output"
  );
  assertIncludes(
    tasksHelp.stdout,
    "prodex tasks list [--status new|claimed|done|blocked] [--cwd /absolute/path/to/repo]",
    "installed tasks help output"
  );
  assertIncludes(
    tasksHelp.stdout,
    "prodex tasks show <task-id|latest> [--cwd /absolute/path/to/repo]",
    "installed tasks help output"
  );
  assertIncludes(
    tasksHelp.stdout,
    "prodex tasks claim <task-id> [--cwd /absolute/path/to/repo] [--by codex]",
    "installed tasks help output"
  );
  assertIncludes(
    tasksHelp.stdout,
    'prodex tasks complete <task-id> [--cwd /absolute/path/to/repo] --summary "Summary" [--command "npm test"] [--artifact .bridge/artifacts/results/name.md=text]',
    "installed tasks help output"
  );
  assertIncludes(
    tasksHelp.stdout,
    'prodex tasks block <task-id> [--cwd /absolute/path/to/repo] --summary "Summary" [--code code] [--next-step "Next step"] [--retryable]',
    "installed tasks help output"
  );
  const resultsHelp = await run(binPath, ["results", "--help"], { cwd: consumerDir });
  assertIncludes(resultsHelp.stdout, "prodex results", "installed results help output");
  assertIncludes(resultsHelp.stdout, "prodex results show <task-id|latest> [--cwd /absolute/path/to/repo]", "installed results help output");
  assertIncludes(resultsHelp.stdout, "prodex results artifact <task-id|latest> [artifact-path] [--cwd /absolute/path/to/repo]", "installed results help output");
  assertIncludes(resultsHelp.stdout, "prodex results reseal <task-id|latest> --confirm-current-result [--cwd /absolute/path/to/repo]", "installed results help output");
  const receiptsHelp = await run(binPath, ["receipts", "--help"], { cwd: consumerDir });
  assertIncludes(receiptsHelp.stdout, "prodex receipts", "installed receipts help output");
  assertIncludes(receiptsHelp.stdout, "prodex receipts list [--kind kind] [--task-id task-id] [--cwd /absolute/path/to/repo]", "installed receipts help output");
  assertIncludes(receiptsHelp.stdout, "prodex receipts show <receipt-id|latest> [--cwd /absolute/path/to/repo]", "installed receipts help output");
  const sessionsHelp = await run(binPath, ["sessions", "--help"], { cwd: consumerDir });
  assertIncludes(sessionsHelp.stdout, "prodex sessions", "installed sessions help output");
  assertIncludes(sessionsHelp.stdout, "prodex sessions list [--status preview|running|done|blocked] [--cwd /absolute/path/to/repo]", "installed sessions help output");
  assertIncludes(sessionsHelp.stdout, "prodex sessions show <session-id|latest> [--cwd /absolute/path/to/repo]", "installed sessions help output");
  const advertisedSubcommandHelpCases = [
    { args: ["release", "status", "--help"], expected: "prodex release status [--cwd /absolute/path/to/repo]" },
    { args: ["release", "pack", "--help"], expected: "prodex release pack [--cwd /absolute/path/to/repo]" },
    { args: ["project", "prompt", "--help"], expected: "prodex project prompt [--cwd /absolute/path/to/repo]" },
    { args: ["claude", "config", "--help"], expected: "prodex claude config [--cwd /absolute/path/to/repo]" },
    { args: ["tasks", "create", "--help"], expected: 'prodex tasks create [--cwd /absolute/path/to/repo] --title "Title" --prompt "Prompt"' },
    { args: ["tasks", "list", "--help"], expected: "prodex tasks list [--status new|claimed|done|blocked] [--cwd /absolute/path/to/repo]" },
    { args: ["tasks", "show", "--help"], expected: "prodex tasks show <task-id|latest> [--cwd /absolute/path/to/repo]" },
    { args: ["tasks", "claim", "--help"], expected: "prodex tasks claim <task-id> [--cwd /absolute/path/to/repo] [--by codex]" },
    { args: ["tasks", "complete", "--help"], expected: 'prodex tasks complete <task-id> [--cwd /absolute/path/to/repo] --summary "Summary"' },
    { args: ["tasks", "block", "--help"], expected: 'prodex tasks block <task-id> [--cwd /absolute/path/to/repo] --summary "Summary"' },
    { args: ["results", "show", "--help"], expected: "prodex results show <task-id|latest> [--cwd /absolute/path/to/repo]" },
    { args: ["results", "artifact", "--help"], expected: "prodex results artifact <task-id|latest> [artifact-path] [--cwd /absolute/path/to/repo]" },
    { args: ["results", "reseal", "--help"], expected: "prodex results reseal <task-id|latest> --confirm-current-result [--cwd /absolute/path/to/repo]" },
    { args: ["receipts", "list", "--help"], expected: "prodex receipts list [--kind kind] [--task-id task-id] [--cwd /absolute/path/to/repo]" },
    { args: ["receipts", "show", "--help"], expected: "prodex receipts show <receipt-id|latest> [--cwd /absolute/path/to/repo]" },
    { args: ["sessions", "list", "--help"], expected: "prodex sessions list [--status preview|running|done|blocked] [--cwd /absolute/path/to/repo]" },
    { args: ["sessions", "show", "--help"], expected: "prodex sessions show <session-id|latest> [--cwd /absolute/path/to/repo]" },
    { args: ["pro", "ask", "--help"], expected: "prodex pro ask [--dry-run] [--cwd /absolute/path/to/repo] [--file path]" },
    { args: ["pro", "browser", "ask", "--help"], expected: "prodex pro browser ask [--source-cli /absolute/path/to/dist/cli.js] [--cwd /absolute/path/to/repo]" },
    { args: ["pro", "latest", "--help"], expected: "prodex pro latest [--source-cli /absolute/path/to/dist/cli.js] [--cwd /absolute/path/to/repo]" },
    { args: ["pro", "list", "--help"], expected: "prodex pro list [--source-cli /absolute/path/to/dist/cli.js] [--cwd /absolute/path/to/repo]" },
    { args: ["pro", "show", "--help"], expected: "prodex pro show <task-id|latest> [--source-cli /absolute/path/to/dist/cli.js] [--cwd /absolute/path/to/repo]" }
  ];
  for (const item of advertisedSubcommandHelpCases) {
    const commandHelp = await run(binPath, item.args, { cwd: consumerDir });
    assertIncludes(commandHelp.stdout, item.expected, `installed ${item.args.join(" ")} output`);
  }
  const trailingHelpCases = [
    {
      args: ["status", "--source-cli", installedSourceCli, "--help"],
      expected: "prodex status [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js]"
    },
    {
      args: ["release", "pack", "--source-cli", installedSourceCli, "--pack-destination", consumerDir, "--help"],
      expected: "prodex release pack [--cwd /absolute/path/to/repo]"
    },
    {
      args: ["tunnel", "url", "--public-url", "https://prodex-package-smoke.example", "--source-cli", installedSourceCli, "--help"],
      expected: "This command does not create a tunnel."
    },
    {
      args: ["project", "prompt", "--source-cli", installedSourceCli, "--help"],
      expected: "prodex project prompt [--cwd /absolute/path/to/repo]"
    },
    {
      args: ["mcp", "--cwd", consumerDir, "--help"],
      expected: "prodex mcp [--cwd /absolute/path/to/repo]"
    },
    {
      args: ["tasks", "list", "--status", "new", "--help"],
      expected: "prodex tasks list [--status new|claimed|done|blocked]"
    },
    {
      args: ["pro", "browser", "ask", "--source-cli", installedSourceCli, "--help"],
      expected: `${sourcePrefix} pro browser ask --source-cli ${installedSourceCli}`
    },
    {
      args: ["pro", "show", "latest", "--source-cli", installedSourceCli, "--help"],
      expected: "prodex pro show <task-id|latest> [--source-cli /absolute/path/to/dist/cli.js]"
    }
  ];
  for (const item of trailingHelpCases) {
    const commandHelp = await run(binPath, item.args, { cwd: consumerDir });
    assertIncludes(commandHelp.stdout, item.expected, `installed trailing help ${item.args.join(" ")} output`);
  }
  const unknownTopLevel = await runExpectFailure(binPath, ["statuz"], { cwd: consumerDir });
  assertIncludes(
    unknownTopLevel.stderr,
    "Unknown command: statuz. Did you mean `prodex status`? Run `prodex help`.",
    "installed unknown top-level command output"
  );
  const unknownSubcommandCases = [
    {
      args: ["tasks", "lst"],
      expected:
        "Unknown tasks subcommand: lst. Did you mean `prodex tasks list`? Expected one of: create, list, show, claim, complete, block. Run `prodex tasks --help`."
    },
    {
      args: ["release", "stats"],
      expected:
        "Unknown release subcommand: stats. Did you mean `prodex release status`? Expected one of: status, pack. Run `prodex release --help`."
    },
    {
      args: ["pro", "brower"],
      expected:
        "Unknown pro subcommand: brower. Did you mean `prodex pro browser`? Expected one of: ask, browser, list, latest, show. Run `prodex pro --help`."
    },
    {
      args: ["pro", "browser", "chek"],
      expected:
        "Unknown pro browser subcommand: chek. Did you mean `prodex pro browser check`? Expected one of: login, ask, smoke, check. Run `prodex pro browser --help`."
    },
    {
      args: ["tunnel", "create"],
      expected: "Unknown tunnel subcommand: create. Expected one of: url. Run `prodex tunnel --help`."
    },
    {
      args: ["tasks", "remove"],
      expected: "Unknown tasks subcommand: remove. Expected one of: create, list, show, claim, complete, block. Run `prodex tasks --help`."
    },
    {
      args: ["results", "list"],
      expected: "Unknown results subcommand: list. Expected one of: show, artifact, reseal. Run `prodex results --help`."
    },
    {
      args: ["receipts", "delete"],
      expected: "Unknown receipts subcommand: delete. Expected one of: list, show. Run `prodex receipts --help`."
    },
    {
      args: ["sessions", "delete"],
      expected: "Unknown sessions subcommand: delete. Expected one of: list, show. Run `prodex sessions --help`."
    },
    {
      args: ["project", "verify"],
      expected: "Unknown project subcommand: verify. Expected one of: prompt. Run `prodex project --help`."
    },
    {
      args: ["claude", "verify"],
      expected: "Unknown claude subcommand: verify. Expected one of: prompt, config. Run `prodex claude --help`."
    },
    {
      args: ["release", "publish"],
      expected: "Unknown release subcommand: publish. Expected one of: status, pack. Run `prodex release --help`."
    },
    {
      args: ["pro", "browser", "verify"],
      expected: "Unknown pro browser subcommand: verify. Expected one of: login, ask, smoke, check. Run `prodex pro browser --help`."
    },
    {
      args: ["pro", "verify"],
      expected: "Unknown pro subcommand: verify. Expected one of: ask, browser, list, latest, show. Run `prodex pro --help`."
    }
  ];
  for (const item of unknownSubcommandCases) {
    const unknownSubcommand = await runExpectFailure(binPath, item.args, { cwd: consumerDir });
    assertIncludes(unknownSubcommand.stderr, item.expected, `installed ${item.args.join(" ")} output`);
  }
  const unknownOptionCases = [
    {
      args: ["tasks", "list", "--stauts", "blocked"],
      expected: "Unknown option for tasks list: --stauts. Did you mean `--status`?"
    },
    {
      args: ["setup", "--token-ttl-hour", "24"],
      expected: "Unknown option for setup: --token-ttl-hour. Did you mean `--token-ttl-hours`?"
    },
    {
      args: ["pro", "browser", "login", "--dry-rn"],
      expected: "Unknown option for pro browser login: --dry-rn. Did you mean `--dry-run`?"
    },
    {
      args: ["pro", "browser", "ask", "--fil", "README.md", "Review"],
      expected: "Unknown option: --fil. Did you mean `--file`?"
    },
    {
      args: ["release", "pack", "--pack-dest", "/tmp/out"],
      expected: "Unknown option for release pack: --pack-dest. Did you mean `--pack-destination`?"
    },
    {
      args: ["start", "--token", "runtime-token"],
      expected: "Unknown option for start: --token"
    }
  ];
  for (const item of unknownOptionCases) {
    const unknownOption = await runExpectFailure(binPath, item.args, { cwd: consumerDir });
    assertIncludes(unknownOption.stderr, item.expected, `installed ${item.args.join(" ")} output`);
  }
  const legacyChatGptHelp = await runExpectFailure(binPath, ["chatgpt", "--help"], { cwd: consumerDir });
  assertIncludes(
    legacyChatGptHelp.stderr,
    "The legacy `chatgpt` namespace is hidden. Use `prodex pro browser help` for visible-browser commands.",
    "installed legacy chatgpt help output"
  );
  const legacyChatGptUnknown = await runExpectFailure(binPath, ["chatgpt", "verify"], { cwd: consumerDir });
  assertIncludes(
    legacyChatGptUnknown.stderr,
    "Unknown legacy chatgpt subcommand: verify. Use `prodex pro browser help` for visible-browser commands.",
    "installed legacy chatgpt unknown output"
  );
  const freshDoctorDir = path.join(tmp, "fresh-doctor");
  await mkdir(freshDoctorDir, { recursive: true });
  const freshDoctor = await run(binPath, ["doctor"], { cwd: freshDoctorDir });
  assertIncludes(freshDoctor.stdout, "bridge: missing/incomplete", "installed fresh doctor output");
  assertNotIncludes((await readdir(freshDoctorDir)).join("\n"), ".bridge", "installed fresh doctor cwd entries");
  const releaseStatus = await run(binPath, ["release", "status", "--cwd", installedPackageDir], { cwd: consumerDir });
  assertIncludes(releaseStatus.stdout, "prodex release status", "installed release status output");
  assertIncludes(releaseStatus.stdout, "metadata: ok license=MIT license_file=present", "installed release status output");
  assertNotIncludes(releaseStatus.stdout, "explicit license", "installed release status output");
  assertIncludes(releaseStatus.stdout, "pack:", "installed release status output");
  assertIncludes(releaseStatus.stdout, "git: blocked", "installed release status output");
  assertIncludes(releaseStatus.stdout, "not a git worktree", "installed release status output");
  const sourceReleaseStatus = await run(binPath, ["release", "status", "--cwd", installedPackageDir, "--source-cli", installedSourceCli], {
    cwd: consumerDir
  });
  assertIncludes(
    sourceReleaseStatus.stdout,
    `node ${installedSourceCli} release status --source-cli ${installedSourceCli} --cwd ${installedPackageDir}`,
    "installed source release status --cwd output"
  );
  const releasePackDestination = path.join(tmp, "installed-release-pack");
  const releasePackSuccess = await run(
    process.execPath,
    [path.join(installedPackageDir, "scripts", "release-pack.mjs"), "--root", installedPackageDir, "--pack-destination", releasePackDestination],
    { cwd: consumerDir, timeout: 120_000, maxBuffer: 20 * 1024 * 1024 }
  );
  assertIncludes(releasePackSuccess.stdout, "release_pack=ok", "installed release-pack success output");
  assertIncludes(releasePackSuccess.stdout, "file_modes=ok", "installed release-pack success output");
  assertIncludes(releasePackSuccess.stdout, "release_pack_next:", "installed release-pack success output");
  assertIncludes(releasePackSuccess.stdout, "release_pack_git: blocked not a git worktree", "installed release-pack success output");
  assertIncludes(
    releasePackSuccess.stdout,
    "release_pack_git_next: initialize a git repo and commit the release state before public release",
    "installed release-pack success output"
  );
  assertIncludes(releasePackSuccess.stdout, "release_pack_publish_blocked: fix git readiness before npm publish", "installed release-pack success output");
  assertNotIncludes(releasePackSuccess.stdout, "release_pack_publish: npm publish", "installed release-pack success output");
  const releasePackTarballs = (await readdir(releasePackDestination)).filter((entry) => entry.endsWith(".tgz"));
  if (releasePackTarballs.length !== 1) {
    throw new Error(`installed release-pack expected exactly one tarball, found: ${releasePackTarballs.join(", ")}`);
  }
  const releasePackTarballPath = path.join(releasePackDestination, releasePackTarballs[0]);
  assertIncludes(releasePackSuccess.stdout, `release_pack_verify: npm publish --dry-run ${releasePackTarballPath}`, "installed release-pack success output");
  await assertInstalledReleasePackTarballModes(releasePackTarballPath, packed.files, "installed release-pack tarball");
  await assertNpmPublishDryRun(releasePackTarballPath, consumerDir, "installed release-pack tarball");
  const releasePackCliDestination = path.join(tmp, "installed-release-pack-cli");
  const releasePackCliSuccess = await run(
    binPath,
    ["release", "pack", "--cwd", installedPackageDir, "--pack-destination", releasePackCliDestination],
    { cwd: consumerDir, timeout: 120_000, maxBuffer: 20 * 1024 * 1024 }
  );
  assertIncludes(releasePackCliSuccess.stdout, "release_pack=ok", "installed release pack CLI output");
  assertIncludes(releasePackCliSuccess.stdout, "release_pack_git: blocked not a git worktree", "installed release pack CLI output");
  assertIncludes(
    releasePackCliSuccess.stdout,
    "release_pack_git_next: initialize a git repo and commit the release state before public release",
    "installed release pack CLI output"
  );
  assertIncludes(releasePackCliSuccess.stdout, "release_pack_publish_blocked: fix git readiness before npm publish", "installed release pack CLI output");
  assertNotIncludes(releasePackCliSuccess.stdout, "release_pack_publish: npm publish", "installed release pack CLI output");
  const releasePackCliTarballs = (await readdir(releasePackCliDestination)).filter((entry) => entry.endsWith(".tgz"));
  if (releasePackCliTarballs.length !== 1) {
    throw new Error(`installed release pack CLI expected exactly one tarball, found: ${releasePackCliTarballs.join(", ")}`);
  }
  const releasePackCliTarballPath = path.join(releasePackCliDestination, releasePackCliTarballs[0]);
  assertIncludes(releasePackCliSuccess.stdout, `release_pack_verify: npm publish --dry-run ${releasePackCliTarballPath}`, "installed release pack CLI output");
  await assertInstalledReleasePackTarballModes(releasePackCliTarballPath, packed.files, "installed release pack CLI tarball");
  await assertNpmPublishDryRun(releasePackCliTarballPath, consumerDir, "installed release pack CLI tarball");
  const releasePackSourceCliDestination = path.join(tmp, "installed-release-pack-source-cli");
  const releasePackSourceCliSuccess = await run(
    binPath,
    [
      "release",
      "pack",
      "--cwd",
      installedPackageDir,
      "--source-cli",
      installedSourceCli,
      "--pack-destination",
      releasePackSourceCliDestination
    ],
    { cwd: consumerDir, timeout: 120_000, maxBuffer: 20 * 1024 * 1024 }
  );
  assertIncludes(releasePackSourceCliSuccess.stdout, "release_pack=ok", "installed source release pack CLI output");
  assertIncludes(
    releasePackSourceCliSuccess.stdout,
    `release_pack_next: run \`npm run release:verify\` and \`node ${installedSourceCli} release status --source-cli ${installedSourceCli} --cwd ${installedPackageDir}\` before publishing this tarball.`,
    "installed source release pack CLI output"
  );
  assertIncludes(
    releasePackSourceCliSuccess.stdout,
    `release_pack_publish_blocked: fix git readiness before npm publish; run \`node ${installedSourceCli} release status --source-cli ${installedSourceCli} --cwd ${installedPackageDir}\`, then rerun release pack after blockers are clear.`,
    "installed source release pack CLI output"
  );
  assertNotIncludes(releasePackSourceCliSuccess.stdout, "release_pack_publish: npm publish", "installed source release pack CLI output");
  const releasePackSourceCliTarballs = (await readdir(releasePackSourceCliDestination)).filter((entry) => entry.endsWith(".tgz"));
  if (releasePackSourceCliTarballs.length !== 1) {
    throw new Error(`installed source release pack CLI expected exactly one tarball, found: ${releasePackSourceCliTarballs.join(", ")}`);
  }
  const releasePackSourceCliTarballPath = path.join(releasePackSourceCliDestination, releasePackSourceCliTarballs[0]);
  await assertInstalledReleasePackTarballModes(releasePackSourceCliTarballPath, packed.files, "installed source release pack CLI tarball");
  const releasePackGitReadyRoot = path.join(tmp, "installed-release-pack-git-ready-root");
  await cp(installedPackageDir, releasePackGitReadyRoot, { recursive: true });
  const releasePackGitReadyGit = await initPackageSmokeReleaseGitReadyRepo(releasePackGitReadyRoot);
  const releasePackGitReadyDestination = path.join(tmp, "installed-release-pack-git-ready");
  const releasePackGitReadySuccess = await run(
    binPath,
    ["release", "pack", "--cwd", releasePackGitReadyRoot, "--pack-destination", releasePackGitReadyDestination],
    { cwd: consumerDir, timeout: 120_000, maxBuffer: 20 * 1024 * 1024 }
  );
  assertIncludes(releasePackGitReadySuccess.stdout, "release_pack=ok", "installed git-ready release pack CLI output");
  assertIncludes(
    releasePackGitReadySuccess.stdout,
    `release_pack_git: ok branch=${releasePackGitReadyGit.branch} commit=${releasePackGitReadyGit.commit}`,
    "installed git-ready release pack CLI output"
  );
  assertNotIncludes(
    releasePackGitReadySuccess.stdout,
    "release_pack_publish_blocked",
    "installed git-ready release pack CLI output"
  );
  const releasePackGitReadyTarballs = (await readdir(releasePackGitReadyDestination)).filter((entry) => entry.endsWith(".tgz"));
  if (releasePackGitReadyTarballs.length !== 1) {
    throw new Error(`installed git-ready release pack CLI expected exactly one tarball, found: ${releasePackGitReadyTarballs.join(", ")}`);
  }
  const releasePackGitReadyTarballPath = path.join(releasePackGitReadyDestination, releasePackGitReadyTarballs[0]);
  assertIncludes(
    releasePackGitReadySuccess.stdout,
    `release_pack_verify: npm publish --dry-run ${releasePackGitReadyTarballPath}`,
    "installed git-ready release pack CLI output"
  );
  assertIncludes(
    releasePackGitReadySuccess.stdout,
    "release_pack_publish_guard: npm publish <tarball> bypasses prepublishOnly; run the release_pack_verify command first, then publish only that verified tarball if it succeeds.",
    "installed git-ready release pack CLI output"
  );
  assertIncludes(
    releasePackGitReadySuccess.stdout,
    `release_pack_publish: npm publish ${releasePackGitReadyTarballPath}`,
    "installed git-ready release pack CLI output"
  );
  await assertInstalledReleasePackTarballModes(releasePackGitReadyTarballPath, packed.files, "installed git-ready release pack CLI tarball");
  await assertNpmPublishDryRun(releasePackGitReadyTarballPath, consumerDir, "installed git-ready release pack CLI tarball");
  const releasePackMissingDestination = await runExpectFailure(
    process.execPath,
    [path.join(installedPackageDir, "scripts", "release-pack.mjs"), "--root", installedPackageDir],
    { cwd: consumerDir }
  );
  assertIncludes(
    releasePackMissingDestination.stderr,
    "--pack-destination is required",
    "installed release-pack missing destination output"
  );
  assertNotIncludes(
    releasePackMissingDestination.stdout,
    "release_pack=ok",
    "installed release-pack missing destination output"
  );
  const releasePackUnknownOption = await runExpectFailure(
    process.execPath,
    [path.join(installedPackageDir, "scripts", "release-pack.mjs"), "--pack-dest", path.join(tmp, "unused-pack-dest")],
    { cwd: consumerDir }
  );
  assertIncludes(
    releasePackUnknownOption.stderr,
    "release pack flags failed: unknown option --pack-dest. Did you mean `--pack-destination`?",
    "installed release-pack unknown option output"
  );
  const releaseCheckUnknownOption = await runExpectFailure(
    process.execPath,
    [path.join(installedPackageDir, "scripts", "release-check.mjs"), "--verificaton-only"],
    { cwd: consumerDir }
  );
  assertIncludes(
    releaseCheckUnknownOption.stderr,
    "release check flags failed: unknown option --verificaton-only. Did you mean `--verification-only`?",
    "installed release-check unknown option output"
  );
  if ((await readdir(installedPackageDir)).some((entry) => entry.endsWith(".tgz"))) {
    throw new Error("installed release-pack created a tarball without --pack-destination");
  }
  const releaseCheckSilentDir = path.join(tmp, "release-check-silent-pack");
  await mkdir(releaseCheckSilentDir, { recursive: true });
  await writeFile(
    path.join(releaseCheckSilentDir, "package.json"),
    `${JSON.stringify({ name: "release-check-silent-pack", version: "1.0.0", license: "MIT" }, null, 2)}\n`
  );
  await writeFile(path.join(releaseCheckSilentDir, "LICENSE"), "MIT License\n");
  const releaseCheckFakeBin = path.join(tmp, "release-check-silent-pack-bin");
  await mkdir(releaseCheckFakeBin, { recursive: true });
  await writeFakeNpmSilentFailure(releaseCheckFakeBin);
  const releaseCheckSilent = await runExpectFailure(
    process.execPath,
    [path.join(installedPackageDir, "scripts", "release-check.mjs"), "--metadata-only", "--root", releaseCheckSilentDir],
    {
      cwd: consumerDir,
      env: { PATH: `${releaseCheckFakeBin}${path.delimiter}${process.env.PATH ?? ""}` }
    }
  );
  assertIncludes(releaseCheckSilent.stderr, "npm pack dry-run failed: exit code 42", "installed release-check silent npm failure output");
  assertNotIncludes(releaseCheckSilent.stderr, "Command failed:", "installed release-check silent npm failure output");
  const privatePackageDir = path.join(tmp, "private-release");
  await mkdir(privatePackageDir, { recursive: true });
  await writeFile(
    path.join(privatePackageDir, "package.json"),
    `${JSON.stringify({ name: "private-demo", version: "1.0.0", license: "MIT", private: true, files: ["README.md"] }, null, 2)}\n`
  );
  await writeFile(path.join(privatePackageDir, "LICENSE"), "MIT License\n");
  await writeFile(path.join(privatePackageDir, "README.md"), "# Private demo\n");
  await chmod(path.join(privatePackageDir, "README.md"), 0o755);
  const privateReleaseStatus = await run(binPath, ["release", "status", "--cwd", privatePackageDir], { cwd: consumerDir });
  assertIncludes(privateReleaseStatus.stdout, "metadata: blocked", "installed private release status output");
  assertIncludes(privateReleaseStatus.stdout, "private: true", "installed private release status output");
  assertIncludes(privateReleaseStatus.stdout, "pack: blocked packed files have unexpected executable modes", "installed private release status output");
  assertIncludes(privateReleaseStatus.stdout, "README.md", "installed private release status output");
  assertIncludes(privateReleaseStatus.stdout, "pack_next:", "installed private release status output");
  assertNotIncludes(privateReleaseStatus.stdout, "metadata: ok", "installed private release status output");
  const missingLicenseMetadataDir = path.join(tmp, "missing-license-metadata-release");
  await mkdir(missingLicenseMetadataDir, { recursive: true });
  await writeFile(
    path.join(missingLicenseMetadataDir, "package.json"),
    `${JSON.stringify({ name: "missing-license-metadata-demo", version: "1.0.0" }, null, 2)}\n`
  );
  await writeFile(path.join(missingLicenseMetadataDir, "LICENSE"), "MIT License\n");
  const missingLicenseMetadataReleaseStatus = await run(binPath, ["release", "status", "--cwd", missingLicenseMetadataDir], { cwd: consumerDir });
  assertIncludes(missingLicenseMetadataReleaseStatus.stdout, "metadata: blocked", "installed missing license metadata release status output");
  assertIncludes(
    missingLicenseMetadataReleaseStatus.stdout,
    "next: choose a license and set package.json license, then run `npm run release:check`",
    "installed missing license metadata release status output"
  );
  assertNotIncludes(missingLicenseMetadataReleaseStatus.stdout, "add LICENSE", "installed missing license metadata release status output");
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
  assertIncludes(onboard.stdout, "prodex onboarding", "installed onboard output");
  assertNotIncludes(onboard.stdout, "\t", "installed onboard output");
  assertIncludes(onboard.stdout, "\n3. ChatGPT Project HTTP MCP:", "installed onboard output");
  assertIncludes(onboard.stdout, `prodex init --cwd ${consumerDir}`, "installed onboard output");
  assertIncludes(onboard.stdout, `prodex doctor --cwd ${consumerDir}`, "installed onboard output");
  assertIncludes(onboard.stdout, `prodex claude config --cwd ${consumerDir}`, "installed onboard output");
  assertIncludes(onboard.stdout, `prodex claude prompt --cwd ${consumerDir}`, "installed onboard output");
  assertIncludes(onboard.stdout, `prodex setup --cwd ${consumerDir} --token-ttl-hours 24`, "installed onboard output");
  assertIncludes(
    onboard.stdout,
    "Keep this terminal open while ChatGPT uses the bridge; run the next commands in a second terminal.",
    "installed onboard output"
  );
  assertIncludes(onboard.stdout, `prodex project prompt --cwd ${consumerDir}`, "installed onboard output");
  assertAppearsBefore(
    onboard.stdout,
    "HTTP MCP uses a short-lived token",
    `prodex status --cwd ${consumerDir} --show-token --url-only`,
    "installed onboard output"
  );
  assertIncludes(onboard.stdout, "authorizes all enabled bridge tools", "installed onboard token authority warning");
  assertIncludes(onboard.stdout, "repo_write_file_apply", "installed onboard token authority warning");
  assertIncludes(onboard.stdout, `cd ${consumerDir}`, "installed onboard output");
  assertIncludes(onboard.stdout, `prodex pro ask --cwd ${consumerDir} "Review this repo"  # dry-run/manual preview`, "installed onboard output");
  assertNotIncludes(onboard.stdout, "--file README.md", "installed onboard output");
  assertIncludes(onboard.stdout, "prodex pro browser login --dry-run  # preview, no browser opens", "installed onboard output");
  assertIncludes(onboard.stdout, "prodex pro browser login  # opens visible browser", "installed onboard output");
  assertIncludes(onboard.stdout, "prodex pro browser help", "installed onboard output");
  assertIncludes(onboard.stdout, `prodex pro browser check --cwd ${consumerDir}`, "installed onboard output");
  assertIncludes(onboard.stdout, `prodex pro browser ask --cwd ${consumerDir} "Review this repo"  # visible-browser send`, "installed onboard output");
  assertIncludes(onboard.stdout, `prodex pro list --cwd ${consumerDir}`, "installed onboard output");
  assertIncludes(onboard.stdout, `prodex pro latest --cwd ${consumerDir}`, "installed onboard output");
  assertIncludes(onboard.stdout, `prodex results show latest --cwd ${consumerDir}`, "installed onboard output");
  assertIncludes(onboard.stdout, `prodex results artifact latest --cwd ${consumerDir}`, "installed onboard output");
  assertIncludes(onboard.stdout, `prodex results reseal <task-id> --confirm-current-result --cwd ${consumerDir}`, "installed onboard output");
  assertIncludes(onboard.stdout, "Cloudflare", "installed onboard output");
  assertIncludes(onboard.stdout, "usage-limit", "installed onboard output");
  assertNotIncludes(onboard.stdout, "prodex_token=", "installed onboard output");
  const sourceOnboard = await run(binPath, ["onboard", "--cwd", consumerDir, "--source-cli", installedSourceCli], { cwd: path.dirname(consumerDir) });
  assertNotIncludes(sourceOnboard.stdout, "\t", "installed source onboard output");
  assertIncludes(sourceOnboard.stdout, "\n3. ChatGPT Project HTTP MCP:", "installed source onboard output");
  assertIncludes(sourceOnboard.stdout, `${sourcePrefix} init --cwd ${consumerDir}`, "installed source onboard output");
  assertIncludes(
    sourceOnboard.stdout,
    `${sourcePrefix} doctor --cwd ${consumerDir} --source-cli ${installedSourceCli}`,
    "installed source onboard output"
  );
  assertIncludes(
    sourceOnboard.stdout,
    `${sourcePrefix} claude config --cwd ${consumerDir} --source-cli ${installedSourceCli}`,
    "installed source onboard output"
  );
  assertIncludes(
    sourceOnboard.stdout,
    `${sourcePrefix} claude prompt --cwd ${consumerDir} --source-cli ${installedSourceCli}`,
    "installed source onboard output"
  );
  assertIncludes(sourceOnboard.stdout, `${sourcePrefix} setup --cwd ${consumerDir} --token-ttl-hours 24`, "installed source onboard output");
  assertIncludes(
    sourceOnboard.stdout,
    `${sourcePrefix} start --cwd ${consumerDir} --source-cli ${installedSourceCli}`,
    "installed source onboard output"
  );
  assertIncludes(
    sourceOnboard.stdout,
    `${sourcePrefix} status --cwd ${consumerDir} --show-token --url-only --source-cli ${installedSourceCli}`,
    "installed source onboard output"
  );
  assertIncludes(sourceOnboard.stdout, `${sourcePrefix} project prompt --cwd ${consumerDir} --source-cli ${installedSourceCli}`, "installed source onboard output");
  assertIncludes(
    sourceOnboard.stdout,
    `${sourcePrefix} pro browser login --dry-run --source-cli ${installedSourceCli}  # preview, no browser opens`,
    "installed source onboard output"
  );
  assertIncludes(
    sourceOnboard.stdout,
    `${sourcePrefix} pro browser login --source-cli ${installedSourceCli}  # opens visible browser`,
    "installed source onboard output"
  );
  assertIncludes(
    sourceOnboard.stdout,
    `${sourcePrefix} pro browser help --source-cli ${installedSourceCli}`,
    "installed source onboard output"
  );
  assertIncludes(
    sourceOnboard.stdout,
    `${sourcePrefix} pro browser check --source-cli ${installedSourceCli} --cwd ${consumerDir}`,
    "installed source onboard output"
  );
  assertIncludes(
    sourceOnboard.stdout,
    `${sourcePrefix} pro browser smoke --source-cli ${installedSourceCli} --cwd ${consumerDir}`,
    "installed source onboard output"
  );
  assertIncludes(
    sourceOnboard.stdout,
    `${sourcePrefix} pro browser ask --source-cli ${installedSourceCli} --cwd ${consumerDir} "Review this repo"  # visible-browser send`,
    "installed source onboard output"
  );
  assertIncludes(sourceOnboard.stdout, `${sourcePrefix} pro list --source-cli ${installedSourceCli} --cwd ${consumerDir}`, "installed source onboard output");
  assertIncludes(sourceOnboard.stdout, `${sourcePrefix} pro latest --source-cli ${installedSourceCli} --cwd ${consumerDir}`, "installed source onboard output");
  assertIncludes(sourceOnboard.stdout, `${sourcePrefix} results show latest --cwd ${consumerDir}`, "installed source onboard output");
  assertIncludes(sourceOnboard.stdout, `${sourcePrefix} results artifact latest --cwd ${consumerDir}`, "installed source onboard output");
  assertIncludes(
    sourceOnboard.stdout,
    `${sourcePrefix} results reseal <task-id> --confirm-current-result --cwd ${consumerDir}`,
    "installed source onboard output"
  );
  assertNotIncludes(sourceOnboard.stdout, "prodex init --cwd", "installed source onboard output");
  assertNotIncludes(sourceOnboard.stdout, "prodex_token=", "installed source onboard output");
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
  assertIncludes(missingSetupStatus.stderr, "Run `prodex setup` first.", "installed missing setup status output");
  assertNotIncludes(missingSetupStatus.stderr, "Run `prodex setup --token-ttl-hours <hours>` first.", "installed missing setup status output");
  const missingSetupCwdStatus = await runExpectFailure(binPath, ["status", "--cwd", consumerDir], { cwd: path.dirname(consumerDir) });
  assertIncludes(
    missingSetupCwdStatus.stderr,
    `Run \`prodex setup --cwd ${consumerDir}\` first.`,
    "installed missing setup --cwd status output"
  );
  const missingSetupSourceStatus = await runExpectFailure(binPath, ["status", "--source-cli", installedSourceCli], { cwd: consumerDir });
  assertIncludes(
    missingSetupSourceStatus.stderr,
    `Run \`node ${installedSourceCli} setup\` first.`,
    "installed source missing setup status output"
  );
  assertNotIncludes(missingSetupSourceStatus.stderr, "Run `prodex setup`", "installed source missing setup status output");
  const missingSetupSourceCwdStatus = await runExpectFailure(binPath, ["status", "--cwd", consumerDir, "--source-cli", installedSourceCli], {
    cwd: path.dirname(consumerDir)
  });
  assertIncludes(
    missingSetupSourceCwdStatus.stderr,
    `Run \`node ${installedSourceCli} setup --cwd ${consumerDir}\` first.`,
    "installed source missing setup --cwd status output"
  );
  const missingBridgeSourceCwdCheck = await runExpectFailure(
    binPath,
    ["pro", "browser", "check", "--cwd", consumerDir, "--source-cli", installedSourceCli, "--port", "65534", "--timeout-ms", "10"],
    { cwd: path.dirname(consumerDir) }
  );
  assertIncludes(
    missingBridgeSourceCwdCheck.stdout,
    `bridge: missing (.bridge) - run \`node ${installedSourceCli} init --cwd ${consumerDir}\``,
    "installed source product check --cwd bridge output"
  );
  const missingTunnelPublicUrl = await runExpectFailure(binPath, ["tunnel", "url"], { cwd: consumerDir });
  assertIncludes(missingTunnelPublicUrl.stderr, "tunnel url requires --public-url <https-url>", "installed missing tunnel public URL output");
  assertNotIncludes(missingTunnelPublicUrl.stderr, "requires local MCP setup", "installed missing tunnel public URL output");
  await assertMissingFile(path.join(consumerDir, ".bridge"), "installed consumer bridge after missing tunnel public URL");
  const invalidTunnelPublicUrl = await runExpectFailure(binPath, ["tunnel", "url", "--public-url", "not-a-url"], { cwd: consumerDir });
  assertIncludes(invalidTunnelPublicUrl.stderr, "--public-url must be a valid URL", "installed invalid tunnel public URL output");
  assertNotIncludes(invalidTunnelPublicUrl.stderr, "requires local MCP setup", "installed invalid tunnel public URL output");
  await assertMissingFile(path.join(consumerDir, ".bridge"), "installed consumer bridge after invalid tunnel public URL");
  const missingSetupTunnel = await runExpectFailure(
    binPath,
    ["tunnel", "url", "--public-url", "https://prodex-package-smoke.example", "--show-token", "--url-only"],
    { cwd: consumerDir }
  );
  assertIncludes(missingSetupTunnel.stderr, "tunnel url requires local MCP setup. Run `prodex setup` first.", "installed missing setup tunnel output");
  assertNotIncludes(missingSetupTunnel.stderr, "ENOENT", "installed missing setup tunnel output");
  const missingSetupSourceTunnel = await runExpectFailure(
    binPath,
    ["tunnel", "url", "--public-url", "https://prodex-package-smoke.example", "--source-cli", installedSourceCli],
    { cwd: consumerDir }
  );
  assertIncludes(
    missingSetupSourceTunnel.stderr,
    `tunnel url requires local MCP setup. Run \`node ${installedSourceCli} setup\` first.`,
    "installed source missing setup tunnel output"
  );
  assertNotIncludes(missingSetupSourceTunnel.stderr, "Run `prodex setup`", "installed source missing setup tunnel output");
  const projectPrompt = await run(binPath, ["project", "prompt", "--cwd", consumerDir], { cwd: path.dirname(consumerDir) });
  assertIncludes(projectPrompt.stdout, "ChatGPT Project MCP verification prompt", "installed project prompt output");
  assertIncludes(projectPrompt.stdout, "authorizes all enabled bridge tools", "installed project prompt token authority warning");
  assertIncludes(projectPrompt.stdout, "repo_stage_reviewed_paths", "installed project prompt token authority warning");
  assertIncludes(projectPrompt.stdout, "bridge_create_task", "installed project prompt output");
  assertIncludes(projectPrompt.stdout, "bridge_list_tasks", "installed project prompt output");
  assertIncludes(projectPrompt.stdout, "bridge_get_task", "installed project prompt output");
  assertIncludes(projectPrompt.stdout, "bridge_fetch_result", "installed project prompt output");
  assertIncludes(projectPrompt.stdout, "bridge_fetch_result_artifact", "installed project prompt output");
  assertIncludes(projectPrompt.stdout, `prodex tasks list --status new --cwd ${consumerDir}`, "installed project prompt output");
  assertIncludes(projectPrompt.stdout, `prodex tasks show <task-id> --cwd ${consumerDir}`, "installed project prompt output");
  assertIncludes(
    projectPrompt.stdout,
    `prodex tasks complete <task-id> --cwd ${consumerDir} --summary "prodex MCP verification result" --artifact .bridge/artifacts/results/mcp-verification.md="prodex MCP verification artifact"`,
    "installed project prompt output"
  );
  assertIncludes(projectPrompt.stdout, "local completion done", "installed project prompt output");
  assertIncludes(projectPrompt.stdout, `prodex status --cwd ${consumerDir}`, "installed project prompt output");
  assertIncludes(projectPrompt.stdout, `prodex doctor --cwd ${consumerDir}`, "installed project prompt output");
  assertNotIncludes(projectPrompt.stdout, "prodex_token=", "installed project prompt output");
  const sourceProjectPrompt = await run(binPath, ["project", "prompt", "--cwd", consumerDir, "--source-cli", installedSourceCli], {
    cwd: path.dirname(consumerDir)
  });
  assertIncludes(sourceProjectPrompt.stdout, `${sourcePrefix} tasks list --status new --cwd ${consumerDir}`, "installed source project prompt output");
  assertIncludes(sourceProjectPrompt.stdout, `${sourcePrefix} tasks show <task-id> --cwd ${consumerDir}`, "installed source project prompt output");
  assertIncludes(
    sourceProjectPrompt.stdout,
    `${sourcePrefix} tasks complete <task-id> --cwd ${consumerDir} --summary "prodex MCP verification result" --artifact .bridge/artifacts/results/mcp-verification.md="prodex MCP verification artifact"`,
    "installed source project prompt output"
  );
  assertIncludes(sourceProjectPrompt.stdout, "bridge_fetch_result_artifact", "installed source project prompt output");
  assertIncludes(sourceProjectPrompt.stdout, `${sourcePrefix} status --cwd ${consumerDir}`, "installed source project prompt output");
  assertIncludes(sourceProjectPrompt.stdout, `${sourcePrefix} doctor --cwd ${consumerDir}`, "installed source project prompt output");
  assertIncludes(
    sourceProjectPrompt.stdout,
    `${sourcePrefix} status --cwd ${consumerDir} --source-cli ${installedSourceCli}`,
    "installed source project prompt output"
  );
  assertIncludes(
    sourceProjectPrompt.stdout,
    `${sourcePrefix} doctor --cwd ${consumerDir} --source-cli ${installedSourceCli}`,
    "installed source project prompt output"
  );
  assertNotIncludes(sourceProjectPrompt.stdout, "prodex tasks list --status new", "installed source project prompt output");
  assertNotIncludes(sourceProjectPrompt.stdout, "prodex_token=", "installed source project prompt output");
  const claudePrompt = await run(binPath, ["claude", "prompt", "--cwd", consumerDir], { cwd: path.dirname(consumerDir) });
  assertIncludes(claudePrompt.stdout, "Claude MCP verification prompt", "installed Claude prompt output");
  assertIncludes(claudePrompt.stdout, "bridge_create_task", "installed Claude prompt output");
  assertIncludes(claudePrompt.stdout, "bridge_list_tasks", "installed Claude prompt output");
  assertIncludes(claudePrompt.stdout, "bridge_get_task", "installed Claude prompt output");
  assertIncludes(claudePrompt.stdout, "bridge_fetch_result", "installed Claude prompt output");
  assertIncludes(claudePrompt.stdout, "bridge_fetch_result_artifact", "installed Claude prompt output");
  assertIncludes(claudePrompt.stdout, `prodex tasks list --status new --cwd ${consumerDir}`, "installed Claude prompt output");
  assertIncludes(claudePrompt.stdout, `prodex tasks show <task-id> --cwd ${consumerDir}`, "installed Claude prompt output");
  assertIncludes(
    claudePrompt.stdout,
    `prodex tasks complete <task-id> --cwd ${consumerDir} --summary "prodex Claude MCP verification result" --artifact .bridge/artifacts/results/claude-verification.md="prodex Claude MCP verification artifact"`,
    "installed Claude prompt output"
  );
  assertIncludes(claudePrompt.stdout, `prodex claude config --cwd ${consumerDir}`, "installed Claude prompt output");
  assertIncludes(claudePrompt.stdout, `prodex doctor --cwd ${consumerDir}`, "installed Claude prompt output");
  assertNotIncludes(claudePrompt.stdout, "prodex_token=", "installed Claude prompt output");
  const sourceClaudePrompt = await run(binPath, ["claude", "prompt", "--cwd", consumerDir, "--source-cli", installedSourceCli], {
    cwd: path.dirname(consumerDir)
  });
  assertIncludes(sourceClaudePrompt.stdout, `${sourcePrefix} tasks list --status new --cwd ${consumerDir}`, "installed source Claude prompt output");
  assertIncludes(sourceClaudePrompt.stdout, `${sourcePrefix} tasks show <task-id> --cwd ${consumerDir}`, "installed source Claude prompt output");
  assertIncludes(
    sourceClaudePrompt.stdout,
    `${sourcePrefix} tasks complete <task-id> --cwd ${consumerDir} --summary "prodex Claude MCP verification result" --artifact .bridge/artifacts/results/claude-verification.md="prodex Claude MCP verification artifact"`,
    "installed source Claude prompt output"
  );
  assertIncludes(sourceClaudePrompt.stdout, "bridge_fetch_result_artifact", "installed source Claude prompt output");
  assertIncludes(sourceClaudePrompt.stdout, `${sourcePrefix} claude config --cwd ${consumerDir} --source-cli ${installedSourceCli}`, "installed source Claude prompt output");
  assertIncludes(sourceClaudePrompt.stdout, `${sourcePrefix} doctor --cwd ${consumerDir}`, "installed source Claude prompt output");
  assertIncludes(
    sourceClaudePrompt.stdout,
    `${sourcePrefix} doctor --cwd ${consumerDir} --source-cli ${installedSourceCli}`,
    "installed source Claude prompt output"
  );
  assertNotIncludes(sourceClaudePrompt.stdout, "prodex tasks list --status new", "installed source Claude prompt output");
  assertNotIncludes(sourceClaudePrompt.stdout, "prodex_token=", "installed source Claude prompt output");
  const claudeConfig = await run(binPath, ["claude", "config", "--cwd", consumerDir], { cwd: path.dirname(consumerDir) });
  const parsedClaudeConfig = JSON.parse(claudeConfig.stdout);
  if (parsedClaudeConfig?.mcpServers?.prodex?.command !== "prodex") {
    throw new Error(`Installed Claude config command mismatch: ${claudeConfig.stdout}`);
  }
  if (JSON.stringify(parsedClaudeConfig?.mcpServers?.prodex?.args) !== JSON.stringify(["mcp", "--cwd", consumerDir])) {
    throw new Error(`Installed Claude config args mismatch: ${claudeConfig.stdout}`);
  }
  assertNotIncludes(claudeConfig.stdout, "prodex_token=", "installed Claude config output");
  const browserLoginGuide = await run(binPath, ["pro", "browser", "login", "--dry-run"], { cwd: consumerDir });
  assertIncludes(browserLoginGuide.stdout, "Dry run: no browser was opened.", "installed browser login guide");
  assertIncludes(browserLoginGuide.stdout, "Cloudflare", "installed browser login guide");
  assertIncludes(browserLoginGuide.stdout, "usage limit", "installed browser login guide");
  assertIncludes(
    browserLoginGuide.stdout,
    "For usage limit, message limit, model limit, or rate limit, wait for the reset or choose an available model in the browser.",
    "installed browser login guide"
  );
  assertIncludes(browserLoginGuide.stdout, "Open a normal ChatGPT chat or the intended Project/thread so the prompt composer is visible.", "installed browser login guide");
  assertIncludes(browserLoginGuide.stdout, "prodex pro browser check", "installed browser login guide");
  assertIncludes(browserLoginGuide.stdout, "prodex pro browser smoke", "installed browser login guide");
  assertIncludes(
    browserLoginGuide.stdout,
    "1. Run `prodex pro browser login` without `--dry-run` to open the dedicated Chrome window.",
    "installed browser login guide"
  );
  assertIncludes(browserLoginGuide.stdout, "2. Log in manually at https://chatgpt.com/ in that Chrome window.", "installed browser login guide");
  assertNotIncludes(browserLoginGuide.stdout, "usage limit handling, complete it in the browser", "installed browser login guide");
  assertAppearsBefore(
    browserLoginGuide.stdout,
    "Run `prodex pro browser login` without `--dry-run`",
    "Log in manually",
    "installed browser login guide"
  );
  assertNotIncludes(browserLoginGuide.stdout, "You can close this Chrome window after login", "installed browser login guide");
  assertNotIncludes(browserLoginGuide.stdout, "node dist/cli.js", "installed browser login guide");
  const sourceBrowserLoginGuide = await run(binPath, ["pro", "browser", "login", "--dry-run", "--source-cli", installedSourceCli], {
    cwd: consumerDir
  });
  assertIncludes(
    sourceBrowserLoginGuide.stdout,
    `1. Run \`${sourcePrefix} pro browser login --source-cli ${installedSourceCli}\` without \`--dry-run\` to open the dedicated Chrome window.`,
    "installed source browser login guide"
  );
  assertIncludes(
    sourceBrowserLoginGuide.stdout,
    `Run \`${sourcePrefix} pro browser check --source-cli ${installedSourceCli}\` to confirm the session is reachable.`,
    "installed source browser login guide"
  );
  assertIncludes(
    sourceBrowserLoginGuide.stdout,
    `Run \`${sourcePrefix} pro browser smoke --source-cli ${installedSourceCli}\` to verify a real Pro response path.`,
    "installed source browser login guide"
  );
  assertNotIncludes(sourceBrowserLoginGuide.stdout, "Run `prodex pro browser login`", "installed source browser login guide");
  const sourceCwdBrowserLoginGuide = await run(binPath, ["pro", "browser", "login", "--dry-run", "--cwd", consumerDir, "--source-cli", installedSourceCli], {
    cwd: path.dirname(consumerDir)
  });
  assertIncludes(
    sourceCwdBrowserLoginGuide.stdout,
    `Run \`cd ${consumerDir} && ${sourcePrefix} pro browser check --source-cli ${installedSourceCli}\` to confirm the session is reachable.`,
    "installed source cwd browser login guide"
  );
  assertIncludes(
    sourceCwdBrowserLoginGuide.stdout,
    `Run \`cd ${consumerDir} && ${sourcePrefix} pro browser smoke --source-cli ${installedSourceCli}\` to verify a real Pro response path.`,
    "installed source cwd browser login guide"
  );
  const customBrowserProfile = path.join(tmp, "custom-browser-profile");
  const customBrowserLoginGuide = await run(
    binPath,
    [
      "pro",
      "browser",
      "login",
      "--dry-run",
      "--source-cli",
      installedSourceCli,
      "--profile-dir",
      customBrowserProfile,
      "--port",
      "12345",
      "--url",
      "https://chatgpt.com/g/g-demo/project",
      "--launch-timeout-ms",
      "12000"
    ],
    { cwd: consumerDir }
  );
  assertIncludes(
    customBrowserLoginGuide.stdout,
    `${sourcePrefix} pro browser login --source-cli ${installedSourceCli} --profile-dir ${customBrowserProfile} --port 12345 --url https://chatgpt.com/g/g-demo/project --launch-timeout-ms 12000`,
    "installed custom browser login guide"
  );
  assertIncludes(
    customBrowserLoginGuide.stdout,
    `${sourcePrefix} pro browser check --source-cli ${installedSourceCli} --port 12345`,
    "installed custom browser login guide"
  );
  assertIncludes(
    customBrowserLoginGuide.stdout,
    `${sourcePrefix} pro browser smoke --source-cli ${installedSourceCli} --port 12345`,
    "installed custom browser login guide"
  );
  const browserHelp = await run(binPath, ["pro", "browser", "help"], { cwd: consumerDir });
  assertIncludes(
    browserHelp.stdout,
    "prodex pro browser login [--cwd /absolute/path/to/repo] [--dry-run] [--source-cli /absolute/path/to/dist/cli.js]",
    "installed browser help"
  );
  assertIncludes(
    browserHelp.stdout,
    "prodex pro browser check [--source-cli /absolute/path/to/dist/cli.js]",
    "installed browser help"
  );
  assertIncludes(
    browserHelp.stdout,
    "prodex pro browser smoke [--source-cli /absolute/path/to/dist/cli.js] [--cwd /absolute/path/to/repo]",
    "installed browser help"
  );
  assertIncludes(
    browserHelp.stdout,
    'prodex pro browser ask [--source-cli /absolute/path/to/dist/cli.js] [--cwd /absolute/path/to/repo] [--port 9333] [--timeout-ms 90000] [--target-url url --confirm-target] [--file path] "prompt"',
    "installed browser help"
  );
  assertIncludes(
    browserHelp.stdout,
    "Use `prodex pro ask` for dry-run/manual previews.",
    "installed browser help"
  );
  assertIncludes(
    browserHelp.stdout,
    "`prodex pro browser ask` always attempts an explicit visible-browser send.",
    "installed browser help"
  );
  const sourceBrowserHelp = await run(binPath, ["pro", "browser", "help", "--source-cli", installedSourceCli], { cwd: consumerDir });
  assertIncludes(
    sourceBrowserHelp.stdout,
    `${sourcePrefix} pro browser login --source-cli ${installedSourceCli} [--cwd /absolute/path/to/repo] [--dry-run]`,
    "installed source browser help"
  );
  assertIncludes(
    sourceBrowserHelp.stdout,
    `${sourcePrefix} pro browser check --source-cli ${installedSourceCli}`,
    "installed source browser help"
  );
  assertIncludes(
    sourceBrowserHelp.stdout,
    `${sourcePrefix} pro browser smoke --source-cli ${installedSourceCli} [--cwd /absolute/path/to/repo]`,
    "installed source browser help"
  );
  assertIncludes(
    sourceBrowserHelp.stdout,
    `${sourcePrefix} pro browser ask --source-cli ${installedSourceCli} [--cwd /absolute/path/to/repo] [--port 9333] [--timeout-ms 90000] [--target-url url --confirm-target] [--file path] "prompt"`,
    "installed source browser help"
  );
  assertIncludes(
    sourceBrowserHelp.stdout,
    `Use \`${sourcePrefix} pro ask\` for dry-run/manual previews.`,
    "installed source browser help"
  );
  assertNotIncludes(sourceBrowserHelp.stdout, "Use `prodex pro ask`", "installed source browser help");
  for (const subcommand of ["login", "check", "smoke", "ask"]) {
    const sourceBrowserSubcommandHelp = await run(binPath, ["pro", "browser", subcommand, "--source-cli", installedSourceCli, "--help"], {
      cwd: consumerDir
    });
    assertIncludes(
      sourceBrowserSubcommandHelp.stdout,
      `${sourcePrefix} pro browser login --source-cli ${installedSourceCli} [--cwd /absolute/path/to/repo] [--dry-run]`,
      `installed source browser ${subcommand} help`
    );
    assertIncludes(
      sourceBrowserSubcommandHelp.stdout,
      `${sourcePrefix} pro browser smoke --source-cli ${installedSourceCli} [--cwd /absolute/path/to/repo]`,
      `installed source browser ${subcommand} help`
    );
    assertIncludes(
      sourceBrowserSubcommandHelp.stdout,
      `${sourcePrefix} pro browser ask --source-cli ${installedSourceCli}`,
      `installed source browser ${subcommand} help`
    );
    assertNotIncludes(sourceBrowserSubcommandHelp.stdout, "Use `prodex pro ask`", `installed source browser ${subcommand} help`);
  }
  const invalidBrowserPort = await runExpectFailure(binPath, ["pro", "browser", "check", "--port", "-1", "--timeout-ms", "10"], {
    cwd: consumerDir
  });
  assertIncludes(invalidBrowserPort.stderr, "--port must be an integer from 1 to 65535", "installed invalid browser port output");
  const invalidBrowserTimeout = await runExpectFailure(binPath, ["pro", "browser", "check", "--port", "65534", "--timeout-ms", "0"], {
    cwd: consumerDir
  });
  assertIncludes(invalidBrowserTimeout.stderr, "--timeout-ms must be greater than 0", "installed invalid browser timeout output");
  const invalidBrowserLaunchTimeout = await runExpectFailure(binPath, ["pro", "browser", "login", "--dry-run", "--launch-timeout-ms", "0"], {
    cwd: consumerDir
  });
  assertIncludes(invalidBrowserLaunchTimeout.stderr, "--launch-timeout-ms must be greater than 0", "installed invalid browser launch timeout output");
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
  const proAskCwdTarget = path.join(tmp, "pro ask cwd target");
  const proAskLauncher = path.join(tmp, "pro ask launcher");
  await mkdir(proAskCwdTarget, { recursive: true });
  await mkdir(proAskLauncher, { recursive: true });
  await writeFile(path.join(proAskCwdTarget, "notes.md"), "installed target pro ask notes\n", "utf8");
  const proAskCwd = await run(binPath, ["pro", "ask", "--cwd", proAskCwdTarget, "--file", "notes.md", "Review this"], {
    cwd: proAskLauncher
  });
  assertIncludes(proAskCwd.stdout, "DRY RUN", "installed pro ask cwd output");
  assertIncludes(proAskCwd.stdout, "installed target pro ask notes", "installed pro ask cwd output");
  await assertMissingFile(path.join(proAskLauncher, ".bridge"), "installed pro ask cwd launcher bridge");
  const browserAskCwdTarget = path.join(tmp, "browser ask cwd target");
  const browserAskLauncher = path.join(tmp, "browser ask launcher");
  await mkdir(browserAskCwdTarget, { recursive: true });
  await mkdir(browserAskLauncher, { recursive: true });
  await writeFile(path.join(browserAskCwdTarget, "notes.md"), "installed target browser ask notes\n", "utf8");
  const browserAskCwd = await runExpectFailure(
    binPath,
    [
      "pro",
      "browser",
      "ask",
      "--cwd",
      browserAskCwdTarget,
      "--port",
      "65534",
      "--timeout-ms",
      "10",
      "--source-cli",
      installedSourceCli,
      "--file",
      "notes.md",
      "Review this"
    ],
    {
      cwd: browserAskLauncher,
      timeout: 60_000
    }
  );
  assertIncludes(
    browserAskCwd.stderr,
    `cd ${shellQuotedForSmoke(browserAskCwdTarget)} && ${sourcePrefix} pro browser login --source-cli ${installedSourceCli} --port 65534`,
    "installed pro browser ask cwd output"
  );
  await assertMissingFile(path.join(browserAskLauncher, ".bridge"), "installed pro browser ask cwd launcher bridge");
  const browserAskLatest = await run(binPath, ["pro", "latest", "--cwd", browserAskCwdTarget], { cwd: browserAskLauncher });
  assertIncludes(browserAskLatest.stdout, "status: blocked", "installed pro browser ask cwd latest output");
  const browserAskTaskId = browserAskLatest.stdout.match(/^task_id: (task_[^\n]+)/m)?.[1];
  if (!browserAskTaskId) {
    throw new Error(`Installed pro browser ask cwd latest output did not include a task id: ${browserAskLatest.stdout}`);
  }
  const browserAskTask = JSON.parse(await readFile(path.join(browserAskCwdTarget, ".bridge", "tasks", `${browserAskTaskId}.json`), "utf8"));
  assertIncludes(browserAskTask.prompt, "installed target browser ask notes", "installed pro browser ask cwd task");
  await assertMissingFile(path.join(consumerDir, ".bridge"), "installed consumer bridge before pro ask alias guard");
  const proAskSendAlias = await runExpectFailure(binPath, ["pro", "ask", "--send", "--timeout-ms", "1", "Review this"], {
    cwd: consumerDir
  });
  assertIncludes(proAskSendAlias.stderr, "pro ask is a dry-run preview", "installed pro ask send alias guard");
  assertIncludes(proAskSendAlias.stderr, "pro browser ask", "installed pro ask send alias guard");
  const browserAskDryRun = await runExpectFailure(binPath, ["pro", "browser", "ask", "--dry-run", "Installed dry-run smoke"], {
    cwd: consumerDir
  });
  assertIncludes(browserAskDryRun.stderr, "prodex pro browser ask is an explicit visible-browser send", "installed browser ask dry-run guard");
  assertIncludes(browserAskDryRun.stderr, "Use `prodex pro ask` for dry-run previews", "installed browser ask dry-run guard");
  const rawAskProSend = await runExpectFailure(binPath, ["ask-pro", "--send", "--timeout-ms", "1", "Review this"], {
    cwd: consumerDir
  });
  assertIncludes(rawAskProSend.stderr, "Direct ask-pro --send is disabled", "installed raw ask-pro send guard");
  assertIncludes(rawAskProSend.stderr, "pro browser ask", "installed raw ask-pro send guard");
  const conflictingProBrowserAsk = await runExpectFailure(binPath, ["pro", "browser", "ask", "--dry-run", "--send", "Review this"], {
    cwd: consumerDir
  });
  assertIncludes(conflictingProBrowserAsk.stderr, "cannot combine --dry-run and --send", "installed pro browser ask mode guard");
  const confirmWithoutTargetDir = path.join(tmp, "confirm-without-target");
  await mkdir(confirmWithoutTargetDir, { recursive: true });
  const confirmWithoutTarget = await runExpectFailure(
    binPath,
    ["pro", "browser", "ask", "--confirm-target", "--timeout-ms", "1", "Review this"],
    {
      cwd: confirmWithoutTargetDir
    }
  );
  assertIncludes(confirmWithoutTarget.stderr, "--confirm-target requires --target-url", "installed pro browser ask target confirmation guard");
  await assertMissingFile(path.join(confirmWithoutTargetDir, ".bridge"), "installed confirm-without-target bridge");
  const browserSmoke = await runExpectFailure(binPath, ["pro", "browser", "smoke", "--port", "65534", "--timeout-ms", "10"], {
    cwd: consumerDir,
    timeout: 60_000
  });
  assertIncludes(browserSmoke.stderr, "No Chrome DevTools endpoint is reachable", "installed pro browser smoke output");
  assertIncludes(browserSmoke.stderr, "prodex pro browser login", "installed pro browser smoke output");
  assertIncludes(browserSmoke.stderr, "blocked consult recorded: task_", "installed pro browser smoke output");
  const blockedSmoke = await run(binPath, ["pro", "latest"], { cwd: consumerDir });
  assertIncludes(blockedSmoke.stdout, "status: blocked", "installed pro browser smoke blocker output");
  assertIncludes(blockedSmoke.stdout, "- code: browser_unreachable", "installed pro browser smoke blocker output");
  const browserSmokeCwdTarget = path.join(tmp, "browser smoke cwd target");
  const browserSmokeLauncher = path.join(tmp, "browser smoke launcher");
  await mkdir(browserSmokeCwdTarget, { recursive: true });
  await mkdir(browserSmokeLauncher, { recursive: true });
  const browserSmokeCwd = await runExpectFailure(
    binPath,
    ["pro", "browser", "smoke", "--cwd", browserSmokeCwdTarget, "--port", "65534", "--timeout-ms", "10", "--source-cli", installedSourceCli],
    {
      cwd: browserSmokeLauncher,
      timeout: 60_000
    }
  );
  assertIncludes(
    browserSmokeCwd.stderr,
    `cd ${shellQuotedForSmoke(browserSmokeCwdTarget)} && ${sourcePrefix} pro browser login --source-cli ${installedSourceCli} --port 65534`,
    "installed pro browser smoke cwd output"
  );
  await assertMissingFile(path.join(browserSmokeLauncher, ".bridge"), "installed pro browser smoke cwd launcher bridge");
  const blockedSmokeCwd = await run(binPath, ["pro", "latest", "--cwd", browserSmokeCwdTarget], { cwd: browserSmokeLauncher });
  assertIncludes(blockedSmokeCwd.stdout, "status: blocked", "installed pro browser smoke cwd blocker output");
  assertIncludes(blockedSmokeCwd.stdout, "- code: browser_unreachable", "installed pro browser smoke cwd blocker output");
  assertIncludes(
    blockedSmokeCwd.stdout,
    `- next_step: Run \`cd ${shellQuotedForSmoke(browserSmokeCwdTarget)} && ${sourcePrefix} pro browser login --source-cli ${installedSourceCli} --port 65534\`, log in, then retry.`,
    "installed pro browser smoke cwd blocker output"
  );
  const browserSmokeCwdNoSourceTarget = path.join(tmp, "browser smoke cwd nosource target");
  const browserSmokeNoSourceLauncher = path.join(tmp, "browser smoke nosource launcher");
  await mkdir(browserSmokeCwdNoSourceTarget, { recursive: true });
  await mkdir(browserSmokeNoSourceLauncher, { recursive: true });
  const browserSmokeCwdNoSource = await runExpectFailure(
    binPath,
    ["pro", "browser", "smoke", "--cwd", browserSmokeCwdNoSourceTarget, "--port", "65534", "--timeout-ms", "10"],
    {
      cwd: browserSmokeNoSourceLauncher,
      timeout: 60_000
    }
  );
  assertIncludes(
    browserSmokeCwdNoSource.stderr,
    `cd ${shellQuotedForSmoke(browserSmokeCwdNoSourceTarget)} && prodex pro browser login --port 65534`,
    "installed pro browser smoke cwd no-source output"
  );
  await assertMissingFile(path.join(browserSmokeNoSourceLauncher, ".bridge"), "installed pro browser smoke cwd no-source launcher bridge");
  const blockedSmokeCwdNoSource = await run(binPath, ["pro", "latest", "--cwd", browserSmokeCwdNoSourceTarget], { cwd: browserSmokeNoSourceLauncher });
  assertIncludes(blockedSmokeCwdNoSource.stdout, "status: blocked", "installed pro browser smoke cwd no-source blocker output");
  assertIncludes(
    blockedSmokeCwdNoSource.stdout,
    `- next_step: Run \`cd ${shellQuotedForSmoke(browserSmokeCwdNoSourceTarget)} && prodex pro browser login --port 65534\`, log in, then retry.`,
    "installed pro browser smoke cwd no-source blocker output"
  );
  const browserCheck = await runExpectFailure(binPath, ["pro", "browser", "check", "--port", "65534", "--timeout-ms", "10"], {
    cwd: consumerDir,
    timeout: 60_000
  });
  assertIncludes(browserCheck.stdout, "prodex product check", "installed pro browser check output");
  assertIncludes(browserCheck.stdout, "chatgpt: browser_unreachable", "installed pro browser check output");
  assertIncludes(browserCheck.stdout, "prodex pro browser login", "installed pro browser check output");
  const sourceBrowserCheck = await runExpectFailure(
    binPath,
    ["pro", "browser", "check", "--port", "65534", "--timeout-ms", "10", "--source-cli", installedSourceCli],
    {
      cwd: consumerDir,
      timeout: 60_000
    }
  );
  assertIncludes(
    sourceBrowserCheck.stdout,
    `node ${installedSourceCli} pro browser login --source-cli ${installedSourceCli}`,
    "installed source pro browser check output"
  );
  assertNotIncludes(sourceBrowserCheck.stdout, "prodex pro browser login", "installed source pro browser check output");
  const corruptSourceCheckDir = path.join(tmp, "corrupt-source-check");
  await mkdir(path.join(corruptSourceCheckDir, ".bridge"), { recursive: true });
  await writeFile(path.join(corruptSourceCheckDir, ".bridge", "config.local.json"), "{not json", "utf8");
  const corruptSourceBrowserCheck = await runExpectFailure(
    binPath,
    ["pro", "browser", "check", "--port", "65534", "--timeout-ms", "10", "--source-cli", installedSourceCli],
    {
      cwd: corruptSourceCheckDir,
      timeout: 60_000
    }
  );
  assertIncludes(
    corruptSourceBrowserCheck.stdout,
    `config: failed local MCP config is corrupt. Run \`node ${installedSourceCli} setup\` to replace .bridge/config.local.json.`,
    "installed corrupt source pro browser check output"
  );
  assertNotIncludes(corruptSourceBrowserCheck.stdout, "Run `prodex setup`", "installed corrupt source pro browser check output");
  const productCheckTargetDir = path.join(tmp, "product-check-target");
  const productCheckLauncherDir = path.join(tmp, "product-check-launcher");
  await mkdir(productCheckTargetDir, { recursive: true });
  await mkdir(productCheckLauncherDir, { recursive: true });
  await run(binPath, ["init", "--cwd", productCheckTargetDir], { cwd: productCheckLauncherDir });
  await run(
    binPath,
    ["setup", "--cwd", productCheckTargetDir, "--port", "8789", "--token", "super-secret-token", "--token-ttl-hours", "1"],
    { cwd: productCheckLauncherDir }
  );
  const cwdBrowserCheck = await runExpectFailure(
    binPath,
    ["pro", "browser", "check", "--cwd", productCheckTargetDir, "--port", "65534", "--timeout-ms", "10"],
    {
      cwd: productCheckLauncherDir,
      timeout: 60_000
    }
  );
  assertIncludes(cwdBrowserCheck.stdout, "bridge: ok (.bridge)", "installed explicit --cwd pro browser check output");
  assertIncludes(
    cwdBrowserCheck.stdout,
    "config: ok http://127.0.0.1:8789/mcp?prodex_token=*** token_status=valid",
    "installed explicit --cwd pro browser check output"
  );
  assertNotIncludes(cwdBrowserCheck.stdout, "super-secret-token", "installed explicit --cwd pro browser check output");
  await assertMissingFile(path.join(productCheckLauncherDir, ".bridge"), "installed explicit --cwd pro browser check launcher bridge");
  for (const [alias, replacement] of [
    ["open", "login"],
    ["status", "check"],
    ["doctor", "check"]
  ]) {
    const staleAlias = await runExpectFailure(binPath, ["pro", "browser", alias, "--port", "65534", "--timeout-ms", "1"], {
      cwd: consumerDir
    });
    assertIncludes(staleAlias.stderr, `Use \`prodex pro browser ${replacement}\``, `installed pro browser ${alias} alias guard`);
  }
  const emptyRecordsDir = path.join(tmp, "empty-records");
  await mkdir(emptyRecordsDir, { recursive: true });
  for (const command of [
    ["tasks", "list"],
    ["receipts", "list"],
    ["sessions", "list"],
    ["pro", "list"]
  ]) {
    await run(binPath, command, { cwd: emptyRecordsDir });
  }
  for (const [command, expectedMessage] of [
    [["tasks", "show", "latest"], "No tasks found"],
    [["results", "show", "latest"], "No results found"],
    [["results", "artifact", "latest"], "No results found"],
    [["receipts", "show", "latest"], "No receipts found"],
    [["sessions", "show", "latest"], "No sessions found"],
    [["pro", "show", "latest"], "No GPT Pro answers found"]
  ]) {
    const latestFailure = await runExpectFailure(binPath, command, { cwd: emptyRecordsDir });
    assertIncludes(latestFailure.stderr, expectedMessage, `installed empty ${command.join(" ")} output`);
  }
  await assertMissingFile(path.join(emptyRecordsDir, ".bridge"), "installed empty inspection bridge directory");
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
  const corruptRecordsDir = path.join(tmp, "corrupt-records");
  for (const fixture of [
    {
      dir: "tasks",
      id: "task_20990101_000000_corrupt-task",
      command: ["tasks", "show", "task_20990101_000000_corrupt-task"],
      expected: "Task record is corrupt: .bridge/tasks/task_20990101_000000_corrupt-task.json."
    },
    {
      dir: "results",
      id: "task_20990101_000000_corrupt-result",
      command: ["results", "show", "task_20990101_000000_corrupt-result"],
      expected: "Result record is corrupt: .bridge/results/task_20990101_000000_corrupt-result.json."
    },
    {
      dir: "receipts",
      id: "receipt_20990101_000000_corrupt-receipt",
      command: ["receipts", "show", "receipt_20990101_000000_corrupt-receipt"],
      expected: "Receipt record is corrupt: .bridge/receipts/receipt_20990101_000000_corrupt-receipt.json."
    },
    {
      dir: "sessions",
      id: "sess_20990101_000000_corrupt-session",
      command: ["sessions", "show", "sess_20990101_000000_corrupt-session"],
      expected: "Session record is corrupt: .bridge/sessions/sess_20990101_000000_corrupt-session.json."
    }
  ]) {
    await mkdir(path.join(corruptRecordsDir, ".bridge", fixture.dir), { recursive: true });
    await writeFile(path.join(corruptRecordsDir, ".bridge", fixture.dir, `${fixture.id}.json`), "{not-json\n", "utf8");
    const corruptRecord = await runExpectFailure(binPath, fixture.command, { cwd: corruptRecordsDir });
    assertIncludes(corruptRecord.stderr, fixture.expected, `installed corrupt ${fixture.command.join(" ")} output`);
    assertIncludes(corruptRecord.stderr, "Move it aside or fix the JSON", `installed corrupt ${fixture.command.join(" ")} output`);
    assertNotIncludes(corruptRecord.stderr, "SyntaxError", `installed corrupt ${fixture.command.join(" ")} output`);
    assertNotIncludes(corruptRecord.stderr, "Unexpected token", `installed corrupt ${fixture.command.join(" ")} output`);
    assertNotIncludes(corruptRecord.stderr, "ZodError", `installed corrupt ${fixture.command.join(" ")} output`);
  }
  const legacyConsults = await runExpectFailure(binPath, ["consults", "list"], { cwd: consumerDir });
  assertIncludes(legacyConsults.stderr, "legacy `consults` alias is retired", "installed consults alias guard");
  assertIncludes(legacyConsults.stderr, "prodex pro list", "installed consults alias guard");

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
  const blockedConsultTaskId = await smokeInstalledProBlockedConsult(binPath, consumerDir);
  await smokeInstalledExplicitCwdInspection(binPath, consumerDir, launcherDir, blockedConsultTaskId);
  await smokeInstalledUntrustedResultInspection(binPath, tmp, launcherDir);

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
  const stdioNonGitDir = path.join(tmp, "stdio-non-git");
  await mkdir(stdioNonGitDir, { recursive: true });
  await smokeStdioMcpNonGitWriteFailure(binPath, stdioNonGitDir);
  await smokeInstalledStdioTaskFinalizers(binPath, consumerDir);

  console.log(
    `package_smoke: ok tarball=${path.basename(packed.filename)} http_onboarding=ok installed_http_mcp=ok http_write_flow=ok http_task_finalizers=ok http_result_artifact_flow=ok http_result_artifact_tamper=ok http_receipt_session_tools=ok configured_doctor=ok tunnel_url=ok package_boundary=ok installed_untrusted_result=ok installed_release_pack=ok installed_release_pack_cli=ok installed_release_pack_source_cli=ok installed_release_git_matrix=ok installed_release_pack_publish_dry_run=ok installed_release_pack_publish_command=ok stdio_write_flow=ok stdio_search_overflow=ok stdio_non_git_write=ok stdio_task_flow=ok stdio_task_finalizers=ok stdio_result_artifact_flow=ok stdio_result_artifact_tamper=ok stdio_receipt_session_tools=ok tools=${REQUIRED_MCP_TOOLS.join(",")}`
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
  const allowedExact = new Set([
    "LICENSE",
    "README.md",
    "docs/claude.md",
    "docs/clients.md",
    "docs/http-mcp.md",
    "package.json",
    "scripts/release-check.mjs",
    "scripts/release-pack.mjs"
  ]);
  for (const filePath of allowedExact) {
    assertArrayIncludes(paths, filePath, "packed files");
  }
  assertArrayIncludes(paths, "dist/cli.js", "packed files");

  const unexpected = paths.filter((filePath) => !allowedExact.has(filePath) && !/^dist\/[^/]+\.(?:d\.ts|js|js\.map)$/.test(filePath));
  if (unexpected.length > 0) {
    throw new Error(`packed files unexpectedly included non-public paths: ${unexpected.slice(0, 10).join(", ")}`);
  }
}

async function assertInstalledReleasePackTarballModes(tarballPath, packedFiles, label) {
  const consumer = await mkdtemp(path.join(tmp, "release-pack-consumer-"));
  await writeFile(path.join(consumer, "package.json"), `${JSON.stringify({ private: true }, null, 2)}\n`, "utf8");
  await run(npmCommand, ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", tarballPath], {
    cwd: consumer,
    timeout: 120_000,
    maxBuffer: 20 * 1024 * 1024
  });
  const installedRoot = path.join(consumer, "node_modules", "@youdie006", "prodex");
  const installedPackageJson = JSON.parse(await readFile(path.join(installedRoot, "package.json"), "utf8"));
  const binPaths = packageBinPaths(installedPackageJson);
  for (const file of packedFiles) {
    const packagePath = normalizePackagePath(file.path);
    const expectedMode = binPaths.has(packagePath) ? 0o755 : 0o644;
    await assertFileMode(path.join(installedRoot, ...packagePath.split("/")), expectedMode, `${label} ${packagePath}`);
  }
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
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`packed file entry is missing a path: ${JSON.stringify(value)}`);
  }
  return value.replaceAll("\\", "/").replace(/^\.\/+/, "");
}

async function assertNpmPublishDryRun(tarballPath, cwd, label) {
  const result = await run(npmCommand, ["publish", "--dry-run", tarballPath], {
    cwd,
    timeout: 120_000,
    maxBuffer: 20 * 1024 * 1024
  });
  const output = `${result.stdout}\n${result.stderr}`;
  assertIncludes(output, "prodex@0.2.0", `${label} npm publish dry-run output`);
  assertIncludes(output, "Publishing to", `${label} npm publish dry-run output`);
  assertIncludes(output, "(dry-run)", `${label} npm publish dry-run output`);
}

async function assertFileMode(filePath, expectedMode, label) {
  const actualMode = (await stat(filePath)).mode & 0o777;
  if (actualMode !== expectedMode) {
    throw new Error(`${label} expected mode ${expectedMode.toString(8)}, got ${actualMode.toString(8)}`);
  }
}

async function assertInstalledDocsArePortable(consumerDir) {
  const packageDir = path.join(consumerDir, "node_modules", "@youdie006", "prodex");
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
  assertIncludes(readme, "note the scope", "installed README");
  assertIncludes(readme, "prodex onboard", "installed README");
  assertIncludes(readme, "onboard --source-cli", "installed README");
  assertIncludes(readme, "cd /absolute/path/to/prodex", "installed README");
  assertIncludes(readme, 'SOURCE_CLI="/absolute/path/to/prodex/dist/cli.js"', "installed README");
  assertNotIncludes(readme, 'SOURCE_CLI="$(pwd)/dist/cli.js"', "installed README");
  assertIncludes(readme, 'doctor --source-cli "$SOURCE_CLI"', "installed README");
  assertIncludes(readme, "local MCP troubleshooting commands so their follow-up guidance stays in source-checkout form", "installed README");
  assertIncludes(readme, "tasks create/list/show/claim/complete/block", "installed README");
  assertIncludes(readme, "cd /absolute/path/to/your/repo", "installed README");
  assertIncludes(readme, "prodex tasks create --cwd /absolute/path/to/your/repo", "installed README");
  assertIncludes(readme, "prodex tasks list --status new --cwd /absolute/path/to/your/repo", "installed README");
  assertIncludes(readme, "prodex tasks show <task-id> --cwd /absolute/path/to/your/repo", "installed README");
  assertIncludes(
    readme,
    'prodex tasks complete <task-id> --cwd /absolute/path/to/your/repo --summary "prodex MCP verification result"',
    "installed README"
  );
  assertIncludes(readme, "prodex tasks list --cwd /absolute/path/to/your/repo", "installed README");
  assertIncludes(readme, "prodex tasks show latest --cwd /absolute/path/to/your/repo", "installed README");
  assertIncludes(readme, "prodex tasks block <task-id> --cwd /absolute/path/to/your/repo", "installed README");
  assertIncludes(readme, 'prodex pro ask --cwd /absolute/path/to/your/repo "Review the project positioning"', "installed README");
  assertIncludes(readme, "prodex pro browser login --dry-run", "installed README");
  assertIncludes(readme, "pass `--cwd /absolute/path/to/your/repo` to `login`, `check`, or `smoke`", "installed README");
  assertIncludes(readme, "Open a normal ChatGPT chat or the intended Project/thread so the prompt composer is visible.", "installed README");
  assertIncludes(readme, "If ChatGPT shows a usage limit, message limit, model limit, or rate limit, wait for the reset or choose an available model in the browser.", "installed README");
  assertNotIncludes(readme, "If ChatGPT asks for captcha, permission, or account verification, handle it in that browser.", "installed README");
  assertIncludes(readme, "You can close that Chrome window after check/smoke or when you are done.", "installed README");
  assertNotIncludes(readme, "You can close that Chrome window after login", "installed README");
  assertIncludes(readme, "pro browser login --dry-run --source-cli", "installed README");
  assertIncludes(readme, "pro browser check --source-cli", "installed README");
  assertIncludes(readme, "prodex pro browser smoke --cwd /absolute/path/to/your/repo", "installed README");
  assertIncludes(readme, 'node "$SOURCE_CLI" pro browser smoke --source-cli "$SOURCE_CLI" --cwd /absolute/path/to/your/repo', "installed README");
  assertIncludes(readme, "pro browser ask --source-cli", "installed README");
  assertIncludes(readme, "prodex pro browser ask -- --strict mode review", "installed README");
  assertIncludes(readme, "pro list`, `pro latest`, or `pro show <task-id|latest>`", "installed README");
  assertIncludes(readme, "prodex pro browser help", "installed README");
  assertIncludes(readme, "visibility cannot be verified for extra ChatGPT tabs", "installed README");
  assertIncludes(readme, "prodex init", "installed README");
  assertIncludes(readme, "CLI-only", "installed README");
  assertIncludes(readme, "ripgrep", "installed README");
  assertIncludes(readme, "setup --cwd", "installed README");
  assertIncludes(
    readme,
    "node dist/cli.js start --cwd /absolute/path/to/your/repo --source-cli /absolute/path/to/prodex/dist/cli.js",
    "installed README"
  );
  assertIncludes(
    readme,
    "node dist/cli.js status --cwd /absolute/path/to/your/repo --source-cli /absolute/path/to/prodex/dist/cli.js --show-token --url-only",
    "installed README"
  );
  assertIncludes(readme, "mcp --cwd", "installed README");
  assertIncludes(readme, "prodex project prompt", "installed README");
  assertIncludes(
    readme,
    "node dist/cli.js project prompt --cwd /absolute/path/to/your/repo --source-cli /absolute/path/to/prodex/dist/cli.js",
    "installed README"
  );
  assertNotIncludes(readme, 'node dist/cli.js project prompt --source-cli "$(pwd)/dist/cli.js"', "installed README");
  assertIncludes(readme, "project prompt --cwd /absolute/path/to/your/repo --source-cli", "installed README");
  assertIncludes(readme, "bridge_fetch_result", "installed README");
  assertIncludes(readme, "bridge_fetch_result_artifact", "installed README");
  assertNotIncludes(readme, "`bridge_get_task` only", "installed README");
  assertIncludes(readme, "Source-checkout prompts keep `--source-cli` on those troubleshooting commands too.", "installed README");
  assertIncludes(readme, "status --cwd ...", "installed README");
  assertIncludes(readme, "doctor --cwd ...", "installed README");
  assertIncludes(readme, "prodex claude prompt", "installed README");
  assertIncludes(readme, "claude prompt --cwd /absolute/path/to/your/repo --source-cli", "installed README");
  assertIncludes(readme, "node dist/cli.js claude config --cwd /absolute/path/to/your/repo --source-cli /absolute/path/to/prodex/dist/cli.js", "installed README");
  assertNotIncludes(readme, "prodex claude config --cwd /absolute/path/to/your/repo --source-cli /absolute/path/to/prodex/dist/cli.js", "installed README");
  assertIncludes(readme, "claude config --cwd ...", "installed README");
  assertIncludes(readme, "prodex claude config", "installed README");
  assertIncludes(readme, "prodex release status", "installed README");
  assertIncludes(readme, "prodex release pack --pack-destination", "installed README");
  assertIncludes(readme, "--keep-workdir", "installed README");
  assertIncludes(readme, "release status --source-cli", "installed README");
  assertIncludes(readme, "release pack --source-cli", "installed README");
  assertIncludes(
    readme,
    "For source-checkout release commands, prefer the CLI wrapper when you want follow-up guidance to stay in `node dist/cli.js ... --source-cli` form.",
    "installed README"
  );
  assertIncludes(
    readme,
    "node /absolute/path/to/prodex/dist/cli.js release status --source-cli /absolute/path/to/prodex/dist/cli.js",
    "installed README"
  );
  assertIncludes(
    readme,
    "node /absolute/path/to/prodex/dist/cli.js release pack --source-cli /absolute/path/to/prodex/dist/cli.js --pack-destination <dir>",
    "installed README"
  );
  assertIncludes(readme, "pack file-mode, non-regular file, or hard-link blockers", "installed README");
  assertIncludes(readme, "Run `pro ask` and `pro browser ask` from the repo root, or pass `--cwd /absolute/path/to/your/repo`", "installed README");
  assertIncludes(readme, "npm run release:check", "installed README");
  assertIncludes(readme, "npm run release:verify", "installed README");
  assertIncludes(readme, "npm run release:pack", "installed README");
  assertIncludes(readme, "npm publish --dry-run <tarball>", "installed README");
  assertIncludes(readme, "Tarball publish commands bypass npm `prepublishOnly`", "installed README");
  assertIncludes(readme, "release_pack_publish_guard", "installed README");
  assertIncludes(readme, "git remote add origin <git-url>", "installed README");
  assertIncludes(readme, "git push -u origin <branch>", "installed README");
  assertIncludes(readme, "release_pack_git", "installed README");
  assertIncludes(readme, "detached HEAD", "installed README");
  assertIncludes(readme, "upstream is gone", "installed README");
  assertIncludes(readme, "branch divergence", "installed README");
  assertIncludes(readme, "behind upstream", "installed README");
  assertIncludes(readme, "installed `release-pack` script and `prodex release pack` CLI success paths", "installed README");
  assertIncludes(readme, "runs `npm publish --dry-run` against those normalized tarballs", "installed README");
  assertIncludes(readme, "git-ready release-pack output includes the tarball publish lifecycle warning and guarded `release_pack_publish` command", "installed README");
  assertIncludes(
    readme,
    "verifies installed release git blockers for no remote, dirty worktrees, detached HEAD, no upstream, unpushed, upstream gone, behind, and diverged states",
    "installed README"
  );
  assertIncludes(readme, "verifies `release pack` blocks publish guidance for those unsafe git states", "installed README");
  assertIncludes(readme, "regular file", "installed README");
  assertIncludes(readme, "symlinked packed files", "installed README");
  assertIncludes(readme, "hard link", "installed README");
  assertIncludes(readme, "unexpected executable modes", "installed README");
  assertNotIncludes(readme, "hard links outside the package `bin` entries", "installed README");
  assertIncludes(readme, "WSL/Windows mount", "installed README");
  assertIncludes(readme, "npm-publishable `name` and valid semver `version`", "installed README");
  assertIncludes(readme, "installed HTTP MCP repo write dry-run/apply/stage flow", "installed README");
  assertIncludes(readme, "installed HTTP MCP task completion/blocking/result/artifact fetch flow", "installed README");
  assertIncludes(readme, "installed HTTP MCP receipt/session list/fetch tools", "installed README");
  assertIncludes(readme, "installed stdio MCP repo write dry-run/apply/stage flow", "installed README");
  assertIncludes(readme, "installed stdio oversized repo_search failure output", "installed README");
  assertIncludes(readme, "installed stdio non-git write failure output", "installed README");
  assertIncludes(readme, "installed stdio MCP task completion/blocking/result/artifact fetch flow", "installed README");
  assertIncludes(readme, "installed stdio MCP receipt/session list/fetch tools", "installed README");
  assertIncludes(readme, "loopback-only", "installed README");
  assertIncludes(readme, "`start` reads the saved setup profile when the server process starts", "installed README");
  assertIncludes(readme, "restart `prodex start` so the running server uses the new profile", "installed README");
  assertIncludes(readme, "`tunnel url` formats your supplied public tunnel URL with the saved token", "installed README");
  assertNotIncludes(readme, "running server stay on the same host, port, and token", "installed README");
  assertIncludes(readme, "private: true", "installed README");
  assertIncludes(readme, "configured `doctor`", "installed README");
  assertIncludes(readme, ".bridge/artifacts/results/", "installed README");
  assertIncludes(readme, "generic MCP handoff artifacts", "installed README");
  assertIncludes(readme, "sha256 recorded at finalization", "installed README");
  assertIncludes(readme, "prodex results reseal <task-id> --confirm-current-result", "installed README");
  assertIncludes(readme, "Prefer the explicit task id you just reviewed", "installed README");
  assertIncludes(readme, "missing `result_sha256`", "installed README");
  assertIncludes(readme, "It does not reseal unsigned receipts", "installed README");
  assertIncludes(readme, "answer_artifact_warning", "installed README");
  assertIncludes(readme, "too large for `bridge_fetch_result_artifact`", "installed README");
  assertIncludes(readme, "more than one ChatGPT tab or window is visible", "installed README");
  assertIncludes(readme, "blocker code and next step", "installed README");
  assertIncludes(readme, "the failed command also prints the recorded task id plus `pro show`/`pro latest` inspection commands", "installed README");
  assertIncludes(readme, "fatal finalization failures print the received answer", "installed README");
  assertIncludes(readme, "connects to the installed `/mcp` endpoint", "installed README");
  assertIncludes(readme, "verifies explicit `--cwd` task storage", "installed README");
  assertNotIncludes(readme, "ask-pro --send", "installed README");
  assertNotIncludes(readme, "start --host", "installed README");
  assertNotIncludes(readme, "Read-only result artifact fetch for Pro consult artifacts explicitly listed", "installed README");
  assertAppearsBefore(
    readme,
    "Token-bearing MCP URLs are secrets",
    "prodex status --show-token --url-only",
    "installed README token URL warning"
  );
  assertIncludes(readme, "They authorize all enabled bridge tools", "installed README token authority warning");
  assertIncludes(readme, "stage-reviewed-paths tools", "installed README token authority warning");
  assertAppearsBefore(
    readme,
    "Public tunnel MCP URLs are also secrets",
    "prodex tunnel url --public-url \"https://your-tunnel.example\" --show-token --url-only",
    "installed README tunnel token URL warning"
  );
  assertIncludes(httpMcpDoc, "For an installed package", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, "ripgrep", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, "setup --cwd", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, "cd /absolute/path/to/prodex", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, "If your ChatGPT MCP client cannot reach localhost", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, "prodex tunnel url --public-url \"https://your-tunnel.example\" --show-token --url-only", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, "prodex setup --token-ttl-hours 24", "installed HTTP MCP docs");
  assertIncludes(
    httpMcpDoc,
    "node dist/cli.js setup --cwd /absolute/path/to/your/repo --token-ttl-hours 24",
    "installed HTTP MCP docs"
  );
  assertNotIncludes(httpMcpDoc, "node dist/cli.js setup --token-ttl-hours 24", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, "prodex project prompt", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, "project prompt --cwd /absolute/path/to/your/repo --source-cli", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, "prodex tasks list --status new --cwd /absolute/path/to/your/repo", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, "prodex tasks show <task-id> --cwd /absolute/path/to/your/repo", "installed HTTP MCP docs");
  assertIncludes(
    httpMcpDoc,
    'prodex tasks complete <task-id> --cwd /absolute/path/to/your/repo --summary "prodex MCP verification result"',
    "installed HTTP MCP docs"
  );
  assertIncludes(httpMcpDoc, "bridge_fetch_result", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, "bridge_fetch_result_artifact", "installed HTTP MCP docs");
  assertNotIncludes(httpMcpDoc, "then reply with the created task id", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, "recovery hints stay in source-checkout form", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, "Source-checkout prompts keep `--source-cli` on those troubleshooting commands too.", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, "status --cwd ...", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, "doctor --cwd ...", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, "Verify In ChatGPT", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, "Keep `prodex start` running", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, "loopback-only", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, "`start` reads the saved setup profile when the server process starts", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, "restart `prodex start` so the running server uses the new profile", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, "`tunnel url` formats your supplied public tunnel URL with the saved token", "installed HTTP MCP docs");
  assertNotIncludes(httpMcpDoc, "running server matches the URL printed by `status` and `tunnel url`", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, "CLI-only", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, ".bridge/artifacts/results/", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, "fetch rejects the artifact if its content changed afterward", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, "oversized result artifacts", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, "too large for `bridge_fetch_result_artifact`", "installed HTTP MCP docs");
  assertIncludes(httpMcpDoc, "git worktree with a committed HEAD", "installed HTTP MCP docs");
  assertNotIncludes(httpMcpDoc, "start --host", "installed HTTP MCP docs");
  assertAppearsBefore(
    httpMcpDoc,
    "Token-bearing MCP URLs are secrets",
    "prodex status --show-token --url-only",
    "installed HTTP MCP docs token URL warning"
  );
  assertIncludes(httpMcpDoc, "They authorize all enabled bridge tools", "installed HTTP MCP docs token authority warning");
  assertIncludes(httpMcpDoc, "stage-reviewed-paths tools", "installed HTTP MCP docs token authority warning");
  assertAppearsBefore(
    httpMcpDoc,
    "Token-bearing MCP URLs are secrets",
    "prodex status --cwd /absolute/path/to/your/repo --show-token --url-only",
    "installed HTTP MCP docs cwd token URL warning"
  );
  assertAppearsBefore(
    httpMcpDoc,
    "Public tunnel MCP URLs are also secrets",
    "prodex tunnel url --public-url \"https://your-tunnel.example\" --show-token --url-only",
    "installed HTTP MCP docs tunnel token URL warning"
  );
  assertAppearsBefore(
    httpMcpDoc,
    "Public tunnel MCP URLs are also secrets",
    "prodex tunnel url --cwd /absolute/path/to/your/repo --public-url \"https://your-tunnel.example\" --show-token --url-only",
    "installed HTTP MCP docs cwd tunnel token URL warning"
  );
  assertIncludes(claudeDoc, "CLI-only", "installed Claude docs");
  assertIncludes(claudeDoc, "ripgrep", "installed Claude docs");
  assertIncludes(claudeDoc, "mcp --cwd", "installed Claude docs");
  assertIncludes(claudeDoc, "prodex claude prompt", "installed Claude docs");
  assertIncludes(claudeDoc, "claude prompt --cwd /absolute/path/to/your/repo --source-cli", "installed Claude docs");
  assertIncludes(claudeDoc, "prodex tasks list --status new --cwd /absolute/path/to/your/repo", "installed Claude docs");
  assertIncludes(claudeDoc, "prodex tasks show <task-id> --cwd /absolute/path/to/your/repo", "installed Claude docs");
  assertIncludes(
    claudeDoc,
    'prodex tasks complete <task-id> --cwd /absolute/path/to/your/repo --summary "prodex Claude MCP verification result"',
    "installed Claude docs"
  );
  assertIncludes(claudeDoc, "node dist/cli.js claude config --cwd /absolute/path/to/your/repo --source-cli /absolute/path/to/prodex/dist/cli.js", "installed Claude docs");
  assertNotIncludes(claudeDoc, "prodex claude config --cwd /absolute/path/to/your/repo --source-cli /absolute/path/to/prodex/dist/cli.js", "installed Claude docs");
  assertIncludes(claudeDoc, "Source-checkout prompts keep `--source-cli` on those troubleshooting commands too.", "installed Claude docs");
  assertIncludes(
    claudeDoc,
    "claude mcp add prodex -- node /absolute/path/to/prodex/dist/cli.js mcp --cwd /absolute/path/to/your/repo",
    "installed Claude docs"
  );
  assertIncludes(claudeDoc, "claude config --cwd ...", "installed Claude docs");
  assertIncludes(claudeDoc, "doctor --cwd ...", "installed Claude docs");
  assertIncludes(claudeDoc, "prodex claude config", "installed Claude docs");
  assertIncludes(claudeDoc, "bridge_fetch_result_artifact", "installed Claude docs");
  assertIncludes(claudeDoc, ".bridge/artifacts/results/", "installed Claude docs");
  assertIncludes(claudeDoc, "fetch rejects the artifact if its content changed afterward", "installed Claude docs");
  assertIncludes(claudeDoc, "oversized result artifacts", "installed Claude docs");
  assertIncludes(claudeDoc, "too large for `bridge_fetch_result_artifact`", "installed Claude docs");
  assertIncludes(claudeDoc, "git worktree with a committed HEAD", "installed Claude docs");
}

async function assertInstalledPackageImportBoundary(consumerDir, packedFiles) {
  const unsupportedSpecifiers = [
    "@youdie006/prodex",
    ...packedFiles
      .map((file) => file.path)
      .filter((filePath) => filePath.startsWith("dist/") && filePath.endsWith(".js"))
      .sort()
      .map((filePath) => `@youdie006/prodex/${filePath}`)
  ];
  assertArrayIncludes(unsupportedSpecifiers, "@youdie006/prodex/dist/cli.js", "installed package boundary specifiers");
  assertArrayIncludes(unsupportedSpecifiers, "@youdie006/prodex/dist/index.js", "installed package boundary specifiers");
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
  const latest = await run(binPath, ["pro", "latest"], { cwd });
  const taskId = latest.stdout.match(/^task_id: (task_[^\n]+)/m)?.[1];
  if (!taskId?.startsWith("task_")) {
    throw new Error(`Installed blocked consult smoke could not parse task id: ${latest.stdout}`);
  }
  assertIncludes(latest.stdout, "status: blocked", "installed pro latest blocked output");
  assertIncludes(latest.stdout, "blocker:", "installed pro latest blocked output");
  assertIncludes(latest.stdout, "- code: browser_unreachable", "installed pro latest blocked output");
  assertIncludes(latest.stdout, "- retryable: true", "installed pro latest blocked output");
  assertIncludes(latest.stdout, "pro browser login", "installed pro latest blocked output");
  const check = await runExpectFailure(binPath, ["pro", "browser", "check", "--port", "65534", "--timeout-ms", "10"], { cwd, timeout: 60_000 });
  assertIncludes(check.stdout, `latest_pro: blocked ${taskId}`, "installed pro browser check blocked output");
  assertNotIncludes(check.stdout, `latest_pro: ok ${taskId} blocked`, "installed pro browser check blocked output");
  return taskId;
}

async function smokeInstalledExplicitCwdInspection(binPath, repoCwd, launcherCwd, taskId) {
  const latest = await run(binPath, ["pro", "latest", "--cwd", repoCwd], { cwd: launcherCwd });
  assertIncludes(latest.stdout, `task_id: ${taskId}`, "installed explicit --cwd pro latest output");
  assertIncludes(latest.stdout, "status: blocked", "installed explicit --cwd pro latest output");

  const taskList = await run(binPath, ["tasks", "list", "--cwd", repoCwd], { cwd: launcherCwd });
  assertIncludes(taskList.stdout, `${taskId}\tblocked\tGPT Pro smoke`, "installed explicit --cwd tasks list output");

  const result = await run(binPath, ["results", "show", "latest", "--cwd", repoCwd], { cwd: launcherCwd });
  assertIncludes(result.stdout, `"task_id": "${taskId}"`, "installed explicit --cwd results show output");

  const created = await run(binPath, ["tasks", "create", "--cwd", repoCwd, "--title", "Installed cwd mutation", "--prompt", "Create from launcher"], {
    cwd: launcherCwd
  });
  const createdTaskId = created.stdout.split("\t")[0];
  if (!createdTaskId?.startsWith("task_")) {
    throw new Error(`Installed explicit --cwd tasks create output did not include a task id: ${created.stdout}`);
  }
  const claimed = await run(binPath, ["tasks", "claim", createdTaskId, "--cwd", repoCwd, "--by", "package-smoke"], { cwd: launcherCwd });
  assertIncludes(claimed.stdout, `${createdTaskId}\tclaimed\tpackage-smoke`, "installed explicit --cwd tasks claim output");
  const blocked = await run(
    binPath,
    ["tasks", "block", createdTaskId, "--cwd", repoCwd, "--summary", "Blocked from launcher.", "--code", "package_smoke_blocker"],
    { cwd: launcherCwd }
  );
  assertIncludes(blocked.stdout, `${createdTaskId}\tblocked\tBlocked from launcher.`, "installed explicit --cwd tasks block output");
  const blockedResult = await run(binPath, ["results", "show", createdTaskId, "--cwd", repoCwd], { cwd: launcherCwd });
  assertIncludes(blockedResult.stdout, `"task_id": "${createdTaskId}"`, "installed explicit --cwd tasks block result output");
  assertIncludes(blockedResult.stdout, `"status": "blocked"`, "installed explicit --cwd tasks block result output");
  await assertMissingFile(path.join(launcherCwd, ".bridge", ".gitignore"), "installed explicit --cwd inspection launcher bridge gitignore");
}

async function smokeInstalledUntrustedResultInspection(binPath, tmp, launcherCwd) {
  const cwd = path.join(tmp, "untrusted-result");
  const bridgeDir = path.join(cwd, ".bridge");
  const taskId = "task_20990101_000000_untrusted-result";
  const timestamp = "2099-01-01T00:00:00.000Z";
  await mkdir(path.join(bridgeDir, "tasks"), { recursive: true });
  await mkdir(path.join(bridgeDir, "results"), { recursive: true });
  await mkdir(path.join(bridgeDir, "artifacts", "results"), { recursive: true });
  await writeFile(
    path.join(bridgeDir, "tasks", `${taskId}.json`),
    `${JSON.stringify(
      {
        schema_version: 1,
        id: taskId,
        source: "codex",
        status: "new",
        title: "GPT Pro consult",
        prompt: "Do not trust raw results.",
        repo_id: "default",
        files: [],
        provenance: { adapter: "chatgpt-control", warnings: [] },
        created_at: timestamp,
        updated_at: timestamp
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(path.join(bridgeDir, "artifacts", "results", "raw.md"), "raw installed answer\n", "utf8");
  await writeFile(
    path.join(bridgeDir, "results", `${taskId}.json`),
    `${JSON.stringify(
      {
        schema_version: 1,
        task_id: taskId,
        status: "done",
        summary: "Raw installed answer.",
        artifacts: [{ path: ".bridge/artifacts/results/raw.md", role: "result" }],
        commands: ["visible ChatGPT browser consult"],
        warnings: [],
        created_at: timestamp
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const proList = await run(binPath, ["pro", "list", "--cwd", cwd], { cwd: launcherCwd });
  assertIncludes(proList.stdout, `${taskId}\tuntrusted\tResult record is untrusted`, "installed untrusted pro list");
  assertIncludes(proList.stdout, "task_completed receipt", "installed untrusted pro list");
  assertNotIncludes(proList.stdout, "Raw installed answer.", "installed untrusted pro list");

  for (const item of [
    { args: ["results", "show", "latest", "--cwd", cwd], label: "installed untrusted results latest" },
    { args: ["results", "show", taskId, "--cwd", cwd], label: "installed untrusted results show" },
    { args: ["results", "artifact", taskId, "--cwd", cwd], label: "installed untrusted results artifact" },
    { args: ["pro", "show", taskId, "--cwd", cwd], label: "installed untrusted pro show" },
    { args: ["pro", "latest", "--cwd", cwd], label: "installed untrusted pro latest" }
  ]) {
    const failure = await runExpectFailure(binPath, item.args, { cwd: launcherCwd });
    const output = `${failure.stdout}\n${failure.stderr}`;
    assertIncludes(output, "Result record is untrusted", item.label);
    assertIncludes(output, "task_completed receipt", item.label);
    assertNotIncludes(output, "raw installed answer", item.label);
  }

  const legacyCwd = path.join(tmp, "legacy-signed-result");
  await mkdir(legacyCwd, { recursive: true });
  const legacyCreated = await run(
    binPath,
    ["tasks", "create", "--title", "GPT Pro consult", "--prompt", "Legacy signed result"],
    { cwd: legacyCwd }
  );
  const legacyTaskId = legacyCreated.stdout.trim().split(/\s+/)[0];
  await run(binPath, ["tasks", "complete", legacyTaskId, "--summary", "Legacy installed answer"], { cwd: legacyCwd });
  await makeCompletionReceiptsLegacySigned(legacyCwd, legacyTaskId);
  const legacyShowFailure = await runExpectFailure(binPath, ["results", "show", legacyTaskId, "--cwd", legacyCwd], { cwd: launcherCwd });
  assertIncludes(`${legacyShowFailure.stdout}\n${legacyShowFailure.stderr}`, "missing result_sha256", "installed legacy signed result before reseal");
  const legacyResealMissingConfirm = await runExpectFailure(binPath, ["results", "reseal", legacyTaskId, "--cwd", legacyCwd], { cwd: launcherCwd });
  assertIncludes(legacyResealMissingConfirm.stderr, "--confirm-current-result", "installed legacy signed reseal missing confirmation");
  const legacyReseal = await run(binPath, ["results", "reseal", legacyTaskId, "--cwd", legacyCwd, "--confirm-current-result"], {
    cwd: launcherCwd
  });
  assertIncludes(legacyReseal.stdout, `${legacyTaskId}\tresealed\treceipt_`, "installed legacy signed reseal output");
  assertIncludes(legacyReseal.stdout, "result_sha256=", "installed legacy signed reseal output");
  assertNotIncludes(legacyReseal.stdout, "Legacy installed answer", "installed legacy signed reseal output");
  const legacyShow = await run(binPath, ["results", "show", legacyTaskId, "--cwd", legacyCwd], { cwd: launcherCwd });
  assertIncludes(legacyShow.stdout, '"summary": "Legacy installed answer"', "installed legacy signed result after reseal");
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

  const malformedPackDir = path.join(tmp, "release-malformed-pack");
  await mkdir(malformedPackDir, { recursive: true });
  await writeFile(
    path.join(malformedPackDir, "package.json"),
    `${JSON.stringify({ name: "malformed-pack-demo", version: "1.0.0", license: "MIT" }, null, 2)}\n`
  );
  await writeFile(path.join(malformedPackDir, "LICENSE"), "MIT License\n");
  const fakeBin = path.join(tmp, "release-malformed-pack-bin");
  await mkdir(fakeBin, { recursive: true });
  await writeFakeNpmDryRun(
    fakeBin,
    '[{"files":[{"path":"package.json","mode":420},{"path":"LICENSE","mode":420},{"mode":420}]}]\n'
  );
  const malformedPack = await run(binPath, ["release", "status", "--cwd", malformedPackDir], {
    cwd: launcherCwd,
    env: { PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}` }
  });
  assertIncludes(malformedPack.stdout, "metadata: ok", "installed release status malformed pack output");
  assertIncludes(malformedPack.stdout, "pack: blocked npm pack dry-run failed", "installed release status malformed pack output");
  assertIncludes(malformedPack.stdout, "npm pack dry-run file entry is missing a path", "installed release status malformed pack output");
  assertNotIncludes(malformedPack.stdout, "pack: ok", "installed release status malformed pack output");

  const silentPackDir = path.join(tmp, "release-silent-pack");
  await mkdir(silentPackDir, { recursive: true });
  await writeFile(
    path.join(silentPackDir, "package.json"),
    `${JSON.stringify({ name: "silent-pack-demo", version: "1.0.0", license: "MIT" }, null, 2)}\n`
  );
  await writeFile(path.join(silentPackDir, "LICENSE"), "MIT License\n");
  const silentFakeBin = path.join(tmp, "release-silent-pack-bin");
  await mkdir(silentFakeBin, { recursive: true });
  await writeFakeNpmSilentFailure(silentFakeBin);
  const silentPack = await run(binPath, ["release", "status", "--cwd", silentPackDir], {
    cwd: launcherCwd,
    env: { PATH: `${silentFakeBin}${path.delimiter}${process.env.PATH ?? ""}` }
  });
  assertIncludes(silentPack.stdout, "metadata: ok", "installed release status silent pack output");
  assertIncludes(
    silentPack.stdout,
    "pack: blocked npm pack dry-run failed: exit code 42",
    "installed release status silent pack output"
  );
  assertNotIncludes(silentPack.stdout, "Command failed:", "installed release status silent pack output");
  assertNotIncludes(silentPack.stdout, "pack: ok", "installed release status silent pack output");

  const symlinkPackDir = path.join(tmp, "release-symlink-pack");
  await mkdir(symlinkPackDir, { recursive: true });
  await writeFile(
    path.join(symlinkPackDir, "package.json"),
    `${JSON.stringify({ name: "symlink-pack-demo", version: "1.0.0", license: "MIT", files: ["README.md"] }, null, 2)}\n`
  );
  await writeFile(path.join(symlinkPackDir, "LICENSE"), "MIT License\n");
  const outsideReadme = path.join(tmp, "release-symlink-pack-outside-readme.md");
  await writeFile(outsideReadme, "# Outside README\n");
  await symlink(outsideReadme, path.join(symlinkPackDir, "README.md"));
  const symlinkFakeBin = path.join(tmp, "release-symlink-pack-bin");
  await mkdir(symlinkFakeBin, { recursive: true });
  await writeFakeNpmDryRun(
    symlinkFakeBin,
    '[{"files":[{"path":"package.json","mode":420},{"path":"LICENSE","mode":420},{"path":"README.md","mode":420}]}]\n'
  );
  const symlinkPack = await run(binPath, ["release", "status", "--cwd", symlinkPackDir], {
    cwd: launcherCwd,
    env: { PATH: `${symlinkFakeBin}${path.delimiter}${process.env.PATH ?? ""}` }
  });
  assertIncludes(symlinkPack.stdout, "metadata: ok", "installed release status symlink pack output");
  assertIncludes(
    symlinkPack.stdout,
    "pack: blocked packed files must be regular non-symlink files",
    "installed release status symlink pack output"
  );
  assertIncludes(symlinkPack.stdout, "README.md", "installed release status symlink pack output");
  assertNotIncludes(symlinkPack.stdout, "pack: ok", "installed release status symlink pack output");

  const noRemoteDir = await createReleaseGitFixture(path.join(tmp, "release-no-remote"), { remote: false });
  const noRemote = await run(binPath, ["release", "status", "--cwd", noRemoteDir], { cwd: launcherCwd });
  assertIncludes(noRemote.stdout, "metadata: ok", "installed release status no-remote output");
  assertIncludes(noRemote.stdout, "git: blocked no remote", "installed release status no-remote output");
  assertIncludes(noRemote.stdout, "git remote add origin <git-url>; git push -u origin", "installed release status no-remote output");
  await assertInstalledReleasePackGitBlocked(binPath, noRemoteDir, path.join(tmp, "release-pack-no-remote"), launcherCwd, "no remote configured");

  const dirtyDir = await createReleaseGitFixture(path.join(tmp, "release-dirty"), { remote: true });
  await writeFile(path.join(dirtyDir, "README.md"), "dirty\n");
  const dirty = await run(binPath, ["release", "status", "--cwd", dirtyDir], { cwd: launcherCwd });
  assertIncludes(dirty.stdout, "git: blocked worktree has uncommitted changes", "installed release status dirty output");
  await assertInstalledReleasePackGitBlocked(binPath, dirtyDir, path.join(tmp, "release-pack-dirty"), launcherCwd, "worktree has uncommitted changes");

  const detachedDir = await createReleaseGitFixture(path.join(tmp, "release-detached"), { remote: true });
  await execFileAsync("git", ["checkout", "--detach", "HEAD"], { cwd: detachedDir });
  const detached = await run(binPath, ["release", "status", "--cwd", detachedDir], { cwd: launcherCwd });
  assertIncludes(detached.stdout, "git: blocked detached HEAD", "installed release status detached output");
  await assertInstalledReleasePackGitBlocked(binPath, detachedDir, path.join(tmp, "release-pack-detached"), launcherCwd, "detached HEAD");

  const noUpstreamDir = await createReleaseGitFixture(path.join(tmp, "release-no-upstream"), {
    remote: true,
    upstream: false
  });
  const noUpstream = await run(binPath, ["release", "status", "--cwd", noUpstreamDir], { cwd: launcherCwd });
  assertIncludes(noUpstream.stdout, "git: blocked no upstream configured", "installed release status no-upstream output");
  assertIncludes(noUpstream.stdout, "git push -u origin", "installed release status no-upstream output");
  await assertInstalledReleasePackGitBlocked(binPath, noUpstreamDir, path.join(tmp, "release-pack-no-upstream"), launcherCwd, "no upstream configured");

  const unpushedDir = await createReleaseGitFixture(path.join(tmp, "release-unpushed"), { remote: true });
  await writeFile(path.join(unpushedDir, "README.md"), "unpushed\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: unpushedDir });
  await execFileAsync("git", ["commit", "-m", "unpushed"], { cwd: unpushedDir });
  const unpushed = await run(binPath, ["release", "status", "--cwd", unpushedDir], { cwd: launcherCwd });
  assertIncludes(unpushed.stdout, "git: blocked branch has unpushed commits", "installed release status unpushed output");
  await assertInstalledReleasePackGitBlocked(binPath, unpushedDir, path.join(tmp, "release-pack-unpushed"), launcherCwd, "branch has unpushed commits");

  const goneDir = await createReleaseGitFixture(path.join(tmp, "release-upstream-gone"), { remote: true });
  const goneBranch = (await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: goneDir })).stdout.trim();
  const goneRemoteUrl = (await execFileAsync("git", ["remote", "get-url", "origin"], { cwd: goneDir })).stdout.trim();
  await execFileAsync("git", ["--git-dir", goneRemoteUrl, "config", "receive.denyDeleteCurrent", "ignore"], { cwd: goneDir });
  await execFileAsync("git", ["push", "origin", "--delete", goneBranch], { cwd: goneDir });
  await execFileAsync("git", ["fetch", "--prune", "origin"], { cwd: goneDir });
  const gone = await run(binPath, ["release", "status", "--cwd", goneDir], { cwd: launcherCwd });
  assertIncludes(gone.stdout, "git: blocked upstream is gone", "installed release status upstream-gone output");
  assertIncludes(gone.stdout, `upstream=origin/${goneBranch}`, "installed release status upstream-gone output");
  await assertInstalledReleasePackGitBlocked(binPath, goneDir, path.join(tmp, "release-pack-upstream-gone"), launcherCwd, "upstream is gone");

  const behindDir = await createReleaseGitFixture(path.join(tmp, "release-behind"), { remote: true });
  await pushRemoteOnlyReleaseCommit(behindDir, tmp, "behind");
  const behind = await run(binPath, ["release", "status", "--cwd", behindDir], { cwd: launcherCwd });
  assertIncludes(behind.stdout, "git: blocked branch is behind upstream", "installed release status behind output");
  assertIncludes(behind.stdout, "behind=1", "installed release status behind output");
  await assertInstalledReleasePackGitBlocked(binPath, behindDir, path.join(tmp, "release-pack-behind"), launcherCwd, "branch is behind upstream");

  const divergedDir = await createReleaseGitFixture(path.join(tmp, "release-diverged"), { remote: true });
  await pushRemoteOnlyReleaseCommit(divergedDir, tmp, "diverged");
  await writeFile(path.join(divergedDir, "LOCAL.md"), "local diverged change\n");
  await execFileAsync("git", ["add", "LOCAL.md"], { cwd: divergedDir });
  await execFileAsync("git", ["commit", "-m", "local diverged"], { cwd: divergedDir });
  const diverged = await run(binPath, ["release", "status", "--cwd", divergedDir], { cwd: launcherCwd });
  assertIncludes(diverged.stdout, "git: blocked branch diverged", "installed release status diverged output");
  assertIncludes(diverged.stdout, "ahead=1 behind=1", "installed release status diverged output");
  await assertInstalledReleasePackGitBlocked(binPath, divergedDir, path.join(tmp, "release-pack-diverged"), launcherCwd, "branch diverged");

  const okDir = await createReleaseGitFixture(path.join(tmp, "release-ok"), { remote: true });
  const ok = await run(binPath, ["release", "status", "--cwd", okDir], { cwd: launcherCwd });
  assertIncludes(ok.stdout, "metadata: ok", "installed release status ok output");
  assertIncludes(ok.stdout, "git: ok", "installed release status ok output");
  assertIncludes(ok.stdout, "upstream=origin/", "installed release status ok output");
}

async function assertInstalledReleasePackGitBlocked(binPath, cwd, packDestination, launcherCwd, expectedGitText) {
  const result = await run(
    binPath,
    ["release", "pack", "--cwd", cwd, "--pack-destination", packDestination],
    { cwd: launcherCwd, timeout: 120_000, maxBuffer: 20 * 1024 * 1024 }
  );
  assertIncludes(result.stdout, "release_pack=ok", `installed release pack ${expectedGitText} output`);
  assertIncludes(result.stdout, `release_pack_git: blocked ${expectedGitText}`, `installed release pack ${expectedGitText} output`);
  assertIncludes(result.stdout, "release_pack_publish_blocked: fix git readiness before npm publish", `installed release pack ${expectedGitText} output`);
  assertNotIncludes(result.stdout, "release_pack_publish: npm publish", `installed release pack ${expectedGitText} output`);
}

async function pushRemoteOnlyReleaseCommit(sourceCwd, tmp, label) {
  const remoteUrl = (await execFileAsync("git", ["remote", "get-url", "origin"], { cwd: sourceCwd })).stdout.trim();
  const branch = (await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: sourceCwd })).stdout.trim();
  const cloneDir = path.join(tmp, `release-${label}-remote-work`);
  await execFileAsync("git", ["clone", remoteUrl, cloneDir], { cwd: tmp });
  await execFileAsync("git", ["config", "user.email", "release@example.com"], { cwd: cloneDir });
  await execFileAsync("git", ["config", "user.name", "PROdex Package Smoke"], { cwd: cloneDir });
  await writeFile(path.join(cloneDir, `${label.toUpperCase()}.md`), `${label} remote change\n`);
  await execFileAsync("git", ["add", `${label.toUpperCase()}.md`], { cwd: cloneDir });
  await execFileAsync("git", ["commit", "-m", `${label} remote`], { cwd: cloneDir });
  await execFileAsync("git", ["push", "origin", branch], { cwd: cloneDir });
  await execFileAsync("git", ["fetch", "origin"], { cwd: sourceCwd });
}

async function createReleaseGitFixture(cwd, options) {
  await mkdir(cwd, { recursive: true });
  await mkdir(path.join(cwd, "scripts"), { recursive: true });
  await writeFile(
    path.join(cwd, "package.json"),
    `${JSON.stringify({ name: path.basename(cwd), version: "1.0.0", license: "MIT", files: ["LICENSE", "scripts/release-check.mjs"] }, null, 2)}\n`
  );
  await writeFile(path.join(cwd, "LICENSE"), "MIT License\n");
  await writeFile(path.join(cwd, "scripts", "release-check.mjs"), await readFile(path.join(repoRoot, "scripts", "release-check.mjs"), "utf8"));
  await execFileAsync("git", ["init"], { cwd });
  await execFileAsync("git", ["config", "user.email", "release@example.com"], { cwd });
  await execFileAsync("git", ["config", "user.name", "PROdex Package Smoke"], { cwd });
  await execFileAsync("git", ["add", "."], { cwd });
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

async function initPackageSmokeReleaseGitReadyRepo(cwd) {
  await execFileAsync("git", ["init"], { cwd });
  await execFileAsync("git", ["config", "user.email", "release@example.com"], { cwd });
  await execFileAsync("git", ["config", "user.name", "PROdex Package Smoke"], { cwd });
  await execFileAsync("git", ["add", "."], { cwd });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd });
  const remoteDir = path.join(path.dirname(cwd), `${path.basename(cwd)}-remote.git`);
  await execFileAsync("git", ["init", "--bare", remoteDir], { cwd: path.dirname(cwd) });
  await execFileAsync("git", ["remote", "add", "origin", remoteDir], { cwd });
  const branch = (await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd })).stdout.trim();
  await execFileAsync("git", ["push", "-u", "origin", branch], { cwd });
  const commit = (await execFileAsync("git", ["rev-parse", "--short", "HEAD"], { cwd })).stdout.trim();
  return { branch, commit };
}

async function writeFakeNpmDryRun(binDir, stdout) {
  const script = path.join(binDir, "fake-npm.mjs");
  await writeFile(script, `process.stdout.write(${JSON.stringify(stdout)});\n`);
  await writeFakeNpmLauncher(binDir, script);
}

async function writeFakeNpmSilentFailure(binDir) {
  const script = path.join(binDir, "fake-npm-silent-failure.mjs");
  await writeFile(script, "process.exit(42);\n");
  await writeFakeNpmLauncher(binDir, script);
}

async function writeFakeNpmLauncher(binDir, script) {
  const commandPath = path.join(binDir, npmCommand);
  if (process.platform === "win32") {
    await writeFile(commandPath, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    return;
  }
  await writeFile(commandPath, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  await chmod(commandPath, 0o755);
}

async function smokeStdioMcp(binPath, cwd) {
  await writeFile(path.join(cwd, "search-smoke.txt"), "before\n--package-rg-literal ok\nafter\n", "utf8");
  await writeFile(path.join(cwd, "notes.md"), "old\n", "utf8");
  const head = await initPackageSmokeGitRepo(cwd, ["search-smoke.txt", "notes.md"]);
  const client = new Client({ name: "prodex-package-smoke", version: "0.2.0" });
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
    await writeFile(path.join(cwd, "huge-search-smoke.txt"), `${"package-overflow ".repeat(200_000)}\n`, "utf8");
    const overflowText = await callToolExpectFailureText(
      client,
      "repo_search",
      { query: "package-overflow" },
      "repo_search returned too many matches"
    );
    assertIncludes(overflowText, "narrow the query or glob", "installed stdio oversized repo_search failure output");
    assertNotIncludes(overflowText, "maxBuffer", "installed stdio oversized repo_search failure output");
    assertNotIncludes(overflowText, "stdout", "installed stdio oversized repo_search failure output");
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

async function smokeStdioMcpNonGitWriteFailure(binPath, cwd) {
  await writeFile(path.join(cwd, "notes.md"), "old\n", "utf8");
  const client = new Client({ name: "prodex-package-smoke-non-git", version: "0.2.0" });
  const transport = new StdioClientTransport({
    command: binPath,
    args: ["mcp", "--cwd", cwd],
    cwd: path.dirname(cwd),
    stderr: "pipe"
  });
  try {
    await withTimeout(client.connect(transport), 20_000, "Timed out connecting to installed stdio MCP server for non-git smoke");
    const text = await callToolExpectFailureText(
      client,
      "repo_write_file_dry_run",
      {
        path: "notes.md",
        content: "new\n",
        expected_head: "main"
      },
      "repo write tools require a git worktree with a committed HEAD"
    );
    assertNotIncludes(text, "Command failed:", "installed stdio non-git write failure output");
    assertNotIncludes(text, "rev-parse", "installed stdio non-git write failure output");
  } finally {
    await closeStdioClient(client, transport, "installed stdio non-git MCP client");
  }
}

async function initPackageSmokeGitRepo(cwd, files) {
  await execFileAsync("git", ["init"], { cwd });
  await execFileAsync("git", ["config", "user.email", "package-smoke@example.com"], { cwd });
  await execFileAsync("git", ["config", "user.name", "PROdex Package Smoke"], { cwd });
  await execFileAsync("git", ["add", ...files], { cwd });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd });
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
  return stdout.trim();
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function makeCompletionReceiptsLegacySigned(cwd, taskId) {
  const key = (await readFile(path.join(cwd, ".bridge", "receipt-key.local"), "utf8")).trim();
  const receiptsDir = path.join(cwd, ".bridge", "receipts");
  for (const file of await readdir(receiptsDir)) {
    if (!file.endsWith(".json")) continue;
    const receiptPath = path.join(receiptsDir, file);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    if (receipt.kind !== "task_completed" || receipt.task_id !== taskId) continue;
    receipt.metadata = { ...receipt.metadata };
    delete receipt.metadata.result_sha256;
    delete receipt.integrity;
    receipt.integrity = {
      algorithm: "hmac-sha256",
      digest: createHmac("sha256", Buffer.from(key, "hex")).update(canonicalJson(receipt)).digest("hex")
    };
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  }
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value && typeof value === "object") {
    const canonical = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) canonical[key] = canonicalize(value[key]);
    }
    return canonical;
  }
  return value;
}

async function smokeInstalledStdioTaskFinalizers(binPath, cwd) {
  const client = new Client({ name: "prodex-package-finalizers-smoke", version: "0.2.0" });
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
    const sessionId = "sess_20990101_000000_package-stdio-session";
    await writeSessionFixture(cwd, sessionId, {
      status: "preview",
      backend: "manual",
      direction: "codex_to_chatgpt",
      task_id: doneTask.task.id
    });
    const sessions = await callJsonTool(client, "bridge_list_sessions", { status: "preview" });
    const fetchedSession = await callJsonTool(client, "bridge_get_session", { session_id: sessionId });
    const receipts = await callJsonTool(client, "bridge_list_receipts", {
      kind: "task_completed",
      task_id: doneTask.task.id
    });
    const completionReceipt = receipts.receipts?.[0];
    if (!completionReceipt?.id) {
      throw new Error(`Installed stdio receipt list did not include a task_completed receipt: ${JSON.stringify(receipts)}`);
    }
    const fetchedReceipt = await callJsonTool(client, "bridge_get_receipt", { receipt_id: completionReceipt.id });

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
    assertSessionInList(sessions.sessions, {
      sessionId,
      status: "preview",
      backend: "manual"
    });
    assertSession(fetchedSession.session, {
      sessionId,
      status: "preview",
      backend: "manual"
    });
    assertReceipt(completionReceipt, {
      kind: "task_completed",
      taskId: doneTask.task.id
    });
    assertReceipt(fetchedReceipt.receipt, {
      receiptId: completionReceipt.id,
      kind: "task_completed",
      taskId: doneTask.task.id
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

async function writeSessionFixture(cwd, sessionId, input) {
  const timestamp = new Date().toISOString();
  await mkdir(path.join(cwd, ".bridge", "sessions"), { recursive: true });
  await writeFile(
    path.join(cwd, ".bridge", "sessions", `${sessionId}.json`),
    `${JSON.stringify(
      {
        schema_version: 1,
        id: sessionId,
        direction: input.direction,
        backend: input.backend,
        task_id: input.task_id,
        status: input.status,
        warnings: [],
        created_at: timestamp,
        last_used_at: timestamp
      },
      null,
      2
    )}\n`
  );
}

async function smokeInstalledHttpOnboarding(binPath, cwd) {
  const launcherCwd = path.dirname(cwd);
  const port = await getFreePort();
  const token = "package-smoke-token";
  const expectedUrl = `http://127.0.0.1:${port}/mcp?prodex_token=${token}`;
  await writeFile(path.join(cwd, "http-notes.md"), "old\n", "utf8");
  const writeHead = await initPackageSmokeGitRepo(cwd, ["http-notes.md"]);

  const setup = await run(binPath, ["setup", "--cwd", cwd, "--port", String(port), "--token", token, "--token-ttl-hours", "1"], { cwd: launcherCwd });
  const setupOutput = `${setup.stdout}\n${setup.stderr}`;
  assertIncludes(setupOutput, "prodex_token=***", "installed setup output");
  assertIncludes(setupOutput, "Token expires:", "installed setup output");
  assertNotIncludes(setupOutput, token, "installed setup output");
  assertIncludes(await readFile(path.join(cwd, ".bridge", "config.local.json"), "utf8"), token, "installed explicit --cwd config file");
  await assertMissingFile(path.join(launcherCwd, ".bridge", "config.local.json"), "installed launcher cwd config file");

  const status = await run(binPath, ["status", "--cwd", cwd], { cwd: launcherCwd });
  const statusOutput = `${status.stdout}\n${status.stderr}`;
  assertIncludes(statusOutput, "prodex_token=***", "installed status output");
  assertIncludes(statusOutput, '"token_status": "valid"', "installed status output");
  assertIncludes(statusOutput, '"token_expires_at":', "installed status output");
  assertNotIncludes(statusOutput, token, "installed status output");

  const nonExpiringCwd = path.join(launcherCwd, "non-expiring-http");
  const nonExpiringToken = "non-expiring-package-smoke-token";
  await mkdir(nonExpiringCwd, { recursive: true });
  await run(binPath, ["setup", "--cwd", nonExpiringCwd, "--port", "8790", "--token", nonExpiringToken], { cwd: launcherCwd });
  const nonExpiringStatus = await run(binPath, ["status", "--cwd", nonExpiringCwd], { cwd: launcherCwd });
  assertIncludes(nonExpiringStatus.stdout, '"token_status": "non_expiring"', "installed non-expiring status output");
  assertIncludes(nonExpiringStatus.stdout, "Token has no expiry. Keep this local-only", "installed non-expiring status output");
  assertNotIncludes(nonExpiringStatus.stdout, '"token_status": "none"', "installed non-expiring status output");
  const nonExpiringProductCheck = await runExpectFailure(
    binPath,
    ["pro", "browser", "check", "--cwd", nonExpiringCwd, "--port", "65534", "--timeout-ms", "10"],
    { cwd: launcherCwd }
  );
  const nonExpiringProductCheckOutput = `${nonExpiringProductCheck.stdout}\n${nonExpiringProductCheck.stderr}`;
  assertIncludes(
    nonExpiringProductCheckOutput,
    "config_warning: Token has no expiry. Keep this local-only",
    "installed non-expiring product check output"
  );
  assertIncludes(
    nonExpiringProductCheckOutput,
    `rerun \`prodex setup --cwd ${nonExpiringCwd} --token-ttl-hours <hours>\``,
    "installed non-expiring product check output"
  );
  assertIncludes(
    nonExpiringProductCheckOutput,
    `bridge: missing (.bridge) - run \`prodex init --cwd ${nonExpiringCwd}\``,
    "installed non-expiring product check output"
  );
  assertNotIncludes(nonExpiringProductCheckOutput, nonExpiringToken, "installed non-expiring product check output");
  const nonExpiringReveal = await runExpectFailure(binPath, ["status", "--cwd", nonExpiringCwd, "--show-token", "--url-only"], { cwd: launcherCwd });
  const nonExpiringRevealOutput = `${nonExpiringReveal.stdout}\n${nonExpiringReveal.stderr}`;
  assertIncludes(nonExpiringRevealOutput, "status --show-token requires a token with expiry", "installed non-expiring status reveal refusal");
  assertNotIncludes(nonExpiringRevealOutput, nonExpiringToken, "installed non-expiring status reveal refusal");
  const unsafeNonExpiringReveal = await run(
    binPath,
    ["status", "--cwd", nonExpiringCwd, "--show-token", "--unsafe-show-non-expiring-token", "--url-only"],
    { cwd: launcherCwd }
  );
  assertIncludes(unsafeNonExpiringReveal.stdout, nonExpiringToken, "installed unsafe non-expiring status reveal output");
  assertIncludes(
    unsafeNonExpiringReveal.stderr,
    "Showing a non-expiring token. Keep this local-only",
    "installed unsafe non-expiring status reveal warning"
  );

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
        server_url: `http://127.0.0.1:8791/mcp?prodex_token=${expiredToken}`,
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
        server_url: "http://127.0.0.1:8792/mcp?prodex_token=stale-package-smoke-token",
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
  assertIncludes(configuredDoctor.stdout, "prodex_token=***", "installed configured doctor output");
  assertNotIncludes(configuredDoctor.stdout, token, "installed configured doctor output");

  const pasteReady = await run(binPath, ["status", "--cwd", cwd, "--show-token", "--url-only"], { cwd: launcherCwd });
  if (pasteReady.stdout.trim() !== expectedUrl) {
    throw new Error(
      `Installed status --show-token --url-only returned ${redactSmokeSecrets(pasteReady.stdout.trim())}, expected ${redactSmokeSecrets(expectedUrl)}`
    );
  }
  assertIncludes(pasteReady.stderr, "authorizes all enabled bridge tools", "installed status token authority warning");
  assertIncludes(pasteReady.stderr, "repo_write_file_apply", "installed status token authority warning");

  const tunnelUrl = await run(
    binPath,
    ["tunnel", "url", "--cwd", cwd, "--public-url", "https://prodex-package-smoke.example/ignored", "--show-token", "--url-only"],
    { cwd: launcherCwd }
  );
  const expectedTunnelUrl = `https://prodex-package-smoke.example/mcp?prodex_token=${token}`;
  if (tunnelUrl.stdout.trim() !== expectedTunnelUrl) {
    throw new Error(`Installed tunnel url returned ${redactSmokeSecrets(tunnelUrl.stdout.trim())}, expected ${redactSmokeSecrets(expectedTunnelUrl)}`);
  }
  assertIncludes(tunnelUrl.stderr, "authorizes all enabled bridge tools", "installed tunnel token authority warning");
  assertIncludes(tunnelUrl.stderr, "repo_stage_reviewed_paths", "installed tunnel token authority warning");
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
  assertIncludes(startOutput, "prodex_token=***", "installed start output");
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
        if (body?.ok === true && body?.name === "prodex") return;
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
  const client = new Client({ name: "prodex-package-http-smoke", version: "0.2.0" });
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
    const sessionId = "sess_20990101_000000_package-http-session";
    await writeSessionFixture(cwd, sessionId, {
      status: "running",
      backend: "manual",
      direction: "chatgpt_to_codex",
      task_id: created.task.id
    });
    const sessions = await callJsonTool(client, "bridge_list_sessions", { status: "running" });
    const fetchedSession = await callJsonTool(client, "bridge_get_session", { session_id: sessionId });
    const receipts = await callJsonTool(client, "bridge_list_receipts", {
      kind: "task_completed",
      task_id: created.task.id
    });
    const completionReceipt = receipts.receipts?.[0];
    if (!completionReceipt?.id) {
      throw new Error(`Installed HTTP receipt list did not include a task_completed receipt: ${JSON.stringify(receipts)}`);
    }
    const fetchedReceipt = await callJsonTool(client, "bridge_get_receipt", { receipt_id: completionReceipt.id });
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
    assertSessionInList(sessions.sessions, {
      sessionId,
      status: "running",
      backend: "manual"
    });
    assertSession(fetchedSession.session, {
      sessionId,
      status: "running",
      backend: "manual"
    });
    assertReceipt(completionReceipt, {
      kind: "task_completed",
      taskId: created.task.id
    });
    assertReceipt(fetchedReceipt.receipt, {
      receiptId: completionReceipt.id,
      kind: "task_completed",
      taskId: created.task.id
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
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : undefined
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
  await callToolExpectFailureText(client, name, args, expectedText);
}

async function callToolExpectFailureText(client, name, args, expectedText) {
  let result;
  try {
    result = await withTimeout(
      client.callTool({ name, arguments: args }),
      20_000,
      `Timed out calling installed MCP tool ${name}`
    );
  } catch (error) {
    const message = errorMessage(error);
    if (message.includes(expectedText)) return message;
    throw error;
  }
  const text = result.content.find((item) => item.type === "text")?.text ?? "";
  if (result.isError === true) {
    assertIncludes(text, expectedText, `installed MCP ${name} failure output`);
    return text;
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

function assertSession(session, expected) {
  if (session?.id !== expected.sessionId || session?.status !== expected.status || session?.backend !== expected.backend) {
    throw new Error(`Unexpected session record: ${JSON.stringify(session)} expected ${JSON.stringify(expected)}`);
  }
}

function assertSessionInList(sessions, expected) {
  if (!Array.isArray(sessions)) {
    throw new Error(`Unexpected session list: ${JSON.stringify(sessions)}`);
  }
  if (!sessions.some((session) => session?.id === expected.sessionId && session?.status === expected.status && session?.backend === expected.backend)) {
    throw new Error(`Missing session in list: ${JSON.stringify(expected)} from ${JSON.stringify(sessions)}`);
  }
}

function assertReceipt(receipt, expected) {
  if (expected.receiptId !== undefined && receipt?.id !== expected.receiptId) {
    throw new Error(`Unexpected receipt id: ${JSON.stringify(receipt)} expected ${expected.receiptId}`);
  }
  if (receipt?.kind !== expected.kind || receipt?.task_id !== expected.taskId) {
    throw new Error(`Unexpected receipt record: ${JSON.stringify(receipt)} expected ${JSON.stringify(expected)}`);
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
    .replace(/prodex_token=([^&\s"'`<>]+)/g, "prodex_token=***")
    .replace(/\b(?:non-expiring-package-smoke-token|expired-package-smoke-token|package-smoke-token)\b/g, "***");
}

function assertSmokeRedaction() {
  const sample =
    "http://127.0.0.1:8787/mcp?prodex_token=package-smoke-token non-expiring-package-smoke-token expired-package-smoke-token";
  const redacted = redactSmokeSecrets(sample);
  if (redacted.includes("package-smoke-token") || redacted.includes("non-expiring-package-smoke-token") || redacted.includes("expired-package-smoke-token")) {
    throw new Error(`Smoke redaction failed: ${redacted}`);
  }
  if (!redacted.includes("prodex_token=***")) {
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

function shellQuotedForSmoke(value) {
  return /^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
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
