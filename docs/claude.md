# Claude Setup

`gptprouse` exposes a stdio MCP server so Claude can create bridge tasks, inspect task/result/session/receipt records, read/search the current repo, and request receipt-gated text-file edits.

## Build

Requires Node.js 20 or newer, `git`, and `ripgrep` (`rg`) on PATH.

If `gptprouse` is installed and on your PATH, you can use the `gptprouse mcp` command directly.

The installed npm package is CLI-only. Use the `gptprouse` command and MCP server surfaces; JavaScript imports from `gptprouse` or `gptprouse/dist/*` are unsupported until a library API is designed and documented.

For a source checkout:

```bash
cd /absolute/path/to/gptprouse
npm install
npm run build
```

## Claude Desktop

Generate a Claude Desktop MCP config:

```bash
gptprouse claude config --cwd /absolute/path/to/your/repo
```

It prints this token-free JSON:

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

For a source checkout instead of an installed package, first build the project, then generate a `node dist/cli.js` config:

```bash
gptprouse claude config --cwd /absolute/path/to/your/repo --source-cli /absolute/path/to/gptprouse/dist/cli.js
```

It prints this shape:

```json
{
  "mcpServers": {
    "gptprouse": {
      "command": "node",
      "args": ["/absolute/path/to/gptprouse/dist/cli.js", "mcp", "--cwd", "/absolute/path/to/your/repo"]
    }
  }
}
```

Restart Claude Desktop after editing the config.

## Claude Code

Use the same command shape in Claude Code's MCP configuration. If your Claude Code install supports adding servers from the CLI, the command is conceptually:

```bash
claude mcp add gptprouse -- gptprouse mcp --cwd /absolute/path/to/your/repo
```

If your install expects a JSON config, use the Claude Desktop JSON above.

## Tools

The server currently exposes ledger-first tools:

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

`bridge_complete_task` and `bridge_block_task` close tasks by writing durable `.bridge/results` records; they do not modify repo files. `bridge_fetch_result_artifact` only returns text artifacts that are listed on a result record and stored under `.bridge/artifacts/pro-consults/` or `.bridge/artifacts/results/`; it does not expose arbitrary `.bridge/artifacts` files.

Write tools are narrow and receipt-gated. Claude must first call `repo_write_file_dry_run` with an existing repo-relative text file, replacement content, and the expected git HEAD. The file is not changed; the receipt stores hashes/diff and points at a replacement-text artifact under `.bridge/artifacts/repo-writes/`. To apply it, Claude must call `repo_write_file_apply` with the dry-run receipt id, the same expected HEAD, and the reported preimage hash. If git HEAD, file content, or artifact content changed, apply fails. To stage the result, Claude must call `repo_stage_reviewed_paths` with applied write receipt ids and the same expected HEAD; staging fails if any file changed after apply.

No shell, browser, public tunnel, direct ungated write, or direct ungated staging tools are exposed through the Claude stdio MCP server.

## First Prompt

After adding the MCP server, generate a paste-ready verification prompt:

```bash
gptprouse claude prompt --cwd /absolute/path/to/your/repo
```

Paste the generated prompt into Claude. It asks Claude to use only `bridge_create_task`, `bridge_list_tasks`, and `bridge_get_task`, then gives local follow-up commands for checking the created task from your terminal.
