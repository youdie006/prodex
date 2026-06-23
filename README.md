# gptprouse

Personal bridge for using ChatGPT Pro/Projects, Claude, and Codex together.

`gptprouse` is a local receipt bus plus MCP bridge for coordinating Codex execution with ChatGPT Pro/Projects and Claude.

The goal is not to turn ChatGPT Pro into a public API. The goal is to remove copy/paste friction in a private workflow while keeping durable receipts:

- Let ChatGPT Projects hand structured tasks to Codex/local tools through an HTTP MCP bridge.
- Ask ChatGPT Pro from Codex when a stronger planning/review pass is useful.
- Let Claude create/fetch the same tasks through stdio MCP.
- Keep durable records of what was asked, what was returned, and what Codex did with it.

## Core Shape

```text
ChatGPT Pro / Project
   | Developer Mode HTTP MCP
   v
gptprouse local bridge + .bridge receipts
   ^                         |
   | stdio MCP               | visible browser consult
Claude / Codex <-------------+
```

## Operating Rules

- Manual-first: each ChatGPT Pro consult should be user-initiated or clearly tied to the current task.
- Visible browser: use the real logged-in browser session when browser control is needed.
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
- Claude-compatible stdio MCP server through `gptprouse mcp`.
- ChatGPT Developer Mode-style Streamable HTTP MCP server through `gptprouse setup` and `gptprouse start`.
- Read-only repo tools for bounded file reads and ripgrep search.
- `ask-pro --dry-run` for manual-copy consult bundles.
- `ask-pro --send` for visible-browser ChatGPT Pro consults when a logged-in local Chrome profile is available.
- `chatgpt open/status/smoke` commands for the visible browser adapter.

Not implemented:

- Hidden ChatGPT endpoints.
- Cookie, token, localStorage, or sessionStorage extraction.
- Direct write tools.
- Shell execution tools.
- Automatic public tunnel setup.

## Quick Start

```bash
npm install
npm run build
node dist/cli.js init
node dist/cli.js setup
node dist/cli.js start
```

Paste the printed Server URL into ChatGPT Developer Mode / Apps as the MCP server URL. The URL token is stored only in `.bridge/config.local.json`, which is ignored by git.

If ChatGPT cannot reach `127.0.0.1` from its app runtime, keep `gptprouse start` local and put a tunnel in front of it. Tunnel setup is intentionally not automatic yet.

In another terminal:

```bash
node dist/cli.js tasks create --title "Review plan" --prompt "Review this architecture"
node dist/cli.js tasks list
node dist/cli.js ask-pro --dry-run --file README.md "Review the project positioning"
```

For Codex -> ChatGPT Pro consults, open and log into the dedicated visible browser profile once:

```bash
node dist/cli.js chatgpt open
node dist/cli.js chatgpt status
node dist/cli.js ask-pro --send --file README.md "Review the project positioning"
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
