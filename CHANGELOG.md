# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
