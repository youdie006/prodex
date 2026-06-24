# gptprouse

Personal bridge for using ChatGPT Pro/Projects, Claude, and Codex together.

`gptprouse` is a local receipt bus plus MCP bridge for coordinating Codex execution with ChatGPT Pro/Projects and Claude.

The goal is not to turn ChatGPT Pro into a public API. The goal is to make Codex the main workbench while keeping durable receipts for every outside consult or handoff:

- Ask ChatGPT Pro from Codex when a stronger planning/review pass is useful.
- Let ChatGPT Projects hand structured tasks to Codex/local tools through an optional HTTP MCP bridge.
- Let Claude create/fetch the same tasks through stdio MCP.
- Keep durable records of what was asked, what was returned, and what Codex did with it.

## Core Shape

```text
Codex
  | pro ask preview / tasks / mcp
  v
gptprouse local bridge + .bridge receipts
  |                         ^
  | optional explicit       | optional HTTP/stdin MCP
  | pro browser consult     |
  v                         |
ChatGPT Pro              ChatGPT Projects / Claude
```

## Operating Rules

- Manual-first: each ChatGPT Pro consult should be user-initiated or clearly tied to the current task.
- Browser automation is optional and explicit: use it only through `pro browser ...`, with a real visible logged-in browser session.
- Stop on blockers: login, captcha, rate limit, Cloudflare, permission, and model-limit states stop the workflow.
- No bypass: no hidden API, cookie extraction, stealth automation, proxies, or captcha solving.
- Low volume: no batch prompting or recurring loops that make ChatGPT Pro behave like an API server.
- Local only: do not expose account access, browser sessions, or bridge endpoints to other users.

## Components

- `docs/http-mcp.md`: ChatGPT Project HTTP MCP setup and safety notes.
- `docs/claude.md`: Claude stdio MCP setup and tool notes.
- `.bridge/`: local task/result/session/artifact/receipt storage.

## Package Surface

The npm package is CLI-only for now. The supported public surfaces are the `gptprouse` command, the stdio MCP server, and the optional HTTP MCP server. JavaScript imports from `gptprouse` or `gptprouse/dist/*` are intentionally not exported until a library API is designed and documented.

## v0.2 Status

Implemented:

- Versioned `.bridge` ledger schemas for tasks, results, sessions, and receipts.
- CLI commands for task creation/listing/inspection/claiming/completion/blocking and result display.
- `pro ask` and `pro latest` for Codex-first consult previews and review receipts.
- `sessions list` and `sessions show` for inspecting dry-run, running, done, or blocked consult sessions.
- `receipts list` and `receipts show` for inspecting the local action ledger without exposing legacy inline write payloads.
- Ledger MCP tools for creating, claiming, completing, blocking, and inspecting task/result/session/receipt records from Claude or ChatGPT Projects.
- Read-only result artifact fetch for Pro consult artifacts explicitly listed on a result record.
- `ask-pro --dry-run` and `ask-pro --send` as explicit lower-level aliases.
- `pro browser login/check/smoke/ask` for the optional visible browser adapter.
- Claude-compatible stdio MCP server through `gptprouse mcp`.
- ChatGPT Developer Mode-style Streamable HTTP MCP server through `gptprouse setup` and `gptprouse start`.
- Read-only repo tools for bounded file reads and ripgrep search.
- Receipt-gated repo write/stage tools for existing text files: dry-run first, apply only with matching git HEAD and preimage hash, then stage only reviewed applied receipts.
- `doctor` local health check for `.bridge`, redacted config loading, receipt-backed write/apply/stage, and the real HTTP MCP tool catalog.

Not implemented:

- Hidden ChatGPT endpoints.
- Cookie, token, localStorage, or sessionStorage extraction.
- Direct ungated write tools.
- Shell execution tools.
- Automatic public tunnel setup.

## Quick Start

Requires Node.js 20 or newer, `git`, and `ripgrep` (`rg`) on PATH. The optional visible-browser adapter also needs a Chromium-family browser (`google-chrome`, `chromium`, `chromium-browser`, `microsoft-edge`, `brave-browser`) or `GPTPROUSE_CHROME=/path/to/browser`.

For an installed package:

```bash
gptprouse init
gptprouse doctor
gptprouse pro ask --file README.md "Review the project positioning"
```

For a source checkout:

```bash
npm install
npm run build
node dist/cli.js init
node dist/cli.js doctor
node dist/cli.js pro ask --file README.md "Review the project positioning"
```

The examples below use the installed `gptprouse` binary. In a source checkout, replace `gptprouse` with `node dist/cli.js` after building.

`init` creates the local `.bridge/` ledger directories and ignore rules. On a source checkout it may also add `node_modules/` and `dist/` to the repo root `.gitignore` so local dependencies and build output stay out of git.
Run `init` from the repo root, or use `gptprouse init --cwd /absolute/path/to/your/repo` from elsewhere.

`pro ask` is a dry-run/manual preview by default. It does not drive a logged-in browser unless you explicitly choose the browser adapter.
If your prompt itself starts with flag-like text, put `--` before the prompt, for example `gptprouse pro ask -- --strict mode review`.

## First Pro Login

Use this only when you explicitly want to use your logged-in ChatGPT Pro web session.

```bash
gptprouse pro browser login
gptprouse pro browser check
gptprouse pro browser smoke
```

What happens:

- A dedicated Chrome profile opens at ChatGPT.
- You log in manually in the visible browser.
- If ChatGPT asks for captcha, permission, or account verification, handle it in that browser.
- Pick the Pro/Thinking model you want in the ChatGPT UI.
- The login stays in the dedicated profile:

```text
~/.local/share/gptprouse/chrome-chatgpt-pro
```

You can close that Chrome window after login. The next time you need it, run `pro browser login` or `pro browser check` again. `check` will tell you what to do if the browser is closed.

Actual explicit visible-browser consult:

```bash
gptprouse pro browser ask --file README.md "Review the project positioning"
gptprouse pro latest
gptprouse results show latest
gptprouse results artifact latest
gptprouse sessions show latest
```

This uses the currently available ChatGPT web session and model selection. It is not a hidden API client, and it does not read cookies, tokens, localStorage, or sessionStorage.

Each explicit browser consult creates a `.bridge` task and `.bridge/sessions` record before sending. If the visible browser is blocked by login, captcha, permission, or usage limits, the task is completed as a blocked consult so `gptprouse pro latest` still shows what happened. Successful answers are also saved as result artifacts under `.bridge/artifacts/pro-consults/` before the task result is finalized.

To send into a specific visible Project or thread, open that ChatGPT URL in the dedicated browser first, confirm it is the right destination, then pass the same URL:

```bash
gptprouse pro browser ask --target-url "https://chatgpt.com/c/..." --confirm-target --file README.md "Review this in this thread"
```

`gptprouse` does not silently switch Projects or threads. If the visible ChatGPT tab is not already on the confirmed URL, the send is refused.

For optional ChatGPT Project -> local handoff, start the HTTP MCP bridge:

```bash
gptprouse setup --token-ttl-hours 24
gptprouse start
```

`setup` writes `.bridge/config.local.json` and ensures `.bridge/.gitignore` covers local task/result/session/receipt/artifact/config files. `setup`, `start`, and `status` redact the URL token by default.

Run these commands from the repo root, or add `--cwd /absolute/path/to/your/repo` to `setup`, `start`, `status`, `doctor`, and `tunnel url`. For example:

```bash
gptprouse setup --cwd /absolute/path/to/your/repo --token-ttl-hours 24
gptprouse start --cwd /absolute/path/to/your/repo
```

When you are ready to paste the MCP URL into ChatGPT Developer Mode / Apps, run:

```bash
gptprouse status --show-token --url-only
```

The URL token is stored only in `.bridge/config.local.json`, which is ignored by git. Treat the full `--show-token` URL like a password: paste it only into your own private ChatGPT Project/App configuration, then rotate it with `setup` when you no longer need that URL. If you omit `--token-ttl-hours`, the token does not expire; keep that local-only and rerun `setup --token-ttl-hours <hours>` before putting any tunnel in front of it.

After adding the MCP URL to ChatGPT, generate a paste-ready verification prompt:

```bash
gptprouse project prompt
```

Paste that prompt into the ChatGPT Project. It asks ChatGPT to call `bridge_create_task`, `bridge_list_tasks`, and `bridge_get_task` only, then you can confirm the created task locally:

```bash
gptprouse tasks list --status new
gptprouse tasks show <task-id>
```

If ChatGPT cannot reach `127.0.0.1` from its app runtime, keep `gptprouse start` local and put your own tunnel in front of it only after creating a short-lived token. `gptprouse` does not create the tunnel for you, but it can format the public MCP URL safely:

```bash
gptprouse tunnel url --public-url "https://your-tunnel.example" --show-token --url-only
```

See [docs/http-mcp.md](docs/http-mcp.md) for the full ChatGPT Project HTTP MCP setup flow and safety notes.

The MCP write path is intentionally narrow:

- `repo_write_file_dry_run` previews an existing repo-relative text-file replacement, stores hashes/diff in a receipt, and stores replacement text under `.bridge/artifacts/repo-writes/`.
- `repo_write_file_apply` applies that receipt only when the current git HEAD and file preimage hash still match.
- `repo_stage_reviewed_paths` stages only files whose applied write receipts still match the current git HEAD and file content.
- Sensitive local paths such as `.bridge`, `.git`, `.env*`, `node_modules`, and `dist` are rejected.
- No shell execution or direct ungated staging tool is exposed.

For local task-bus smoke tests:

```bash
gptprouse doctor
gptprouse tasks create --title "Review plan" --prompt "Review this architecture"
gptprouse tasks list
gptprouse tasks show latest
gptprouse tasks block <task-id> --summary "Blocked reason" --code manual_blocker --next-step "What to do next" --retryable
gptprouse pro ask --dry-run --file README.md "Review the project positioning"
gptprouse sessions list
```

`doctor` stays local: it does not open ChatGPT or a browser. It creates isolated temp workspaces for the write/apply/stage smoke and HTTP MCP smoke, then confirms the expected bridge/repo tools are visible and that task create/list/get/claim/complete/block/fetch/list-results works over the MCP protocol.

During local development, you can run the TypeScript source directly:

```bash
npm run dev -- tasks list
```

## Release Checks

Before sharing a package tarball, run:

```bash
npm run smoke:package
```

This packs the project, installs the tarball into a temporary consumer project, runs the installed `gptprouse` binary, verifies HTTP MCP onboarding through installed token-TTL `setup`/`status`/configured `doctor`/`tunnel url`/`start` plus `/health`, verifies the package is CLI-only by blocking unsupported deep imports, verifies the installed stdio MCP server exposes the expected tool catalog, and calls the installed stdio task completion/blocking tools.

To run the full release verification sequence before choosing a public license:

```bash
npm run release:verify
```

This runs tests, typecheck, build, package smoke, and `doctor` without weakening the publish guard.

To see the current publish blocker and next step from the CLI:

```bash
gptprouse release status
```

Before publishing to npm, choose an explicit license and add the matching `LICENSE` file. `npm publish` is intentionally guarded by `prepublishOnly`; it runs:

```bash
npm run release:check
```

Until the license is chosen, `release:check` fails with a metadata error instead of letting an accidental public publish proceed.

## Claude MCP

If `gptprouse` is installed and on your PATH, point Claude at the stdio server:

```json
{
  "mcpServers": {
    "gptprouse": {
      "command": "gptprouse",
      "args": ["mcp", "--cwd", "/absolute/path/to/your/repo"]
    }
  }
}
```

For a source checkout, first run `npm install && npm run build`, then use `node` with your own absolute path to `dist/cli.js` and the same `mcp --cwd /absolute/path/to/your/repo` args. See [docs/claude.md](docs/claude.md) for Claude Desktop and Claude Code notes.
