# Parallel pure-headless investigation

Date: 2026-09-23 (Asia/Seoul). The user approved investigating pure headless in
parallel with the existing virtual-display operating path. This is a research
track, not a change to runtime defaults, an automatic fallback or a recurring job.

## Decision

- Keep the verified virtual-display service as the operating path on WSL and M3.
  Continue the guided-login, first-install and release work independently of the
  pure-headless investigation. A headless experiment does not authorize delaying
  or replacing the working path.
- Investigate ordinary, sandboxed Chrome/Chromium headless in isolated profiles
  and disposable runtimes. Record browser version, architecture, actual process
  mode, test surface and cleanup for every observation.
- Do not import stealth settings, change fingerprints/user agents to evade
  protection, solve challenges, copy profiles/cookies/tokens, expose the account
  as a service or retry a refused request. Keep the project hard boundaries.
- Do not stop the installed service, reset login or open a new authentication
  window as part of routine research. Any later authenticated mode transition
  needs its own explicit scope and user approval.

Immediate replacement would discard the only authenticated path verified on both
machines. Dropping headless entirely would discard a testable candidate. Keeping
an isolated comparison track preserves the current product while allowing a
candidate to advance only when its evidence improves.

## Evidence ledger

| Surface | Evidence | Limit |
| --- | --- | --- |
| WSL/M3 virtual display | Actual Pro answers, exact-thread continuation and trusted saved results | Headed browser on Xvfb, not pure headless |
| WSL/M3 Linux pure-headless mechanics | Existing account-free input, attachment, synthetic profile restart and navigation checks passed | Not account or Pro acceptance |
| WSL pure-headless public document, September 18 | Correlated 307 -> 403; final challenge header observed | Access blocked; exact server-side rule unknown |
| September 23 local WSL host smoke | Chrome 144.0.7559.132, x64, actual headless, all local capabilities passed | Different binary from the earlier stock Chrome 153 container comparison |
| September 23 installed WSL/M3 status | Both healthy, reachable, READY; no blocker | Read-only point-in-time status, not another Pro request |

The latest public refusal is historical evidence, not a new September 23 request.
An old refusal is neither proof of permanent failure nor permission to retry it
without a distinct hypothesis. A local fixture's synthetic 403 is not a new
ChatGPT response. The host Chrome 144 observation is not a recommendation to use
that older binary for public browsing.

Detailed records:

- [Mode comparison](headless-mode-comparison-2026-09-17.md)
- [Stock Chrome comparison](stock-chrome-comparison-2026-09-17.md)
- [Correlated navigation diagnostics](navigation-diagnostics-2026-09-18.md)
- [Guided login and M3 Pro acceptance](guided-login-2026-09-18.md)

## September 23 upstream recheck

Official product documentation was excluded. Public repository commit patches
and implementation files were inspected; no upstream package was installed or
executed. Search results were treated as pointers, not successful reproductions.

- Oracle's September 22 [IPv6/probe cleanup change](https://github.com/steipete/oracle/commit/74fe3ac8f896dfac17e7ba904e05f5df5adafa78)
  brackets IPv6 DevTools hosts and cleans up timeout/response resources in a
  `finally` block. Its tests cover URL formation and rejected-probe timer cleanup.
  This is connection hygiene, not evidence of a headless ChatGPT protection fix.
- Oracle's [localized process identity change](https://github.com/steipete/oracle/commit/bdabdb56ed745fa303e163e3c81a4903054187ed)
  sets `LC_ALL=C` for a `ps lstart` timestamp query. ProDex's inspected browser
  process path reads `user,pid,command`, not that timestamp; its CDP version probe
  uses literal IPv4 loopback and `AbortSignal.timeout`. These patches do not
  directly establish corresponding ProDex bugs. Reproduce a local failure before
  porting a fix or expanding supported endpoint types.
- `guberm/chatgpt-web-provider` still resolved to
  [`e18fc0da7f60dd2c22af80d4b4cae64aa5ef7b81`](https://github.com/guberm/chatgpt-web-provider/commit/e18fc0da7f60dd2c22af80d4b4cae64aa5ef7b81)
  from July 28, the same revision previously reviewed. No newer revision was
  found there in this bounded check.
- `stufently/gpt-web-gateway` advanced to
  [`2b29918cfb18b32df04988835aa41d1b0450fa63`](https://github.com/stufently/gpt-web-gateway/blob/2b29918cfb18b32df04988835aa41d1b0450fa63/Dockerfile).
  Its inspected Dockerfile still selects `HEADLESS=false` and starts Xvfb. The
  latest commit affecting that file was August 19. Current repository activity
  alone is therefore not evidence of a new pure-headless solution. Evasion,
  challenge handling and relaxed sandbox/display choices in that project remain
  excluded from ProDex.

This bounded recheck did not find a newly demonstrated ordinary pure-headless
Pro solution. It is not an exhaustive claim about all repositories or users.

The [September 26 follow-up](headless-evidence-followup-2026-09-26.md) adds an
upstream headless ChatGPT response report missed by this recheck and explains its
missing binary/authentication and Pro evidence. It also audits our comparison
limits; neither note establishes that headless is inherently impossible.

## Next experiment gates

1. Reproduce ordinary browser compatibility locally first. Compare the same
   pinned supported binary, architecture and resource limits with only the mode
   varied. Use fresh isolated profiles, existing account-free navigation fixtures
   and actual process checks. Avoid comparing host Chrome 144 directly against
   container Chrome 153 as if the mode were the only difference.
2. Before a new public-root measurement, record a distinct hypothesis and the
   changed variable. Use the existing correlated diagnostic runner: at most one
   navigation per explicitly selected case, bounded time, no login or prompt,
   no protection interaction and no automatic retry. A 200 without a challenge
   advances only the anonymous document gate, not authenticated Pro acceptance.
3. Only after a justified candidate advances, scope an opt-in authenticated test
   separately. Preserve the production service and account profile; do not copy
   authentication into a disposable trial. Authentication requirements and any
   use of an existing dedicated profile must be agreed before changing modes.
   A challenge stops the experiment and does not prescribe another login cycle.

Promoting a candidate requires verified pure-headless process mode, saved-session
readiness, one verified Pro answer, exact-request/thread continuation from another
MCP client, no-send recovery, trusted receipts/artifact hashes, and owned-process
cleanup on each claimed target. Later manual sessions must also check session
reuse; a single successful response cannot certify ongoing reliability. Mode
selection remains explicit until those checks justify a separate default change.

## Verification and deployment

- PASS: `npm test -- tests/cli-login.test.ts tests/login-container.test.ts tests/login-viewer.test.ts tests/browser-navigation-diagnostics.test.ts`
  (60 tests across four files).
- PASS: `npm run smoke:browser` on the WSL host. Actual headless process,
  Runtime/DOM, keyboard, mouse, synthetic attachment, same-profile marker restart,
  correlated local navigation and graceful cleanup all passed. No
  `--public-chatgpt` option was used; zero ChatGPT navigations/logins/prompts.
- PASS: existing container helper `status` on WSL `default` and M3
  `colima-prodex-check` returned version 0.40.18, actual headed mode, healthy,
  reachable and READY. Image IDs matched the earlier installed-service records.
- PASS: GitHub API commit and file inspection for the pinned upstream changes.
  Web opening of three exact commit/file URLs returned cache misses; the GitHub
  API supplied the actual patches and Dockerfile. No success was inferred from
  the failed web opens.
- No product source, launch preference, installed package, service, authentication
  state or attached client was changed. No new M3 headless run is claimed.
- This research/decision record and its changelog entry are committed on
  `feat/headless-browser-compatibility`; source commit/push details are recorded
  in [PR 7](https://github.com/youdie006/prodex/pull/7). No release tag, npm/image
  publication or installation is part of this update. The user's untracked
  `Makefile` remains untouched.
