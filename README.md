<div align="center">

<img src="https://raw.githubusercontent.com/youdie006/prodex/main/assets/cli-banner.png" alt="prodex - ChatGPT Pro for your terminal and your coding agents, local, with receipts" width="760" />

[![CI](https://github.com/youdie006/prodex/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/youdie006/prodex/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40youdie006%2Fprodex?logo=npm&color=b91c1c)](https://www.npmjs.com/package/@youdie006/prodex)
[![node](https://img.shields.io/badge/node-%E2%89%A5%2020-1e1d1a.svg)](package.json)
[![license](https://img.shields.io/badge/license-MIT-1e1d1a.svg)](LICENSE)
[![browser: visible, yours](https://img.shields.io/badge/browser-visible%2C%20yours-b91c1c.svg)](#what-it-will-not-do)

[Install](#install) &middot; [Quick start](#quick-start) &middot; [Agents over MCP](#agents-over-mcp) &middot; [Model, effort, project](#model-effort-and-project) &middot; [No window](#running-without-a-window) &middot; [Receipts](#receipts) &middot; [FAQ](#faq)

<img src="https://raw.githubusercontent.com/youdie006/prodex/main/docs/demo-cli.webp" width="780" alt="Terminal recording: prodex ask sends a question to ChatGPT Pro, prints progress while Pro reasons for two and a half minutes, prints the answer and where it was saved; pro latest re-prints it; pro browser models reads the picker's five rungs ending in Pro; claude config prints the MCP config for an agent">

</div>

You pay for ChatGPT Pro. The reasoning that makes it worth paying for lives behind a web page, and the coding agent you actually spend the day with cannot reach it. prodex closes that gap without an API key, a proxy, or a stealth bot: it drives a real Chrome that you logged into once, types into the same composer you would, and reads the rendered answer from the page.

The recording below is from 0.40.6, before internal transcript access was removed. Current builds use rendered page content only; they do not fetch hidden ChatGPT APIs or extract session tokens.

```console
$ prodex ask --new-chat --effort Pro "A CLI drives a logged-in browser over the Chrome DevTools Protocol and holds a cross-process file lock while a send is in flight. What failure modes must the lock's expiry rule handle, and which single rule would you ship? Under 150 words."
progress: connecting to browser (port 9333)
progress: applying selection (effort=Pro project=set)
progress: prompt sent, waiting for answer (budget 20 min)
progress: waiting 1m 21s (generating)
progress: answer received after 2m 32s (transcript (1235 chars))
model_used: gpt-6-pro

Handle slow legitimate sends, hung or suspended owners, sleep/reboot, clock jumps,
crashes leaving stale files, PID reuse, incomplete metadata, competing reclaimers,
...
I'd ship: reclaim only a provably dead original owner's lock - never expire a live
or unverifiable owner by age.

saved: .bridge/artifacts/pro-consults/task_20260908_032750_gpt-pro-consult.md
```

That is a real run, timings included. Every consult lands as a task, a result and an HMAC-signed receipt under `.bridge/` in your repo, so `prodex pro latest` re-prints it, your agent can fetch it over MCP, and a week later you can still answer "what did Pro say about the lock?".

## What you can do with it

- **Ask from the terminal.** `prodex ask` with a question, a file's contents (`--file`), an uploaded pdf, deck, sheet or image (`--attach`), or anything piped in (`--stdin`). Available rendered composer tools can be selected with `--tool`; unsupported result formats stop with a blocker.
- **Let your agent ask.** `prodex mcp` is a stdio MCP server with a `pro_consult` tool; Claude Code, Codex, Cursor and Gemini CLI call it like any other tool. ChatGPT Projects can hand work back the other way over a loopback HTTP MCP bridge.
- **Pick the model and effort per ask.** The picker ChatGPT shows is the picker prodex drives: `--effort Pro` reaches the top rung, `--project` sends inside a sidebar project, and `prodex setup` pins defaults per repo.
- **Keep every answer.** Tasks, results, sessions and receipts are versioned JSON on disk, signed with a local key. Nothing is stored anywhere else.
- **Run it with no desktop window.** One headed login, then a virtual display: a dedicated browser running off your desktop. Authentication and protective checks still require your attention.
- **Stop where a person should.** Login, captcha, Cloudflare, usage limits and permission prompts halt the send with a named blocker and a next step. prodex solves none of them for you.

## Install

Node 20 or newer, `git`, and `ripgrep` (`rg`) on PATH. A Chromium-family browser for the browser adapter: Chrome, Chromium, Edge or Brave on PATH or in the standard native macOS and Windows locations. Set `PRODEX_CHROME` for another executable. WSL uses a Linux browser; Windows-host Chrome is not automatically discovered or interchangeable with a Linux profile.

On native Windows, generated command examples target PowerShell (PowerShell 7 for commands joined with `&&`), not `cmd.exe`. CLI/MCP subprocesses pass arguments directly without a shell.

```sh
npm install -g @youdie006/prodex
```

Note the scope: the unscoped `prodex` on npm is an unrelated package.

## Quick start

```sh
prodex pro browser login          # opens a dedicated Chrome; sign in once, it waits until READY
prodex ask "Explain this stack trace"
prodex ask --file src/auth.ts "Review this for security holes"
git diff | prodex ask --stdin "Review this diff"
prodex pro latest                 # re-print the last answer
```

`prodex ask` is the short form of `prodex pro browser ask`; every flag works on both. The login opens its own Chrome profile (`~/.local/share/prodex/chrome-chatgpt-pro`), never your daily browser, and in a terminal it keeps watching the window and names the manual step still missing (sign in, clear a check, open a chat) until it reports READY.

For a one-time visible login followed by a verified headless handoff, use `prodex pro browser login --background`. Keep the window open until `background: READY`: prodex verifies login, gracefully closes only an idle dedicated browser, then reopens the same profile and conversation headless. Future CLI/MCP relaunches reuse that mode. Other tabs, Chrome account/permission confirmation windows, unfinished input, and active answers block the handoff. A verification challenge remains a blocker; this option does not guarantee that ChatGPT accepts headless Chrome.

Finish any native browser or OS confirmation before requesting the handoff: Chrome does not expose every native dialog through its page-control interface. The guard detects page targets and rendered dialogs, not every OS prompt. Incognito, guest, and explicitly selected Chrome sub-profiles are refused.

A Chrome account-connection chooser is separate from ChatGPT sign-in. If prodex confirms that chooser is displayed, choose for yourself whether to connect Chrome to the account; "Use Chrome without an account" declines that separate connection. A hidden or unreadable internal target still blocks the handoff but is not proof that a prompt is visible or that ChatGPT is logged out.

"Login readiness is not yet confirmed" does not mean the saved login was lost. Inspect the dedicated browser before signing in again. An explicit `login_required`, `cloudflare_check`, `captcha_required`, or `permission_required` during a headless/virtual-display wait stops promptly. For a running headless browser, use `prodex pro browser login --headed --recover-visible` to open that same profile and page visibly. This explicit recovery refuses other tabs, active work, filled inputs, and uncertain browser identity; it never clicks a security check or sends a prompt. A usage limit or missing composer has its own next step instead of a blanket login instruction.

While Pro thinks, progress goes to stderr: connecting, prompt sent, elapsed time while generating. A Pro selection raises the send budget to twenty minutes on its own; `--timeout-ms` overrides it. Answers are read from the rendered page, so formatting can differ from the original message. If the dedicated browser is not running, an interactive `ask` starts it, waits for your saved session, and retries once (`--no-auto-login` turns that off; scripts opt in with `--auto-login`).

If the browser stops responding after your question was sent, prodex stops without sending it again. Use the `thread` and `request_id` from the error with `prodex pro browser recover --target-url <thread-url> --request-id <32hex>` (MCP: `pro_recover`). The request ID verifies that the recovered assistant answer follows that exact marked user turn. Legacy recovery without it remains available but returns `request_verified: false` and a warning.

If submission itself is unconfirmed, do not resend or simply increase the timeout: first inspect the original conversation for the `[prodex-request:...]` marker in the error. Missing login signals or text still in the composer do not prove that the question was never submitted.

Useful flags on every send:

| Flag | What it does |
|---|---|
| `--new-chat` | Explicitly request the default: ordinary consults start in a fresh chat. The shared current tab is never an implicit destination. |
| `--session-key id` | Identify one caller for scoped `--continue`. Falls back to `PRODEX_SESSION_KEY`, then `CODEX_THREAD_ID`. |
| `--file path` | Inline a text file's contents into the prompt. Repeatable. |
| `--attach path` | Upload the file itself: the only way to hand ChatGPT a pdf, pptx, xlsx or image. Paths must live inside the repo. |
| `--tool web-search` | Select a rendered composer tool. Automatic deep-research report retrieval is currently unsupported and is blocked before sending. |
| `--project "name"` | Send inside an existing sidebar project. `--project-new` creates one first. `prodex pro browser projects` lists exact names. |
| `--temporary` | A ChatGPT Temporary Chat: nothing in your chat list, but the answer is read off the page and cannot be recovered later. |
| `--json` | Structured output on stdout, progress on stderr. |
| `--target-url url --confirm-target` | Send into a specific thread the dedicated browser already has open. |

Prefer prompts to flags? `prodex ui` (or a bare `prodex` in a terminal) asks what to send and where, shows a progress bar, and prints the equivalent command so the flags are learnable.

Conversation/project lists contain only entries exposed by the rendered UI, not the full account history. Automatic chat/project deletion and hidden transcript/report retrieval are unavailable; perform those operations yourself in ChatGPT. A successful recovery requires the requested conversation and a stable, finished answer.

## Agents over MCP

**Claude Code, Codex, Cursor, Gemini CLI** talk to prodex over stdio. For Claude:

```sh
prodex claude config --cwd /absolute/path/to/your/repo
```

prints a token-free config that points Claude at `prodex mcp --cwd /absolute/path/to/your/repo`:

```json
{ "mcpServers": { "prodex": { "command": "prodex", "args": ["mcp", "--cwd", "/absolute/path/to/your/repo"] } } }
```

The server exposes `pro_consult` (a visible-browser send, with the same model, effort, project and tool choices as the CLI), `pro_recover` (fetch an answer that finished after a timeout), the bridge ledger tools (`bridge_create_task`, `bridge_list_tasks`, `bridge_fetch_result`, receipts, sessions), bounded `repo_read_file` and `repo_search`, and a receipt-gated write path: `repo_write_file_dry_run` first, `repo_write_file_apply` only while git HEAD and the file's preimage hash still match, `repo_stage_reviewed_paths` for applied receipts only. Each stdio MCP connection receives one default session key, ordinary consults start fresh, and `continue_thread` only searches that key and project. Logical agents sharing one MCP connection should pass distinct explicit `session_key` values and preserve them for follow-ups; an explicit key also preserves continuity across an MCP restart. No shell tool, no ungated write. `prodex claude prompt` prints a paste-ready prompt that verifies the wiring. [docs/claude.md](docs/claude.md) covers Claude Desktop and Claude Code; [docs/clients.md](docs/clients.md) covers the others, including the per-call approval and `tool_timeout_sec` Codex needs.

For same-task dialogue, reuse the response's exact `continuation` arguments with a
new prompt. The caller can answer Pro's clarification and ask useful follow-ups,
stopping when sufficient, repetitive, or blocked. `PRODEX_MAX_AUTO_FOLLOWUPS` sets
a configurable approval checkpoint (default 5, not a target round count); an
`awaiting_user` response sends nothing until the caller obtains your approval.
See [same-task dialogue](docs/clients.md#same-task-dialogue) for the budget and
`user_approved` contract. New topics still start fresh chats.

Updating the installed npm package does not reload an MCP process that is already running. Reconnect the MCP server or restart the Codex/Claude client to load the new build. This preserves the separate dedicated browser profile and does not itself require another login. ChatGPT can still expire the saved session; a `login_required` blocker means you need to sign in manually again.

An MCP server usually starts without `--cwd`, so a per-repo default can be missed. For defaults that apply from any directory, set `PRODEX_DEFAULT_PROJECT`, `PRODEX_DEFAULT_MODEL`, `PRODEX_DEFAULT_EFFORT` or `PRODEX_DEFAULT_PRO_MODE` in the agent's MCP `env` block; a per-repo config still wins field by field.

**ChatGPT Projects** can hand structured tasks back to your machine over a loopback-only HTTP MCP bridge. Token-bearing MCP URLs are secrets: the URL authorizes every enabled tool, so it is printed only on request and belongs only in your own trusted Project configuration.

```sh
prodex setup --token-ttl-hours 24
prodex start
prodex status --show-token --url-only   # the paste-ready URL, token included
prodex project prompt                   # a paste-ready verification prompt for the Project
```

The listener binds loopback only; put your own tunnel in front of it if ChatGPT cannot reach `127.0.0.1`, and only with a short-lived token (`prodex tunnel url --public-url https://... --show-token --url-only` formats the URL). [docs/http-mcp.md](docs/http-mcp.md) has the full flow and the safety notes.

## Model, effort and project

ChatGPT's composer picker is one slider that walks model and effort together. prodex drives that slider, and reads it back before every send:

```console
$ prodex pro browser models
Model menu options in the visible ChatGPT tab (read-only; nothing was selected):
* Latest
  GPT-5.6 Sol
  GPT-5.5

Power slider on this account (the slider was walked and put back):
  1/5  Latest  -  Instant
  2/5  Latest  -  Medium
  3/5  Latest  -  High
  4/5  Latest  -  Extra High
* 5/5  6  -  Pro
```

- `--effort 즉시|중간|높음|"매우 높음"|Pro` picks a rung; English aliases `instant`, `medium`, `high`, `extrahigh` and `max` are accepted, and `--model Pro` reaches the same top rung. Korean and English (US) ChatGPT labels are both matched; on another display language, pass the exact label `models` shows.
- ChatGPT now has two surfaces, Chat and Work, with different pickers; Work's ladder ends in Max and Ultra and offers no Pro. prodex puts the browser back on Chat before a send (and says so on the receipt), so a drifted browser cannot quietly send on the wrong picker. `Max` and `Ultra` are accepted for a browser already on Work.
- The model rows themselves (Latest, GPT-5.6 Sol, GPT-5.5) cannot be clicked by automation in the current picker; the slider is the lever, and prodex says so rather than pretending a row was chosen.
- Selection is guarded: a control that is covered or off screen is not clicked, a menu that stays open after a pick counts as a failed pick, and any failure backs out with Escape and reports a blocker instead of sending with the wrong model. What was applied is recorded on the receipt (`metadata.selection`, project name redacted).

Pin defaults once per repo so routine asks need no flags; a per-ask flag always wins:

```sh
prodex setup --effort Pro --project "your-project"
prodex setup --clear-project
prodex setup --interactive        # a short wizard instead of flags
prodex status                     # shows the saved defaults
```

## Running without a window

```sh
prodex pro browser login                    # once, headed: sign in
prodex pro browser login --virtual-display  # from then on: no window anywhere
prodex pro browser login --headed            # visible login/captcha when a hidden mode was saved
```

`--virtual-display` (or `PRODEX_VIRTUAL_DISPLAY=1`, which the MCP server and its auto-recovery honour too) starts an X virtual framebuffer and runs the dedicated Chrome on it. It uses ordinary headed Chrome without a desktop window, not Chrome's headless mode. Linux and WSL; needs `xvfb` and `xauth`. New displays use local abstract Unix sockets with per-display xauth authentication and no TCP listener. This does not bypass login or protection checks.

Already-running browsers and legacy TCP X servers are not stopped or migrated by the update. To migrate, finish pending consults, stop the dedicated browser and its old X server, then launch with `--virtual-display` using the updated prodex. A new launch skips any display number still occupied by a TCP listener.

The last recorded window mode is reused by later `login` commands and by CLI/MCP auto-recovery. One explicit mode flag (`--headed`, `--headless`, `--minimized`, or `--virtual-display`) overrides environment and saved state as a whole. With no mode flag, any non-empty mode environment value wins as a whole too, including `PRODEX_HEADLESS=0`, `false`, or `no`; otherwise the saved mode remains. The modes are mutually exclusive, and the normal first-run default remains a visible headed browser. If virtual-display setup fails, recovery stops instead of unexpectedly opening a desktop window.

`--minimized` keeps a window but minimizes it. Under WSLg a minimized Chrome still reports itself visible and consults keep working; a normal Linux desktop marks it hidden, and prodex refuses to send into a tab it cannot read, restores the window, and tells you.

`--headless` may be blocked even with a saved login: a previous test on a signed-in profile stayed on Cloudflare's interstitial past sixty seconds. `--background` verifies the actual handoff and only reports READY when the signed-in composer works headless. A challenge does not prove that the saved login was lost. Only the window is optional; authentication and protection checks still apply.

If a running headless browser needs login, captcha, Cloudflare, or account verification, run `prodex pro browser login --headed --recover-visible`. This is an explicit, guarded switch for a known authentication/protection blocker, not an automatic fallback or a general browser reset. It preserves the profile and page, waits for a clean shutdown, and opens a visible browser for any required manual step. That window is temporary: after the dedicated browser fully exits, the next launch remains headless. On macOS, closing a window alone may leave Chrome running; prodex stops rather than reopening that temporary visible window. Another challenge also stops instead of opening a visible window automatically; an ordinary explicit `login --headed` selects headed mode permanently. A virtual-display browser must still be closed manually before `login --headed`; it is not covered by this headless-only recovery. Merely omitting `--headless` does not switch modes because the saved preference persists. prodex never bypasses protection or force-kills a browser for a mode change.

Before a prompt is submitted, a browser confirmed to have stopped answering its control port can be ended and started fresh, and the receipt says so (`PRODEX_NO_AUTO_CLEAR=1` turns that off). A browser that is merely slow is left alone. After submission, prodex never auto-resends a lost prompt.

## Receipts

Everything a consult touches is written under `.bridge/` in the repo it ran from:

```text
.bridge/
  tasks/        what was asked, by whom, with which files and tools
  results/      the answer's summary and the artifacts it produced
  sessions/     preview, running, done or blocked, per consult
  receipts/     HMAC-signed records of every action, keyed by .bridge/receipt-key.local
  artifacts/    pro-consults/ answers, results/ handoff artifacts, repo-writes/ staged text
  diagnostics/  screenshots and page-shape snapshots from failed sends, when enabled
```

`prodex init` creates the ledger (a browser send creates it on first use too). `prodex pro latest`, `pro show`, `results show`, `results artifact`, `receipts show` and `sessions show` read them; `--json` on the list commands gives structured output. Newly finalized result artifacts are checked against their recorded sha256. Legacy artifacts without hashes remain readable with a `legacy_artifact_unverified` warning; signing result metadata does not verify those bytes. A blocked consult is completed as blocked with its code and next step, so `pro latest` shows what happened even when nothing was sent. `prodex receipts rotate-key` signs new receipts with a fresh key while older ones stay verifiable; `prodex results reseal <task-id> --confirm-current-result` re-signs a legacy result you have reviewed.

`sessions cancel` clears a stale session record after an interrupted send; it does not stop a running browser request. Stop that request in the terminal or client that started it.

Two sibling tools read the same ledger, found through the bridge registry prodex keeps in `~/.local/share/prodex/bridges.json`: [sessionwiki](https://github.com/youdie006/sessionwiki) indexes every consult as a searchable session, and [swapdex](https://github.com/youdie006/swapdex) lists recent consults after an account switch. Neither is required.

## How it works

```text
you / prodex ask ---------+
                          |          Chrome DevTools Protocol (loopback)
Claude, Codex, Cursor ----+--> prodex ------------------------------------> dedicated Chrome, your login
   stdio MCP: pro_consult |        |                                              |
                          |        | tasks, results, sessions, receipts           | chatgpt.com, the same
ChatGPT Projects ---------+        v                                              | composer you would use
   loopback HTTP MCP           .bridge/  (in your repo, HMAC-signed)              v
                                                                                ChatGPT Pro
```

The browser is a real Chrome launched with `--remote-debugging-port` on `127.0.0.1`, live only while the browser process is running. prodex checks the page state, confirms the tab is on a ChatGPT conversation it can read, applies the picker selection, types the prompt, waits for the answer to finish, and reads its rendered content. Sends are paced to human speed (one every ten seconds by default, `PRODEX_MIN_SEND_INTERVAL_MS` tunes it) and take a cross-process lock, so two agents on one machine queue rather than fight over the composer.

### What it will not do

- No hidden ChatGPT endpoints, no cookie, token, localStorage or sessionStorage extraction. It never reads a credential; the browser holds your login.
- No captcha solving, Cloudflare bypass, proxies or stealth. Login, captcha, verification, usage and model limits stop the send with a named blocker.
- No batch prompting or recurring loops. It is built for the occasional consult a person would make, and the pacing enforces that.
- No shell tool and no ungated write over MCP. Reads and searches are bounded to the repo and refuse `.bridge`, `.git`, `.env*`, `node_modules`, `dist` and common credential files.
- Nothing leaves your machine except what you type into ChatGPT. Bridge endpoints bind loopback; exposing them is your call and your tunnel.

Automating a paid ChatGPT account is your responsibility under OpenAI's terms; prodex keeps it visible and slow so that it looks like what it is.

## When a send breaks

prodex drives a web UI that changes underneath it, so the tooling assumes it will.

```sh
prodex pro report-issue              # a GitHub issue drafted from the blocked consult's receipt
prodex pro report-issue --confirm    # files it through gh; the prompt and the answer never travel
PRODEX_BROWSER_DIAGNOSTICS=1 prodex ask "..."   # leaves a screenshot and a page-shape snapshot in .bridge/diagnostics/
node scripts/ui-watchdog.mjs         # a real round trip that says ok or broken; --file-issue reports it
```

Reports are deduplicated by blocker code, so something that stays broken adds to one issue. Captures stay on your machine.

## FAQ

**Do I need tmux?** No. Explicit CLI commands work in a normal terminal, and stdio MCP works through pipes without a terminal. Only the interactive picker and `setup --interactive` need keyboard input from a terminal. Keep the calling CLI or agent running while waiting for an answer: closing its terminal or disconnecting SSH can interrupt collection. tmux is an optional way to keep that foreground session alive, not a requirement. `prodex start` is also a foreground process, not an installed service.

**Can I close the terminal after login?** Yes, once login is READY: the dedicated Chrome is launched separately. Keep that browser running for consults. If a CLI or agent exits during a request, ChatGPT may still finish it; recover the original thread and request ID rather than automatically sending the question again.

**Does closing the Chrome window switch to headless?** No. Use `login --background` and wait for `background: READY`; ordinary headed login never silently changes mode. A closed window alone is not evidence of logout. Before an unsent request, MCP or an auto-login-enabled CLI can reopen one missing ChatGPT tab in the existing browser and recheck the saved login without restarting Chrome.

**It stopped with `browser_tab_crashed` or `Runtime.enable`.** Chrome can leave an "Aw, Snap!" tab listed on its control port even though that tab's renderer has crashed. Before typing a new prompt, prodex can reload a confirmed crashed tab once at the same conversation address and records `browser_tab_recovered`. A timeout alone never authorizes a reload. A crash after a prompt was submitted stops without resending; inspect the original conversation, then recover with both `--target-url` and `--request-id` from the blocker. Other tabs, the browser profile, and saved login are left alone.

**A send failed with `send_ui_changed`.** ChatGPT redesigned the composer or send control. Update (`npm i -g @youdie006/prodex@latest`); if it persists, `prodex pro report-issue`, and paste the prompt by hand meanwhile.

**It stopped with `tab_not_visible`.** A tab counts as watchable only while its window is not minimized and it is the active tab. Leave the dedicated window behind your editor and it sends in the background; prodex never steals focus (`PRODEX_ACTIVATE_TAB=1` if you want the tab pulled forward on a stopped send).

**Why the pause before sending?** Pacing: `send_pacing: waiting Ns` on stderr. `PRODEX_MIN_SEND_INTERVAL_MS=0` disables it.

**The answer timed out.** Pro can take many minutes. Do not resend automatically. Recover the original marked turn with `prodex pro browser recover --target-url <thread> --request-id <request_id>` after it finishes.

**A consult returned an unrelated answer.** Current sends append a unique visible request marker and accept only the assistant turn following that marker. Ordinary calls also start fresh. A `request_mismatch` blocker is not retryable; inspect the named request instead of treating the returned page's last answer as the consult.

**Every send says "still generating" and nothing is being written.** ChatGPT parked the thread on "which response do you prefer?". prodex reports `response_choice_pending` and names the buttons; pick one, or send with `--new-chat`.

**Does it read my cookies or tokens?** No. It talks to the browser only over the loopback DevTools port, and only while that browser is open.

**Windows and macOS?** The CI matrix targets Linux, native Windows, and macOS ARM/Intel. See [platform verification](docs/platform-verification.md) for actual results and limits. Virtual display is Linux/WSL-only; a passing OS test does not prove authenticated headless ChatGPT access. On Windows, keep the repository and browser profile in a private user directory with suitable ACLs; Unix permission bits do not make Windows storage private.

## Development

```sh
npm install
npm run build
npm test                   # 1000+ tests; none of them touch a real browser
npm run release:verify     # tests, typecheck, build, package smoke, doctor
```

The npm package is CLI-only: the `prodex` command, the stdio MCP server and the HTTP MCP server are the supported surfaces, and deep imports are blocked on purpose. [docs/cli-reference.md](docs/cli-reference.md) carries the full operational detail: every command in installed and source-checkout form, the first login step by step, the HTTP bridge setup, and the local smoke tests. [docs/releasing.md](docs/releasing.md) describes the tag-driven publish (npm trusted publishing, no long-lived token) and the release checks.

## License

MIT. See [LICENSE](LICENSE).
