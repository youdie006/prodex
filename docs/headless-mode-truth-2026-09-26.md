# Headless login must verify the running browser

Date: 2026-09-26 (Asia/Seoul). Follow-up source correction after the
[paired public controls](headless-paired-control-2026-09-26.md).

## Defect and scope

`pro browser login --headless` reused an already-reachable browser to avoid
opening duplicate windows. Except in the `--background` flow, its mode check
trusted saved launch metadata. With no saved record or a stale headless record,
a headed browser could therefore reach the headless success message. When a
profile was known, the command could also persist the incorrect mode.

This is a local truthfulness defect, not the cause of the public 403 measurements:
those disposable runs independently verified actual headless process flags on
both initial launch and restart. Fixing a false success message does not remove
the remote protection response.

## Corrected contract

- Before headless reuse, inspect the dedicated process using the existing exact
  port/profile identity helper instead of treating saved mode as runtime proof.
- A headed or unverifiable process cannot authorize a headless login record or
  headless success. The command does not close, restart or replace that browser.
- Verify a newly launched headless process before recording or describing it,
  including a wrapper that ignores the headless option.
- Recheck actual mode after readiness before printing the final headless success
  message, including the wait helper's stderr `login: READY` line. A changed
  browser must not inherit the earlier mode claim.
- Keep the launch record after initial process verification, even if a later
  readiness probe fails. It preserves the chosen profile and launch preference,
  not a claim of current readiness. Deferring that record until readiness would
  lose a new custom profile on control failure or an interrupted login wait.
- Preserve explicit background/visible recovery flows and ordinary headed reuse.
  No new login window, automatic recovery, protection retry or authentication
  transfer is introduced.

## Verification

- Expected RED: `npx vitest run tests/background-login.test.ts -t "refuses a headed reuse|refuses an unverified reused|reuses a genuinely|refuses a new launch|does not report READY"`
  failed all six new cases before the source change (30 skipped). Five paths
  incorrectly succeeded; the genuine-headless case made no identity probe.
- Expected RED: `npx vitest run tests/background-login.test.ts -t "trusts a verified headless process over stale headed metadata"`
  separately exposed the stale virtual-display guard and then the stale
  minimized guard. Both now defer to positively verified headless mode.
- Interim failures: three existing non-auth blocker fixtures lacked an explicit
  genuine-headless process mock; three mocked-launch tests reached the real
  process inspector after the new check. The affected fixtures now declare the
  process mode explicitly, without weakening production identity checks.
- Review exposed a premature stderr `login: READY` before the final mode check.
  Strengthening the replacement regression first reproduced it; the wait helper
  now invokes the caller's final identity guard before announcing readiness.
  A separate regression preserves the initially verified launch identity after
  a later control failure, without claiming READY or modifying the browser.
- PASS: `npx vitest run tests/background-login.test.ts tests/window-mode-lifecycle.test.ts tests/cli-pro-browser-login-wait.test.ts`
  (99 tests), and `npm run typecheck`.
- PASS: `npm run build` and the final `CI=1 npm test` (130 files, 1,862 passed, three
  platform exclusions, zero failures). The suite's isolated browser fixtures do
  not operate the user's account.
- PASS: `npm run smoke:package`, including temporary installed CLI, HTTP and
  stdio MCP, task/write flows, result artifact integrity and normalized release
  packaging. This is a disposable package check, not production installation.
- PASS: `git diff --check`.
- Independent re-review found no remaining P1/P2 issue in this scoped fix.
  The launch-record versus current-readiness distinction above is deliberate;
  the actual mode is rechecked rather than inferred from that historical record.

Publication and additional package/review results are recorded in
[PR 7](https://github.com/youdie006/prodex/pull/7). These checks are not evidence
of authenticated pure-headless acceptance; the public comparison remains blocked.

## Delivery boundary

The source branch is `feat/headless-browser-compatibility`; package version
remains 0.40.18. Building this checkout updates its local `dist` CLI only. Source
publication does not replace either installed browser container or reconnect any
MCP client. Both operating services remain on their previously verified headed
Xvfb images and saved profiles. There is no release tag, npm publication or
image-registry publication for this correction.
