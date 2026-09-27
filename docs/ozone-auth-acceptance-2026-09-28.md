# Ozone acceptance follow-up: 2026-09-28

## Acceptance Contract

This user-requested follow-up does not redefine missing evidence as success.
The existing response-model requirement remains distinct from successful
request matching and from selecting Pro in the composer. Ozone is ordinary
Chrome using a headless display backend; it is not the browser `--headless`
switch, and the earlier pure-headless protection refusal is not erased.

The next authenticated experiment is explicitly bounded and reversible:

1. Keep the installed Chromium 152 executable and current adapter unchanged.
   Test only the Ozone display-backend wrapper and experimental runner.
2. Require an anonymous public-root pass, an idle/empty original composer,
   exclusive shared-send ownership and no other container using the account
   volume before stopping the original browser service.
3. Mount the existing account volume only after that service has stopped. Do
   not copy or inspect cookies, tokens, passwords, or account-profile contents.
   Do not open a viewer, login window, publish a port, or weaken the sandbox.
4. Verify actual Chrome 152 ownership, Ozone flag, absence of display servers,
   process security and saved-session readiness before any question.
5. Allow at most two synthetic prompts: one fresh Pro-effort request, followed
   by one exact-thread continuation from an independent MCP client. A final
   read-only recovery may verify the already-posted second request. No resend,
   blind retry or loop is allowed after a blocker or unverified identity.
6. Close the trial, confirm cleanup and restore the original service, settings,
   volume and conversation. Trial success alone does not promote a production
   backend or prove response-model provenance.

The operating services remain on their prior images unless a separate,
verified deployment is explicitly recorded. No public npm release is implied.

## Response Provenance Investigation

Read-only checks of both previous synthetic answers confirmed exactly one
fallback assistant node and no response `data-message-model-slug` or model/
effort attribute. The current composer displayed Pro; it is not response-bound
evidence. On WSL, a native More actions menu linked to that answer offered only
a timestamp and Open new branch. It was closed without selecting an action.
No question was sent. The original host-browser inspection was refused by an
active shared-send lock and did not interact with that browser.

Source review found no dropped metadata in the parser, receipt, CLI or MCP
path. Unknown model evidence intentionally remains absent rather than being
inferred from answer text or the active composer. Hidden application state,
private API responses and credential extraction are not substitutes.

The first temporary DOM inspector had a nested-template construction error
and exited before browser access; correcting the operator expression enabled
the measured read-only checks. This was not a product or login failure.

## Anonymous Public Controls

All four successful controls used a fresh disposable profile, no account
volume, no host display socket, no viewer or published port, and the existing
sandbox/security/resource constraints. The existing browser smoke verifies
local DOM/input/file attachment, a same-profile synthetic restart, then issues
exactly one public-root navigation. Request/frame/loader correlation, response
status, document loading and cleanup are required.

| Target | Browser | Correlated final status | Challenge header | Navigation commands | Cleanup |
| --- | --- | --- | --- | --- | --- |
| WSL x64 | Stock Chrome 154 Ozone | 200 | Absent | 1 | Graceful |
| M3 Linux ARM64 | Stock Chrome 154 Ozone | 200 | Absent | 1 | Graceful |
| WSL x64 | Installed Chromium 152 Ozone | 200 | Absent | 1 | Graceful |
| M3 Linux ARM64 | Installed Chromium 152 Ozone | 200 | Absent | 1 | Graceful |

These are anonymous main-document observations, not authenticated Pro passes
or evidence that every later application request succeeds. The 152 comparison
was needed to avoid a browser/profile version upgrade in the planned account
trial. No control was retried after a protection response.

The initial 152 candidates contained an older smoke script that did not accept
`--public-chatgpt`. Both exited before launching a browser and made no public
navigation. The corrected candidates copied the current tested diagnostic
scripts only; Chromium, production services and account state were unchanged.

## Verification Before Follow-up

- PASS: 203 tests covering the prior fresh-selector behavior, transcript
  parsing and separate-load experiment helpers.
- PASS: 52 smoke-option/navigation-correlation tests run by the main agent.
- PASS: independent provenance review, 357 focused selector/CLI/MCP tests and
  typecheck; no source change or model-verification relaxation was recommended.
- PASS: four bounded anonymous public controls, each exiting 0 with complete
  local smoke and graceful cleanup.
- NOT A PASS: the two pre-launch stale-helper failures; the refused host lock
  provided no host-browser observation.

The authenticated and restoration results below complete this bounded trial.
They do not change the response-model evidence requirement.

## Runner Admission

The experimental runner is a single additional image layer over each publicly
tested Chromium 152 candidate. Before any account volume was mounted, both
architectures passed a `--network none` trial with disposable HOME: all 23
readiness/security fields were true, SIGTERM used ownership-revalidated
`Browser.close`, the runner exited 0 and the trial container was removed.
The 12 focused runner regression tests also passed independently.

The first image build commands incorrectly supplied a local image ID as a
Dockerfile FROM reference. BuildKit treated it as a registry repository and
failed resolution (WSL access denied; M3 missing registry credential helper).
The correction used existing local tags and subsequently verifies their image
layers against the pinned public candidates. No browser or account was opened
by those failed builds, and no registry credentials were changed.

## Authenticated Results

Both targets passed the functional trial using their existing private volume
and installed Chromium 152.0.7977.82. Only the original service was allowed to
own that volume before the stop; the trial mount used `volume-nocopy`. No
cookies, tokens, passwords or profile contents were copied or inspected.

| Check | WSL Linux x64 | M3 Linux ARM64 |
| --- | --- | --- |
| Chrome without Xvfb, Wayland or browser `--headless` | PASS | PASS |
| All 23 process/security admission checks | PASS | PASS |
| Saved login, original thread, model/tools readiness | PASS | PASS |
| First Pro-effort consult, exact synthetic answer | PASS | PASS |
| Independent MCP client, exact-thread continuation | PASS | PASS |
| Read-only recovery, request identity and artifact hash | PASS | PASS |
| Trial cleanup and original service restoration | PASS | PASS |
| Fresh MCP read after restoration, exact stored answers | PASS | PASS |
| Response-bound model/Pro provenance | UNKNOWN | UNKNOWN |

Each target received exactly two synthetic questions, with no automatic
resends. The first stored `VALUE=17` and returned its unique verification
token. The second used the first result's exact continuation metadata from a
new MCP client and returned that same token with `42`, without being supplied
the original value or token again. Recovery read that second answer without
sending a third question. After restoring the original service, a fresh MCP
client required exact equality of all three stored answer summaries and
rechecked their trusted artifact hashes. This is sequential cross-client
continuation evidence, not a simultaneous multi-user load test.

| Target | First task | Continuation task | Recovery task |
| --- | --- | --- | --- |
| WSL | `task_20260927_155921_gpt-pro-consult` | `task_20260927_160008_gpt-pro-consult` | `task_20260927_160040_gpt-pro-consult-recovered` |
| M3 | `task_20260927_160131_gpt-pro-consult` | `task_20260927_160157_gpt-pro-consult` | `task_20260927_160222_gpt-pro-consult-recovered` |

The runner closed its owned browser using `Browser.close`, confirmed exit and
preserved the profile. Both temporary containers were removed. The original
container IDs, images, complete configuration and mount invariants matched;
adapter bytes and saved viewer-file metadata were unchanged. Restored pages
were signed in, idle and at the original conversation with usable controls.
The trial held the browser for approximately 85 seconds on WSL and 58 seconds
on M3. No protection response or login prompt occurred in either account trial.

Both coordinators intentionally exited **2**, not 0: functional checks passed,
but the response DOM still omitted model metadata. The evidence's
`proVerified: false` means the strict proof gate did not pass; it does not
establish that a non-Pro model answered. No production verification logic was
relaxed, and selecting Pro effort is not substituted for response proof.

## Delivery And Runtime State

This is an experimental source/evidence update for version **0.40.18 plus
unreleased changes**, not an npm release or default-backend deployment. The
baseline source is `54657e0d2cd8623a436858bfaa7273de9718d673`; the installed
adapter remains SHA-256
`079a054574c48fee7e3b5f0db4c936eb4158da080acecff82afa8aff01e80400`.

| Target | Experimental image | Restored production image | Restored start, UTC |
| --- | --- | --- | --- |
| WSL x64 | `sha256:7e1c5711c659aa7de7600b450df9a65e62b3124054389134908e10ddc29e253e` | `sha256:7635c70fb84096a8fe6c6e18fefbfedc70fe8bc5831e72364ef1e98a741c64a2` | 2026-09-27 16:00:43 |
| M3 Linux ARM64 | `sha256:c37994edffdb30ded2a2efc9187bedec6485ad539ae1324201a2046afa31bc76` | `sha256:395f67d40bd9a052588da1571318cac20ee93ea76da3a64eb496ef9a4a05dd79` | 2026-09-27 16:02:26 |

Both production services remain on their existing private-Xvfb backend, healthy
and signed in. Fresh MCP connections exposed all 20 tools and returned
`{tasks:[]}` for a read-only new-task listing. WSL used the configured
`container-client` stdio path; M3 used explicit SSH/container stdio. Every
verification client exited. A client disconnected by the planned restart may
need `/mcp` reconnection, not another ChatGPT login. The reporting harness
session was notified; that is not a claim that its existing connection
automatically reattached.

Machine-readable [acceptance evidence](experiments/ozone-2026-09-28/acceptance-evidence.json)
preserves image IDs, timestamps, request IDs, artifact hashes, all security
checks, setup failures and restoration results without private thread URLs or
credentials. The test runner and its regression tests are in the same folder.
Delivery is through branch `feat/headless-browser-compatibility` and
[PR #7](https://github.com/youdie006/prodex/pull/7); the commit and push result
are recorded in the PR delivery comment rather than asserting a release tag.

## Final Verification And Limits

- PASS: `npm test`, 140 test files, 1,977 passed and 3 skipped.
- PASS: `npm run typecheck`.
- PASS: `npx vitest run docs/experiments/ozone-2026-09-28/authenticated-runner.test.mjs`,
  12 tests, independently rerun by the main agent.
- PASS: syntax and diff-whitespace checks, public/offline controls, two bounded
  authenticated trials, restored-service MCP reads and exact receipt checks.
- NOT PASSED: strict response-bound Pro verification; both trial coordinators
  explicitly returned exit 2 for this missing evidence.
- NOT CLAIMED: browser `--headless` acceptance, native Windows/macOS browser
  coverage, indefinite reliability, or a production Ozone default. M3 evidence
  is Linux ARM64 under Colima, not a native macOS browser.

The operator coordinator was reviewed and hardened for normal signal cleanup,
partial creation, log-capture failure, exact volume mounting and the complete
23-field readiness contract before use. It is not a production installer or
crash-recovery service: host loss, SIGKILL or an unavailable Docker daemon still
requires an operator to reconcile exact container ownership before restoring
the account volume. No such failure occurred in these measured trials.

The Ozone functional gate now passes on both available architectures. Full
strict-Pro acceptance and automatic/default production promotion remain open;
neither missing evidence nor the earlier pure-headless 403 is erased by these
successful results.
