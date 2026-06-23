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
gptprouse pro latest
gptprouse tasks list
gptprouse tasks claim <task-id>
gptprouse results show <task-id>
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

Phase 1:

- Local task/result files.
- `pro ask` wrapper around Oracle-style dry-run/manual consult.
- Safety gates and dry-run preview.

Phase 2:

- Optional visible browser backend for Codex -> ChatGPT Pro consults through `pro browser login/check/ask`.
- Explicit blocker handling and resumable sessions.

Phase 3:

- MCP endpoint for ChatGPT Project -> local task creation/result fetch.
- Repo read/search with gpt-repo-mcp-style path sandbox.

Phase 4:

- Optional tunnel helper for ChatGPT clients that cannot reach `127.0.0.1`.
- Write tools only after dry-run, expected-head checks, and receipt gates exist.
