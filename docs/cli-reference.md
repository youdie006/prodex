# CLI reference

The operational detail behind the [README](../README.md): the agent bridge over MCP, the first login step by step, source-checkout forms of every command, the HTTP MCP bridge for ChatGPT Projects, the receipt commands, and the local smoke tests. Sections are grouped the way the README introduces them; commands are shown for an installed `prodex` and, where they differ, for a source checkout.

## What is implemented

Implemented:

- Versioned `.bridge` ledger schemas for tasks, results, sessions, and receipts.
- CLI commands for task creation/listing/inspection/claiming/completion/blocking and result display.
- `pro ask` and `pro latest` for Codex-first consult previews and review receipts.
- `sessions list` and `sessions show` for inspecting dry-run, running, done, or blocked consult sessions.
- `receipts list` and `receipts show` for inspecting the local action ledger without exposing legacy inline write payloads.
- Ledger MCP tools for creating, claiming, completing, blocking, and inspecting task/result/session/receipt records from Claude or ChatGPT Projects.
- Read-only result artifact fetch for Pro consult and generic MCP handoff artifacts explicitly listed on result records.
- Explicit local reseal for legacy signed result receipts after reviewing the current result payload.
- `pro browser login/check/smoke/ask` for the optional visible browser adapter.
- Claude-compatible stdio MCP server through `prodex mcp`.
- ChatGPT Developer Mode-style Streamable HTTP MCP server through `prodex setup` and `prodex start`.
- Read-only repo tools for bounded file reads and ripgrep search.
- Receipt-gated repo write/stage tools for existing text files: dry-run first, apply only with matching git HEAD and preimage hash, then stage only reviewed applied receipts.
- `doctor` local health check for `.bridge`, redacted config loading, receipt-backed write/apply/stage, and the real HTTP MCP tool catalog.

Not implemented:

- Hidden ChatGPT endpoints.
- Cookie, token, localStorage, or sessionStorage extraction.
- Direct ungated write tools.
- Shell execution tools.
- Automatic public tunnel setup.

## Agent Bridge Quick Start

This section connects coding agents (Claude, Codex, ChatGPT Projects) to the bridge over MCP. It is not required for the standalone terminal flow above — if you only want Pro answers in your terminal, the [Quickstart](#quickstart-a-pro-second-opinion-from-your-terminal) is complete on its own.

Requires Node.js 20 or newer, `git`, and `ripgrep` (`rg`) on PATH. The optional visible-browser adapter needs a Chromium-family browser: PATH binaries (`google-chrome`, `chromium`, `chromium-browser`, `microsoft-edge`, `brave-browser`), standard macOS app bundles, Windows Program Files/LOCALAPPDATA installs, and Windows-host browsers under WSL are all probed automatically; anything else via `PRODEX_CHROME=/path/to/browser`.

Install from npm — **note the scope**. The unscoped `prodex` on npm is an unrelated third-party package; do **not** install it. Use the scoped name:

```bash
npm install -g @youdie006/prodex
```

The `prodex` command is then on your PATH:

```bash
prodex onboard
prodex init
prodex doctor
prodex pro ask --cwd /absolute/path/to/your/repo "Review the project positioning"
```

For a source checkout:

```bash
cd /absolute/path/to/prodex
npm install
npm run build
SOURCE_CLI="/absolute/path/to/prodex/dist/cli.js"
node "$SOURCE_CLI" onboard --source-cli "$SOURCE_CLI"
node "$SOURCE_CLI" init
node "$SOURCE_CLI" doctor --source-cli "$SOURCE_CLI"
node "$SOURCE_CLI" pro ask --cwd /absolute/path/to/your/repo "Review the project positioning"
```

The examples below use the installed `prodex` binary. In a source checkout, replace `prodex` with `node /absolute/path/to/prodex/dist/cli.js` after building, and pass `--source-cli /absolute/path/to/prodex/dist/cli.js` to onboarding, browser, prompt, and local MCP troubleshooting commands so their follow-up guidance stays in source-checkout form.
`onboard` prints the Claude, ChatGPT Project, and optional ChatGPT Pro consult commands without changing local state.

`init` creates the local `.bridge/` ledger directories and ignore rules. On a source checkout it may also add `node_modules/` and `dist/` to the repo root `.gitignore` so local dependencies and build output stay out of git.
Run `init` from the repo root, or use `prodex init --cwd /absolute/path/to/your/repo` from elsewhere.

`pro ask` is a dry-run/manual preview. It does not drive a logged-in browser; `pro ask --send` is rejected so accidental sends do not happen through the preview alias. Use `pro browser ask` when you explicitly want the visible browser adapter.
Run `pro ask` and `pro browser ask` from the repo root, or pass `--cwd /absolute/path/to/your/repo` so `--file` paths and `.bridge` records resolve to the intended project. If you generated commands with `onboard --cwd`, those commands already include the target cwd.
Bridge inspection and task handoff commands such as `pro browser check`, `pro latest`, `pro show`, `tasks create/list/show/claim/complete/block`, `results show`, `results artifact`, `receipts show`, and `sessions show` can also be run from elsewhere with `--cwd /absolute/path/to/your/repo`.
When the file exists and you want it included, add it explicitly, for example `prodex pro ask --cwd /absolute/path/to/your/repo --file README.md "Review the project positioning"`.
If your prompt itself starts with flag-like text, put `--` before the prompt. This applies to both preview and visible-browser sends, for example `prodex pro ask -- --strict mode review` or `prodex pro browser ask -- --strict mode review`.

## First Pro Login

Use this only when you explicitly want to use your logged-in ChatGPT Pro web session.

```bash
prodex pro browser login --dry-run
prodex pro browser login
prodex pro browser help
prodex pro browser check
prodex pro browser smoke --cwd /absolute/path/to/your/repo
```

If you use a non-default debug port or Chrome profile, pass it to `login`; the printed follow-up `check` and `smoke` commands keep the matching `--port`. To stop repeating `--port` on every command, export `PRODEX_CDP_PORT=<port>` once — explicit `--port` still wins. If you launch from outside the repo you want to inspect, pass `--cwd /absolute/path/to/your/repo` to `login`, `check`, or `smoke` so the command targets the same bridge. On slower first launches, add `--launch-timeout-ms 12000`.

For a source checkout, keep the follow-up commands in source-checkout form too:

```bash
cd /absolute/path/to/prodex
SOURCE_CLI="/absolute/path/to/prodex/dist/cli.js"
node "$SOURCE_CLI" pro browser login --dry-run --source-cli "$SOURCE_CLI"
node "$SOURCE_CLI" pro browser login --source-cli "$SOURCE_CLI"
node "$SOURCE_CLI" pro browser help --source-cli "$SOURCE_CLI"
node "$SOURCE_CLI" pro browser check --source-cli "$SOURCE_CLI"
node "$SOURCE_CLI" pro browser smoke --source-cli "$SOURCE_CLI" --cwd /absolute/path/to/your/repo
```

What happens:

- `login --dry-run` prints the dedicated Chrome profile, debug URL, and next commands without opening a browser.
- `login` opens that dedicated Chrome profile at ChatGPT. In an interactive terminal it then waits (default 5 minutes; `--no-wait` skips, `--wait-timeout-ms` tunes) and narrates which manual step is still missing until it reports READY; scripts and agents get the immediate return unless they pass `--wait`.
- You log in manually in the visible browser.
- If ChatGPT asks for captcha, Cloudflare/human verification, permission, or account verification, handle it in that browser.
- If ChatGPT shows a usage limit, message limit, model limit, or rate limit, wait for the reset or choose an available model in the browser.
- Open a normal ChatGPT chat or the intended Project/thread so the prompt composer is visible.
- Pick the Pro/Thinking model you want in the ChatGPT UI.
- The login stays in the dedicated profile:

```text
~/.local/share/prodex/chrome-chatgpt-pro
```

You can close that Chrome window after check/smoke or when you are done. The next time you need it, run `pro browser login` or `pro browser check` again. `check` will tell you what to do if the browser is closed.

Actual explicit visible-browser consult (`prodex ask` is the short form of `prodex pro browser ask`):

```bash
cd /absolute/path/to/your/repo
prodex ask --file README.md "Review the project positioning"
prodex pro latest
prodex results show latest
prodex results artifact latest
prodex sessions show latest
```

This uses the currently available ChatGPT web session and model selection. It is not a hidden API client, and it does not read cookies, tokens, localStorage, or sessionStorage.

#### Choosing the model, reasoning effort, and project

The visible-browser send drives the same composer picker you use by hand. Since ChatGPT replaced the model menu with one power slider that walks model and effort together, that slider is the lever:

```bash
# The top rung: GPT-6 Pro
prodex pro browser ask --effort Pro "Review the migration plan"

# A lower rung, inside an existing sidebar project
prodex pro browser ask --effort "매우 높음" --project "my-project" "Draft the release notes"
```

To see the ladder your account currently shows, list it read-only (opens the menu, walks the slider and puts it back, presses Escape; nothing is selected):

```bash
prodex pro browser models
```

- `--effort 즉시|중간|높음|"매우 높음"|Max|Ultra|Pro` sets the rung. English aliases `instant`/`light`, `medium`, `high`, `extrahigh`/`max`, `ultra` are accepted, and both the Korean and the English (US) ChatGPT labels are matched. `Max` and `Ultra` belong to the Work surface's ladder and apply only when the browser is already on Work; every other value is sent on Chat, whose top step is Pro.
- `--model Pro` reaches the same top rung. The model rows in the picker (Latest, GPT-5.6 Sol, GPT-5.5) refuse automation clicks in the current UI - they carry `pointer-events: none` - so `--model` with any other label reports `model_not_applied` rather than pretending. On a display language other than Korean or English, pass the exact label `models` prints.
- `--pro-mode 기본|확장` selects a Pro sub-mode where the picker still exposes one (the GPT-5.5 generation); with a single Pro rung it fails with guidance. `--pro-mode` and `--effort` are different axes of the same control and cannot be combined. Any Pro selection raises the default `--timeout-ms` to 1200000, because Pro reasoning routinely runs for many minutes; an explicit `--timeout-ms` always wins.
- ChatGPT keeps two surfaces, Chat and Work, with different pickers; Work's ladder has no Pro. A send puts the browser back on Chat first and notes it on the receipt, so a browser that drifted onto Work does not quietly send on the wrong picker.
- `--project "name"` enters an existing sidebar project before sending. `--project-new "name"` creates a new project (sidebar 새 프로젝트 popover, committed with Enter) and sends inside it. Neither can be combined with `--target-url` (the project step would navigate away from the confirmed tab), and `--project-new` never comes from saved defaults - creating a project is always an explicit per-ask choice.

Selection is guarded: prodex refuses to click a control that is covered or out of view, waits for the menu to actually open instead of sleeping a fixed delay, and treats a menu that stays open after a pick as a failed selection. If any step fails, it backs out with Escape and reports a blocker instead of sending with the wrong model. An applied selection stays active in your ChatGPT session after the send.

Persist defaults so you can omit these flags on routine asks; a per-ask flag always overrides the saved default. View saved defaults with `prodex status`, clear one with the matching `--clear-*` flag, or answer a short wizard instead of remembering flags:

```bash
prodex setup --model Pro --project "my-project"
prodex setup --clear-project
prodex setup --interactive   # asks model / Pro sub-mode or effort / project
```

The saved default above lives in the repo's `.bridge/config.local.json`, so it only applies when `prodex` runs from that repo. A coding agent often starts the MCP as `prodex mcp` with no `--cwd` (it reads whatever directory the agent launched in), so a per-repo default is missed and consults land in the general chat. For a default that applies from **any** directory, set environment variables instead — `PRODEX_DEFAULT_PROJECT` and `PRODEX_DEFAULT_MODEL` (also `PRODEX_DEFAULT_PRO_MODE`, `PRODEX_DEFAULT_EFFORT`) — in the agent's MCP `env` block or your shell. Use your own project name (list them with `prodex pro browser projects`); with no project set, consults simply go to the general chat. A per-repo config still wins field-by-field over the env fallback.

### No window at all: virtual display (recommended)

Log in once, then never see the browser again:

```bash
prodex pro browser login                    # once, headed - sign in
prodex pro browser login --virtual-display  # from now on: no window anywhere
```

`--virtual-display` (or `PRODEX_VIRTUAL_DISPLAY=1`, which also covers the MCP server and its auto-recovery) starts an X virtual framebuffer and runs the dedicated Chrome on it. It is a **real headed browser**, so Cloudflare treats it as an ordinary one — measured end to end: the signed-in profile loaded chatgpt.com with no challenge and a real Pro send returned in 31 seconds, with nothing on the desktop and nothing in the taskbar. Headless, by contrast, never gets past Cloudflare at all (see below).

Requires `Xvfb` and `xauth` (`sudo apt install -y xvfb x11-xkb-utils xauth`); prodex names the package if they are missing. Linux and WSL only. The display is served over loopback TCP because WSLg mounts `/tmp/.X11-unix` read-only, and it is protected by a per-display xauth cookie under `~/.local/share/prodex/xvfb/` — never `-ac`, so no other process can watch your signed-in window. The X server outlives the CLI on purpose (the browser runs on it) and is reused by later commands; `PRODEX_VIRTUAL_DISPLAY_NUM` picks the display number if `:99` is taken.

A browser already running on your desktop cannot be moved onto a virtual display by reusing it, so prodex refuses the switch and tells you to close it first (`pkill -f "remote-debugging-port=9333"`).

### Keeping the window, just out of the way

`prodex pro browser login --minimized` (or `PRODEX_MINIMIZE_WINDOW=1`) launches the dedicated browser and then minimizes it. It stays a **real headed Chrome** — which is the point, because Cloudflare admits headed browsers and rejects headless ones — but nothing sits on your desktop.

The catch is what "minimized" means to your desktop. Under WSLg a minimized Chrome still reports `visibilityState: "visible"`, so consults keep working (measured: a real Pro send completed in 26s with the window minimized). A normal Linux desktop instead marks minimized windows hidden, and prodex refuses to send into a tab it cannot read — so it restores the window and tells you, rather than leaving you a browser it cannot use. Try it; the login says which case you are in.

### Headless mode (not usable against ChatGPT today)

`prodex pro browser login --headless` (or `PRODEX_HEADLESS=1`, which also covers the MCP server and its auto-recovery) runs the dedicated browser with no visible window. Two constraints are real, not cosmetic:

- **Sign in headed first.** Nobody can log in to a window that does not exist, so headless reuses a profile you already signed into. The headless login verifies the saved session and tells you to run the headed login once if it is not there.
- **One mode at a time.** A single Chrome profile cannot serve a headed and a headless instance simultaneously; close the running one before switching (prodex refuses the switch instead of silently reusing the wrong mode).

**Cloudflare is the catch, and it is not theoretical.** Measured on a real signed-in profile: headless Chrome lands on the "Just a moment..." interstitial and stays there past 60 seconds, so ChatGPT never loads. A signed-in profile does not buy a pass — the challenge keys on the headless browser itself. Treat `--headless` as available-but-unproven against ChatGPT: try it, and if `prodex pro browser check` reports the challenge, run headed. Only the window is optional; the login is not.

If a consult finds the browser closed, prodex now relaunches it in the same mode you last used and retries once — including from the MCP server, which has no terminal to prompt in. `PRODEX_NO_AUTO_LOGIN=1` turns that off.

Whatever selection is applied is recorded on the consult receipt (`metadata.selection`); receipt display output redacts the project name, keeping only the model axes visible. `prodex` only clicks the picker you can see; it never selects a model, effort, or project silently outside the visible browser.

For a source checkout, keep the explicit send and inspection commands source-aware too:

```bash
cd /absolute/path/to/prodex
SOURCE_CLI="/absolute/path/to/prodex/dist/cli.js"
node "$SOURCE_CLI" pro browser ask --source-cli "$SOURCE_CLI" --cwd /absolute/path/to/your/repo --file README.md "Review the project positioning"
node "$SOURCE_CLI" pro latest --source-cli "$SOURCE_CLI"
```

Pass `--source-cli /absolute/path/to/prodex/dist/cli.js` to `pro browser ask`, `pro list`, `pro latest`, or `pro show <task-id|latest>` so blocked consults display source-checkout retry commands instead of installed-binary commands.

Each explicit browser consult creates a `.bridge` task and `.bridge/sessions` record before sending. If the visible browser is blocked by login, captcha, permission, or usage limits, the task is completed as a blocked consult so `prodex pro latest` still shows what happened, including the blocker code and next step; the failed command also prints the recorded task id plus `pro show`/`pro latest` inspection commands. Successful answers are normally saved as result artifacts under `.bridge/artifacts/pro-consults/` before the task result is finalized; if artifact or receipt recording fails after an answer is received, the answer is still completed as the result summary with a warning, and fatal finalization failures print the received answer before exiting. If a Pro answer is too large for `bridge_fetch_result_artifact`, it stays in the result summary with `answer_artifact_warning` and no unfetchable artifact is listed. Generic MCP handoff result artifacts can be stored under `.bridge/artifacts/results/`; `bridge_fetch_result_artifact` only reads artifacts explicitly listed on the result record, and newly finalized result artifacts are checked against the sha256 recorded at finalization time.

If an older local result is reported as untrusted because a locally signed legacy `task_completed` receipt is missing `result_sha256`, review `.bridge/results/<task-id>.json` yourself first, then run:

```bash
prodex results reseal <task-id> --confirm-current-result
```

This writes a new local `task_completed` receipt for the current result payload. Prefer the explicit task id you just reviewed; `latest` is accepted for convenience but resolves from the current raw result list at execution time. It does not reseal unsigned receipts, forged receipts, or receipts that already point at a different result digest.

Receipts are HMAC-signed with a local key in `.bridge/receipt-key.local`. If you suspect the key was exposed, rotate it:

```bash
prodex receipts rotate-key
```

New receipts are signed with the fresh key; previous keys stay in the file (verification only) so receipts signed before the rotation remain trusted.

To send into a specific visible Project or thread, open that ChatGPT URL in the dedicated browser first, confirm it is the right destination, then pass the same URL:

```bash
prodex pro browser ask --cwd /absolute/path/to/your/repo --target-url "https://chatgpt.com/c/..." --confirm-target --file README.md "Review this in this thread"
```

`prodex` does not silently switch Projects or threads. If the visible ChatGPT tab is not already on the confirmed URL, the send is refused.
If more than one ChatGPT tab or window is visible or visibility cannot be verified for extra ChatGPT tabs, an untargeted browser send is also refused; close the extra ChatGPT windows or use `--target-url ... --confirm-target`.

For optional ChatGPT Project -> local handoff, start the HTTP MCP bridge:

```bash
prodex setup --token-ttl-hours 24
prodex start
```

`setup` writes `.bridge/config.local.json` and ensures `.bridge/.gitignore` covers local task/result/session/receipt/artifact/config files. `setup`, `start`, and `status` redact the URL token by default.
The HTTP MCP listener is loopback-only: `setup --host` accepts local loopback hosts such as `127.0.0.1` or `localhost`, not public interfaces like `0.0.0.0`.
`start` reads the saved setup profile when the server process starts. If you rerun `setup` to change the listener or rotate the token, restart `prodex start` so the running server uses the new profile. `status --show-token --url-only` prints the saved local MCP URL, while `tunnel url` formats your supplied public tunnel URL with the saved token; it does not create or inspect the tunnel.

Run these commands from the repo root, or add `--cwd /absolute/path/to/your/repo` to `setup`, `start`, `status`, `doctor`, `tunnel url`, and bridge inspection commands. For example:

```bash
prodex setup --cwd /absolute/path/to/your/repo --token-ttl-hours 24
prodex start --cwd /absolute/path/to/your/repo
```

For a source checkout, keep the source CLI path on runtime/status commands too so recovery hints stay copyable:

```bash
node dist/cli.js start --cwd /absolute/path/to/your/repo --source-cli /absolute/path/to/prodex/dist/cli.js
node dist/cli.js status --cwd /absolute/path/to/your/repo --source-cli /absolute/path/to/prodex/dist/cli.js --show-token --url-only
```

Token-bearing MCP URLs are secrets. They authorize all enabled bridge tools, including repo read, search, write dry-run/apply, and stage-reviewed-paths tools. Use the next command only when you are ready to paste the URL into your own trusted private ChatGPT Project/App configuration:

```bash
prodex status --show-token --url-only
```

`status --show-token` requires a token with an expiry, so run `setup --token-ttl-hours <hours>` before asking for a paste-ready URL. The URL token is stored only in `.bridge/config.local.json`, which is ignored by git. Rotate it with `setup` when you no longer need that URL. If you intentionally created a non-expiring token for local-only debugging, `status --show-token` refuses to reveal it unless you also pass `--unsafe-show-non-expiring-token`. `doctor` and `pro browser check` also print `config_warning` when the saved token is non-expiring.

After adding the MCP URL to ChatGPT, generate a paste-ready verification prompt:

```bash
prodex project prompt
```

For a source checkout, pass the same built CLI path so the prompt's local follow-up commands are also source-checkout commands:

```bash
node dist/cli.js project prompt --cwd /absolute/path/to/your/repo --source-cli /absolute/path/to/prodex/dist/cli.js
```

Paste that prompt into the ChatGPT Project. It asks ChatGPT to call `bridge_create_task`, `bridge_list_tasks`, and `bridge_get_task`, then wait while you complete the verification task locally:

```bash
prodex tasks list --status new --cwd /absolute/path/to/your/repo
prodex tasks show <task-id> --cwd /absolute/path/to/your/repo
prodex tasks complete <task-id> --cwd /absolute/path/to/your/repo --summary "prodex MCP verification result" --artifact .bridge/artifacts/results/mcp-verification.md="prodex MCP verification artifact"
```

After the local completion command succeeds, reply to ChatGPT with `local completion done`. The generated prompt then asks ChatGPT to call `bridge_fetch_result` for the same task id, call `bridge_fetch_result_artifact` for every listed result artifact path, and report whether it can read both the verification result summary and artifact content.

The generated prompt also includes local `status --cwd ...` and `doctor --cwd ...` troubleshooting commands in case the Project cannot see or call the MCP tools. Source-checkout prompts keep `--source-cli` on those troubleshooting commands too.

If ChatGPT cannot reach `127.0.0.1` from its app runtime, keep `prodex start` local and put your own tunnel in front of it only after creating a short-lived token. `prodex` does not create the tunnel for you, but it can format the public MCP URL safely.

Public tunnel MCP URLs are also secrets. They authorize all enabled bridge tools, including repo read, search, write dry-run/apply, and stage-reviewed-paths tools. Use the next command only when you are ready to paste the public URL into your own trusted private MCP client configuration:

```bash
prodex tunnel url --public-url "https://your-tunnel.example" --show-token --url-only
```

See [docs/http-mcp.md](docs/http-mcp.md) for the full ChatGPT Project HTTP MCP setup flow and safety notes.

The MCP write path is intentionally narrow:

- `repo_write_file_dry_run` previews an existing repo-relative text-file replacement, stores hashes/diff in a receipt, and stores replacement text under `.bridge/artifacts/repo-writes/`.
- `repo_write_file_apply` applies that receipt only when the current git HEAD and file preimage hash still match.
- `repo_stage_reviewed_paths` stages only files whose applied write receipts still match the current git HEAD and file content.
- Sensitive local paths are rejected by both the read and write tools: `.bridge`, `.git`, `.env*`, `node_modules`, `dist`, and a set of common in-repo credential/key files (for example `.npmrc`, `.netrc`, `id_rsa`/`id_ed25519`, `*.pem`, `*.key`, `*.p12`/`*.pfx`/`*.jks`, `*.tfstate`, `credentials.*`, `service-account.*`, and the `.ssh`/`.aws`/`.gnupg` directories). This blocklist is defense in depth, not an exhaustive secret scanner — traversal and symlink escapes are separately blocked, but keep genuine secrets out of the repo and treat a token-bearing MCP URL as authorizing everything the tools can reach.
- No shell execution or direct ungated staging tool is exposed.

For local task-bus smoke tests:

```bash
cd /absolute/path/to/your/repo
prodex doctor
prodex tasks create --cwd /absolute/path/to/your/repo --title "Review plan" --prompt "Review this architecture"
prodex tasks list --cwd /absolute/path/to/your/repo
prodex tasks show latest --cwd /absolute/path/to/your/repo
prodex tasks block <task-id> --cwd /absolute/path/to/your/repo --summary "Blocked reason" --code manual_blocker --next-step "What to do next" --retryable
prodex pro ask --dry-run --cwd /absolute/path/to/your/repo --file README.md "Review the project positioning"
prodex sessions list
```

`doctor` stays local: it does not open ChatGPT or a browser. It creates isolated temp workspaces for the write/apply/stage smoke and HTTP MCP smoke, then confirms the expected bridge/repo tools are visible and that task create/list/get/claim/complete/block/fetch/list-results works over the MCP protocol.

During local development, you can run the TypeScript source directly:

```bash
npm run dev -- tasks list
```

## Claude MCP

If `prodex` is installed and on your PATH, generate the Claude MCP config JSON:

```bash
prodex claude config --cwd /absolute/path/to/your/repo
```

It prints this token-free config:

```json
{
  "mcpServers": {
    "prodex": {
      "command": "prodex",
      "args": ["mcp", "--cwd", "/absolute/path/to/your/repo"]
    }
  }
}
```

For a source checkout, first run `npm install && npm run build`, then generate a `node dist/cli.js` config:

```bash
node dist/cli.js claude config --cwd /absolute/path/to/your/repo --source-cli /absolute/path/to/prodex/dist/cli.js
```

See [docs/claude.md](docs/claude.md) for Claude Desktop and Claude Code notes.
Both generated configs point Claude at the same `mcp --cwd /absolute/path/to/your/repo` server args.

After adding the MCP server in Claude, generate a paste-ready verification prompt:

```bash
prodex claude prompt --cwd /absolute/path/to/your/repo
```

For a source checkout, include the built CLI path:

```bash
node dist/cli.js claude prompt --cwd /absolute/path/to/your/repo --source-cli /absolute/path/to/prodex/dist/cli.js
```

The generated prompt asks Claude to create and read a bridge task only; it does not request write, stage, shell, browser, or tunnel actions. It also includes local `claude config --cwd ...` and `doctor --cwd ...` troubleshooting commands in case Claude cannot see or call the MCP tools. Source-checkout prompts keep `--source-cli` on those troubleshooting commands too.
