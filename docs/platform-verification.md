# Platform Verification

Open source does not mean every operating system, architecture, filesystem, or
browser version has been tested. This record distinguishes configured CI jobs,
completed checks, installed versions, and live account-dependent behavior.

## Current compatibility work

Branch: `fix/cross-platform-verification`.
Tracking PR: <https://github.com/youdie006/prodex/pull/6>.
Initial matrix commit: `37b1684795271f69afdca492562d99aa9c203e6d`.
CI run: <https://github.com/youdie006/prodex/actions/runs/34964947086>.

| Environment | Initial result | Scope |
| --- | --- | --- |
| Ubuntu 24.04 x64, Node 20/22/24 | PASS | Full release verification on all three CI jobs |
| macOS 15 ARM, Node 22 | Pending | Full release verification in CI |
| macOS 15 Intel, Node 22 | Pending | Full release verification in CI |
| Windows Server 2025 x64, Node 22 | FAIL | Build passed; npm subprocess launch blocked metadata check |
| Windows 11 x64, Node 22.22.0 | Partial | Real native temporary runtime, not WSL; initial full suite: 1,049 passed, 503 failed, 3 skipped |
| WSL Linux x64, Node 22.22.0 | Partial | 94 focused POSIX storage/config tests passed; broader final checks pending |
| Physical M3 macOS ARM, Node 22.22.3 | Pending | Installed 0.40.17 at inventory; this branch is not installed yet |

The Windows initialization and junction regressions failed before correction and
passed afterward. Additional native checks reproduced file replacement and
concurrent initialization failures; their six focused regressions now pass.
The initial Windows suite also lacks file-symlink creation privileges on this
machine. This is recorded separately from product failures; no security test is
declared passed by ignoring an `EPERM` error. Directory-junction checks can run
without granting administrator privileges or changing Windows Developer Mode.

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
