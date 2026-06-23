# Claude Setup

`gptprouse` exposes a stdio MCP server so Claude can create bridge tasks, inspect task/results, read/search the current repo, and request receipt-gated text-file edits.

## Build

```bash
cd /absolute/path/to/project/gptprouse
npm install
npm run build
```

## Claude Desktop

Add this server to your Claude Desktop MCP config:

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

Restart Claude Desktop after editing the config.

## Claude Code

Use the same command shape in Claude Code's MCP configuration. If your Claude Code install supports adding servers from the CLI, the command is conceptually:

```bash
claude mcp add gptprouse -- node /absolute/path/to/project/gptprouse/dist/cli.js mcp
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

Write tools are narrow and receipt-gated. Claude must first call `repo_write_file_dry_run` with an existing repo-relative text file, replacement content, and the expected git HEAD. The file is not changed. To apply it, Claude must call `repo_write_file_apply` with the dry-run receipt id, the same expected HEAD, and the reported preimage hash. If git HEAD or file content changed, apply fails.

No shell, browser, public tunnel, direct ungated write, or staging tools are exposed through the Claude stdio MCP server.

## First Prompt

```text
Use gptprouse. Create a bridge task for Codex with a short title and a concrete prompt. Then list open bridge tasks.
```
