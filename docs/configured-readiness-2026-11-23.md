# Configured Readiness Follow-up

## Report And Installed Scope

Report `9af78ec5` from the `harness_eg` Claude session names two host-CLI
consultations in the reporting repository. The exact durable records confirm:

| Task | Created, UTC | Persisted outcome |
| --- | --- | --- |
| `task_20260929_044703_gpt-pro-consult` | 2026-09-29 04:47:03 | `project_not_found`, zero visible projects, no send |
| `task_20260929_044753_gpt-pro-consult` | 2026-09-29 04:47:53 | `browser_send_failed`, model menu did not open |

The task and result records agree. Project names in persisted diagnostics are
redacted as `<project>`; this is not evidence of literal placeholder input.
No prompt or answer content was needed for this investigation. These are
September incidents, not new November reproductions.

At the November 23 investigation, the PATH host CLI was version **0.40.55**,
installed on November 19. Its built adapter SHA-256 was
`5697029696931259d5a0a380904fd675f4c22b9e2ccd6c3c5804a412e88fe60e` and its
CLI module SHA-256 was
`5f898a4032780a2587518368c8b9cde6cbf322f3c4da101b6844884f5dc7757d`.
The remote release line was **0.40.56**, commit
`182a7a5c74a38f849b632f6adf6b134f8f1936a0`.

The configured-selector check previously implemented in experimental commit
`77feb382930069cce2c29706cbb22b2f121925b8` was not an ancestor of current
`main`. The installed CLI and current release source still only echoed saved
defaults before declaring the browser ready from login/composer presence.
Neither contained `inspectConfiguredBrowserSelectors` or the
`browser_selectors` readiness output. The version number and a healthy
container therefore could not establish that the host CLI had this check.

After the bounded renderer recovery below, the installed 0.40.55 CLI's own
`pro browser check --timeout-ms 5000` exited 0 and printed `chatgpt: ok`, while
emitting no `browser_selectors` line. The reporting directory still had a
saved Pro model and a nonempty project. This confirms the missing diagnostic
contract in the current installation; it is not a replay of either failed
consult or proof that the current selectors themselves are broken.

## Correction Contract

The change is based on current `main` in a separate worktree, not a downgrade
to the experimental 0.40.18 tree. It brings the no-send configured-readiness
contract forward while retaining current send behavior and selectors:

- Resolve defaults from the same working directory as a send. A failed read
  is unknown configuration, not an empty selection.
- Acquire the shared browser-send lock without waiting. Recheck the live page,
  require an idle empty composer and no open overlays, and stop at blockers.
- Inspect configured model/effort controls and the exact project navigation
  control. Do not enter a project or create a conversation to diagnose it.
- Verify the original model/effort, conversation and menu restoration. Unknown
  controls, missing options, a busy lock or incomplete cleanup prevent success.
- Explicitly label checks without configured selectors `scope=session-only`.
  They are not model checks. No selector check proves the model that answered,
  a subsequent new-chat load or a per-request tool selection.

No prompt loop, authentication extraction, hidden endpoint, protective-measure
bypass, automatic browser launch or automatic login is introduced.

## Live Boundaries

The current host CDP endpoint was reachable, but its read-only status returned
`browser_tab_crashed`, with no usable composer or confirmed login. That was a
separate current blocker; it did not reproduce either September selector
failure and did not prove that the saved login expired.

A subsequent fail-fast shared-lock check confirmed the crash again. A bounded
operator recovery then required a fresh `Inspector.targetCrashed` event and
the same unique target ID, URL and loopback websocket before issuing exactly
one `Page.reload` at 05:15:06Z. At 05:15:08Z the same target and URL were
reachable, logged in and showing a usable composer with no blocker. The
operator exited 0, closed its CDP connection and released the lock. No prompt,
browser-process restart, profile copy or login window was involved. This
recovers the current renderer; it does not prove either historical consult
would now complete or change the response-model evidence requirement.

A single candidate CLI check completed at **05:25:34Z** with exit **1**:

- Base status before and after: reachable, logged in, composer available,
  no blocker, same conversation URL.
- Model menu: opened. Saved `Pro` effort: verified against the visible
  Instant/Medium/High/Extra High/Pro ladder; original setting restored.
- Project navigation control: **UNVERIFIED**, covered or unavailable. The
  command correctly printed `chatgpt: unverified`, not `chatgpt: ok`.
- Zero prompt submissions, navigation requests or browser launches.

Review of that result found that the candidate only hovered a project row
when the hidden button lacked a rectangle. Existing send code already handles
hover-only controls. The diagnostic now hovers the row first even when its
hidden button has geometry; a new regression failed before this correction
and passed after it. This is not a claim that the original September failures
had the same cause, or that the corrected project probe has passed live.

The final source also rejects a requested model/effort combination when only
a different model owns that effort step, and stops rather than answering a
JavaScript confirmation during inspection, status or visibility reads. Those
cases have mocked red/green regression evidence, not an account-backed rerun.
Independent review additionally reproduced `GPT-5` matching a `GPT-5.6 Pro`
button. The diagnostic now requires exact checked-model or slider evidence;
the shared send-time button matcher also rejects decimal version prefixes.
Both the helper and configured probe have a failing-before/passing-after test.
No second host-control attempt was made after the active computer-use routing
required a gated real-browser path. The host is a persistent signed-in Chrome
on Xvfb display `:99`, not a disposable test profile. No profile was copied and
no alternative driver was used to bypass that boundary.

The WSL/M3 browser containers are separate deployments. Their fresh MCP
read-only checks and container health from the preceding November status
inspection are not evidence that this host browser can send. No container
replacement or change to the operational private-display backend is part of
this source correction.

## Verification And Delivery

- Baseline: 62 configured-selector tests passed on the experimental source.
- Baseline: 40 current-main product-check, pinned-default, sidebar, model-trigger
  and slider-restoration tests passed in the isolated worktree.
- The help-example regression failed against the old 1.5-second example, then
  passed after requiring the 15-second configured-selector example. An earlier
  broad test-name filter selected a different passing help test and was not
  used as red-test evidence.
- PASS `npx vitest run tests/browser-selection-check.test.ts tests/cli-product-check.test.ts tests/sidebar-project-rows.test.ts tests/model-trigger-scope.test.ts tests/slider-restore.test.ts tests/pinned-default-check.test.ts tests/javascript-dialog.test.ts tests/cdp-port.test.ts`: 83 tests.
- PASS `npm run typecheck` and `npm run build`.
- PASS `npm test -- --reporter=dot` after the exact-model review correction:
  165 files, 2,038 tests passed,
  three platform-specific tests skipped. These are WSL/Linux results, not
  native Windows or macOS certification.
- An earlier full run before a build failed two package-bin tests because
  `dist/cli.js` was absent; building and rerunning the complete suite passed.
- The project-hover, model/effort-pair and JavaScript-confirmation tests were
  observed failing before their corresponding fixes. The first dialog fixture
  assertion produced an asynchronous rejection warning; the assertion was
  corrected and the red run repeated without an unhandled rejection.
- PASS `npm run smoke:package`: isolated tarball install, HTTP/stdio MCP,
  task/result/artifact/receipt flows, write guards and package boundaries.
  This installs only into a temporary consumer directory, not the host CLI.
- PASS after the review correction: `npx vitest run tests/browser-selection-check.test.ts tests/chatgpt-browser.test.ts tests/cli-product-check.test.ts`, 211 tests; typecheck, build and package smoke were rerun and passed as well.
- PASS `git diff --check`. Native CI and source-delivery status are recorded
  in the PR; no unexecuted platform is treated as passed.
- NOT PASSED: the single live candidate check exited 1 for the project
  control. The final corrected project probe and an actual consult response
  were not reverified on the account. There was no automatic resubmission.

Source delivery uses branch `fix/configured-browser-readiness`. No version
bump, release tag, npm publication or installation is implied by a pushed
source change. The PR records the final commit, test results and installation
boundary without credentials or private conversation URLs.

A later read-only PATH check during this work returned version **0.40.56**,
but its installed CLI module still lacked `browser_selectors`. That update
was not performed by this change and is not installation of this patch.

Attempts to notify the reporting Claude session and the separate repository
owner were **not delivered**: the harness retained the messages after failing
to find a live receiver. Retention is not receipt, and neither peer is claimed
to have accepted the correction or rerun a consult.
