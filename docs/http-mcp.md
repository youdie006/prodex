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

Requires Node.js 20 or newer, `git`, and `ripgrep` (`rg`) on PATH.

For an installed package:

```bash
gptprouse setup --token-ttl-hours 24
```

The installed npm package is CLI-only. Use the `gptprouse` command and MCP server surfaces; JavaScript imports from `gptprouse` or `gptprouse/dist/*` are unsupported until a library API is designed and documented.
Run the local bridge commands from the repo root, or pass `--cwd /absolute/path/to/your/repo` to `setup`, `start`, `status`, `doctor`, and `tunnel url`.

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

`--token-ttl-hours` is optional for strictly local use. If you omit it, `status` reports `token_status: "non_expiring"` and the token does not expire. `status --show-token` refuses to reveal non-expiring tokens by default; pass `--unsafe-show-non-expiring-token` only for local-only debugging. Before pasting the URL into ChatGPT or exposing this server through any tunnel, rerun setup with a short TTL:

```bash
gptprouse setup --token-ttl-hours 24
```

Equivalent from outside the repo:

```bash
gptprouse setup --cwd /absolute/path/to/your/repo --token-ttl-hours 24
```

Expired tokens are rejected by `gptprouse start` and by the HTTP MCP server. Rerun `setup` to rotate the URL.

## Start The Local Server

Run this in a terminal and keep it running while ChatGPT is using the bridge:

```bash
gptprouse start
```

The HTTP MCP listener is loopback-only. `setup --host` accepts local loopback hosts such as `127.0.0.1` or `localhost`; it rejects public interfaces like `0.0.0.0`. `start` reads the saved setup profile when the server process starts. If you rerun `setup` to change the listener or rotate the token, restart `gptprouse start` so the running server uses the new profile. `status --show-token --url-only` prints the saved local MCP URL, while `tunnel url` formats your supplied public tunnel URL with the saved token; it does not create or inspect the tunnel. If you need ChatGPT to reach it from outside the machine, keep `gptprouse start` local and put your own explicit tunnel in front of it.

From outside the repo:

```bash
gptprouse start --cwd /absolute/path/to/your/repo
```

Token-bearing MCP URLs are secrets. Use the next command only when you are ready to paste the URL into your own trusted private MCP client configuration:

```bash
gptprouse status --show-token --url-only
```

From outside the repo:

```bash
gptprouse status --cwd /absolute/path/to/your/repo --show-token --url-only
```

`--show-token` requires a token created with `setup --token-ttl-hours <hours>` unless you explicitly pass the local-debug `--unsafe-show-non-expiring-token` override.

## Add It To ChatGPT

In your ChatGPT Project MCP or Developer Mode setup, add the token-bearing URL generated in the previous step. Use it as a remote Streamable HTTP MCP server URL. Keep `gptprouse start` running and rotate the URL with `setup` when you no longer need it.

## Verify In ChatGPT

After adding the MCP URL, generate a prompt that tells ChatGPT exactly which read/task tools to call:

```bash
gptprouse project prompt
```

From outside the repo:

```bash
gptprouse project prompt --cwd /absolute/path/to/your/repo
```

For a source checkout, include the built CLI path so the generated local follow-up commands also use `node dist/cli.js`:

```bash
node dist/cli.js project prompt --cwd /absolute/path/to/your/repo --source-cli /absolute/path/to/gptprouse/dist/cli.js
```

Paste the generated prompt into the ChatGPT Project. It asks ChatGPT to call `bridge_create_task`, `bridge_list_tasks`, and `bridge_get_task`, then reply with the created task id. It deliberately does not ask for any repo write or staging tools.

After ChatGPT replies, confirm the task locally:

```bash
gptprouse tasks list --status new
gptprouse tasks show <task-id>
```

If the ChatGPT app runtime cannot reach `127.0.0.1`, this project intentionally does not create a tunnel automatically. Put your own explicit tunnel in front of the local server only after you understand the token exposure risk, and create a short-lived replacement URL first:

```bash
gptprouse setup --token-ttl-hours 24
```

After you create your own tunnel, ask `gptprouse` to format the public MCP URL. This command only rewrites the URL; it does not start or manage any tunnel process.

Public tunnel MCP URLs are also secrets. Use the next command only when you are ready to paste the public URL into your own trusted private MCP client configuration:

```bash
gptprouse tunnel url --public-url "https://your-tunnel.example" --show-token --url-only
```

From outside the repo, include the same target:

```bash
gptprouse tunnel url --cwd /absolute/path/to/your/repo --public-url "https://your-tunnel.example" --show-token --url-only
```

`tunnel url` refuses non-expiring or expired tokens. By default it redacts the token.

## Available Tools

The HTTP server exposes the same tool catalog as stdio MCP:

- `bridge_create_task`
- `bridge_list_tasks`
- `bridge_get_task`
- `bridge_claim_task`
- `bridge_complete_task`
- `bridge_block_task`
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

`bridge_complete_task` and `bridge_block_task` close tasks by writing durable `.bridge/results` records; they do not modify repo files. `bridge_fetch_result_artifact` only returns text artifacts that are listed on a result record and stored under `.bridge/artifacts/pro-consults/` or `.bridge/artifacts/results/`; it does not expose arbitrary `.bridge/artifacts` files. Newly finalized result artifacts record a sha256, and fetch rejects the artifact if its content changed afterward. The bridge rejects oversized result artifacts before task finalization; if a Pro browser answer is too large for `bridge_fetch_result_artifact`, it stays in the result summary with `answer_artifact_warning` instead of listing an unfetchable artifact.

## Write Flow

Writes are deliberately gated and require a git worktree with a committed HEAD:

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

`doctor` stays local. It verifies `.bridge`, redacted config loading, receipt-gated write/apply/stage behavior in a temporary git repo, and the real HTTP MCP tool catalog plus task create/list/get/claim/complete/block/fetch/list-results calls.

If ChatGPT cannot connect:

- Confirm `gptprouse start` is still running.
- Confirm you pasted the full `status --show-token --url-only` URL.
- Confirm the client can reach the host in that URL.
- If `status --show-token` says a token with expiry is required, run `gptprouse setup --token-ttl-hours 24` and update the URL.
- Run `gptprouse status`; if the token is expired, run `gptprouse setup --token-ttl-hours 24` again and update the URL.
