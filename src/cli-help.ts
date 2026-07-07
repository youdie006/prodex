import { createRequire } from "node:module";
import { formatCliCommand, formatSourceCliOption } from "./cli-args.js";

const requirePackageJson = createRequire(import.meta.url);
const packageJson = requirePackageJson("../package.json") as { version?: string };
export const CLI_VERSION = packageJson.version ?? "0.0.0";

export function printHelp(stdout: (line: string) => void): void {
  stdout(`prodex v${CLI_VERSION}

Ask ChatGPT from the terminal (visible logged-in browser):
  prodex ask "Explain this stack trace"          # shortcut for: prodex pro browser ask
  prodex ask --file src/auth.ts "Review this for security holes"
  git diff | prodex ask --stdin "Review this diff"   # pipe anything in; --json for structured output

First-time setup:
  prodex pro browser login    # dedicated Chrome; interactive runs wait until your login is READY
  prodex doctor               # bridge + MCP + browser health

Ask / consult commands:
  prodex ask [same flags as pro browser ask] "prompt"  # top-level shortcut for pro browser ask
  prodex pro ask [--dry-run] [--cwd /absolute/path/to/repo] [--file path] "prompt"  # dry-run preview
  prodex pro debate-prompt [--topic "..."] [--rounds 2] [--source-cli /absolute/path/to/dist/cli.js]  # print an agent prompt for a structured GPT Pro debate
  prodex pro browser login [--cwd /absolute/path/to/repo] [--dry-run] [--source-cli /absolute/path/to/dist/cli.js] [--profile-dir path] [--port 9333] [--url https://chatgpt.com/...] [--launch-timeout-ms 5000] [--wait|--no-wait] [--wait-timeout-ms 300000]  # preview/open visible browser login
  prodex pro browser help [--source-cli /absolute/path/to/dist/cli.js]
  prodex pro browser check [--source-cli /absolute/path/to/dist/cli.js] [--cwd /absolute/path/to/repo] [--port 9333] [--timeout-ms 1500]
  prodex pro browser smoke [--source-cli /absolute/path/to/dist/cli.js] [--cwd /absolute/path/to/repo] [--port 9333] [--timeout-ms 90000]
  prodex pro browser models [--source-cli /absolute/path/to/dist/cli.js] [--port 9333] [--timeout-ms 15000]  # read-only list of model menu options
  prodex pro browser ask [--source-cli /absolute/path/to/dist/cli.js] [--cwd /absolute/path/to/repo] [--port 9333] [--timeout-ms 90000] [--target-url url --confirm-target] [--new-chat] [--stdin] [--json] [--file path] [--model Pro] [--pro-mode 기본|확장] [--effort 즉시|중간|높음|"매우 높음"] [--project "name" | --project-new "name"] "prompt"  # explicit visible-browser send
  prodex pro latest [--source-cli /absolute/path/to/dist/cli.js] [--cwd /absolute/path/to/repo]
  prodex pro list [--source-cli /absolute/path/to/dist/cli.js] [--cwd /absolute/path/to/repo]
  prodex pro show <task-id|latest> [--source-cli /absolute/path/to/dist/cli.js] [--cwd /absolute/path/to/repo]

Bridge ledger (durable tasks/results/receipts/sessions under .bridge/):
  prodex init [--cwd /absolute/path/to/repo]
  prodex tasks create [--cwd /absolute/path/to/repo] --title "Title" --prompt "Prompt"
  prodex tasks list [--status new|claimed|done|blocked] [--cwd /absolute/path/to/repo]
  prodex tasks show <task-id|latest> [--cwd /absolute/path/to/repo]
  prodex tasks claim <task-id> [--cwd /absolute/path/to/repo] [--by codex]
  prodex tasks complete <task-id> [--cwd /absolute/path/to/repo] --summary "Summary" [--command "npm test"] [--artifact .bridge/artifacts/results/name.md=text]
  prodex tasks block <task-id> [--cwd /absolute/path/to/repo] --summary "Summary" [--code code] [--next-step "Next step"] [--retryable]
  prodex results show <task-id|latest> [--cwd /absolute/path/to/repo]
  prodex results artifact <task-id|latest> [artifact-path] [--cwd /absolute/path/to/repo]
  prodex results reseal <task-id|latest> --confirm-current-result [--cwd /absolute/path/to/repo]
  prodex receipts list [--kind kind] [--task-id task-id] [--cwd /absolute/path/to/repo]
  prodex receipts show <receipt-id|latest> [--cwd /absolute/path/to/repo]
  prodex receipts rotate-key [--cwd /absolute/path/to/repo]
  prodex sessions list [--status preview|running|done|blocked] [--cwd /absolute/path/to/repo]
  prodex sessions show <session-id|latest> [--cwd /absolute/path/to/repo]

Agent / MCP integration:
  prodex mcp [--cwd /absolute/path/to/repo]
  prodex setup [--cwd /absolute/path/to/repo] [--host 127.0.0.1] [--port 8787] [--token-ttl-hours <hours>] [--model Pro] [--pro-mode 기본|확장] [--effort 즉시|중간|높음|"매우 높음"] [--project "name"] [--clear-model|--clear-pro-mode|--clear-effort|--clear-project] [--interactive]
  prodex start [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js]
  prodex status [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js] [--show-token] [--url-only] [--unsafe-show-non-expiring-token]
  prodex tunnel url [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js] --public-url https://... [--show-token] [--url-only]
  prodex claude prompt [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js]
  prodex claude config [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js]
  prodex project prompt [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js]
  prodex onboard [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js]

Maintenance:
  prodex --version
  prodex doctor [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js]
  prodex release status [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js]
  prodex release pack [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js] --pack-destination /absolute/path [--keep-workdir]`);
}
export function printInitHelp(stdout: (line: string) => void): void {
  stdout(`prodex init

Commands:
  prodex init [--cwd /absolute/path/to/repo]

Initialize the local .bridge receipt ledger and bridge .gitignore entries.`);
}
export function printSetupHelp(stdout: (line: string) => void): void {
  stdout(`prodex setup

Commands:
  prodex setup [--cwd /absolute/path/to/repo] [--host 127.0.0.1] [--port 8787] [--token-ttl-hours <hours>] [--model Pro] [--pro-mode 기본|확장] [--effort 즉시|중간|높음|"매우 높음"] [--project "name"] [--clear-model|--clear-pro-mode|--clear-effort|--clear-project] [--interactive]

Save a loopback-only HTTP MCP profile in .bridge/config.local.json. Use --token-ttl-hours before tunnels or ChatGPT Project use.

Optional visible-browser send defaults (applied by \`pro browser ask\` when the matching per-ask flag is omitted):
  --model      Composer model to pick by its exact menu label (verified: Pro)
  --pro-mode   Pro sub-mode: 기본 (standard) or 확장 (extended)
  --effort     Reasoning effort: 즉시 / 중간 / 높음 / 매우 높음 (English aliases: instant/medium/high/max); picking one deselects Pro
  --project    Sidebar project to enter before sending
Clear a saved default with --clear-model / --clear-pro-mode / --clear-effort / --clear-project.
--pro-mode and --effort are different model axes and cannot be combined. View saved defaults with \`prodex status\`.`);
}
export function printStartHelp(stdout: (line: string) => void): void {
  stdout(`prodex start

Commands:
  prodex start [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js]

Start the local loopback HTTP MCP server from the saved setup profile.`);
}
export function printStatusHelp(stdout: (line: string) => void): void {
  stdout(`prodex status

Commands:
  prodex status [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js] [--show-token] [--url-only] [--unsafe-show-non-expiring-token]

Show the saved local MCP URL with tokens redacted by default.`);
}
export function printTunnelHelp(stdout: (line: string) => void): void {
  stdout(`prodex tunnel

Commands:
  prodex tunnel url [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js] --public-url https://... [--show-token] [--url-only]

Format a public tunnel MCP URL from an existing local setup. This command does not create a tunnel.`);
}
export function printTunnelUrlHelp(stdout: (line: string) => void): void {
  stdout(`prodex tunnel url

Commands:
  prodex tunnel url [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js] --public-url https://... [--show-token] [--url-only]

This command does not create a tunnel. It only formats your supplied public URL with the saved short-lived MCP token.`);
}
export function printDoctorHelp(stdout: (line: string) => void): void {
  stdout(`prodex doctor

Commands:
  prodex doctor [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js]

Run local bridge, MCP, write/apply/stage, and HTTP MCP smoke checks without opening ChatGPT.`);
}
export function printOnboardHelp(stdout: (line: string) => void): void {
  stdout(`prodex onboard

Commands:
  prodex onboard [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js]

Print a local-first setup guide for Codex, ChatGPT Projects, Claude, and visible-browser Pro consults.`);
}
export function printMcpHelp(stdout: (line: string) => void): void {
  stdout(`prodex mcp

Commands:
  prodex mcp [--cwd /absolute/path/to/repo]

Run the stdio MCP server for local clients such as Claude. This does not reveal HTTP MCP URL tokens.`);
}
export function printReleaseHelp(stdout: (line: string) => void): void {
  stdout(`prodex release

Commands:
  prodex release status [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js]
  prodex release pack [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js] --pack-destination /absolute/path [--keep-workdir]

Release commands are local checks and package preparation helpers; they do not publish or push.`);
}
export function printProHelp(stdout: (line: string) => void): void {
  stdout(`prodex pro

Commands:
  prodex pro ask [--dry-run] [--cwd /absolute/path/to/repo] [--file path] "prompt"
  prodex pro browser help [--source-cli /absolute/path/to/dist/cli.js]
  prodex pro browser login [--cwd /absolute/path/to/repo] [--dry-run] [--source-cli /absolute/path/to/dist/cli.js] [--launch-timeout-ms 5000] [--wait|--no-wait] [--wait-timeout-ms 300000]
  prodex pro browser check [--source-cli /absolute/path/to/dist/cli.js] [--cwd /absolute/path/to/repo]
  prodex pro browser smoke [--source-cli /absolute/path/to/dist/cli.js] [--cwd /absolute/path/to/repo]
  prodex pro browser models [--source-cli /absolute/path/to/dist/cli.js]
  prodex pro browser ask [--source-cli /absolute/path/to/dist/cli.js] [--cwd /absolute/path/to/repo] [--target-url url --confirm-target] [--new-chat] [--stdin] [--json] [--file path] [--model Pro] [--pro-mode 기본|확장] [--effort 즉시|중간|높음|"매우 높음"] [--project "name" | --project-new "name"] "prompt"
  prodex pro latest [--source-cli /absolute/path/to/dist/cli.js] [--cwd /absolute/path/to/repo]
  prodex pro list [--source-cli /absolute/path/to/dist/cli.js] [--cwd /absolute/path/to/repo]
  prodex pro show <task-id|latest> [--source-cli /absolute/path/to/dist/cli.js] [--cwd /absolute/path/to/repo]

Use \`prodex pro ask\` for dry-run/manual previews.
Use \`prodex pro browser ask\` only when you want an explicit visible-browser send.
Model/project selection (visible-browser send):
  --model "label"              Pick the composer model by its exact menu label (verified: Pro). Submenu models (e.g. GPT-5.5 variants) are rejected for now.
  --pro-mode 기본 | 확장          Pro sub-mode (only when the model is Pro); 확장 raises the default timeout to 300000 ms
  --effort 즉시|중간|높음|매우 높음   Reasoning effort (aliases: instant/medium/high/max); picking one deselects Pro
  --project "name"             Enter an existing sidebar project first (cannot combine with --target-url)
Labels are matched in both the Korean and English (US) UI; run \`prodex pro browser models\` to list what your account shows.
Persist defaults with \`prodex setup --model/--pro-mode/--effort/--project\`; clear them with setup --clear-model/--clear-pro-mode/--clear-effort/--clear-project.
(Creating a new project from the CLI is planned; for now create it in ChatGPT and pass --project.)`);
}
export function printProjectHelp(stdout: (line: string) => void): void {
  stdout(`prodex project

Commands:
  prodex project prompt [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js]

Print a ChatGPT Project MCP verification prompt. The prompt asks for read/task handoff verification only.`);
}
export function printClaudeHelp(stdout: (line: string) => void): void {
  stdout(`prodex claude

Commands:
  prodex claude prompt [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js]
  prodex claude config [--cwd /absolute/path/to/repo] [--source-cli /absolute/path/to/dist/cli.js]

Print Claude MCP setup and verification helpers. These commands do not start MCP or reveal HTTP tokens.`);
}
export function printTasksHelp(stdout: (line: string) => void): void {
  stdout(`prodex tasks

Commands:
  prodex tasks create [--cwd /absolute/path/to/repo] --title "Title" --prompt "Prompt"
  prodex tasks list [--status new|claimed|done|blocked] [--cwd /absolute/path/to/repo]
  prodex tasks show <task-id|latest> [--cwd /absolute/path/to/repo]
  prodex tasks claim <task-id> [--cwd /absolute/path/to/repo] [--by codex]
  prodex tasks complete <task-id> [--cwd /absolute/path/to/repo] --summary "Summary" [--command "npm test"] [--artifact .bridge/artifacts/results/name.md=text]
  prodex tasks block <task-id> [--cwd /absolute/path/to/repo] --summary "Summary" [--code code] [--next-step "Next step"] [--retryable]`);
}
export function printResultsHelp(stdout: (line: string) => void): void {
  stdout(`prodex results

Commands:
  prodex results show <task-id|latest> [--cwd /absolute/path/to/repo]
  prodex results artifact <task-id|latest> [artifact-path] [--cwd /absolute/path/to/repo]
  prodex results reseal <task-id|latest> --confirm-current-result [--cwd /absolute/path/to/repo]`);
}
export function printReceiptsHelp(stdout: (line: string) => void): void {
  stdout(`prodex receipts

Commands:
  prodex receipts list [--kind kind] [--task-id task-id] [--cwd /absolute/path/to/repo]
  prodex receipts show <receipt-id|latest> [--cwd /absolute/path/to/repo]
  prodex receipts rotate-key [--cwd /absolute/path/to/repo]

rotate-key generates a new signing key for receipt integrity seals and keeps the
previous keys in .bridge/receipt-key.local so receipts signed before the
rotation still verify.`);
}
export function printSessionsHelp(stdout: (line: string) => void): void {
  stdout(`prodex sessions

Commands:
  prodex sessions list [--status preview|running|done|blocked] [--cwd /absolute/path/to/repo]
  prodex sessions show <session-id|latest> [--cwd /absolute/path/to/repo]`);
}
export function printProBrowserHelp(stdout: (line: string) => void, sourceCli?: string): void {
  const cli = formatCliCommand(sourceCli);
  const sourceCliOption = formatSourceCliOption(sourceCli);
  const loginUsage = sourceCli
    ? `${cli} pro browser login${sourceCliOption} [--cwd /absolute/path/to/repo] [--dry-run] [--profile-dir path] [--port 9333] [--url https://chatgpt.com/...] [--launch-timeout-ms 5000] [--wait|--no-wait] [--wait-timeout-ms 300000]`
    : "prodex pro browser login [--cwd /absolute/path/to/repo] [--dry-run] [--source-cli /absolute/path/to/dist/cli.js] [--profile-dir path] [--port 9333] [--url https://chatgpt.com/...] [--launch-timeout-ms 5000] [--wait|--no-wait] [--wait-timeout-ms 300000]";
  const checkUsage = sourceCli
    ? `${cli} pro browser check${sourceCliOption} [--cwd /absolute/path/to/repo] [--port 9333] [--timeout-ms 1500]`
    : "prodex pro browser check [--source-cli /absolute/path/to/dist/cli.js] [--cwd /absolute/path/to/repo] [--port 9333] [--timeout-ms 1500]";
  const smokeUsage = sourceCli
    ? `${cli} pro browser smoke${sourceCliOption} [--cwd /absolute/path/to/repo] [--port 9333] [--timeout-ms 90000]`
    : "prodex pro browser smoke [--source-cli /absolute/path/to/dist/cli.js] [--cwd /absolute/path/to/repo] [--port 9333] [--timeout-ms 90000]";
  const selectionUsage = '[--model Pro] [--pro-mode 기본|확장] [--effort 즉시|중간|높음|"매우 높음"] [--project "name" | --project-new "name"]';
  const askUsage = sourceCli
    ? `${cli} pro browser ask${sourceCliOption} [--cwd /absolute/path/to/repo] [--port 9333] [--timeout-ms 90000] [--target-url url --confirm-target] [--new-chat] [--stdin] [--json] [--file path] ${selectionUsage} "prompt"`
    : `prodex pro browser ask [--source-cli /absolute/path/to/dist/cli.js] [--cwd /absolute/path/to/repo] [--port 9333] [--timeout-ms 90000] [--target-url url --confirm-target] [--new-chat] [--stdin] [--json] [--file path] ${selectionUsage} "prompt"`;
  const modelsUsage = sourceCli
    ? `${cli} pro browser models${sourceCliOption} [--port 9333] [--timeout-ms 15000]`
    : "prodex pro browser models [--source-cli /absolute/path/to/dist/cli.js] [--port 9333] [--timeout-ms 15000]";
  stdout(`${cli} pro browser

Commands:
  ${loginUsage}
  ${checkUsage}
  ${smokeUsage}
  ${modelsUsage}
  ${askUsage}

Visible-browser sends require a manual browser session and stop on login, captcha, Cloudflare, permission, rate-limit, or usage-limit blockers.
Model/project selection (ask):
  --model      Composer model to pick by its exact menu label (verified: Pro). Models whose menu entry opens a submenu of variants are rejected with a clear error for now.
  --pro-mode   Pro sub-mode: 기본 (standard) or 확장 (extended), used when the model is Pro. 확장 raises the default --timeout-ms to 300000.
  --effort     Reasoning effort: 즉시 / 중간 / 높음 / 매우 높음 (aliases: instant/medium/high/max). Picking an effort switches the composer to the standard reasoning model, deselecting Pro.
  --project    Enter an existing sidebar project before sending. Cannot be combined with --target-url.
--pro-mode and --effort cannot be combined. Labels are matched in both the Korean and English (US) ChatGPT UI (e.g. 높음/High, Pro 확장/Pro Extended).
Run \`${cli} pro browser models${sourceCliOption}\` to list the labels your account currently shows.
Persist defaults with \`${cli} setup${sourceCliOption}\`; per-ask flags override them.
Use \`${cli} pro ask\` for dry-run/manual previews.
\`${cli} pro browser ask${sourceCliOption}\` always attempts an explicit visible-browser send.`);
}
