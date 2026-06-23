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

## Phase 3 - Codex-First Consult

- [x] Add visible-browser blocker handling.
- [x] Add one-shot Codex -> ChatGPT Pro consult path through `ask-pro --send`.
- [x] Fix Korean ChatGPT UI detection and thinking-placeholder handling.
- [ ] Add write tools only after dry-run and expected-head checks exist.
  - [ ] `repo_write_file_dry_run`: create a diff receipt without modifying files.
  - [ ] `repo_write_file_apply`: require path sandbox, expected git HEAD, prior diff receipt id, and preimage hash.
  - [ ] `repo_stage_reviewed_paths`: only stage paths with matching reviewed receipts.

## Phase 4 - Optional Inbound MCP

- [x] Implement MCP server exposing task creation and result fetch.
- [x] Add repo read/search with path sandbox.
- [x] Add Streamable HTTP MCP endpoint for ChatGPT Developer Mode-style clients.
- [x] Add local setup/start/status commands and ignored `.bridge/config.local.json`.
- [ ] Add Project/thread selection only after manual confirmation.
- [ ] Add optional tunnel helper for remote ChatGPT clients only after local auth/token expiry warnings are implemented.

## Safety Checklist

- [x] No hidden ChatGPT endpoints.
- [x] No cookie/token extraction.
- [x] No captcha/rate-limit/Cloudflare bypass.
- [x] No scheduled loops.
- [x] No public account-sharing service.
- [x] Stop and report when ChatGPT asks for login, permission, captcha, or usage-limit handling.
