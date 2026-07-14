# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.16.14] - 2026-07-14

### Fixed
- Concurrent prodex clients no longer corrupt each other's sends. Two sessions
  sharing the one dedicated browser tab interleaved composer input and
  navigation - measured live: one client's test prompt landed inside the other
  client's consult thread, and a 15-minute consult never actually posted (its
  acceptance signal came from the other client's activity). Visible-browser
  sends now hold a machine-global lock (~/.local/share/prodex/browser-send.lock,
  pid-liveness stale reaping): a second send queues behind the holder within
  its --busy-wait-ms budget, or fails fast naming the holder pid. Applies to
  ask and smoke.

## [0.16.13] - 2026-07-14

Shared-tab contention and post-creation transients, from a live sweep of the
remaining real-usage flows.

### Added
- `--busy-wait-ms <ms>` on visible-browser asks: when the tab is busy with
  another response (another agent or the user mid-generation), wait up to the
  given bound for it to finish instead of failing immediately. Progress shows
  the wait; a mid-wait page blocker (usage limit etc.) still fails fast.
  Verified against a genuine in-flight generation.

### Fixed
- `--project-new` aborted right after creating the project: the create-modal's
  closing overlay transiently covered the model selector, and a single
  hover-verify refusal failed the whole send. The selector click now retries
  briefly with fresh coordinates on a transient refusal (persistent covers
  still fail). Verified live end to end: create, select, send, and the thread
  URL carries the new project's slug.

### Tests
- In-page menu match predicate pinned in parity with menuItemLabelMatches
  across the full label matrix (badges, cross-match refusals, Korean labels).
- True key rotation pinned: receipts written after rotate verify under the new
  key alone; pre-rotation receipts do not.

## [0.16.12] - 2026-07-13

Project management usability: stop guessing names, notice wrong landings.

### Added
- `prodex pro browser projects` - read-only list of the sidebar project names
  exactly as ChatGPT renders them, so `--project` / `setup --project` never
  have to guess spelling or case. Polls briefly for sidebar hydration; failures
  carry port-aware guidance like `models`.
- `project_landing_warning`: when a project was requested but the answered
  thread's URL is a root `/c/` thread (in-project threads carry
  `/g/g-p-<project>/c/`), the send now warns on stderr and in the recorded
  result instead of leaving the mis-landing to a manual sidebar audit.

### Changed
- The `--project` not-found error now points at `prodex pro browser projects`.

## [0.16.11] - 2026-07-13

### Fixed
- `--new-chat --project` silently created the thread at ROOT instead of inside
  the project: the root new-chat navigation left the SPA composer bound to the
  root conversation target even after entering the project. When a project is
  requested, the root navigation is now skipped - the project home the
  selection step opens IS the fresh composer for "a new chat in this project".
  Verified live: the thread URL now carries the project slug
  (`/g/g-p-<project>/c/<thread>`), where broken runs produced a bare
  `/c/<thread>` root URL. Plain `--new-chat` (no project) is unchanged.

## [0.16.10] - 2026-07-13

### Fixed
- `--new-chat --project` failed with "project not found in sidebar (0 projects
  visible)": right after the new-chat navigation the sidebar's Projects section
  has not hydrated yet, and project selection checked it exactly once. The
  project row is now polled (up to 6s) - the same race class as the
  model-selector button after new-chat (0.15.7). Reproduced and verified live
  with the failing combination.

## [0.16.9] - 2026-07-13

### Fixed
- `--project` matching now falls back to a case-insensitive match when the
  exact name is not in the sidebar (an agent asking for "codex" resolves the
  sidebar's "Codex" when unambiguous; multiple case-insensitive matches fail
  loudly instead of guessing). The not-found error also says how matching
  works and how many projects were visible, without listing their names
  (sidebar project names are personal context and error text is persisted).

## [0.16.8] - 2026-07-13

Field report: a harness consult meant for GPT Pro silently ran on the
medium-effort thinking model, because the 2026-07 ChatGPT update reset the
UI's selected model and nothing pinned one.

### Fixed
- A send with NO model selection at all (no per-ask flag, no saved default)
  now emits and records `model_selection_warning`, naming the fix
  (`prodex setup --model Pro` or --model/--effort) - it previously used
  whatever the ChatGPT UI last had selected without any indication.
- Re-running `prodex setup` only to change browser-send defaults (e.g.
  `setup --model Pro`) no longer rotates the MCP token - rotation would
  silently 401 every client holding the old URL. The token now rotates only
  when explicitly requested via `--token` or `--token-ttl-hours`.

## [0.16.7] - 2026-07-13

Fixes from an xhigh multi-agent review of the 0.16.4-0.16.6 firefight range
(15 verified findings).

### Fixed
- `--project`: a stalled cross-project navigation could be silently accepted
  while the tab was still inside the OLD project (any `/g/g-p-` URL passed the
  already-inside check), sending the prompt into the wrong project. The
  unchanged-URL acceptance now also requires the REQUESTED project's name in
  the page title or heading (both carry it, measured live).
- Dialog auto-dismiss safety: Escape is no longer sent when the open dialog is
  itself the evidence of a real blocker (usage limit, verification, captcha) -
  the precise blocker is reported instead; a websocket failure during the
  dismiss no longer aborts the flow (connect is inside the best-effort guard);
  only a VISIBLE dialog is sampled; and when Escape cannot close the dialog,
  the not-ready error now names the dialog instead of suggesting a re-login.
- `--pro-mode` guidance: no longer swallows the real reason (a Plus plan with
  no Pro entry now says "Pro option not found" instead of claiming the UI
  removed sub-modes), and names `prodex setup --clear-pro-mode` for users whose
  saved default injects pro_mode into every plain ask. The submenu-model
  rejection text also stopped recommending the removed --pro-mode.
- `pro browser models`: a flag-validation error (e.g. `--timeout-ms abc`) is a
  plain usage error again instead of being dressed as a browser blocker, and
  port-aware guidance now reflects the resolved port (PRODEX_CDP_PORT
  included), not just the raw --port flag.
- `pro browser check`: an invalid PRODEX_CDP_PORT/--port/--timeout-ms is
  reported as the config/usage error it is (not "check failed"); a probe
  failure no longer skips the independent latest_pro section; and the
  check-failed next step is rewritten port/source-cli-aware like every other
  next step.

## [0.16.6] - 2026-07-10

### Fixed
- A retried `repo_write_file_apply` after a successful apply now says the write
  "was already applied" instead of the generic "File preimage changed" - a
  client retry after a lost response can tell "already done" from a real
  concurrent-modification conflict.
- `pro browser models --port <custom>` failures now suggest the login command
  with that port instead of the default-port command that would not fix the
  setup.
- `pro browser check` reports a failing in-page probe as a check failure with a
  next step (like doctor) instead of crashing with an internal
  "Runtime.evaluate failed".

### Tests
- The in-page answer extractor (`answerExpression`) is now behaviorally tested
  against a fake DOM (message counts, last-assistant answer, thinking
  placeholder, empty-message and no-message fallbacks) - previously the send
  loop's only data producer had no test.
- Added the fresh-preimage bypass test: an apply whose preimage matches the
  concurrently-changed file but not the reviewed receipt is rejected.

## [0.16.5] - 2026-07-10

More 2026-07 ChatGPT update compatibility, found by live-sweeping the
remaining selection paths.

### Fixed
- `--project` selection: the update made the sidebar project row a plain list
  item (no longer a link), so clicking it never navigated. Navigation now uses
  the row's "Open project home" button (verified live from both outside and
  inside the project), with the old row click kept as a fallback. An unchanged
  URL is also accepted when the tab is already on the project's home instead
  of failing with "did not navigate".
- `--pro-mode`: the update removed the Pro sub-mode submenu from the model
  picker entirely (verified live, including on hover) - Pro is a single mode
  now. The flag now fails with guidance to use `--model Pro` instead of a bare
  "expander not found".

## [0.16.4] - 2026-07-10

Compatibility with the 2026-07 ChatGPT web update (measured live).

### Fixed
- Model/effort menu matching survives label badges: the update renders a
  version chip next to a label (e.g. "Instant" + a "5.5" chip), which
  concatenates in textContent ("Instant5.5") and broke both exact and
  first-line matching. Menu predicates (and the Pro radio finder, the
  "available" error listing, and `pro browser models` output) now read
  innerText - where the badge stays on its own line - so the existing
  first-line tolerant match handles it. Verified live: `--effort 즉시`
  selects Instant and answers on the new UI.
- The update ships a "ChatGPT for Work" onboarding modal that puts the app
  behind aria-hidden, hiding the composer and the logged-in signals, so every
  send/models run reported "not ready". The page-settle path now detects an
  open dialog blocking the composer and dismisses it with Escape (bounded,
  only when the composer is actually blocked). Verified live.

### Fixed (release tooling)
- npm 12 changed `npm pack --json` from an array to an object keyed by package
  name, which broke `release pack`/`release status` (and the publish
  workflow's verification, which installs npm@latest). All pack-output parsing
  now accepts both shapes. Release verification failures also print a tail of
  the captured output instead of hiding the real error behind npm warnings.

### Changed
- Refreshed stale model-name examples in help text (GPT-5.5 -> GPT-5.6 Sol).

## [0.16.3] - 2026-07-08

Fixes from a second multi-angle audit (docs, dependencies/packaging, error-UX,
test coverage, MCP protocol, browser/CDP lifecycle).

### Fixed
- `prodex pro browser login` no longer opens a second Chrome window when the
  dedicated browser is already running: it detects the reachable instance and
  reuses it (Chrome's singleton otherwise honored `--new-window` and spawned a
  duplicate, which then blocked sends as `ambiguous_chatgpt_tabs`). This is the
  recurring "extra windows" problem.
- The MCP stdio transport no longer tears down the whole session on a single
  malformed frame - it reports the parse error and keeps processing the rest of
  the buffer (matching the SDK), so a valid pipelined message after a bad one is
  still delivered. Oversize frames remain fatal.
- `ask` with no prompt now shows an example (and the `--stdin` pipe form)
  instead of a bare "requires a prompt".
- The HTTP MCP `401` now returns a `hint` explaining how to authorize (no
  token-specific detail leaked).

### Changed
- The published package no longer ships source maps or `.d.ts` declarations
  (the package is bin-only, so they were dead weight) - roughly halves the
  unpacked install size.
- Documented `sessions cancel` in the top-level `--help`.

### Tests
- Added the previously-missing security reject-path tests: a wrong HTTP token
  (URL and bearer) returns 401, and a receipt whose signed body is tampered
  while the key is intact is rejected as untrusted.

## [0.16.2] - 2026-07-08

### Changed
- `bridge_list_results` / `listFinalizedResultsReadOnly` now reads the receipts
  directory once and indexes completion receipts by task id, instead of
  re-reading and re-parsing every receipt for each result (was O(results x
  receipts) on the list/completion path). Trust behavior is unchanged.
- Documented existing but previously unlisted flags: `tasks create --repo-id`
  / `--file` and `tasks block --command`.

## [0.16.1] - 2026-07-08

Second pass of the multi-angle audit backlog.

### Fixed
- An assistant message that posted with empty text (image-only reply, tool
  card, or a render-lag frame) no longer causes the send to return page chrome
  (sidebar + echoed prompt) as the "answer" - the page-tail fallback now applies
  only when there is no assistant message at all.
- Receipt integrity-key initialization is now exclusive-create: if two processes
  race to create it, the loser adopts the winner's key instead of clobbering it
  (a clobber would silently untrust every receipt already signed with the
  overwritten key).
- The CDP client now keeps a persistent websocket "error" listener, so a second
  post-open socket error can no longer surface as an unhandled event and crash
  the process.
- `prodex pro ask` (a dry-run preview) now rejects send-only flags (`--model`,
  `--effort`, `--port`, `--target-url`, `--project`, `--new-chat`, ...) with
  guidance to `pro browser ask`, instead of silently accepting and ignoring
  them (their values were not even validated).
- `prodex pro debate-prompt` no longer accepts a meaningless `--cwd` (it prints
  a prompt and never touches the ledger).

## [0.16.0] - 2026-07-08

Fixes from a multi-angle audit (concurrency, resource/error paths, security,
answer-extraction, CLI).

### Fixed
- The in-page "still generating" placeholder test over-matched any answer
  starting with "Thinking"/"Thought for"/"Thought about" (the twin of the
  0.15.7 `isUsableChatGptAnswer` fix, left behind in the page expressions). A
  real answer beginning with those words could cause a false "response in
  progress" send refusal or a false timeout with a bogus truncation warning.
  Both expressions now share one snippet kept in sync with the TS check.
- A crashed claim holder left a `.<task>.claim.lock` that nothing cleaned up,
  permanently wedging all future claims of that task. A lock older than the
  claim window (60s) is now reaped and the claim retried.
- The MCP stdio `send()` could hang forever (and leak a `drain` listener) if the
  reader died while the ~100KB write was backpressured; it now also settles on
  the stream's `error`/`close`.
- The answer acceptance/stability poll loops aborted the whole send on a
  transient CDP evaluate failure, discarding an already-streamed partial answer
  and skipping the salvage path; transient failures now retry.
- `--pro-mode` combined with a non-Pro `--model` was silently dropped; it now
  fails with a clear message.

### Security
- The ChatGPT conversation URL and project name no longer cross the MCP boundary
  via receipts (`metadata.thread`) or tasks (`provenance.thread`/`project`) -
  they are now redacted the same way sessions already were.

## [0.15.8] - 2026-07-08

### Added
- `prodex sessions cancel <session-id|latest>` marks a session blocked - clears a
  session left stuck in "running"/"preview" by an interrupted send (UX audit F15).
- `--json` on `tasks list`, `receipts list`, and `sessions list` emits the full
  records as JSON (empty list is a valid `[]`) for scripting (UX audit F6/F7).

## [0.15.7] - 2026-07-08

### Fixed
- Model/reasoning selection right after `--new-chat` intermittently failed with
  "model selector button not found": the selector lives in the composer form,
  which has not finished rendering immediately after the new-chat navigation.
  The selector button is now polled (up to 4s) instead of checked once
  (verified live: `--new-chat --effort High` now selects and answers). Found
  during live verification of this release.

### Changed
- Model/reasoning menu items are matched tolerantly - exact text OR first line -
  so a description or badge rendered on a second line (e.g. "High\nBalanced
  speed") no longer breaks selection. First-line (not prefix) matching still
  refuses to cross-match "High" with "Extra High" or "Pro" with "Pro Standard".
- `isUsableChatGptAnswer` no longer misclassifies a real answer that merely
  starts with "Thinking" (e.g. "Thinking about it, yes.") as a reasoning
  placeholder; only a single line that IS the reasoning header is treated as a
  placeholder.
- `init` reports ".bridge receipt ledger already initialized (no changes)." when
  re-run against an existing ledger instead of always claiming it initialized.

## [0.15.6] - 2026-07-08

### Changed
- Empty list commands now print a clear message instead of blank output:
  `tasks list`, `receipts list`, `sessions list`, and `pro list` say "No tasks
  yet." / "No receipts yet." / "No sessions yet." / "No GPT Pro consults yet."
  (with the status qualifier when `--status` is given), so a fresh or
  wrong-directory ledger is no longer indistinguishable from a crash.

## [0.15.5] - 2026-07-08

### Added
- `PRODEX_DEBUG_SEND=1` prints send diagnostics to stderr (baseline message
  counts, whether the prompt posted, and per-poll acceptance counts) for
  field-debugging send/acceptance issues. Off by default, no user-facing
  effect.

### Notes
- Follow-up on the 0.15.4 send fix: with the Enter-first submit, visible-browser
  sends are reliable under normal human-paced use (verified 6/6 at the default
  ~10s pacing). The residual failures seen during 0.15.4 debugging were
  reproduced only with pacing disabled (machine-speed back-to-back sends),
  which degrades the ChatGPT session - exactly what the built-in send pacing
  (`PRODEX_MIN_SEND_INTERVAL_MS`, default 10s) exists to prevent. Not a code
  defect.

## [0.15.4] - 2026-07-08

### Fixed
- Intermittent "ChatGPT never registered the prompt" failures, root-caused with
  live instrumentation to two issues in the send path:
  - The composer clear used an in-page Selection API select-all +
    `execCommand("delete")`, which desyncs ProseMirror's internal state so the
    prompt shows and the send button enables but a click never submits
    (confirmed with an A/B repro). prepare now only focuses; leftover text is
    cleared submit-safely via native CDP keyboard events (Ctrl+A, Backspace).
  - Submit is now sent with the Enter key (which targets the focused composer
    and is coordinate-free) instead of a click at captured coordinates. After
    the prompt lands the composer grows and the send button moves ~100px, so a
    click at the captured position missed the button entirely (measured live:
    captured y=583 while the button had moved to y=693). Clicking the send
    button, re-reading fresh coordinates and verifying the post each attempt,
    remains as a fallback for configs where Enter inserts a newline.

## [0.15.3] - 2026-07-08

### Fixed
- `--new-chat` no longer risks a false "ChatGPT never registered the prompt"
  timeout on a slow navigation. It previously navigated to a fresh chat then
  waited a fixed 1.5s; if the old thread was still rendered when the answer-
  count baseline was captured, acceptance (which needs the fresh thread's
  lower counts to exceed the old counts) could never trigger. It now waits for
  the tab to actually reach the fresh empty chat (root URL, zero messages)
  before baselining (`isFreshChatGptPage` / condition-based wait).
- Submit is now polled for up to 2s instead of a single check after a fixed
  300ms sleep. The send button reliably appears within ~200ms of the prompt
  landing (measured live), but a slow render moment could leave it briefly
  absent, and a single miss fell back to Enter and risked the prompt never
  posting.

## [0.15.2] - 2026-07-07

### Fixed
- Streaming detection no longer relies only on the stop-button's label text.
  During generation ChatGPT's send control becomes an icon-only stop button
  (`data-testid="stop-button"`) and the active assistant message carries
  `aria-busy="true"` (both measured live); the previous label regex could miss
  an icon-only/relabeled control and accept a mid-stream pause as the final
  answer, silently truncating it. `generating` now also checks these
  structural signals. Live-verified: a 40-line answer streams as `generating`
  and is captured complete.

## [0.15.1] - 2026-07-07

### Fixed
- Regression from 0.15.0: excluding the sidebar `nav` from the blocker-text
  scan also stripped it from the login/status text and button signals, so a
  logged-in Pro session was misdetected as "missing a clear logged-in ChatGPT
  session" and every send was falsely blocked (the logged-in signals - "New
  chat", "Projects", the profile button, the plan hint - live in the sidebar).
  Blocker detection and login detection now use separate text samples: blocker
  scanning stays nav-excluded (a sidebar chat title still cannot fake a
  blocker), while login/status detection keeps the sidebar. Live-verified: a
  real send that failed under 0.15.0 succeeds again.

## [0.15.0] - 2026-07-07

### Security
- Secret-file blocklist: the service-account guard was anchored
  (`^service-account.json$`) and trivially bypassed by any prefix - Firebase's
  `serviceAccountKey.json`, `<name>-service-account.json`, and
  `firebase-adminsdk-*.json` were readable/searchable through the ChatGPT HTTP
  MCP tools. It now blocks any filename containing service-account / adminsdk
  with a data extension, plus `secrets.{json,yaml,...}`, `.p8`, `.ovpn`, and
  `.tfvars`. Source modules (`secrets.ts`, `service-account.ts`,
  `credentials.ts`) stay readable. Found by a security audit with live PoCs.
- The `bridge_get_session` / `bridge_list_sessions` MCP tools no longer return
  the ChatGPT project name or thread URL - the same personal context receipts
  already redact - so a client on the semi-trusted HTTP MCP surface cannot
  enumerate them. The raw session file keeps them for local CLI inspection.

### Fixed
- Blocker detection no longer scans the ChatGPT sidebar: a past-chat title like
  "usage limit reset" or "verify human" in the history list used to match the
  blocker patterns and abort an otherwise valid send on every poll. The runtime
  blocker-text scan now excludes `nav`/`aside`/navigation (verified live: chat
  titles live inside the sidebar `<nav>`).
- Composer insertion now verifies the composer holds exactly the prompt
  (whitespace-normalized), not merely that it is non-empty. A failed clear that
  left stale text would otherwise silently submit a contaminated prompt.
- Concurrent `claimTask` calls can no longer both succeed: the claim is
  serialized behind an O_EXCL lock file, so a multi-agent bridge gets exactly
  one winner instead of a silent double-claim.
- `connectCdp` guards the message-listener `JSON.parse` (a malformed/binary
  frame is dropped instead of throwing uncaught) and fails fast if the socket
  closes during connect instead of waiting the full timeout.

### Changed
- UX polish from a breadth audit: `prodex ask` typos now suggest `ask` (it was
  missing from the suggestion table); `pro --help` lists `debate-prompt`;
  `--effort`/`--pro-mode` errors include the English aliases; and `pro ask`
  validation errors say `pro ask`, not the internal `ask-pro`.

## [0.14.0] - 2026-07-07

### Fixed
- Auto-recovery now relaunches the profile you last logged in with, not the
  fixed default. `pro browser login` records its profile dir + port
  (`~/.local/share/prodex/last-login.json`, `PRODEX_LAST_LOGIN_FILE` override),
  and `ask` recovery reads it back - a custom-profile user could otherwise be
  silently sent to a different account (or wait 2 minutes on a logged-out
  default profile). Found by an adversarial audit.
- `--json` now stays valid JSON on the blocked path: a login/captcha/limit/
  timeout blocker prints `{status:"blocked", blocker:{...}}` to stdout (the
  human error still goes to stderr), so a script can branch on the case it
  most needs to. Previously only the `done` path was JSON.
- `--new-chat` no longer silently enters a persisted default project; a fresh
  root chat is used (an explicit `--project` still wins). The pointless
  double navigation (root, then into the project) is gone.

### Changed
- Bridge registry hardening (on top of the 0.11.1 concurrency fix):
  roots are canonicalized with `realpath` so one bridge has one entry even
  via symlinked/relative spellings; roots whose directory no longer exists
  are pruned when a new root is registered; total entries are capped at 2000
  (newest kept). Registry work remains fully best-effort.

## [0.13.0] - 2026-07-07

### Added
- One-command recovery: when `prodex ask` / `pro browser ask` fails because no
  browser is running (`browser_unreachable`), an interactive terminal now
  launches the dedicated browser, waits until the saved session is READY, and
  retries the send once - no separate `pro browser login` step. `--auto-login`
  forces it for scripts, `--no-auto-login` disables it, and non-interactive
  runs stay off by default so a window never pops up unattended. Only
  `browser_unreachable` triggers recovery; every other blocker (login, captcha,
  usage limit, ...) reports as before. Live-verified: with the browser killed,
  a single `ask --auto-login` relaunched it, reached READY in 7s on the saved
  session, and returned the answer.

### Changed
- Terminal interactivity is now threaded through `CliIO.isInteractive`
  (defaults to `process.stdout.isTTY`) instead of read directly, so guided
  login and auto-recovery gate deterministically.

## [0.12.0] - 2026-07-07

### Added
- Pipe input into asks: `git diff | prodex ask --stdin "Review this diff"`
  appends piped stdin to the prompt (guarded: errors when nothing was piped
  or input exceeds 200k chars). Live-verified with a real diff summarized
  correctly through the browser.
- `--json` on visible-browser asks prints one structured object (task_id,
  status, thread, answer, warnings) to stdout instead of the tab header
  format, for script consumers; progress and the saved-artifact footer stay
  on stderr. Rejected on the dry-run preview path.
- `onboard` now opens with the standalone terminal flow (guided login,
  `ask --new-chat`, re-print), then the agent MCP section (including
  pro_consult and `pro debate-prompt`), then bridge health, then the
  ChatGPT Project HTTP MCP - matching the README narrative instead of the
  old bridge-first ordering.

### Fixed
- `pro browser ask` validation errors now name `pro browser ask` instead of
  the internal `ask-pro`; the `prodex ask` alias maps both spellings to
  `ask` (including the dry-run guidance sentence).

## [0.11.1] - 2026-07-07

### Fixed
- Bridge registry: concurrent registrations can no longer lose a root. Writes
  from one process are serialized, and a bounded verify-retry re-merges after
  a cross-process rename race (the registry also still self-heals on every
  later `ensure()`). Found by an adversarial audit (30 concurrent first
  registrations used to record 1).

## [0.11.0] - 2026-07-07

### Added
- Machine-wide bridge registry: every `BridgeStore.ensure()` records its
  bridge root in `~/.local/share/prodex/bridges.json` (absolute paths only -
  no task contents, no secrets), so local indexers can find scattered
  per-repo `.bridge` directories from one well-known file. The first
  consumer is sessionwiki's prodex adapter, which turns every bridge task
  (prompt + answer) into a searchable session. Best-effort by design: a
  registry failure never breaks a bridge operation; a corrupt registry is
  rebuilt; writes are atomic. `PRODEX_BRIDGES_REGISTRY` overrides the
  location (used by the hermetic test setup).

## [0.10.0] - 2026-07-07

### Added
- `--new-chat` for `prodex ask` / `pro browser ask` and `new_chat` for the
  `pro_consult` MCP tool: navigate to a fresh chat before sending. Long
  accumulated threads eventually break prompt-acceptance detection (measured
  live during a debate run), so agent loops and repeated consults should send
  each ask into a fresh chat. Incompatible with `--target-url`. Live-verified:
  a send parked on a polluted 11-message thread escaped to a new thread.
- `prodex pro debate-prompt [--topic "..."] [--rounds N]`: prints a
  paste-into-agent orchestration prompt for a structured debate between the
  agent (Claude/Codex) and the user's ChatGPT Pro via `pro_consult` - one
  self-contained consult per round, `new_chat: true` + `timeout_ms: 240000`
  reliability guidance baked in, blocked-consult retry loops forbidden, and a
  final synthesis that cites each round's receipt task_id. Rounds are capped
  at 5 to keep Pro usage low-volume. Validated live with a two-round debate.

## [0.9.1] - 2026-07-06

### Fixed
- Truncated Pro answers are no longer silent at runtime: `answer_incomplete`
  (and any other send warnings) now print to stderr and reach the MCP
  `pro_consult` notes, instead of living only inside the persisted receipt.
  An adversarial review found an agent calling `pro_consult` with a short
  `timeout_ms` would receive a cut-off answer marked `status:"done"` with no
  truncation signal.
- The Windows-host browser fallback under WSL keyed only on
  `WSL_DISTRO_NAME`, which real WSL non-login shells do not export (measured
  live), so it never activated where it mattered. Detection now also accepts
  `WSL_INTEROP` and a `/proc/version` kernel probe.
- The `prodex ask` alias no longer leaks the internal `ask-pro` command name
  in validation errors ("ask requires a prompt", not "ask-pro requires a
  prompt").
- The answer-stability caret guard now trims trailing whitespace before the
  suspect-tail check, so a streaming caret followed by a newline cannot slip
  through with only two confirmations.
- Millisecond flags (`--timeout-ms`, `--launch-timeout-ms`,
  `--wait-timeout-ms`) reject fractional values instead of silently treating
  `1.5` as 1.5ms; `--token-ttl-hours` keeps accepting fractions.

### Added
- `pro_consult` bridges send progress to MCP progress notifications when the
  client requests them (progressToken), so SDK-default clients that reset
  their request timeout on progress survive multi-minute consults. Verified
  end to end against a live browser through a real stdio MCP client.
- `pro browser check` echoes saved `browser_defaults` (model / pro-mode /
  effort / project) next to the live model hints.
- docs/clients.md: Codex needs `tool_timeout_sec` (its default tool timeout
  races prodex's Pro extended budget and it ignores progress notifications);
  Claude Code stdio needs no change (~28h default).

## [0.9.0] - 2026-07-06

### Added
- `prodex ask "..."` top-level shortcut for `prodex pro browser ask` with
  identical flags, and a restructured `--help` that opens with the flagship
  ask examples and groups commands into ask/consult, bridge ledger, agent/MCP
  integration, and maintenance sections.
- Live progress for visible-browser sends: connecting / tab ready / applying
  selection / prompt sent phases plus a throttled waiting heartbeat (elapsed
  seconds, generating|stabilizing) on stderr, so multi-minute Pro consults no
  longer look frozen. Applies to `pro browser ask` and `pro browser smoke`.
- Guided login: `pro browser login` in an interactive terminal now waits
  (default 5 minutes) until a logged-in ChatGPT tab with a visible composer is
  detected, narrating which manual step is still missing, and exits nonzero if
  readiness never arrives. `--wait` forces it for scripts, `--no-wait` skips,
  `--wait-timeout-ms` tunes the budget; non-TTY runs keep the old immediate
  return.
- `pro_consult` tool on the local stdio MCP server so Claude/Codex can ask
  ChatGPT directly through the same explicit visible-browser flow (pacing,
  receipts, artifacts identical to the CLI). The HTTP MCP surface never
  registers it, so nothing reachable through a tunnel or ChatGPT itself can
  drive the browser.
- `PRODEX_CDP_PORT` environment override for the DevTools port (explicit
  --port still wins), replacing ten scattered hardcoded 9333 fallbacks.
- Browser discovery now also probes macOS app bundles, Windows Program
  Files/LOCALAPPDATA installs, and Windows-host browsers under WSL; on Linux
  shells without DISPLAY/WAYLAND_DISPLAY, a present WSLg X socket injects
  DISPLAY=:0 so the browser launch does not die instantly in WSL.
- `doctor` reports an informational `chatgpt:` line (ok / not connected /
  partial with blocker code), so an all-green doctor no longer hides a missing
  browser setup; the line never fails doctor.

### Fixed
- Short answers no longer capture ChatGPT's streaming caret: the current UI
  renders the caret as a literal trailing underscore in the message text, and
  it can outlive the stop button, so a fast answer could be recorded as
  "TOKEN_" instead of "TOKEN" (measured live). Caret-suspect tails now require
  extra stable polls, converging on the finalized text; answers that genuinely
  end with an underscore are still accepted after the extra wait.

### Changed
- After a successful ask, a stderr footer names the saved artifact path and
  the `pro latest` re-print command. `send_timeout` blockers now suggest a
  paste-ready rerun command with a concrete doubled `--timeout-ms` value.
- README: the terminal quickstart uses `prodex ask` and documents the guided
  login and progress output; the MCP section is reframed as the optional
  "Agent Bridge Quick Start" instead of a second competing onboarding path.

## [0.8.3] - 2026-07-06

### Fixed
- Package `bin` path is now `dist/cli.js` (was `./dist/cli.js`). npm 11 rejects
  the `./` prefix and silently drops the bin entry on publish, which would ship
  a package with no `prodex` command. Older releases published under npm 10
  (which kept the `./` form) were unaffected, but the CI auto-publish uses the
  latest npm, so this is required for the tokenless release path. (0.8.2 was
  never published to npm — its CI publish surfaced this before it completed.)

## [0.8.2] - 2026-07-04

### Changed
- Releases now publish to npm from CI via npm trusted publishing (OIDC) with
  provenance, instead of a manually pasted token. A `v*.*.*` tag triggers
  `.github/workflows/publish.yml`, which verifies the tag matches
  `package.json`, runs `release:verify`, and runs
  `npm publish --provenance --access public`. No `NPM_TOKEN` is stored or
  exposed anywhere. One-time owner setup: add a GitHub Actions trusted
  publisher for this repo + `publish.yml` in the npmjs.com package settings,
  then revoke any old automation tokens.

## [0.8.1] - 2026-07-04

### Added
- Selector-rot diagnostic: when a send times out before the prompt ever posts
  (the composer still holds the text, or no send button was found), prodex now
  reports a `send_ui_changed` blocker — "the ChatGPT web UI may have changed" —
  with an update/report next step, instead of the misleading "raise
  --timeout-ms" latency message. The acceptance phase waits for the prompt to
  post, so a timeout there signals a broken submit (a UI change), not a slow
  model. A genuinely clean-but-slow submit still gets the timeout hint.

## [0.8.0] - 2026-07-03

### Fixed
- Restore visible-browser sends after a ChatGPT composer/editor change that
  had silently broken them. Three compounding causes, each fixed and
  live-verified end-to-end in a fresh chat:
  - Composer detection now requires real on-screen size (getBoundingClientRect
    width/height), so the hidden 0x0 fallback `<textarea>` that precedes the
    real ProseMirror editor is no longer picked (it had accepted a `.value`
    write as a false success while the real editor stayed empty).
  - The prompt is now typed with native CDP `Input.insertText` into the focused
    editor instead of in-page `execCommand`/value writes, which ProseMirror
    ignores for its internal model (so the send posted an empty message).
  - Submit performs a real CDP mouse click on the send button (from a fresh
    `getBoundingClientRect`) instead of a synthetic `button.click()`, which
    ChatGPT's React handler ignores; prepare no longer writes a marker
    attribute onto the composer form (that re-rendered/reset the editor).
- `connectCdp` now bounds every connect and command with a default 20s timeout
  even when the caller passes none, so a frozen/half-open browser socket makes
  the poll loop error out instead of hanging indefinitely.

## [0.7.4] - 2026-07-03

### Fixed
- Tighten the 0.7.3 secret-file blocklist to remove false positives found in an
  adversarial regression review: a directory or module named `credentials`/
  `service-account` (e.g. `credentials.ts`, `src/credentials/oauth.ts`,
  `service_account.py`) is no longer blocked — those names now require a
  data/config extension (`credentials.json`, `service-account.json` stay
  blocked). Secret extensions match only as the final extension, so
  `foo.key.ts` / `using.gpg.md` are allowed while `server.pem` / `tls.key`
  stay blocked; `.asc` (public GPG signatures / AsciiDoc) is no longer treated
  as secret; `*.tfstate.backup` remains blocked explicitly.

## [0.7.3] - 2026-07-03

### Fixed
- CI/release: `npm run build` now marks the packaged bin `dist/cli.js`
  executable (new `postbuild` step), so `release:check` and `npm publish` no
  longer need a manual `chmod +x`. This fixes the GitHub Actions
  release-verify job, which failed on every push with "package bin entries
  must be executable: dist/cli.js".
- Visible-browser sends that time out while the answer is still streaming now
  salvage the partial text and return it with an `answer_incomplete` warning
  instead of discarding minutes of Pro reasoning; the answer is saved as a
  normal done consult with the warning recorded on the receipt.

### Changed
- Timeouts now surface as a dedicated `send_timeout` blocker with a
  "raise --timeout-ms" next step instead of the generic `browser_send_failed`
  bucket, and the timeout error messages include the elapsed budget.

## [0.7.2] - 2026-07-03

### Security
- Broaden the repo tool sensitive-path blocklist beyond `.env`/`.git`/
  `.bridge`/`node_modules`/`dist` to cover common in-repo credential and key
  material — `.npmrc`, `.netrc`, `.pgpass`, `.git-credentials`, `id_rsa`/
  `id_ed25519` and friends, `*.pem`/`*.key`/`*.p12`/`*.pfx`/`*.jks`/`*.ppk`/
  `*.kdbx`, `*.tfstate`, `*.gpg`/`*.asc`, `credentials.*`, `service-account.*`,
  and the `.ssh`/`.aws`/`.gnupg`/`.gcloud`/`.azure`/`.kube`/`.docker`
  directories. Applies to `repo_read_file`, `repo_search` (path filter + rg
  excludes), and the `repo_write_file_*` flow, so a remote MCP caller can no
  longer read or overwrite these in-repo secret files. Traversal/symlink
  escape outside the repo was already blocked. Matching is conservative so
  ordinary files (e.g. `keyboard.ts`, `notes/secretsanta.md`) are unaffected;
  it is defense in depth, not an exhaustive secret scanner. README wording
  corrected accordingly.

## [0.7.1] - 2026-07-03

### Changed
- Tab activation is now opt-in (`PRODEX_ACTIVATE_TAB=1`) instead of on by
  default. Bringing the window to the front steals OS focus, which disrupts
  background/agent-loop use; since a non-minimized window (even behind other
  windows) already counts as visible, the default now sends without touching
  window focus and reports the tab_not_visible blocker only when the window is
  minimized or on another tab. This matches how comparable bridges
  (browser-use, OpenCLI) avoid moving the user's visible window.

## [0.7.0] - 2026-07-03

### Added
- Visible-browser sends now bring the ChatGPT tab to the front automatically
  (DevTools activate) before enforcing the visible-tab requirement, so a tab
  merely covered by another recovers instead of failing; a fully minimized
  window still stops with `tab_not_visible`.
- Human-pacing for visible-browser sends: consecutive sends are auto-throttled
  to one per `PRODEX_MIN_SEND_INTERVAL_MS` (default 10000 ms; `0` disables),
  tracked per repo in `.bridge/last-browser-send`, to keep an agent loop from
  hammering ChatGPT at machine speed.
- README: standalone "Pro second opinion" quickstart and an FAQ covering
  visibility, pacing, UI language, and account considerations.

### Changed
- Page status is now read with a short settle-and-retry so a transient SPA
  re-render right after a project hop is not misreported as "no composer".
- Answer completion now requires two consecutive stable, non-generating polls
  (was one), so a mid-stream pause is not mistaken for the final answer.

## [0.6.1] - 2026-07-03

### Changed
- Internal: second pass of the cli.ts decomposition. Command handlers move
  into cli-ledger.ts (tasks/results/receipts/sessions), cli-server.ts
  (init/setup/start/status/tunnel), and cli-pro.ts (pro/ask-pro/legacy
  chatgpt), with shared source-aware messaging in cli-shared.ts; cli.ts
  shrinks from ~4,100 to ~1,700 lines. No behavior change: help output
  verified byte-identical, full test suite and package smoke green.

## [0.6.0] - 2026-07-03

### Added
- English (US) ChatGPT UI support for the selection flags: efforts, Pro
  sub-modes, project rows, and the new-project button match both locales'
  labels (Instant/Medium/High/Extra High, Pro Standard/Extended, "Open
  project options for", "New project"), captured and verified live.
  `parseReasoningEffort` also accepts the English menu labels as input.

### Changed
- Internal: cli.ts split into cli-args.ts (argument parsing) and
  cli-help.ts (help text, CLI version); no behavior change, help output
  verified byte-identical.
- Model-prefixed English thinking placeholders are treated as still
  generating, matching the Korean behavior.

## [0.5.0] - 2026-07-03

### Added
- `--project-new "name"` creates a ChatGPT project from the sidebar popover
  (name typed, committed with Enter, navigation verified) and sends inside it.
  It cannot be combined with `--target-url` and never comes from saved
  defaults.
- `setup --interactive`: a short wizard that collects the browser-send
  defaults (model, Pro sub-mode or effort, project) instead of flags.
- `receipts rotate-key`: rotates the local receipt-integrity HMAC key. The key
  file now holds one key per line — the first signs new receipts, the rest are
  kept so receipts signed before a rotation still verify.

### Changed
- Non-Korean ChatGPT UIs get a documented escape hatch: `--model "<exact
  label>"` clicks any radio entry in the picker, and the composer-button
  detection now also excludes common English control labels.

## [0.4.0] - 2026-07-02

### Added
- `pro browser models`: read-only listing of the model menu options the visible
  ChatGPT tab currently shows (opens the menu, reads labels, presses Escape).
- `setup --clear-model / --clear-pro-mode / --clear-effort / --clear-project`
  to remove individual saved browser-send defaults.
- `status` output now includes `browser_defaults`.

### Changed
- `--pro-mode 확장` raises the default send timeout from 90000 ms to 300000 ms
  (an explicit `--timeout-ms` still wins).
- Selection clicks are now guarded: targets are scrolled into view and refused
  when covered by another element, menu open/close is polled instead of fixed
  sleeps, and a menu that stays open after a pick is treated as a failed
  selection. On any selection error the menu is closed with Escape before the
  blocker is reported.
- Selecting a model whose menu entry opens a submenu of variants (for example
  GPT-5.5) now fails fast with a clear error instead of silently keeping the
  previous model.
- `--project` now verifies that the sidebar click actually navigated and that
  the composer is ready before sending.
- Receipt display output (`receipts list/show`, MCP receipt tools) redacts the
  ChatGPT project name from `metadata.selection`; the raw receipt file keeps it
  for local inspection.

### Fixed
- `--target-url --confirm-target` can no longer be combined with `--project`,
  which could navigate away from the confirmed tab after the check; a saved
  default project is likewise ignored when `--target-url` is used.
- The Pro radio is matched by prefix: its visible label carries the active
  sub-mode (for example "Pro 확장"), which broke exact-text matching for
  `--pro-mode` and `--model Pro` whenever a sub-mode was already selected.
- Model-prefixed thinking placeholders (for example "Pro 생각 중") are no
  longer accepted as the final answer; the poll keeps waiting for the real
  response.

## [0.3.0] - 2026-07-02

### Added
- Model, reasoning-effort, and project selection for visible-browser sends:
  `pro browser ask --model / --pro-mode 기본|확장 / --effort 즉시|중간|높음|"매우 높음" /
  --project "name"` (English effort aliases instant/medium/high/max).
- `setup --model/--pro-mode/--effort/--project` persists browser-send defaults
  in `.bridge/config.local.json` (`browser_defaults`); per-ask flags override
  them.
- Applied selections are recorded on the consult receipt
  (`metadata.selection`).
- `--project-new` is reserved and fails fast until new-project automation is
  verified live.

### Fixed
- Pro sub-mode selection uses the chevron expander next to the Pro radio
  (clicking the Pro radio itself commits Pro and closes the menu).
- `repo_search` resolves ripgrep via absolute-path fallbacks when the MCP
  server is spawned with a narrowed PATH.

## [0.2.0] - 2026-07-01

### Added
- Initial public release as `@youdie006/prodex`: local CLI + MCP bridge
  (stdio and loopback HTTP) that coordinates coding agents with a logged-in
  ChatGPT Pro browser session over raw CDP, with HMAC-signed durable receipts
  under `.bridge/`.
