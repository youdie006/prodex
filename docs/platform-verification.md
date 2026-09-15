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

| Environment | Latest completed result | Scope |
| --- | --- | --- |
| Ubuntu 24.04 x64, Node 20/22/24 | PASS | Full release verification on all three CI jobs |
| macOS 15 ARM, Node 22 | PASS at integrated commit | Full CI release verification; initial path-alias and fixture failures corrected |
| macOS 15 Intel, Node 22 | FAIL at integrated commit | 1,596 passed, 1 timing-dependent contention test failed, 4 platform exclusions; deterministic barrier correction pending rerun |
| Windows Server 2025 x64, Node 22 | FAIL | npm subprocess launch corrected; metadata now reports a non-executable packed bin |
| Windows 11 x64, Node 22.22.0 | Partial | Later full suite: 1,567 passed, 30 failed, 6 exclusions; remaining file-link privilege failures and OS-specific fixtures are separate from the passing 48-test storage/credential run and headless browser smoke |
| WSL Linux x64, Node 22.22.0 | PASS at integrated commit | Full suite: 1,598 passed, 0 failed, 3 platform exclusions; typecheck/build, installed package smoke, and real headless browser smoke passed |
| Physical M3 macOS ARM, Node 22.22.3 | PASS at integrated source snapshot | Full release verification passed: tests, typecheck, build, installed package MCP smoke and doctor; real headless browser smoke also passed |

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
