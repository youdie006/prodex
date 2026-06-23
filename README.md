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

- `docs/research.md`: repo and policy research summary.
- `docs/design.md`: proposed architecture and commands.
- `docs/todo.md`: implementation checklist.
- `.bridge/`: future task/result/session/artifact storage.

## v0.2 Status

Implemented:

- Versioned `.bridge` ledger schemas for tasks, results, sessions, and receipts.
- CLI commands for task creation/listing/claiming/completion and result display.
- `pro ask` and `pro latest` for Codex-first consult previews and review receipts.
- `ask-pro --dry-run` and `ask-pro --send` as explicit lower-level aliases.
- `pro browser login/check/smoke/ask` for the optional visible browser adapter.
- Claude-compatible stdio MCP server through `gptprouse mcp`.
- ChatGPT Developer Mode-style Streamable HTTP MCP server through `gptprouse setup` and `gptprouse start`.
- Read-only repo tools for bounded file reads and ripgrep search.
- Receipt-gated repo write/stage tools for existing text files: dry-run first, apply only with matching git HEAD and preimage hash, then stage only reviewed applied receipts.

Not implemented:

- Hidden ChatGPT endpoints.
- Cookie, token, localStorage, or sessionStorage extraction.
- Direct ungated write tools.
- Shell execution tools.
- Automatic public tunnel setup.

## Quick Start

```bash
npm install
npm run build
node dist/cli.js init
node dist/cli.js pro ask --file README.md "Review the project positioning"
```

`pro ask` is a dry-run/manual preview by default. It does not drive a logged-in browser unless you explicitly choose the browser adapter.

## First Pro Login

Use this only when you explicitly want to use your logged-in ChatGPT Pro web session.

```bash
node dist/cli.js pro browser login
node dist/cli.js pro browser check
node dist/cli.js pro browser smoke
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
node dist/cli.js pro browser ask --file README.md "Review the project positioning"
node dist/cli.js pro latest
```

This uses the currently available ChatGPT web session and model selection. It is not a hidden API client, and it does not read cookies, tokens, localStorage, or sessionStorage.

For optional ChatGPT Project -> local handoff, start the HTTP MCP bridge:

```bash
node dist/cli.js setup
node dist/cli.js start
```

`setup`, `start`, and `status` redact the URL token by default. When you are ready to paste the MCP URL into ChatGPT Developer Mode / Apps, run:

```bash
node dist/cli.js status --show-token
```

The URL token is stored only in `.bridge/config.local.json`, which is ignored by git.

If ChatGPT cannot reach `127.0.0.1` from its app runtime, keep `gptprouse start` local and put a tunnel in front of it. Tunnel setup is intentionally not automatic yet.

The MCP write path is intentionally narrow:

- `repo_write_file_dry_run` previews an existing repo-relative text-file replacement, stores hashes/diff in a receipt, and stores replacement text under `.bridge/artifacts/repo-writes/`.
- `repo_write_file_apply` applies that receipt only when the current git HEAD and file preimage hash still match.
- `repo_stage_reviewed_paths` stages only files whose applied write receipts still match the current git HEAD and file content.
- Sensitive local paths such as `.bridge`, `.git`, `.env*`, `node_modules`, and `dist` are rejected.
- No shell execution or direct ungated staging tool is exposed.

For local task-bus smoke tests:

```bash
node dist/cli.js tasks create --title "Review plan" --prompt "Review this architecture"
node dist/cli.js tasks list
node dist/cli.js pro ask --dry-run --file README.md "Review the project positioning"
```

During local development, you can run the TypeScript source directly:

```bash
npm run dev -- tasks list
```

## Claude MCP

Build first:

```bash
npm run build
```

Then point Claude at the stdio server:

```json
{
  "mcpServers": {
    "gptprouse": {
      "command": "node",
      "args": ["/absolute/path/to/project/gptprouse/dist/cli.js", "mcp"],
      "cwd": "/absolute/path/to/project/gptprouse"
    }
  }
}
```

See [docs/claude.md](docs/claude.md) for Claude Desktop and Claude Code notes.
