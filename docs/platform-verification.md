# Platform Verification

Open source does not mean every operating system, architecture, filesystem, or
browser version has been tested. This record distinguishes configured CI jobs,
completed checks, installed versions, and live account-dependent behavior.

## Headless Compatibility Candidate (2026-09-16)

Branch: `feat/headless-browser-compatibility`, based on `33bf9fe`.
Package version remains `0.40.18`; these changes are unreleased. A staged
candidate or a passing browser fixture is not an installed service update.

The new optional `pro browser check --runtime` reports local CDP metadata and
actual process mode separately from saved preferences. The account-free browser
smoke now verifies DOM/input/file-selection capabilities and
same-profile restart persistence using only a synthetic loopback-origin marker.
It does not inspect or copy ChatGPT authentication data.

### Account-Dependent Observations

- WSL's existing browser reported login/composer signals and
  `response_in_progress`. It was left untouched; no verification prompt was
  submitted into another session's active conversation. Runtime evidence:
  Chrome `144.0.7559.132`, CDP `1.3`, actual `headed`, saved `virtual-display`.
- Physical M3's existing browser was actually headless and returned
  `cloudflare_check`, with no composer. Runtime evidence: Chrome
  `152.0.7977.84`, CDP `1.3`, actual/saved `headless`. No page reload, login,
  profile migration, visible fallback, or protection bypass was attempted.
- Consequently, this candidate has not demonstrated a new authenticated
  pure-headless Pro answer or continuation on either account target.

### Adoption Decision

The examined [Camoufox gateway](https://github.com/Draivix/chatgpt-gateway/tree/e9b3f6a4e984409d5bd09f0d0eb1544c0c366e31/camoufox-gateway)
uses a Python/Firefox control stack, not ProDex's Chromium CDP implementation.
Its persistent daemon/profile ideas do not justify replacing ProDex's existing
task storage, send serialization, and exact-thread continuation. Its README
marks macOS untested; no cross-platform Pro success is inferred from it.
No upstream source code, stealth configuration, password/IMAP login automation,
or authentication material was adopted. An ordinary second browser driver
would require separate implementation and live acceptance evidence, not simply
setting `PRODEX_CHROME` to a Firefox executable.

### Verification Results

- PASS: 39 runtime/product-check regressions and TypeScript typecheck. New CLI
  flag tests first failed with `Unknown option ... --runtime`, then passed.
- PASS: native Windows and M3 candidate `check --runtime --help` without tmux
  or browser side effects. Windows used temporary Node `22.22.0` x64, verified
  against the distribution SHA-256; M3 used its existing Node `22.22.3` ARM.
- FAIL: direct release metadata check on the Windows-mounted source tree found
  unexpected executable modes on non-bin files. The existing normalized
  `release:pack` path passed its unchanged strict metadata check and produced
  a candidate tarball. At that point, uncommitted changes correctly blocked
  publication guidance; no publication was attempted.
- PASS: the final reviewed Linux-filesystem snapshot passed all 117 test files:
  1,667 passed, zero failed, three platform exclusions. Source/test/script bytes
  were compared with the working tree. Command:
  `node node_modules/vitest/vitest.mjs run --maxWorkers=4 --reporter=json --outputFile=/tmp/prodex-headless-vitest-reviewed.json`.
  Typecheck and build also passed. The final canonical-temp-path adjustment was
  subsequently verified by the native browser smokes.
- FAIL: the Windows-mounted source run passed 1,662 tests but had three CLI
  startup/stdio-connection timeouts and three platform exclusions. The three
  timeouts persisted in a focused rerun. Identical source on the Linux
  filesystem passed; mounted-source startup performance is not claimed fixed.
  No timeout or security assertion was relaxed to obtain the passing result.
- FAIL (verification setup): the first Linux snapshot omitted `.github`, causing
  seven workflow-file checks to fail with `ENOENT`. Copying the unchanged
  workflows and rerunning the full suite resolved these setup errors.
- Independent review led to cleanup ownership hardening: each recorded PID must
  still match its browser/profile before receiving a signal, successor browsers
  are refused, and recorded orphan children can be cleaned up. Both new
  regressions failed before implementation, then passed. Pre-spawn launcher
  failures were reviewed; no concrete unhandled post-spawn throw was found.

### Completed Native Browser Checks

All rows used ordinary Chromium-family browsers, fresh temporary profiles and
loopback-only fixture pages. Every pass includes actual headless process proof,
Runtime enable/evaluation, DOM control, keyboard and mouse input, synthetic file
selection, a graceful browser restart preserving the local marker, and confirmed
browser/server cleanup. No row tests ChatGPT or a logged-in account.

| Target | Browser product | CDP | Result |
| --- | --- | --- | --- |
| WSL Linux x64, Node 22.22.0 | Chrome/144.0.7559.132 | 1.3 | PASS |
| Physical M3 macOS ARM, Node 22.22.3 | Chrome/152.0.7977.84 | 1.3 | PASS |
| Native Windows x64, temporary Node 22.22.0 | Chrome/153.0.8010.36 | 1.3 | PASS |
| Native Windows x64, temporary Node 22.22.0 | Edg/153.0.4234.32 | 1.3 | PASS |

Commands: `npm run smoke:browser` on WSL; the same
`node scripts/browser-launch-smoke.mjs` on native Windows/M3, with an explicit
`PRODEX_CHROME` path only for Edge. The copied M3 smoke/helper and runtime module
SHA-256 hashes matched the local tested files. Candidate package smoke also
passed installed CLI, HTTP MCP and stdio MCP, storage/write/artifact integrity,
doctor, and credential-isolated publication dry-run checks. None of these
temporary installations replaced the global CLI or a client-managed MCP.

One intermediate Windows Chrome rerun stopped when CIM returned incomplete
process identity during a bounded recheck. Cleanup completed. A bounded rerun
and the final canonical-profile Chrome/Edge runs passed with unchanged strict
identity requirements; the intermediate failure is not discarded. Native
browser capability tests are separate from full Windows/macOS unit-suite CI.

No release tag was created and no npm package or global installation was
updated. The PR records the pushed source commit and native CI result separately
from these local checks. Existing MCP clients and account browsers were not
restarted. The Chromium engine was retained; no Firefox/Camoufox adapter was
installed or advertised as supported.

### WSL Source Dependencies

Follow-up on 2026-09-16, unchanged runtime source `970a74f`: the mounted-source
startup failure was reproduced with
`timeout --kill-after=3s 15s node prodex.mjs --version` (exit 124 after 15.07s).
`findmnt` identified the dependency directory as a Windows `9p` mount, while
the Linux home directory was `ext4`. Identical compiled files in the earlier
Linux-filesystem snapshot started in about one second. Direct MCP SDK imports
on the mount also exceeded their bound; this was dependency-loading overhead,
not a broken stdio protocol or incorrect `--cwd` handling.

The local repair keeps the checkout under `/mnt/d` and installs the unchanged
lockfile into a fresh directory under `$HOME/.cache/prodex/source-deps/`.
The checkout's `node_modules` is now a symlink to that Linux installation.
The original dependency tree and manifests were retained in a sibling backup
directory outside the checkout. Lockfile SHA-256 before/after:
`54b5a93764e6f4e40a2ea66f3f4126afb32d2a1c7b72f7a2c997cdde931ab703`.
Installed source package version remains `0.40.18`, using Node `22.22.0`.
No global CLI, account profile, browser process or client-managed MCP was
replaced or restarted.

The same version command then passed in 5.02s; `node dist/cli.js --version`
passed in 3.52s. All four focused package-bin/explicit-cwd stdio checks passed
on the original mounted checkout, including the three previously failing
cases. The stdio case completed in 4.79s. Existing subprocess/test deadlines
were unchanged. Full follow-up verification is recorded on PR #7.

The first full run after relocation passed 1,666 tests with one failure and
three platform exclusions. All original startup failures passed; the remaining
failure was an HTTP test fixture that emitted synthetic `SIGTERM` after 50ms,
before slow startup had registered its shutdown listener. The fixture now waits
for the listening/readiness output before signaling and awaits teardown in
`finally`. No production shutdown logic or deadline was changed. This first
failed run is retained separately from the subsequent verification results.

Final verification from the original mounted checkout:

- PASS: `npm test -- --reporter=json --outputFile=/tmp/prodex-mounted-ext4-deps-final.json`
  completed all 117 files: 1,667 passed, zero failed, three platform exclusions,
  about 185s. Default worker settings and all existing deadlines were retained.
- PASS: `npm run typecheck`, `npm run build`, and `npm run smoke:package`.
  The package check covered installed CLI, HTTP/stdio MCP, task/result storage,
  write and artifact integrity, doctor and credential-isolated publication
  dry runs. It did not publish or replace a global installation.
- PASS: `git check-ignore -v --no-index node_modules` after correcting the
  ignore rule; before correction the symlink was untracked and not ignored.
- WARN: fresh `npm ci` reported an unapproved esbuild postinstall script.
  No script-approval policy was changed; the installed optional platform binary
  was sufficient for the subsequent passing tests, typecheck and build.

Runtime sources, build scripts and dependency manifests remain unchanged from
`970a74f`; this follow-up changes the development setup records, dependency
ignore rule and one test fixture. The PR records its own pushed commit and
subsequent CI separately from the previously completed six-platform matrix.

For a similar WSL setup:

1. Prefer placing the whole development checkout under the Linux home directory.
   Use the split arrangement only when Windows-mounted source files are needed.
2. Create a persistent, project-specific directory on Linux, copy only
   `package.json` and `package-lock.json` there, and run
   `npm ci --prefix <linux-dependency-directory>`. Do not copy credentials,
   `.bridge`, or browser profiles into a dependency cache.
3. After stopping source-development commands that use that dependency tree,
   retain the existing `node_modules` as a backup outside the checkout and
   symlink the new directory's `node_modules` into the checkout. Inspect any
   existing link before replacing it. Do not commit a machine-specific link.
4. Run `npm run build` and the tests from the original checkout. After lockfile
   changes, update the two cached manifests and rerun `npm ci` at the cache
   prefix. A plain `npm ci` in the mounted checkout can replace the link and
   reintroduce mounted dependencies.

This is a WSL development arrangement, not a portable dependency bundle. Native
Windows needs its own dependency installation, as do other operating systems
and architectures. Keep the cache until the source checkout no longer uses it;
the link target is inspectable with `readlink node_modules`.

The M3 follow-up separately confirmed one actual headless, non-incognito Chrome
process using the same saved profile, and exactly one ChatGPT root tab with a
human-verification title. The product check still returned `cloudflare_check`.
Neither incorrect target selection nor a replacement profile explains that
observed blocker. No navigation, visible login, authentication reset, protective
check bypass, or Pro prompt was performed. Dependency placement on WSL does not
remove that external account-access requirement.

## Login Redirect Window Regression (2026-09-16)

Follow-up to `a16e723` on `feat/headless-browser-compatibility`; package version
remains `0.40.18` and the fix is unreleased.

During the user's manual visible recovery on M3, read-only CDP target metadata
showed three Google authentication pages. One subsequently moved through
OpenAI authentication and returned to ChatGPT. A separate Chrome account/profile
connection popup was also present. The same dedicated browser process and saved
profile remained in use; this was not a new profile or proof that saved
authentication had been deleted. No provider page content, authentication URL
parameters, cookies or tokens were inspected.

The login wait treated every poll with no `chatgpt.com` target as permission to
open another tab. Authentication redirects therefore looked like missing tabs.
The fix recognizes the observed authentication hosts as a pending manual step,
never selects them for ChatGPT page control, and bounds a login wait to at most
one initial tab-opening attempt. Once a reachable non-missing page state has
been observed, the wait does not replace that authentication flow. Opening
failures remain visible but no longer cause repeated automatic openings.

After the user completed sign-in, a read-only product check reported
`logged_in=true` and `composer=true` on the ChatGPT root page. Actual browser
mode was still headed, with `resume_headless=true` saved for a later launch.
This is not proof of a completed headless handoff or a verified Pro answer.
The SSH-home product check exited 1 for missing local bridge/config/receipt
state, separately from its successful ChatGPT readiness result.

No account browser or client-managed MCP was restarted by this investigation,
and no visible window, authentication reset, or Pro prompt was initiated.
Source fixes and their deployment status are recorded separately from the
user's successful sign-in.

Verification:

- Expected regression failures before implementation: the login-wait suite
  failed four repeat-opening assertions; the auth-redirect suite failed five
  classifier/status/no-extra-tab assertions. A later wording refinement also
  failed its two assertions before being applied.
- PASS: focused browser/login/handoff checks (228 tests), followed by
  `npm test -- --reporter=json --outputFile=/tmp/prodex-auth-redirect-final.json`:
  118 files, 1,687 passed, zero failed, three platform exclusions, about 99s.
  The 18 auth-redirect checks include exact-origin filtering, provider-content
  isolation, explicit-target safety, and headed/headless login waits.
- PASS: `npm run typecheck`, `npm run build`, `git diff --check`, and
  `npm run smoke:package` (installed CLI, HTTP/stdio MCP, storage/write/artifact
  checks and credential-isolated publication dry runs; no publication).
- Native OS CI, package installation and any headless handoff are separate
  verification steps; the unit results do not establish account access.

## 0.40.18 verification

Branch: `fix/cross-platform-verification`.
Tracking PR: <https://github.com/youdie006/prodex/pull/6>.
Verified runtime commit: `ba9551be75586b7ab603964a6cbf117483578766`.
Completed six-job CI: <https://github.com/youdie006/prodex/actions/runs/34980308069>.
Final release/publication and machine installation records are kept in the
version-specific GitHub Release; this source verification is not an installation
or an existing-client reconnection claim.

| Environment | Completed result at verified runtime commit | Scope |
| --- | --- | --- |
| Ubuntu 24.04 x64, Node 20/22/24 | PASS | Each job: 1,614 passed, 0 failed, 3 platform exclusions; full release verification and headless smoke |
| macOS 15 ARM, Node 22 | PASS | 1,613 passed, 0 failed, 4 platform exclusions; full release verification and headless smoke |
| macOS 15 Intel, Node 22 | PASS | 1,613 passed, 0 failed, 4 platform exclusions; full release verification and headless smoke |
| Windows Server 2025 x64, Node 22 | PASS | 1,615 passed, 0 failed, 4 platform exclusions; metadata, installed-package verification and headless smoke |
| Windows 11 x64, Node 22.22.0 | Partial native verification | Actual installed command and fresh MCP passed; 42 CLI/product checks and 7 service-error checks passed. Local full security fixtures require file-symlink privileges and are not claimed as passed |
| WSL Linux x64, Node 22.22.0 | PASS | Full release verification: 1,614 passed, 0 failed, 3 platform exclusions; earlier real headless browser smoke also passed |
| Physical M3 macOS ARM, Node 22.22.3 | PASS | Full release verification: 1,613 passed, 0 failed, 4 platform exclusions; earlier real headless browser smoke also passed |

## Earlier attempts

Initial matrix commit: `37b1684795271f69afdca492562d99aa9c203e6d`.
CI run: <https://github.com/youdie006/prodex/actions/runs/34964947086>.
Integrated compatibility commit: `8569391d525e15e16e67665dbc19e04da53ee042`.
Integrated CI run: <https://github.com/youdie006/prodex/actions/runs/34970055803>.
Candidate commit: `33646bd4cdffca376f332f103f3c5a00932cf767`.
Candidate CI run: <https://github.com/youdie006/prodex/actions/runs/34974010179>.
Follow-up commit: `afec42d3e7f9f4e82601db6fe553dd742664f54d`.
Follow-up CI run: <https://github.com/youdie006/prodex/actions/runs/34976162000>.

The Windows initialization and junction regressions failed before correction and
passed afterward. Additional native checks reproduced file replacement and
concurrent initialization failures; their six focused regressions now pass.
The additional concurrent gitignore replacement regression passed on native
Windows after both initializers adopted the same verified, idempotent write path.
The later 48-test Windows run also passed the original concurrent follow-up
reservation test, npm credential-isolated dry runs, and anchored writer checks.
M3's first integrated command incorrectly exported `PRODEX_NO_AUTO_LOGIN=1`,
which disabled five mocked recovery tests. The complete release-verification
command passed after removing that conflicting harness override. No account
browser or login profile was used by those mocked tests.
The initial Windows suite also lacks file-symlink creation privileges on this
machine. This is recorded separately from product failures; no security test is
declared passed by ignoring an `EPERM` error. Directory-junction checks can run
without granting administrator privileges or changing Windows Developer Mode.

Candidate 0.40.18 uses the unique root bin `prodex.mjs`: native npm produced
archive modes 0755 for that bin and 0644 for `dist/cli.js` and `LICENSE`.
The native metadata check and independent tar-header inspection passed. An
initial root name `cli.js` was rejected because npm also marked the same-named
nested compiled file executable. Strict release checks were not relaxed.
WSL's installed-package smoke passed for the corrected 0.40.18 candidate.
At that point, final candidate CI and installation checks were still pending.
Native Windows focused reruns passed the 11 CLI regressions, two browser-send
and profile cases, and all 21 release-pack tests. The candidate package smoke
passed its formerly failing archive-mode check, then stopped at a real file
symlink creation `EPERM`; that run is partial, not a package-smoke pass.
The three link-swap regressions now assert their fixture was actually installed,
so an unsupported symlink operation cannot masquerade as a rejected attack.

One local staging attempt began before its source archive finished writing and
failed with a truncated TypeScript file. That invalid snapshot was discarded;
the complete archive was extracted and source hashes checked before rerunning.
This was a verification setup failure, not accepted product evidence.

The candidate Windows CI failure was reproduced locally by inheriting uppercase
`NPM_EXECPATH`. It silently displaced explicit lowercase overrides, causing real
npm to run instead of the intended fixture. After normalizing environment names
before subprocess creation, the native npm/release suites passed 54 tests with
one POSIX-only exclusion; their two file-symlink cases still failed with `EPERM`.
The matching WSL checks passed 91 tests with one Windows-only exclusion.
Follow-up changes also canonicalize Windows temporary paths, retain private-mode
assertions only where POSIX modes apply, bound Windows file concurrency to four,
and give the four-consult approval-renewal test a separate 60-second deadline.
Those corrections required the subsequent complete matrix before publication.

Follow-up commit `afec42d3e7f9f4e82601db6fe553dd742664f54d` was tested in
<https://github.com/youdie006/prodex/actions/runs/34976162000>. Ubuntu Node
20/22/24 and macOS ARM passed. Windows passed 1,597 tests with 8 failures and
4 platform exclusions: every failure was an unhandled process-inspection error
in product diagnostics. The strict Windows identity parser correctly refused
incomplete process records, but diagnostics incorrectly aborted the rest of the
report. The new regression reproduced that crash before correction. The fix
reports an unknown-identity blocker without login/reset guidance, keeps shutdown
ownership checks strict, and isolates refused-connection fixtures from the host's
real process table. Focused checks passed on native Windows (42 tests) and WSL
(49 tests); typecheck and the npm-helper declaration type probe also passed.
macOS Intel passed 1,600 tests with 4 exclusions and three 30-second timeouts:
the paired project-warning cases, paired terminal-state cases, and eight-task
concurrent creation. The independent cases are now separate tests, and the
concurrent case retains all eight tasks with a dedicated 60-second deadline.
All five affected cases passed on WSL after this test-only correction. The
subsequent complete matrix passed; no global or production timeout was raised.
The two affected storage/send files also passed all 178 tests on physical M3.

The user subsequently reported a rendered Cloudflare 502 page. Seven focused
regressions verify service-error classification, exclusion of ordinary chat
content, genuine authentication/protection precedence, and no automatic resend
after submission on both WSL and native Windows. The full affected browser,
process and product-check files passed 173 tests on WSL; typecheck passed.
The page error itself is upstream; these
simulated checks do not establish restored ChatGPT availability or a new live
Pro answer, and no visible login window or account profile reset was attempted.

The same `afec42d` snapshot passed full `CI=1 npm run release:verify` on WSL
(1,604 tests, 3 platform exclusions) and physical M3 (1,603 tests, 4 exclusions),
including installed-package checks. Native Windows installed the candidate into
a temporary consumer path containing spaces; its actual `prodex.cmd` launched a
fresh non-tmux MCP, reported 0.40.18 and 20 tools, and read the intended explicit
working-directory fixture. The transport exited and left no matching child
process. These are isolated candidate installs, not global deployment or public
publication. Existing account browsers and the attached MCP were not restarted.

## What each check proves

- Unit/integration tests: local ledger, routing, path policy, and simulated UI.
- Package smoke: installed CLI and MCP transports against disposable local data.
- Browser launch smoke: a fresh headless profile with `about:blank`, CDP readiness,
  script evaluation, owned-process shutdown, and cleanup. No ChatGPT login.
- Live Pro verification: a separate, manually triggered account test with request
  identity, model evidence, and saved result validation. None of the checks above
  substitutes for this test.

## Limits and prerequisites

- Node 20+, Git, ripgrep, and a supported Chromium-family browser are prerequisites.
- Virtual display requires Linux/WSL, Xvfb and xauth. Native macOS and Windows do
  not support this mode; they must report that limitation without opening a window.
- WSL uses a Linux browser/profile. Native Windows browser discovery is not WSL
  cross-host browser support.
- Native Windows storage inherits Windows ACLs. See [SECURITY.md](../SECURITY.md#local-storage-permissions).
- Generated native Windows commands target PowerShell, not `cmd.exe`; compound
  examples with `&&` require PowerShell 7. Internal subprocesses use literal argv.
- Authentication, CAPTCHA, Cloudflare, permissions, and usage limits remain
  explicit blockers. No automatic visible fallback or protection bypass is tested.
- ARM Windows, Linux ARM, BSD, containers without browser dependencies, and every
  historical OS/browser version are not covered by this matrix.

## Installation and running processes

At the start of this work WSL and M3 had CLI 0.40.17 installed. The MCP attached to
the existing Codex client still had 0.40.16 loaded. Updating a package on disk does
not reconnect that MCP or change an already-running browser's mode. No client
restart has been performed in this verification task.

The previously verified WSL no-desktop-window session uses ordinary headed Chrome
on a private virtual display. It is not pure headless Chrome. M3's prior pure
headless ChatGPT check stopped at Cloudflare. Neither installing this branch nor
passing a no-account browser launch test removes that account-dependent blocker.

After the reported 502, bounded read-only probes on 2026-09-15 at approximately
14:38 UTC used the tested candidate adapter against the existing dedicated
browsers. WSL was reachable with saved-login signals and a composer, with no
blocker. M3 was reachable but returned `cloudflare_check`, not a 502. Neither
probe opened a browser, changed profiles, reloaded a page, logged in, or sent a
prompt. WSL readiness does not prove the upstream error's cause or a new Pro
answer; M3 authenticated pure-headless access remains blocked.
