# Container repository search repair: 2026-11-12

`repo_search` in the connected WSL MCP session failed because the browser image
did not contain ripgrep. The host had `rg`, but the MCP server runs inside Docker.
The image now installs the runtime dependency and the account-free MCP smoke
checks both a matching search and a no-match search through separate clients.

## Source and installation

- Implementation: `e87f49f61cde728f856ca1daf6e5651a4730c0e9` on
  `fix/container-ripgrep-20261112`, based on `container/redesign-patches` at
  `41bebbe`. The container implementation is not present on `main`.
- Target: WSL Docker context `default`, service `prodex-browser-browser-1`.
- Version: `0.40.18` container branch, local image variant `ripgrep-20261112`.
- Installed image: `sha256:120e0fb120f93630d0ae438b6650ebbc408874038c119e82f15693cef7ce098f`.
- Previous image: `sha256:9171fbf313e0ed6b89f2ebf78083fb9ab4b744a52a87ae10ea618f46caa7eb27`.
- Rollback tag: `prodex-browser:rollback-pre-ripgrep-20261112`.
- Service started: `2026-11-12T05:38:04.423704745Z`.
- Publication channel: local WSL Docker installation. No npm release, image
  registry publication, release tag or GitHub Release. M3 was not deployed.

The normal Dockerfile rebuild installed ripgrep 13.0.0 and moved Debian's
Chromium patch version from `156.0.8078.47` to `156.0.8078.79`. The installed and
candidate `cli.js`, `chatgpt-browser.js` and `repo.js` hashes were identical.

## Deployment safeguards

The preflight acquired the process-shared browser send lock with a zero wait
budget, required logged-in readiness with no blocker, and used the existing
selector probe with an empty selection to require an empty composer and no open
menu or dialog. No model, project or effort was selected. The lock remained held
until the old container exited. Its dead owner was subsequently reaped through
the normal lock API; acquisition and release succeeded after installation.

The service was recreated once. A before/after comparison verified the same
nonroot user, hostname, environment, healthcheck, read-only root, dropped
capabilities, seccomp, no-new-privileges, tmpfs, resource limits, restart policy,
init setting, volume mount and loopback port binding. The existing
`prodex-browser_browser-home` volume remained at `/home/node`; saved login stayed
ready. No profile, cookie, token or conversation contents were copied or logged.

## Verification

- PASS: before the fix, the actual connected `prodex.repo_search` reproduced
  `ripgrep (rg) is required on PATH for repo_search`.
- PASS (expected failure): the updated `scripts/container-mcp-smoke.mjs`, mounted
  read-only into the old immutable image, exited 1 with that same missing-rg
  error. This confirms the regression check detects the packaging defect.
- PASS: `npm test -- tests/repo-rg.test.ts tests/repo-search-gaps.test.ts tests/container-browser-config.test.ts tests/container-client.test.ts`
  passed the 58-test baseline before edits.
- PASS: `npm run build`, `npm run typecheck`, and `npm test`: 176 files passed,
  2,268 tests passed, 3 skipped. Skipped tests are not counted as verification.
- PASS: `node scripts/release-check.mjs --metadata-only` and `git diff --check`.
- PASS: `docker --context default build --pull=false -f containers/browser/Dockerfile -t prodex-browser:ripgrep-20261112 .`.
- PASS: `scripts/container-mcp-smoke.mjs` inside the candidate image with network
  disabled, nonroot user, read-only root, dropped capabilities,
  no-new-privileges, private `/tmp` tmpfs and no account volume. Actual searches,
  task identity, exclusive claims, client disconnect and child cleanup passed;
  `browser_prompts_sent=0`.
- PASS: `node scripts/container-client.mjs --context default status` after
  replacement reported the exact installed image, `healthy`, `ready: true`,
  `blocker: null`.
- PASS: the same already-connected MCP session called `repo_search` after
  replacement without a client restart or MCP re-registration. The original
  no-match probe returned an empty result instead of the dependency error.
- PASS: an exclusively created synthetic file in the container bridge was
  found by `repo_search` at its exact second line and read by `repo_read_file`.
  After verifying its contents, only that owned file was removed; another search
  confirmed no matches. The positive-match/read checks were confined to that
  owned fixture; no existing user file was changed.

This verifies container repository tools and connection recovery. No ChatGPT
consult was submitted and no Pro answer was tested. Host repositories are still
not mounted into the container; these searches use its configured bridge root.
Git delivery and any CI outcome are recorded in the associated PR ledger.
