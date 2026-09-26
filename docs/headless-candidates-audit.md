# True-headless candidate audit: 2026-09-16

## Decision

True-headless implementations and a firsthand ChatGPT usage report exist. The
evidence inspected here does **not** establish a drop-in, sustained ChatGPT Pro
solution for both WSL and M3. Do not equate a launch flag, a login report, or a
successful documentation PR with a verified Pro response and continuation.

This follow-up checks public GitHub code, issues, and maintainer records, not
official product documentation. No upstream package was installed or executed;
no browser, account, profile, client MCP configuration, or installed version was
changed. The existing [container experiment](container-browser.md) remains
virtual-display Chromium, with account-free checks completed and live Pro
response/continuation still unverified in that runtime.

Subsequent authorized [isolated baseline checks](container-browser.md#isolated-true-headless-baseline-2026-09-16)
passed actual headless browser mechanics, synthetic pixels, and sandbox checks
on both Linux architectures, but fresh public ChatGPT navigation returned HTTP
403 on both. Existing virtual-display services and authentication were untouched.

## Draivix/chatgpt-gateway

Inspected commit: `e9b3f6a4e984409d5bd09f0d0eb1544c0c366e31`.

- **Actually headless by default.** [Configuration](https://github.com/Draivix/chatgpt-gateway/blob/e9b3f6a4e984409d5bd09f0d0eb1544c0c366e31/camoufox-gateway/src/cgw/config.py#L58-L68)
  defaults headed mode off; the [daemon](https://github.com/Draivix/chatgpt-gateway/blob/e9b3f6a4e984409d5bd09f0d0eb1544c0c366e31/camoufox-gateway/src/cgw/daemon.py#L220-L229)
  passes `headless=not headed` through the [browser options](https://github.com/Draivix/chatgpt-gateway/blob/e9b3f6a4e984409d5bd09f0d0eb1544c0c366e31/camoufox-gateway/src/cgw/browser.py#L66-L77)
  to a persistent Camoufox context. Window dimensions alone do not mean that it
  uses a virtual display.
- **Pro evidence is weaker than the success claim.** [Model selection](https://github.com/Draivix/chatgpt-gateway/blob/e9b3f6a4e984409d5bd09f0d0eb1544c0c366e31/camoufox-gateway/src/cgw/chat.py#L269-L295)
  checks a localized composer label, but can return `pro-unverified` or `error`.
  The [caller still sends and can return `ok: true`](https://github.com/Draivix/chatgpt-gateway/blob/e9b3f6a4e984409d5bd09f0d0eb1544c0c366e31/camoufox-gateway/src/cgw/chat.py#L564-L596)
  without rejecting those labels. An answer's existence is therefore not proof
  that the requested Pro mode was selected. The inspected [test file](https://github.com/Draivix/chatgpt-gateway/blob/e9b3f6a4e984409d5bd09f0d0eb1544c0c366e31/camoufox-gateway/tests/test_effort_match.py#L1-L6)
  explicitly tests browser-free effort-label logic, not live Pro acceptance.
- **Continuation is unsafe to copy for multiple callers.** [Continuation](https://github.com/Draivix/chatgpt-gateway/blob/e9b3f6a4e984409d5bd09f0d0eb1544c0c366e31/camoufox-gateway/src/cgw/chat.py#L553-L563)
  uses the current conversation and falls back to a fresh chat when the composer
  is absent. Its [prior assistant-count check](https://github.com/Draivix/chatgpt-gateway/blob/e9b3f6a4e984409d5bd09f0d0eb1544c0c366e31/camoufox-gateway/src/cgw/chat.py#L388-L409)
  is useful, but does not bind that conversation to a ProDex task/request.
- **Not suitable for whole-project adoption.** The browser options include
  identity/humanization settings; the [login implementation](https://github.com/Draivix/chatgpt-gateway/blob/e9b3f6a4e984409d5bd09f0d0eb1544c0c366e31/camoufox-gateway/src/cgw/login.py#L308-L353)
  includes automatic authentication/OTP handling. Do not import these paths.
  A stale SSE description at the top of `chat.py` is not sufficient evidence
  of a hidden API client: the inspected completion implementation above uses
  DOM state. Do not turn a source comment into a runtime accusation.

**Assessment:** strongest inspected true-headless implementation claim, but not
a verified cross-platform Pro replacement. Retain model-confirmation failure
as a blocker and require explicit conversation ownership in any adaptation.

## jo-inc/camofox-browser and Hermes

Inspected commit: `79d425be26743883a06613eaa3be5e38e7ab5409`.

- **The same setting means different runtime modes across operating systems.**
  The [launch branch](https://github.com/jo-inc/camofox-browser/blob/79d425be26743883a06613eaa3be5e38e7ab5409/server.js#L1127-L1172)
  tries Xvfb on Linux when desktop mode is off, then launches headed with that
  display. Only failure to create the display falls back to true headless.
  Non-Linux non-desktop launches use true headless. Thus the ordinary Linux/WSL
  path is not evidence of the same pure-headless setup working everywhere.
- **There is a firsthand Windows report, not a verified Pro-model report.**
  [Hermes issue #97185](https://github.com/NousResearch/hermes-agent/issues/97185)
  reports native Windows 11 ChatGPT login/headless use, and explicitly says
  Docker was not tested. It does not identify a selected Pro model or establish
  Pro-answer attribution, same-thread continuation, or M3/WSL success.
- **The linked PR adds no live replication.** [PR #97391](https://github.com/NousResearch/hermes-agent/pull/97391)
  is a documentation change. Its author explicitly records source checking
  without running Camofox or a live login cycle. Its existence must not be
  presented as an additional successful account test.
- **Persistence behavior is not interchangeable with a Chrome profile.** The
  issue reports lost login after a hard process kill and storage-state
  checkpointing on clean session close/shutdown. Preserve graceful shutdown as
  a design lesson; do not copy its storage-state export/import into ProDex or
  transfer the user's current browser authentication.

**Assessment:** credible evidence that someone used ChatGPT headlessly on native
Windows, with narrower scope than Pro success across our two targets. The
Camoufox-specific identity settings and persistence mechanism are not approved
for adoption to bypass the current protection blocker.

## StartupBros-com/pro-gate

Inspected commit: `588b528732ba884d4873cfbc6f7545e3ec6082f6`.

The [setup record](https://github.com/StartupBros-com/pro-gate/blob/588b528732ba884d4873cfbc6f7545e3ec6082f6/docs/SETUP-NOTES.md#L12-L16)
describes a successful WSL Pro review workflow as headless, but specifies Xvfb
and headful Chrome. The [actual launcher](https://github.com/StartupBros-com/pro-gate/blob/588b528732ba884d4873cfbc6f7545e3ec6082f6/daemon/run-oracle-chrome.sh#L79-L96)
confirms it. This is another virtual-display reference, not a new pure-headless
solution. The reported Pro success is a maintainer record, not our replication.

Useful reported practices include keeping the browser alive, reconnecting to
an existing long-running review rather than resending, and preserving uncertain
conversations until their answers have been durably captured. Do not import its
sandbox-disabled launch settings, automation-hiding flags, scheduled review
loop, or [best-effort model-label policy](https://github.com/StartupBros-com/pro-gate/blob/588b528732ba884d4873cfbc6f7545e3ec6082f6/docs/SETUP-NOTES.md#L25-L36).
Those do not match ProDex's current boundaries or model-verification contract.

## ProDex applicability

1. **No executable-only Firefox swap.** At ProDex `193818b`,
   [page control](../src/chatgpt-browser.ts) uses raw CDP commands such as
   `Runtime.enable` and `Input.dispatchKeyEvent`; [process inspection](../src/browser-process.ts)
   recognizes Chromium-family executables. A Firefox-family integration needs
   an explicit browser adapter and equivalent ownership/lifecycle tests.
2. **Keep the bridge's correctness rules.** Retain the durable task/receipt bus,
   [cross-process send lock](../src/browser-send-lock.ts), exact conversation
   target, request marker, new-answer attribution, and fail-closed Pro selection.
   Do not substitute upstream's implicit current-tab continuation or silently
   create a new chat when continuation fails.
3. **Keep runtime claims separate.** The current virtual-display container has
   account-free verification on both architectures; this audit adds no live Pro
   proof. An ordinary true-headless candidate remains experimental. Any future
   trial must pass the [bounded acceptance gates](headless-methods-research.md#bounded-acceptance-gates-for-a-later-authorized-experiment),
   without stealth, private endpoints, credential transfer, or automatic
   protection handling. There is no new demonstrated fix for the observed 403.

## Verification and publication scope

- Read-only GitHub API checks pinned all three revisions; relevant source ranges
  were checked directly. Hermes issue and PR bodies were checked separately.
- The in-memory link audit checked 20 links: 13 line ranges in nine pinned source
  files, five local targets, and two issue/PR bodies. Local heading anchors and
  ASCII content passed; `git diff --check` passed.
- Local regression command:
  `npm test -- tests/browser-compatibility.test.ts tests/container-browser-config.test.ts tests/container-browser-service.test.ts tests/container-viewer-smoke.test.ts`.
  Result: 46 tests passed in four files. These are local regressions, not upstream
  execution or authenticated ChatGPT tests. No full suite/build was required for
  this documentation-only change.
- This audit and the changelog are the change record. No dependency/runtime
  update, installation, package publication, or release is part of the audit.
  License metadata alone is not a security or transitive-license review.
