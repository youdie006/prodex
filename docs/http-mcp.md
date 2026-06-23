# ChatGPT Project HTTP MCP Setup

Use this path when you want a ChatGPT Project to hand tasks back to this local repo through MCP.

This is not the ChatGPT Pro browser adapter. It does not open ChatGPT, read cookies, or automate a web session. It starts a local HTTP MCP server that exposes the same bridge/repo tools as the Claude stdio server.

## What It Is

`gptprouse start` runs a local Streamable HTTP MCP server.

Typical use:

- ChatGPT creates a structured task in `.bridge/tasks/`.
- Codex claims and executes that task locally.
- Codex writes the result to `.bridge/results/`.
- ChatGPT fetches the result through MCP.

The server is personal and local-first. Do not expose it as a shared service.
HTTP MCP requests are bounded: malformed JSON returns `400`, and request bodies over 1 MiB are rejected with `413`.

## Build And Prepare

Requires Node.js 20 or newer and `git` on PATH.

For an installed package:

```bash
gptprouse setup --token-ttl-hours 24
```

For a source checkout:

```bash
npm install
npm run build
node dist/cli.js setup --token-ttl-hours 24
```

The examples below use the installed `gptprouse` binary. In a source checkout, replace `gptprouse` with `node dist/cli.js` after building.

`setup` writes a local server profile to `.bridge/config.local.json`. The file is ignored by git.
It also ensures `.bridge/.gitignore` covers local task, result, session, receipt, artifact, and config files.

By default, command output redacts the URL token:

```text
gptprouse_token=***
```

`--token-ttl-hours` is optional for strictly local use. If you omit it, `status` reports `token_status: "none"` and the token does not expire. Before exposing this server through any tunnel, rerun setup with a short TTL:

```bash
gptprouse setup --token-ttl-hours 24
```

Expired tokens are rejected by `gptprouse start` and by the HTTP MCP server. Rerun `setup` to rotate the URL.

## Start The Local Server

Run this in a terminal and keep it running while ChatGPT is using the bridge:

```bash
gptprouse start
```

In another terminal, get the paste-ready MCP URL:

```bash
gptprouse status --show-token --url-only
```

Only use `--show-token` when you are ready to paste the URL into your own trusted private MCP client configuration.

## Add It To ChatGPT

In your ChatGPT Project MCP or Developer Mode setup, add the URL from:

```bash
gptprouse status --show-token --url-only
```

Use it as a remote Streamable HTTP MCP server URL. Keep `gptprouse start` running. Treat the token-bearing URL like a password and rotate it with `setup` when you no longer need that URL.

If the ChatGPT app runtime cannot reach `127.0.0.1`, this project intentionally does not create a tunnel automatically. Put your own explicit tunnel in front of the local server only after you understand the token exposure risk, and create a short-lived replacement URL first:

```bash
gptprouse setup --token-ttl-hours 24
```

After you create your own tunnel, ask `gptprouse` to format the public MCP URL. This command only rewrites the URL; it does not start or manage any tunnel process:

```bash
gptprouse tunnel url --public-url "https://your-tunnel.example" --show-token --url-only
```

`tunnel url` refuses non-expiring or expired tokens. By default it redacts the token; use `--show-token` only when you are ready to paste the URL into a trusted private MCP client.

## Available Tools

The HTTP server exposes the same tool catalog as stdio MCP:

- `bridge_create_task`
- `bridge_list_tasks`
- `bridge_get_task`
- `bridge_claim_task`
- `bridge_list_results`
- `bridge_fetch_result`
- `bridge_fetch_result_artifact`
- `bridge_list_receipts`
- `bridge_get_receipt`
- `bridge_list_sessions`
- `bridge_get_session`
- `repo_read_file`
- `repo_search`
- `repo_write_file_dry_run`
- `repo_write_file_apply`
- `repo_stage_reviewed_paths`

## Write Flow

Writes are deliberately gated:

1. `repo_write_file_dry_run` previews replacing an existing repo-relative text file. It records the diff, git HEAD, preimage hash, and a replacement-text artifact under `.bridge/artifacts/repo-writes/`.
2. `repo_write_file_apply` applies that exact receipt only if git HEAD, file path, preimage hash, and artifact content still match.
3. `repo_stage_reviewed_paths` stages only files backed by matching applied write receipts.

There is no direct ungated write tool and no shell execution tool.

## Safety Boundaries

- No hidden ChatGPT API client.
- No browser cookie, token, localStorage, or sessionStorage extraction.
- No captcha, Cloudflare, rate-limit, or permission bypass.
- No recurring prompt loops.
- No public account-sharing service.
- No shell execution over MCP.
- No access to `.bridge`, `.git`, `.env*`, `node_modules`, `dist`, or oversized files through repo read/search tools.

## Troubleshooting

Run the local health check:

```bash
gptprouse doctor
```

`doctor` stays local. It verifies `.bridge`, redacted config loading, receipt-gated write/apply/stage behavior in a temporary git repo, and the real HTTP MCP tool catalog.

If ChatGPT cannot connect:

- Confirm `gptprouse start` is still running.
- Confirm you pasted the full `status --show-token --url-only` URL.
- Confirm the client can reach the host in that URL.
- Run `gptprouse status`; if the token is expired, run `gptprouse setup --token-ttl-hours 24` again and update the URL.
