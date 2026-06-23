# TODO

## Phase 0 - Project Setup

- [x] Create project folder.
- [x] Record goals, boundaries, and research.
- [x] Decide runtime and package manager.
- [ ] Initialize git repo if desired.

## Phase 1 - Local Consult

- [x] Build minimal CLI skeleton.
- [x] Add `ask-pro --dry-run`.
- [x] Add file bundling and prompt preview.
- [x] Add session/result logging under `.bridge/`.
- [x] Decide whether first backend is Oracle CLI, direct wrapper, or local browser control.

## Phase 2 - Task Bus

- [x] Define task/result JSON schemas.
- [x] Implement `tasks list`, `tasks claim`, `results show`.
- [x] Add receipt files for every consult and local action.
- [x] Add safe result artifact fetch for artifacts explicitly listed on result records.
- [x] Reject `.bridge` task/result/receipt ID traversal plus symlinked record files/storage directories.

## Phase 3 - Codex-First Consult

- [x] Add visible-browser blocker handling.
- [x] Keep `pro ask` as a dry-run/manual consult preview by default.
- [x] Add explicit one-shot Codex -> ChatGPT Pro browser consult path through `pro browser ask`.
- [x] Persist `pro browser ask` task/session records before send, record blocked consults on browser failure, and save successful answers as `.bridge` artifacts before result finalization.
- [x] Fix Korean ChatGPT UI detection and thinking-placeholder handling.
- [x] Add `pro list/latest/show` for Codex-first consult review.
- [x] Add friendly `pro browser login` onboarding flow.
- [x] Add `pro browser check` for local browser-adapter health checks.
- [x] Add `sessions list/show` for inspecting dry-run, running, done, and blocked consult sessions.
- [x] Add `doctor` for local bridge, MCP write/apply/stage, and HTTP MCP tool-catalog smoke checks.
- [x] Demote browser automation from the primary CLI path.
- [x] Add write tools only after dry-run and expected-head checks exist.
  - [x] `repo_write_file_dry_run`: create a diff receipt without modifying files.
  - [x] `repo_write_file_apply`: require path sandbox, expected git HEAD, prior diff receipt id, and preimage hash.
  - [x] `repo_stage_reviewed_paths`: only stage paths with matching reviewed receipts.
  - [x] Move write payloads from receipt metadata into `.bridge/artifacts` so receipts stay reviewable.

## Phase 4 - Optional Inbound MCP

- [x] Implement MCP server exposing task creation and result fetch.
- [x] Expose session list/fetch over stdio and HTTP MCP.
- [x] Add repo read/search with path sandbox.
- [x] Add Streamable HTTP MCP endpoint for ChatGPT Developer Mode-style clients.
- [x] Verify Streamable HTTP MCP tool catalog from `doctor`.
- [x] Add local setup/start/status commands and ignored `.bridge/config.local.json`.
- [x] Redact local MCP URL tokens by default; require `status --show-token` for paste-ready URL.
- [x] Add `status --show-token --url-only` for one-line MCP URL copy/paste.
- [x] Block `.bridge`, `.git`, `.env*`, build outputs, and oversized files from repo read/search tools.
- [x] Guard `.bridge` record reads/writes against traversal IDs, symlinked record files, and symlinked storage dirs.
- [x] Add package install smoke for packed tarball, installed bin, and stdio MCP catalog.
- [x] Extend package install smoke to cover installed HTTP setup/status/start onboarding.
- [x] Add optional HTTP MCP token TTL, status warnings, expired-token start/doctor failures, and request-time expiry enforcement.
- [x] Add dedicated ChatGPT Project HTTP MCP setup docs.
- [x] Add Project/thread target URL sends only after manual `--confirm-target` confirmation.
- [x] Add optional tunnel URL helper for remote ChatGPT clients with explicit short-lived-token guidance.

## Safety Checklist

- [x] No hidden ChatGPT endpoints.
- [x] No cookie/token extraction.
- [x] No captcha/rate-limit/Cloudflare bypass.
- [x] No scheduled loops.
- [x] No public account-sharing service.
- [x] Stop and report when ChatGPT asks for login, permission, captcha, or usage-limit handling.
