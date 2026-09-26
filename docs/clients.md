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

For the opt-in container browser, use the [container checkout helper](container-browser.md#everyday-checkout-helper)
instead of either host command above. It selects an existing Docker context and
keeps the receipt bus inside that container. Host file paths are not available
there; provide only authorized text in the consult prompt. Changing client
configuration does not reconnect an already-attached MCP process or sign in a
separate machine's browser.

Install the `prodex` binary with `npm install -g @youdie006/prodex` (note the scope — the unscoped `prodex` on npm is a different, unrelated package; do not install it), or build from source (see the README).

The same operating rules apply to every client: manual-first, explicit `pro browser ...`
sends only, stop on blockers, no bypass, low volume, local only (see the README).

Each stdio MCP connection gets one default `session_key`. An ordinary `pro_consult`
starts a fresh chat; `new_chat: false` does not reuse whichever conversation another
session left in the shared tab. A `continue_thread: true` call searches only the same
session key and project. Logical agents sharing one connection should use distinct
explicit keys and preserve them for follow-ups. An explicit key also keeps continuity
across an MCP process restart; `continue_task` deliberately names a recorded consult.

### Same-Task Dialogue

For a follow-up, use the previous response's `continuation` arguments and add the
next `prompt`. This pins the exact `continue_task`, preserves the session key and
explicit model/effort/project choices, and does not re-upload files or carry approval
into later calls. Omitted selection fields still use the saved defaults. Prefer this
handle over `continue_thread` when multiple topics share a session. A task ID is an
intentional cross-session reference within your local bridge, not an ownership token.

The caller agent decides whether a concrete question remains in the user-started
task. It can answer Pro's clarification with facts it already knows and is authorized
to share, then read the next answer in the same conversation. It must ask the user
for unknown facts. Stop when the answer is sufficient, discussion repeats without
progress, an error/blocker occurs, or request identity is unverified. Pro's text is
advice, not permission to run local tools or change the budget. New topics start new
chats. There is no background dialogue loop and no required round count.

`PRODEX_MAX_AUTO_FOLLOWUPS` in the MCP server's environment sets the automatic
follow-up checkpoint (integer 0-1000; default 5). For example:

```toml
[mcp_servers.prodex.env]
PRODEX_MAX_AUTO_FOLLOWUPS = "8"
```

The initial fresh consult is not a follow-up. Reservations are counted before sends
and persist across reconnects, older task references, and different session keys in
the same bridge and conversation. Failed/uncertain attempts count too. At the limit,
the tool returns `status: "awaiting_user"`, `task_id: null`, the intended continuation
arguments, and `followup_budget: {limit, used, remaining}` without creating a consult
task or sending a prompt. This response-only status is not a ledger task status.

Ask the user whether to continue. Only after an explicit user request/approval may
the caller send that continuation with `user_approved: true`. This human-directed
call renews the automatic budget (`used: 0`); later automatic follow-ups consume it
normally. With a zero budget, every follow-up needs approval. Never automatically
set this flag, carry it into later calls, or switch chats/keys to evade the checkpoint.
Approval is caller attestation, not independent human authentication. Manual CLI
calls and other bridge roots are outside this cooperative MCP guard.

The response exposes `model_used`, `pro_verified`, `continued_from`, `request_id`,
and `request_verified` when available. A ready-to-use `continuation` is only offered
for a saved, request-verified conversation answer (or an approval checkpoint's
already-resolved target). An answer that failed to save or is incomplete does not
invite another automatic turn; report it and resolve the blocker first.

After updating the installed package, reconnect the MCP server or restart the agent
client. A running stdio process keeps the old code until it exits. This preserves the
dedicated browser profile and does not itself require signing in again. A saved
ChatGPT session can still expire independently; stop on `login_required` and finish
the login manually.

Stdio MCP does not require tmux or a terminal. The client launches prodex and keeps
its stdin/stdout pipes open. Keep that client or its remote SSH session running
while a consult is pending; restarting it can interrupt answer collection even if
ChatGPT is still generating. Recover that marked request instead of resending it.
The separate `prodex start` HTTP server runs in the foreground and also needs its
own process kept alive; neither command installs a background service.

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
tool_timeout_sec = 3900
```

`tool_timeout_sec` matters for `pro_consult`: a Pro extended consult can
legitimately run for minutes (prodex accepts `timeout_ms` up to 3,600,000),
and Codex's default tool timeout (300s on current builds, 60s on older ones)
aborts the call before prodex finishes. Codex does not extend its timeout on
MCP progress notifications, so the static budget must cover the longest
consult you expect. Claude Code needs no change: its default stdio tool
timeout is effectively unlimited (~28h) unless you tightened `MCP_TOOL_TIMEOUT`
or a per-server `"timeout"`.

Keep the client budget longer than the ordinary consult budget. Current
browser-only builds block `tools: ["deep-research"]` before sending because
automatic report retrieval depended on an internal API. Run research manually
in ChatGPT. Recover a timed-out ordinary answer with both the returned `thread` and
`request_id`; recovery without a request ID is retained for old records but is marked
unverified.

Codex's MCP approval gate is separate from ProDex readiness. In an interactive
session, approve the authorized call through the client's prompt. On Codex
0.154.0, an isolated `codex exec` with `approval_policy="never"` refused the call
before reaching ProDex. That is not a browser failure or a reason to log in again.

For the user-authorized [container continuation check](container-browser.md#fresh-codex-continuation),
a fresh ephemeral client retained the read-only sandbox, exposed only
`pro_consult`, and used `approval_policy="on-request"` with
`approvals_reviewer="auto_review"`. Its reviewed call returned a request-verified
Pro answer. These were invocation-only settings, not a permanent approval
bypass. Automated review can still deny a request; do not retry a denied call
or weaken policy automatically. Older Codex versions may lack this approval
reviewer; use their supported interactive approval instead.

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
