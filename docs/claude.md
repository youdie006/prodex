# Claude Setup

`gptprouse` exposes a stdio MCP server so Claude can create bridge tasks, inspect task/results, read/search the current repo, and request receipt-gated text-file edits.

## Build

If `gptprouse` is installed and on your PATH, you can use the `gptprouse mcp` command directly.

For a source checkout:

```bash
cd /absolute/path/to/gptprouse
npm install
npm run build
```

## Claude Desktop

Add this server to your Claude Desktop MCP config:

```json
{
  "mcpServers": {
    "gptprouse": {
      "command": "gptprouse",
      "args": ["mcp"],
      "cwd": "/absolute/path/to/your/repo"
    }
  }
}
```

For a source checkout instead of an installed package, use:

```json
{
  "mcpServers": {
    "gptprouse": {
      "command": "node",
      "args": ["/absolute/path/to/gptprouse/dist/cli.js", "mcp"],
      "cwd": "/absolute/path/to/your/repo"
    }
  }
}
```

Restart Claude Desktop after editing the config.

## Claude Code

Use the same command shape in Claude Code's MCP configuration. If your Claude Code install supports adding servers from the CLI, the command is conceptually:

```bash
claude mcp add gptprouse -- gptprouse mcp
```

If your install expects a JSON config, use the Claude Desktop JSON above.

## Tools

The server currently exposes ledger-first tools:

- `bridge_create_task`
- `bridge_list_tasks`
- `bridge_get_task`
- `bridge_claim_task`
- `bridge_list_results`
- `bridge_fetch_result`
- `repo_read_file`
- `repo_search`
- `repo_write_file_dry_run`
- `repo_write_file_apply`
- `repo_stage_reviewed_paths`

Write tools are narrow and receipt-gated. Claude must first call `repo_write_file_dry_run` with an existing repo-relative text file, replacement content, and the expected git HEAD. The file is not changed; the receipt stores hashes/diff and points at a replacement-text artifact under `.bridge/artifacts/repo-writes/`. To apply it, Claude must call `repo_write_file_apply` with the dry-run receipt id, the same expected HEAD, and the reported preimage hash. If git HEAD, file content, or artifact content changed, apply fails. To stage the result, Claude must call `repo_stage_reviewed_paths` with applied write receipt ids and the same expected HEAD; staging fails if any file changed after apply.

No shell, browser, public tunnel, direct ungated write, or direct ungated staging tools are exposed through the Claude stdio MCP server.

## First Prompt

```text
Use gptprouse. Create a bridge task for Codex with a short title and a concrete prompt. Then list open bridge tasks.
```
