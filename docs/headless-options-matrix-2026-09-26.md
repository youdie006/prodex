# Headless options and investigation priorities

Date: 2026-09-26 (Asia/Seoul). Broader GitHub/source/firsthand-report survey
requested after the [response-evidence follow-up](headless-evidence-followup-2026-09-26.md).
This is a bounded map of plausible approaches, not a claim to have exhausted the
internet or tested every combination. Official product documentation was not used.
No account request, browser launch, installation or service transition was made.

## Findings

- A headless ChatGPT response has been reported upstream, but the Oracle report
  still lacks a reproducible binary/authentication specification and Pro proof.
- There are more real implementations than the first survey found, including a
  ChatGPT-specific Moli demo. Their authentication, rendering and lifecycle
  assumptions prevent treating them as drop-in ProDex fixes.
- Some apparent alternatives implement a hidden headed window or a noninteractive
  CLI, not a pure-headless browser. Others rely on credential transfer or protection
  evasion excluded by this repository's boundaries.
- The most informative next comparison is ordinary Chrome with controlled product
  build, runtime identity, profile policy, viewport and environment. Changing a
  library, engine and authentication method together would not identify the cause.

Evidence levels used below: **local** means an existing ProDex measurement;
**reported** means an upstream author's claim/log; **source** means inspected code;
**unknown** means the required account-bound result was not established.

## Eighteen investigation paths

These are distinct questions, not eighteen approved public retries. Priority is
based on expected diagnostic value and integration cost, not a predicted pass rate.

| # | Path | Evidence and gap | Disposition |
| --- | --- | --- | --- |
| 1 | Ordinary Chrome headless versus headed, same build/environment | Local headless 403; no Chrome 154 public headed control | Highest-value future controlled comparison; no request made now |
| 2 | Native host versus Linux container | WSL/M3 container browser mechanics pass; earlier host observations used different browser versions | Separate host, architecture and browser build; do not describe M3 Colima as native macOS Chrome |
| 3 | Browser channel, artifact and actual process identity | Oracle reported reusing Canary after configuring stable Chrome | Audit requested versus running executable; do not kill or relaunch a shared browser speculatively |
| 4 | Full Chromium versus headless shell | Playwright chooses different executables by options; ProDex already tested stock full Chrome | Useful classification, not an untried stock-Chrome fix |
| 5 | Durable dedicated profile and same-runtime authentication | ProDex saved-profile trial still hit protection; restoration retained login | Preserve one owner and direct profile use; no claim that persistence alone clears 403 |
| 6 | Control transport: raw CDP, Playwright, Puppeteer, WebDriver/BiDi | Libraries can differ in event/input/lifecycle behavior | Offline contract testing first; a confirmed HTTP refusal is not itself a transport failure |
| 7 | Ordinary Firefox/WebKit or another Chromium product | Different engine/channel is a compatibility hypothesis, not measured Pro acceptance | New adapter and platform/auth/model/continuation qualification; no cross-engine profile reuse |
| 8 | Moli independent engine | ChatGPT demo exists; direct login can be challenged, preferred bootstrap imports auth from headed Chromium; live-DOM limitation recorded | Keep as exploratory compatibility candidate; do not copy its auth bridge |
| 9 | Lightpanda independent engine | Real CDP engine, but no ChatGPT-specific result found in bounded issue/tree search | Lower priority until required protocol, input, persistence and cleanup contracts pass |
| 10 | Embedded Qt/CEF/Electron offscreen host | SuperGrok distinguishes hidden/native, virtual-display and Qt-offscreen modes | Larger browser-host integration; invisible does not imply pure headless |
| 11 | Existing-browser extension/attachment | Earlier codex-chatgpt-control audit shows attachment, not browser launch/auth repair | Possible ergonomic alternative with explicit tab ownership; requires its browser, not a pure-headless pass |
| 12 | Xvfb/virtual display | Local WSL/M3 Pro answers and exact-thread continuation already recorded | Retain operating path; do not relabel it pure headless |
| 13 | Minimized/offscreen native window | CGPro4Code daemon explicitly requests headed mode; SuperGrok has native hidden modes | No-desktop-interruption alternative with separate input/rendering tests, not no-display operation |
| 14 | Network/configuration/environment differences | Exact server rule and controlled egress comparison absent | Inspect ordinary proxy/DNS/namespace configuration without secrets; no IP rotation or concealment |
| 15 | Rendering/resources/readiness | Sandbox, input and local navigation work; alternative demos expose live rendering failures | Distinguish startup, navigation, hydration, send acceptance and answer completion; do not mask refusal as a longer timeout |
| 16 | Stealth forks, fingerprint rewriting or challenge automation | Present in several claimed solutions | Not adopted; implementation existence is not reproducibility within our boundaries |
| 17 | Cookie/storage-state transfer or remote cloud browsers | Present in pi-oracle, chatgpt-relay and Moli bootstrap; benchmark measures page access | Excluded credential-transfer route; no account outsourced to browser services |
| 18 | API/OAuth/model proxy or terminal-headless MCP | CodexPro headless is server lifecycle, not a browser model endpoint | Different product/transport; no claim it grants the same ChatGPT Pro mode |

Rows 1-5 and 12-15 use the existing [comparison and causal limits](headless-evidence-followup-2026-09-26.md#what-our-experiments-identify).
Rows 7, 10 and 11 also retain the distinctions in the earlier
[engine/embedded/extension audit](headless-methods-research.md).
Pinned new sources follow. A hypothesis in this table is not evidence that it
caused the observed protection response.

## New source checks

### Full browser and headless shell are not interchangeable labels

Playwright at `0404a2cf3b6bcae7e04b6c788ca71ae7a9f15f94` (September 25)
selects `chromium-headless-shell` for default headless launches without a channel,
and regular Chromium for recognized Chromium aliases. This is source-level
executable selection, not a ChatGPT test. ProDex's Chrome 153/154 stock artifact
trials already tested full Chrome, so replacing a shell is not the missing fix
in those experiments.
[Source](https://github.com/microsoft/playwright/blob/0404a2cf3b6bcae7e04b6c788ca71ae7a9f15f94/packages/playwright-core/src/server/chromium/chromium.ts#L418-L424).

### Moli has an actual ChatGPT demo, with significant limits

Pinned revision: `4617ec9a622e6b1a4136070b36dbbfed64bd4b90` (September 25).
The repository contains both raw-CDP and Playwright ChatGPT flows, not just a
generic crawler. The demo distinguishes live DOM answers from answers recovered
after a conversation reload, and records a live-render limitation. This is an
upstream-described behavior, not our account-bound reproduction.
[Demo record](https://github.com/lexmount/moli/blob/4617ec9a622e6b1a4136070b36dbbfed64bd4b90/moli-playground/chatgpt/README.md).

The preferred TUI defaults to a Chromium authentication bridge. Its code exports
cookies/localStorage and imports them into Moli, after using headed Chromium;
direct Moli login is a separate diagnostic path. That bridge is not adopted.
The inspected evidence does not establish selected Pro mode, independent-client
continuation, or unattended session reliability.
[TUI default](https://github.com/lexmount/moli/blob/4617ec9a622e6b1a4136070b36dbbfed64bd4b90/moli-playground/chatgpt/chatgpt_playwright_tui.py#L133-L144),
[auth transfer code](https://github.com/lexmount/moli/blob/4617ec9a622e6b1a4136070b36dbbfed64bd4b90/moli-playground/chatgpt/chatgpt_auth_bridge.py#L410-L427).

Its Browser-domain action enum lacks `Close`, matching open issue 680's request
for graceful whole-server shutdown. A ProDex adapter would need verified owned
process cleanup and durable profile release; successful CDP attachment alone
does not meet that contract.
[Enum](https://github.com/lexmount/moli/blob/4617ec9a622e6b1a4136070b36dbbfed64bd4b90/moli-protocol/src/domains/actions.rs#L49-L59),
[issue 680](https://github.com/lexmount/moli/issues/680).

### Lightpanda: CDP compatibility identity is not executable provenance

Pinned revision: `6f18cfcae71286ecd85831ac22646188579d843e` (September 25).
The inspected Browser-domain handler implements a subset of commands and returns
a hardcoded Chrome product/revision for client compatibility. Its own comment
explicitly distinguishes that CDP identity from its HTTP/JavaScript identity.
Do not infer a real Chrome binary/version from `Browser.getVersion` alone, or
mislabel this client-compatibility behavior as proof of an HTTP protection fix.
[Handler](https://github.com/lightpanda-io/browser/blob/6f18cfcae71286ecd85831ac22646188579d843e/src/server/cdp/domains/browser.zig#L30-L80).

The bounded `chatgpt` issue search returned no matches and the inspected tree
had no ChatGPT-named files. That is a search limit, not proof no user has succeeded.
No Lightpanda package was installed or exercised.

### Other engines and control libraries

An independent read-only pass checked five more engine/control repositories.
The main review re-read the pinned source behind the dispositions below. These
are library capability checks, not claims that their upstream users never
succeeded with ChatGPT. Prior integration-level Camoufox claims remain qualified
in the [candidate audit](headless-candidates-audit.md).

| Candidate / pinned revision | Verified distinction | ProDex disposition |
| --- | --- | --- |
| [Camoufox](https://github.com/daijro/camoufox/blob/c769df8ea84c5cc04557f4cd133462459216d2ab/README.md#L333-L345) `c769df8` | Firefox fork explicitly centered on identity changes and automation concealment | Not equivalent to ordinary Firefox; no evasion dependency adopted |
| [nodriver](https://github.com/ultrafunkamsterdam/nodriver/blob/a71cda374651d13815a42c5eeb61af04a711eaa7/README.md#L123-L133) `a71cda3` | Supports headless but recommends Xvfb on machines without a display | Control-library alternative, not proof it solves headless ChatGPT access |
| [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright/blob/26ab9ae74516a68077f218b5de763d85be9f6d5a/README.md#L179-L199) `26ab9ae` | Its central protection-avoidance claims concern its patching stack | Generic advertised success is not a reproduced Pro result; concealment path excluded |
| [DrissionPage](https://github.com/g1879/DrissionPage/blob/97110c7bf47905d28ba45ad603815ae399847a12/DrissionPage/_configs/chromium_options.py#L174-L189) `97110c7` | Chromium headless option is implemented directly | Could test ordinary control compatibility offline; it does not remove remote access decisions |
| [Selenium Firefox options](https://github.com/SeleniumHQ/selenium/blob/52a288e07fe4e5540bbf67c7d42cbaf66a1c61de/py/selenium/webdriver/firefox/options.py#L35-L58) `52a288e` | Firefox binary/options and BiDi preferences are explicit | Neutral alternative-engine controller; requires a ProDex adapter and new acceptance evidence |

No new Pro answer or exact-thread transcript was established by this bounded
engine-library pass. In particular, a Firefox build limitation must not be
generalized into a runtime result for all WSL/container configurations.

### SuperGrok: hidden Qt windows are not necessarily headless

Pinned revision: `ca57efa15af05456c86c2c638f0818608bc999ab` (May 12).
The automatic offscreen strategy resolves to an offscreen native window on
Windows, Xvfb on Linux, and hidden mode otherwise. The pure Qt offscreen plugin
is explicit and carries a reliability warning. Its ChatGPT input-fix record
prefers the visible authenticated bridge. This supplies an embedded-browser
reference, not a new pure-headless Pro acceptance log.
[Mode code](https://github.com/tibberous/SuperGrok/blob/ca57efa15af05456c86c2c638f0818608bc999ab/start.py#L717-L801),
[input record](https://github.com/tibberous/SuperGrok/blob/ca57efa15af05456c86c2c638f0818608bc999ab/docs/CHATGPT_QT_TRUSTED_INPUT_FIX_20260506.md).

### CGPro4Code: inspect the caller, not only a session helper

Pinned revision: `6cc5d422c4e081e8815c7c0f4cf2930dac24a277` (September 9).
The session helper has a headless branch, but the daemon calls it with
`headed: true` and background enabled by default. The source also uses Patchright
and private backend access. These are not ordinary pure-headless ProDex behavior,
and the existence of the helper flag must not override the actual call site.
[Daemon](https://github.com/yannabadie/CGPro4Code/blob/6cc5d422c4e081e8815c7c0f4cf2930dac24a277/src/daemon/server.ts#L63-L70),
[session](https://github.com/yannabadie/CGPro4Code/blob/6cc5d422c4e081e8815c7c0f4cf2930dac24a277/src/browser/session.ts#L44-L95),
[backend access](https://github.com/yannabadie/CGPro4Code/blob/6cc5d422c4e081e8815c7c0f4cf2930dac24a277/src/browser/chatgpt.ts#L121-L131).

### chatgpt-relay: real headless, excluded authentication/identity changes

Pinned revision: `4ffef8c6901a5c9a7d8a8790314a135b593c45e0` (September 21).
Its server launches headless and reads saved storage state. Its latest change
rewrites browser identification to preserve a protection clearance; the login
helper exports cookies/localStorage. The included browser tests validate that
rewriting, not a ChatGPT Pro response. Those mechanisms are not imported into
ProDex, and the source change is not treated as our root-cause diagnosis.
[Server](https://github.com/johnnymo87/chatgpt-relay/blob/4ffef8c6901a5c9a7d8a8790314a135b593c45e0/src/server.js#L30-L59),
[login state export](https://github.com/johnnymo87/chatgpt-relay/blob/4ffef8c6901a5c9a7d8a8790314a135b593c45e0/src/login.js#L123-L131),
[tests](https://github.com/johnnymo87/chatgpt-relay/blob/4ffef8c6901a5c9a7d8a8790314a135b593c45e0/src/user-agent.test.js).

### Preserve authentication ownership; do not confuse a server flag with a browser

Oracle issue 367 reports interactive-session disruption when live session cookies
were copied into another browser. The author's token-rotation explanation is an
upstream report, not a separately verified cause of our 403. It reinforces keeping
the dedicated profile in place rather than treating cookie copying as a harmless
login shortcut. The linked quiet-oracle repository returned HTTP 404 during this
check, so its implementation was not verified.
[Issue 367](https://github.com/steipete/oracle/issues/367).

CodexPro issue 78 and its merged PR 79 explicitly describe noninteractive server
lifecycle, readiness and child cleanup. They do not provide a headless ChatGPT
browser. This is the original project, not the Codex desktop app.
[Issue](https://github.com/rebel0789/codexpro/issues/78),
[merged implementation record](https://github.com/rebel0789/codexpro/pull/79).

The recently updated `AlexPastukhh/chatgpt-headless-sender` search result was also
checked: revision `1aa4b957d537bda52191975b28b1331e2696fd17` contains only an empty
README, not a sender implementation or successful run.
[Pinned tree](https://github.com/AlexPastukhh/chatgpt-headless-sender/tree/1aa4b957d537bda52191975b28b1331e2696fd17).

## Practical order

The local code audit confirms why these are separate gates. The compatibility
record requires Runtime/DOM/input/file checks and a synthetic restart marker; it
does not record an actual authenticated restart. Process ownership verifies the
launched PID, profile and control port, but the aggregate compatibility record
does not join the requested executable to an observed executable hash.
[Evidence builder](../scripts/browser-compatibility.mjs),
[process checks](../src/browser-process.ts).

The browser smoke expects graceful `Browser.close` and separately attempts
owned-process cleanup on failure. Supporting another engine must retain those
ownership protections rather than weakening the Chromium checks to accept any
CDP-looking endpoint. Actual viewport/DPR and environment observations should
also accompany a controlled comparison; configured dimensions alone do not
establish identical rendered conditions.
[Smoke lifecycle](../scripts/browser-launch-smoke.mjs),
[container lifecycle](../containers/browser/service.mjs).

1. Audit requested versus actual executable, profile owner, namespace and build
   without exposing secrets. Keep transport failure separate from confirmed
   main-document protection and from late page/input failures.
2. Qualify any new engine against local fixtures: actual identity, required CDP
   methods or adapter, input/attachment, profile restart and graceful cleanup.
   Compatibility mode must not be mistaken for the existing Chromium security
   and process-ownership contract passing unchanged.
3. Scope one controlled public comparison only after identifying a distinct
   unanswered hypothesis. No automatic retry, login prompt or challenge handling.
   Network differences may be measured, not hidden or rotated to evade protection.
4. Authenticated Pro and exact-thread tests remain a separate gate with explicit
   profile ownership and user participation where required. No public-page pass
   or generic browser benchmark substitutes for those results.

The current operating path stays Xvfb. Pure headless remains an investigation
track, not a promised replacement or an abandoned possibility.

## Verification and publication

- PASS: initial branch/worktree/remote inspection and `git fetch origin`.
- PASS: `npm test -- tests/browser-compatibility-types.test.ts tests/cli-login.test.ts tests/login-container.test.ts tests/login-viewer.test.ts`
  (42 tests, four files). This freshly exercises the earlier declaration and
  guided-login changes before building on their evidence. Test traffic was local
  fixture traffic, not a new ChatGPT browser session.
- PASS: pinned public source/tree/issue inspection through GitHub API; broader
  web/GitHub searches supplied candidates, not proof. No upstream code executed.
- WARN: quiet-oracle was unavailable (HTTP 404); its linked description was not
  promoted to verified implementation. An initial PR 79 lookup used the wrong
  repository and returned 404; the correct CodexPro PR was then retrieved.
- Research/source records are published only on
  `feat/headless-browser-compatibility` and [PR 7](https://github.com/youdie006/prodex/pull/7).
  Document validation, commit/push and CI status are recorded there. No release,
  npm/image publication, installation, M3 execution, MCP reconnect or new runtime
  readiness result is claimed. The user's untracked `Makefile` is untouched.
