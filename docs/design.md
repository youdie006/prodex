# Design Draft

## Objective

Create a local project that supports:

1. Codex-centered task/result/receipt workflows under `.bridge`.
2. `Codex -> ChatGPT Pro/Project` consult previews that can be copied or run through an explicit optional browser adapter.
3. Optional `ChatGPT Project -> Codex/local` task handoff through HTTP MCP.
4. Durable logs, receipts, and session metadata.

## Proposed CLI

```bash
gptprouse pro ask --file src/server.ts --file docs/design.md "Find risks"
gptprouse pro browser login
gptprouse pro browser check
gptprouse pro browser ask --file src/server.ts --file docs/design.md "Find risks"
gptprouse pro browser ask --target-url "https://chatgpt.com/c/..." --confirm-target --file docs/design.md "Continue in this confirmed thread"
gptprouse pro latest
gptprouse tasks list
gptprouse tasks claim <task-id>
gptprouse results show <task-id>
gptprouse doctor
gptprouse setup
gptprouse start
```

## Proposed MCP Tools

For Codex/Claude/ChatGPT -> local:

- `bridge_create_task`
- `bridge_get_task`
- `bridge_list_results`
- `bridge_fetch_result`
- `repo_read_file`
- `repo_search`
- `repo_git_review`

Mutating tools should be opt-in and receipt-based:

- `repo_write_file_dry_run`
- `repo_write_file_apply`
- `repo_stage_reviewed_paths`

Current implementation exposes `repo_write_file_dry_run` and `repo_write_file_apply` for existing text-file replacement only. It requires a matching git HEAD and preimage hash before apply. Dry-run receipts keep hashes and diff in metadata while replacement text is stored under `.bridge/artifacts/repo-writes/`. `repo_stage_reviewed_paths` stages only paths backed by matching applied write receipts.

## Data Model

Task:

```json
{
  "id": "task_YYYYMMDD_HHMMSS_slug",
  "source": "chatgpt_project|codex",
  "status": "new|claimed|done|blocked",
  "title": "",
  "prompt": "",
  "files": [],
  "created_at": "",
  "updated_at": ""
}
```

Result:

```json
{
  "task_id": "",
  "status": "done|blocked",
  "summary": "",
  "artifacts": [],
  "commands": [],
  "created_at": ""
}
```

Session:

```json
{
  "id": "",
  "direction": "codex_to_chatgpt|chatgpt_to_codex",
  "backend": "oracle|chatgpt-control|mcp",
  "project": "",
  "thread": "",
  "created_at": "",
  "last_used_at": ""
}
```

## Implementation Preference

Use a small TypeScript Node CLI/MCP server. Keep Codex CLI commands as the primary UX. Keep stdio MCP for Claude and Streamable HTTP MCP for optional ChatGPT Developer Mode-style inbound handoff.

`gptprouse doctor` is the local product-health check. It verifies `.bridge` setup, reports local MCP config with tokens redacted, fails on expired HTTP MCP tokens, runs the receipt-backed write/apply/stage flow in an isolated temp git repo, and starts a loopback HTTP MCP server to confirm the expected tool catalog is reachable through the actual protocol.

Phase 1:

- Local task/result files.
- `pro ask` wrapper around Oracle-style dry-run/manual consult.
- Safety gates and dry-run preview.

Phase 2:

- Optional visible browser backend for Codex -> ChatGPT Pro consults through `pro browser login/check/ask`.
- Explicit blocker handling, write-ahead task/session records, blocked consult results on browser failure, and answer artifacts before result finalization.
- Confirmed target URLs for specific ChatGPT Project/thread sends: the visible tab must already be on the user-confirmed ChatGPT URL, otherwise the send is refused.

Phase 3:

- MCP endpoint for ChatGPT Project -> local task creation/result fetch.
- Repo read/search with gpt-repo-mcp-style path sandbox.

Phase 4:

- Optional tunnel helper for ChatGPT clients that cannot reach `127.0.0.1`.
- Tunnel-facing configs should use `setup --token-ttl-hours <hours>` so pasted MCP URLs can expire and be rotated.
- The tunnel helper is URL-only: it validates a user-provided HTTPS public URL and formats the MCP URL, but never starts a tunnel process.
- Broader write tools only after dry-run, expected-head checks, and receipt gates exist.
