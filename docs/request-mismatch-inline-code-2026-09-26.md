# Inline-code request mismatch: 2026-09-26

## Incident And Evidence

Two manually requested `new_chat:true` consults stopped with `request_mismatch`.
The calling agent attributed this to competing sessions, but the blocker was
evidence of a failed identity check, not proof of concurrent browser activity.

Bounded investigation found the actual records in the WSL container's private
bridge, not the host bridge queried during the caller's recovery attempt:

| Record | Request prefix | Duration | Recorded result |
| --- | --- | --- | --- |
| `task_20260925_152519_gpt-pro-consult` | `b99b5d8d` | About 16 seconds | `request_mismatch`, no pinned thread |
| `task_20260925_153215_gpt-pro-consult` | `d86332e5` | About 9 seconds | `request_mismatch`, no pinned thread |

The two stored prompt bodies were identical. Thirteen container MCP processes
used the same home directory without a send-lock override. These were the only
two container tasks in the inspected 15:00-16:00 UTC interval. This does not rule
out every form of external browser activity, but does not establish contention.
The supported container publishes its viewer, not its loopback CDP endpoint;
host CLI status does not identify the container's current thread.

A read-only CDP evaluation of the currently open container chat found the second
request's exact marker in the latest user turn and a 3,814-character assistant
answer. The question was submitted. The installed matcher nevertheless returned
`false`: ChatGPT removed eight single-backtick delimiters from four inline-code
spans. Comparing the entire expected display text, including the original marker,
matched the DOM. No prompt/answer contents or private conversation URLs are
included in this public record.

The first chat was not reopened. Its identical stored prompt makes the same
rendering issue plausible, but its DOM was not independently verified.

## Fix And Guardrails

The adapter keeps strict full-prompt matching first. A fallback projects only
balanced single-backtick spans in the expected prompt to their displayed content.
The observed text is not broadly stripped of punctuation. Escaped literals,
multi-backtick spans, fenced code and unclosed fences are preserved.
Mixed single/multi-backtick lines are deliberately not projected; an unsupported
rendering on such a line still blocks rather than guessing.

The exact per-send marker check is unchanged. The complete projected prompt must
still match; marker-only acceptance, prefix-only matching, automatic resubmission,
automatic recovery and navigation over another session are not introduced.
Unknown formatting still fails closed. The blocker now explicitly says that a
failed verification does not by itself prove another session interfered.

Implementation sequence:

1. Reproduce the actual installed matcher failure without navigating or sending.
2. Add failing synthetic rendering regressions and preserve negative cases.
3. Add the narrow expected-display fallback and a full new-chat send-flow fixture.
4. Recheck the live DOM with old and built fixed matchers in memory.
5. Run focused/full tests, typecheck, build and independent review before push.

## Verification

- PASS: baseline browser, send-lock, CLI-send and MCP suites, 320 tests.
- RED: three rendering tests failed before the implementation, including the
  previously incorrect expectation that stripped inline-code delimiters must fail.
- RED: the new blocker-wording assertion failed before its message update.
- PASS: focused browser, send-lock, CLI-send, MCP and store suites, 379 tests.
- PASS: `npm run typecheck` and `npm run build`.
- PASS: actual second-request DOM, in one bounded read, produced
  `installedMatcher:false`, `fixedMatcher:true`, `requestMarkerPresent:true`,
  `answerCharacters:3814`, `browserNavigations:0`, `promptsSent:0`.
  The installed module SHA-256 was
  `d47d4cce3e990bdac729081a910b3562e6fe786d60d3b27fae6fe0b987c12897`;
  the built fixed module was
  `601b940f6479a3d93796663d7edc19a8b365416ebeb1555ce18cb653ff955de6`.
- PASS: `npm run smoke:package`, including the normalized installed package,
  HTTP/stdio MCP storage flows, artifact integrity checks and release-pack paths.
- PASS: independent read-only matcher review. Added root-navigation/baseline
  ordering assertions and explicit mixed-line fail-closed coverage in response.
- FAIL: first full `npm test` run, 1,852 passed / three skipped / one failed.
  The unrelated tiny-timeout real-socket test received the correctly conservative
  `browser_control_unavailable` outcome instead of the refusal it assumed.
  The fixture now injects both refusal and TCP timeout outcomes, preserving the
  separate real-socket test and all production classification behavior.
- FAIL: direct `node scripts/release-check.mjs --metadata-only` on the WSL
  Windows-mounted checkout reported executable file-mode mismatches. The
  normalized staging/install path in `npm run smoke:package` passed; direct
  publication from this mounted checkout is not certified.
- PASS: final `npm test -- --reporter=dot`, 1,854 passed / three platform
  exclusions across 130 passing files, zero failures (94 seconds).
- PASS: final `npm run typecheck`, `git diff --check`, and incident-record checks
  for ASCII, local links, changelog backlink and absence of private thread URLs.

Focused commands: `npm test -- tests/chatgpt-browser.test.ts tests/browser-send-lock.test.ts tests/cli-pro-browser-send.test.ts tests/mcp-consult.test.ts tests/store.test.ts`
and, after the probe fixture correction,
`npm test -- tests/browser-slow-vs-dead.test.ts tests/chatgpt-browser.test.ts`
(173 tests passed).

The offline fixtures cover changed/missing code content, changed prose, missing,
wrong and duplicate markers, unrelated replies, same-thread contamination,
stale new-chat DOM, literal backticks and fenced content. The new-chat integration
fixture returns the correctly correlated answer after inline-code rendering.
It is a simulated CDP workflow, not a new authenticated ChatGPT send.

A prior macOS Intel CI job timed out in one test combining three independent
receipt rejection scenarios. The same unmodified test passed in the next native
matrix at source `8ac85b4c69d85f239568f70975771b56fe937494`:
[CI run](https://github.com/youdie006/prodex/actions/runs/36154803438).
This change separates the scenarios without removing assertions or increasing
the global timeout. New-change CI results must not be inferred from that run.

Diagnostic attempts retained for audit: an initial metadata reader treated the
plain-text last-send timestamp as JSON, an initial CDP probe used port 9222 instead
of configured 9333, and an initial nested Node probe had a quoting syntax error.
Corrected bounded commands succeeded; none submitted a prompt or altered a
browser/profile. A review command used unsupported Vitest `--runInBand`; its
corrected command passed.

## Runtime And Recovery Limits

The installed WSL service still uses package `0.40.18` and a read-only image,
started `2026-09-17T04:36:34.956128153Z`. The live before/after check loaded the
fixed build only in the diagnostic host process. It did not replace the installed
module or reload already-running MCP processes. No container, browser, viewer,
login state, Codex process or M3 installation has been changed by this check.
`node scripts/container-client.mjs status` subsequently confirmed the unchanged
image `sha256:1f5cf6a36323635c2f03bd3b011f89f9e5223cc955f10737bd187de7e89cfd18`
was healthy, reachable and ready without a blocker. Its actual browser mode was
headed Chromium on the virtual display, not pure headless.

Applying the fix to that service requires a verified image replacement preserving
the existing private home volume, followed by reconnecting its MCP clients.
Source push is not installation, MCP reconnection, an npm release or a published
container image. The browser's read-only protection must not be disabled to patch
it in place. Service replacement was presented separately to the user because
other clients share it.

For future recovery, inspect the recorded task through `bridge_get_task` and
`bridge_fetch_result` on the same MCP connection that performed the consult.
Do not substitute a host CLI's current thread or expand a redacted `~/bridge`
path on another machine. Use `pro_recover` only with the original request marker
and an independently verified exact thread; never resend automatically.

This fixes a local false rejection. It does not establish pure-headless ChatGPT
access, repair remote Cloudflare refusals, or certify arbitrary cross-home/CDP
tunnel lock topologies. The separate [headless options matrix](headless-options-matrix-2026-09-26.md)
remains research, not a changed browser operating mode.
