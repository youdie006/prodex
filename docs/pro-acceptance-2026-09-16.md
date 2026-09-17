# Live Pro acceptance: 2026-09-16

The existing WSL host browser passed three actual Pro requests through fresh
`0.40.18` stdio MCP connections, including a new conversation and two continued
turns. **Overall headless/container acceptance remains open.** These results do
not convert the separate [true-headless HTTP 403 results](container-browser.md#isolated-true-headless-baseline-2026-09-16)
into a pass, or reconnect the MCP already attached to the user's Codex session.

## Runtime and boundaries

Source record: `ddeb9015bad5272778e82640606da929f8839479` on
`feat/headless-browser-compatibility`. The account requests used the existing
globally installed `prodex`, not a build of the unreleased branch. No package,
browser, container, login profile, or client configuration was installed or
replaced in this follow-up.

| Runtime | Observed state | Acceptance scope |
| --- | --- | --- |
| Existing WSL host Chrome `144.0.7559.132` | Signed in, composer ready, actual headed process | Live Pro checks below |
| MCP already attached to Codex | Loaded `0.40.16`; reports installed `0.40.18` as newer | Not reconnected; first response rejected as non-Pro |
| Three fresh independent stdio MCP processes | Each initialization reports `prodex` `0.40.18` | Two continuations and one new-chat Pro request pass |
| WSL container Chromium `152.0.7977.82` | Actual headed, `login_required` | No authenticated request attempted |
| M3 ARM64 Linux VM container | Actual headed, no ChatGPT page | No authenticated request attempted |
| Native M3 host browser | `cloudflare_check` | Stopped; no retry or prompt |

Host loopback port `9333` was owned by Chrome PID `572089`, which had no
headless flag. The generic runtime inspector returned unknown because the host
process list also contained a container browser with the same numeric CDP port
in a different network namespace. The independent listening-socket check
disambiguated the host connection; an unknown inspector result was not treated
as headless evidence.

No visible browser/login window was opened, no browser mode was changed, and
Codex was not restarted. Existing authentication was reused only in its original
host browser. No cookies, tokens, profiles, or authentication state were copied.
Fresh MCP children used `PRODEX_NO_AUTO_LOGIN=1` and the ordinary shared send lock;
none overrode the profile, lock path, or registry to evade coordination.

## Actual request results

Each request explicitly selected `effort: "Pro"` and
`allow_model_fallback: false`. All four answers had exact request verification
and verified project destinations. Pro acceptance additionally required the
rendered answer's model metadata, not the answer's self-description.

| Task ID | Loaded MCP | Operation | Exact answer suffix | Rendered model | Pro acceptance |
| --- | --- | --- | --- | --- | --- |
| `task_20260916_064848_gpt-pro-consult` | `0.40.16` attached | New chat: remember `K7Q4`, calculate 17 x 19 | `FIRST 323` | `gpt-5-6-thinking` | REJECTED, `pro_verified: false` |
| `task_20260916_065431_gpt-pro-consult` | `0.40.18` fresh | Continue exact first task; recall value | `SECOND K7Q4` | `gpt-6-pro` | PASS |
| `task_20260916_065717_gpt-pro-consult` | `0.40.18` another fresh process | Continue exact second task; recall value and add 7 to original result | `THIRD K7Q4 330` | `gpt-6-pro` | PASS |
| `task_20260916_070247_gpt-pro-consult` | `0.40.18` another fresh process | Separate session and new chat: calculate 23 x 29 | `FIRST 667` | `gpt-6-pro` | PASS |

The first three answers matched the prefix `PDX_ACCEPT_20260916_1550_A7D4`;
the independent new-chat answer matched `PDX_ACCEPT_20260916_FRESH_C93E`.
The two continued results had the exact expected `continued_from` IDs and shared
the original conversation URL. The final request had a different conversation
URL. All four request IDs were distinct. Conversation/project URLs and raw
receipts remain local, outside version control.

The first response still offered continuation despite its model mismatch. It
was not counted as a Pro answer. The subsequent successful continuation does
not retroactively validate that response. A bounded no-send picker probe showed
that selecting Pro and closing with Escape retained Pro; changing Escape to
Enter was therefore not justified. Both client age and navigation path differed
between the initial failure and the first success, so no specific root cause or
code fix is claimed. The later current-version new-chat pass narrows the result,
but does not prove model selection can never regress.

## Isolation, recovery, and evidence

- PASS: another session's implicit `continue_thread: true` request returned
  `No finished consult` before task creation. The task count was unchanged and
  no browser prompt was sent; it did not inherit the currently displayed chat.
- PASS: `pro_recover` with the second response's exact thread and request ID
  returned the same `SECOND K7Q4` answer with `request_verified: true`, without
  another send.
- PASS: the third turn did not carry `user_approved` forward. Its recorded
  follow-up budget was one used out of five, with four remaining. Explicit
  approval on the second turn came from the user's current testing request.
- PASS: three independent MCP initialization handshakes reported `0.40.18`;
  each client and transport closed, and each child PID was confirmed absent.
  These temporary SDK connections did not replace the attached Codex MCP.
- PASS: an offline Node assertion checked all four local saved-answer receipts,
  exact result summaries, request/model/Pro/destination fields, unique request
  IDs, continuation ancestry, same/different thread relationships, and the byte
  size and SHA-256 of every listed answer artifact.
- PASS: 56 tests in the six browser/runtime/container suites and 88 tests in the
  six consult/continuation/model-selection suites, with zero failures.
- FAIL (test harness setup only): the first new-chat Node command used incorrect
  shell newline quoting and failed to parse before creating an MCP process or
  sending a prompt. The corrected invocation passed. This was not an automatic
  retry of a submitted ChatGPT request.

Focused regression commands:

```sh
npm test -- tests/browser-compatibility.test.ts tests/browser-process.test.ts tests/browser-launch-smoke-options.test.ts tests/container-browser-config.test.ts tests/container-browser-service.test.ts tests/container-viewer-smoke.test.ts
npm test -- tests/mcp-consult.test.ts tests/continue-thread.test.ts tests/pro-selection-contract.test.ts tests/picker-interaction.test.ts tests/power-ladder.test.ts tests/picker-selection-plan.test.ts
```

The final new-chat harness used the repository's MCP SDK `Client` and
`StdioClientTransport`, launching `prodex mcp --cwd <repository>` with a 15-second
initialization deadline and a 240-second consult deadline. Across this follow-up,
calls were sequential, manually authorized, and bounded: four prompts in total,
three accepted as Pro.
There was no background prompt loop. No full OS/unit-suite matrix was rerun for
this documentation-only follow-up; earlier platform results keep their original
scope and date.

## Remaining acceptance gates

- [x] Existing WSL host: actual Pro new-chat response and exact-thread continued
  responses through fresh current-version MCP connections.
- [x] Same-thread memory across independent MCP processes; unrelated-session
  rejection and request-specific recovery without sending.
- [ ] Actual attached Codex MCP loaded at the current version. Updating an
  installed package or spawning an SDK child is not client reconnection.
- [ ] Container Pro response, continuation, and authentication persistence after
  viewer disconnection. The [2026-09-17 follow-up](container-browser.md#authenticated-container-check-2026-09-17)
  confirmed manual container login and readiness with no viewer connected, but
  its bounded Pro request timed out and exact-request recovery found no answer.
  No continuation was sent; the live container acceptance gate remains open.
- [ ] Authenticated pure-headless Pro response and continuation. The earlier
  WSL/M3 403 trials and native M3 protection blocker remain unresolved.

This is a source-only verification record, not a runtime fix, release tag,
npm/image publication, installation, or guarantee of all-OS authenticated access.
The commit and push outcome are recorded in [PR #7](https://github.com/youdie006/prodex/pull/7).
