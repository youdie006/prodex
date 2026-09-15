# Platform Verification

Open source does not mean every operating system, architecture, filesystem, or
browser version has been tested. This record distinguishes configured CI jobs,
completed checks, installed versions, and live account-dependent behavior.

## Current compatibility work

Branch: `fix/cross-platform-verification`.
Tracking PR: <https://github.com/youdie006/prodex/pull/6>.
Initial matrix commit: `37b1684795271f69afdca492562d99aa9c203e6d`.
CI run: <https://github.com/youdie006/prodex/actions/runs/34964947086>.
Integrated compatibility commit: `8569391d525e15e16e67665dbc19e04da53ee042`.
Integrated CI run: <https://github.com/youdie006/prodex/actions/runs/34970055803>.
Candidate commit: `33646bd4cdffca376f332f103f3c5a00932cf767`.
Candidate CI run: <https://github.com/youdie006/prodex/actions/runs/34974010179>.
Follow-up commit: `afec42d3e7f9f4e82601db6fe553dd742664f54d`.
Follow-up CI run: <https://github.com/youdie006/prodex/actions/runs/34976162000>.

| Environment | Latest completed result | Scope |
| --- | --- | --- |
| Ubuntu 24.04 x64, Node 20/22/24 | PASS | Full release verification on all three CI jobs |
| macOS 15 ARM, Node 22 | PASS at follow-up commit | Full CI release verification; initial path-alias and fixture failures corrected |
| macOS 15 Intel, Node 22 | FAIL at follow-up commit | 1,600 passed, 3 timed out, 4 platform exclusions; prior candidate full verification passed |
| Windows Server 2025 x64, Node 22 | FAIL at follow-up commit | Metadata and headless smoke passed; 1,597 tests passed, 8 failed, 4 exclusions; product checks aborted on incomplete host process identity |
| Windows 11 x64, Node 22.22.0 | Partial at candidate commit | 1,582 passed, 19 failed, 6 exclusions; 14 file-link fixture privilege failures and 5 loaded-run timeouts. The affected 18 product/TUI cases passed in a one-worker rerun without changing their assertions or deadlines |
| WSL Linux x64, Node 22.22.0 | PASS at follow-up commit | Full release verification: 1,604 passed, 0 failed, 3 platform exclusions; earlier real headless browser smoke also passed |
| Physical M3 macOS ARM, Node 22.22.3 | PASS at follow-up commit | 1,603 passed, 0 failed, 4 platform exclusions; full release verification; earlier real headless browser smoke also passed |

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
The final candidate CI and installation checks remain pending.
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
These corrections require a new complete matrix before publication.

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
All five affected cases passed on WSL after this test-only correction. A new
complete matrix is still required; no global or production timeout was raised.
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
