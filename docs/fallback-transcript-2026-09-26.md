# Fallback transcript correction: 2026-09-26

## Observed failure

During the [Pro-assisted headless investigation](ozone-headless-trial-2026-09-26.md),
the operating WSL browser displayed our two-turn research conversation but had
zero `data-message-author-role` elements. The installed adapter read no messages
and treated the question's ordinary "captcha" text as a real page blocker.
This was a UI parsing failure, not evidence of a new Cloudflare challenge,
expired login or another session submitting a question.

The measured message nodes instead carried `data-content-search-unit-key`
values shaped as `fallback-turn-N:P:user` or `fallback-turn-N:P:assistant`.
An outer user bubble repeated the same key under a different attribute.
Assistant nodes contained a direct `H4.sr-only` role heading and a single DIV
body. No rendered `data-message-model-slug` attribute existed in that layout.

## Correction and safety

The parser recognizes only the measured numeric turn/position format and the
two explicit roles. It does not infer a transcript from arbitrary Markdown,
search results or analysis/progress units. Repeated wrapper attributes are not
counted twice. Coordinates must be safe integers and unique; role conflicts
and separate legacy/fallback message populations refuse answer selection.
When the latest fallback user has no assistant in the same turn, no earlier or
later unrelated response is substituted.

Message bodies and their controls are excluded from login/blocker detection.
Outside-message protective text and controls still block. The role heading is
removed only for the observed direct-child structure, not by stripping a text
prefix. A genuine answer beginning "ChatGPT said:" is preserved; unknown shapes
keep their content. Legacy transcript handling remains covered.

Exact request marker and complete prompt matching are unchanged. No automatic
resend, recovery, navigation, retry, security bypass or model inference is added.
Missing rendered model metadata stays unknown and cannot prove Pro operation.
Post-submit acknowledgment also uses this shared reader: a fallback-layout user
turn carrying the current marker now stops the send-button fallback loop. The
final answer still requires the existing complete-prompt/request validation.

## Verification

- RED: initial fallback tests and additional mixed-layout/ambiguity regressions
  failed before correction. A final real-page check exposed the accessibility
  heading; its new regression failed before the structural-body correction.
- PASS: `npx vitest run tests/chatgpt-browser.test.ts`, 176 tests before the
  final post-submit regression. Independent read-only review found no parser
  issue, then identified the legacy-only submission acknowledgment as a
  related integration risk; that path now uses the same strict reader.
- PASS: initial `npm test`, 1,874 passed / three skipped across 130 files.
- PASS: final `npm test`, 1,879 passed / three skipped across 131 files, zero
  failures (164 seconds), after acknowledgment and test-runner corrections.
- PASS: `npm run typecheck`, `npm run build`, and `git diff --check`.
- PASS: fresh built expressions evaluated in the existing WSL page, with zero
  navigation commands and zero prompts sent: composer present, login likely,
  no blocker, two users/two assistants, full last prompt and exact request
  marker matched, post-submit acknowledgment returned true, answer began with
  the expected research marker. Model slug
  was absent. The diagnostic recorded `proVerified:false` to mean unverified;
  the product CLI omits `pro_verified` when provenance is unknown, rather than
  asserting either a Pro success or a known non-Pro model.
- PASS: final focused regressions, `npx vitest run docs/experiments/ozone-2026-09-26/focus-results.test.mjs tests/chatgpt-browser.test.ts tests/browser-crash-recovery.test.ts`,
  196 tests across three files. This includes the posted-question acknowledgment
  and corrected Vitest discovery.

The live-read expression build's `dist/chatgpt-browser.js` SHA-256 was
`0696f84c82dd3e968719d13f84ef0d30d3c0baffc21941b919c472a58f39687b`.
Verified source commit: `1ad5a0e1acdb0b7b542e5712f11aae82511d0987`.

The read-only verifier initially passed a shell-escaped prompt incorrectly and
failed identity matching; corrected argument quoting passed with no parser or
browser change. This harness error did not authorize a resend. Earlier actual
Pro answers were independently verified in the host browser, not this new DOM.
Private conversation URLs, full prompts and answers remain outside this record.

The post-submit regression initially failed because the new expression was
absent. A first focused integration run then had 12 failures and five asynchronous
errors because two fake CDP dispatchers still recognized the old expression.
Their dispatch recognition was updated; the send fixture now actually evaluates
the acknowledgment against a fallback user node instead of returning true
unconditionally. No production timeout or identity assertion was relaxed.
The next complete run passed all 130 product test files but failed discovery
of the new research helper test: it used `node:test` inside a Vitest-discovered
file. That test now uses the repository's existing Vitest runner; no test was
excluded or assertion removed.

PASS: `npm run smoke:package` before the final acknowledgment edit, including
installed CLI, HTTP/stdio MCP flows, result integrity and normalized packaging.
The final acknowledgment change is covered by the subsequent build, live
read-only expression evaluation and full regression run; that package smoke
must not be represented as a second run after the final edit.

## Delivery boundary

This is a source-only update on `feat/headless-browser-compatibility`, published
through [PR 7](https://github.com/youdie006/prodex/pull/7). Package version remains
0.40.18. No release tag, npm publication or public container image is created.
The PR's verification comment records the pushed commit and checks. It must not
be described as an installed-runtime replacement or a headless Pro success.

Both existing container instances remained running/healthy with restart count
zero and unchanged IDs/images/start times:

| Target | Image | Started (UTC) |
| --- | --- | --- |
| WSL x64 | `sha256:a3d8998ebdcecba7e71661a4f31b4aef508402fa02bfb94bc19f7d2befe9eeba` | 2026-09-25T16:10:22.715590748Z |
| M3 Colima ARM64 | `sha256:ce4fc47726c5e3297353222a961d7dbbe379964462c5dd03694dfef95eac45d6` | 2026-09-25T16:13:09.605951542Z |

Healthy container status is not proof that the old parser handles this new UI.
The WSL parser correction was tested in memory without replacing its read-only
image or reloading shared MCP clients. M3 did not receive a new DOM/live-send
test. The already-attached host MCP remains 0.40.16; its version is distinct
from the 0.40.18 checkout and operating containers. No Codex/MCP restart,
visible login window, private-profile copy or service-mode migration occurred.
