# Design Draft

## Objective

Create a local project that supports:

1. `ChatGPT Project -> Codex/local` task handoff through HTTP MCP.
2. `Codex -> ChatGPT Pro/Project` consult through a visible browser adapter.
3. Durable logs, receipts, and session metadata.

## Proposed CLI

```bash
gptprouse setup
gptprouse start
gptprouse chatgpt open
gptprouse ask-pro --send --file src/server.ts --file docs/design.md "Find risks"
gptprouse tasks list
gptprouse tasks claim <task-id>
gptprouse results show <task-id>
```

## Proposed MCP Tools

For ChatGPT -> local:

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

Use a small TypeScript Node CLI/MCP server. Keep stdio MCP for Claude/Codex clients and Streamable HTTP MCP for ChatGPT Developer Mode-style clients.

Phase 1:

- Local task/result files.
- `ask-pro` wrapper around Oracle-style consult.
- Safety gates and dry-run preview.

Phase 2:

- MCP endpoint for ChatGPT Project -> local task creation/result fetch.
- Repo read/search with gpt-repo-mcp-style path sandbox.

Phase 3:

- Visible browser backend for Codex -> ChatGPT Pro consults.
- Explicit blocker handling and resumable sessions.

Phase 4:

- Optional tunnel helper for ChatGPT clients that cannot reach `127.0.0.1`.
- Write tools only after dry-run, expected-head checks, and receipt gates exist.
