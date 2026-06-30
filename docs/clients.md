# Connecting coding agents to ChatGPT Pro

`prodex` exposes a stdio MCP server, so any MCP-capable coding agent — not only Claude
and Codex — can drive the same logged-in ChatGPT Pro bridge and the shared `.bridge`
receipt ledger. The point is to let your existing agent ask ChatGPT Pro for a stronger
planning/review pass, with a durable local record, instead of each tool wiring up its own
account access.

The MCP command is the same everywhere:

```
command: prodex
args:    ["mcp"]
```

For a source checkout, use `command: node`, `args: ["/absolute/path/to/prodex/dist/cli.js", "mcp"]`.

Install the `prodex` binary with `npm install -g @youdie006/prodex` (note the scope — the unscoped `prodex` on npm is a different, unrelated package; do not install it), or build from source (see the README).

The same operating rules apply to every client: manual-first, explicit `pro browser ...`
sends only, stop on blockers, no bypass, low volume, local only (see the README).

## Claude Code

See [claude.md](claude.md), or:

```
claude mcp add prodex -- prodex mcp
```

## Codex

Add to the Codex MCP config (`~/.codex/config.toml`):

```toml
[mcp_servers.prodex]
command = "prodex"
args = ["mcp"]
```

## Cursor

Project `.cursor/mcp.json` (or the global one):

```json
{
  "mcpServers": {
    "prodex": { "command": "prodex", "args": ["mcp"] }
  }
}
```

## Gemini CLI

`~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "prodex": { "command": "prodex", "args": ["mcp"] }
  }
}
```

## Other MCP clients (Cline, Continue, Zed, ...)

Any client that speaks stdio MCP registers prodex the same way: a server named `prodex`
running `prodex mcp`. Once connected, the agent gets the ledger tools
(tasks / results / sessions / receipts) and can request explicit ChatGPT Pro consults
that land in the same receipt-backed `.bridge` ledger.

## ChatGPT Projects

ChatGPT Projects connect over the HTTP MCP bridge instead of stdio — see
[http-mcp.md](http-mcp.md).
