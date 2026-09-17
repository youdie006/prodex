# Stock Chrome candidate comparison

Date: 2026-09-17. Follow-up to the [native-mode comparison](headless-mode-comparison-2026-09-17.md),
authorized to test a materially different ordinary browser without replacing
the working login service or bypassing protective measures.

## Results

| Target | Chrome 153 mode | Local capabilities | ChatGPT public navigation |
| --- | --- | --- | --- |
| WSL x64 | Pure headless | PASS | HTTP 403, protection-page title, no composer |
| WSL x64 | Xvfb virtual display | PASS | FAIL: 10-second `Page.navigate` timeout; no site result captured |
| M3 Linux ARM64 VM | Pure headless | PASS | HTTP 403, protection-page title, no composer |
| M3 Linux ARM64 VM | Xvfb virtual display | PASS | FAIL: 10-second `Page.navigate` timeout; no site result captured |

Both virtual-display modes also passed separate network-disabled sandbox-page
checks. Those follow-ups do not resolve the online timeouts. The original probe
did not preserve whether its sandbox or public navigation timed out; do not
invent an HTTP status or call those two failures Cloudflare blocks.

The headless observations independently recorded the public document's HTTP
status, a `Just a moment` title match, completed DOM, and absent composer. They
are not explained by the separately discovered sidebar-label false positive.
Specific challenge-element and human-verification-body-text predicates were
false, and are retained as such in [the JSON evidence](stock-chrome-comparison-2026-09-17.json).
A probe's exit zero means that it measured the block, not that access passed.

No login, prompt, Pro selection, answer, or continuation was attempted. No
authenticated headless acceptance or general reliability claim follows from
these results. The existing verified virtual-display service remains the default.

## Upstream source and artifacts

The [pinned Chrome for Testing URL implementation](https://github.com/GoogleChromeLabs/chrome-for-testing/blob/49df3201407c3640a8f9465ace6ad8166ab77d3c/url-utils.mjs)
includes Linux x64 and ARM64 release artifacts. The vendor's structured release
manifest, timestamped `2026-09-16T22:17:43.773Z`, identified Stable
`153.0.8010.47` for both platforms. Download URLs and measured archive SHA-256
values are retained in the JSON record. These locally measured hashes are not
publisher signatures.

Both vendor archives were extracted without modifying their contents. Initial
image verification found root-owned, mode-0600 `deb.deps` unreadable to UID 1000;
the isolated image was rebuilt with `COPY --chown=node:node`. Hash-and-size
comparison of all 303 regular files per architecture then passed against the
extracted archives, including after adding the corrected smoke script.

Changing from packaged Chromium 152 to stock Chrome 153 changes both build/vendor
and version. This does not isolate a version-only effect or explain Cloudflare's
decision. No identity patches, alternate proxy, cookie/profile transfer, hidden
endpoint, or challenge interaction was used.

The word `headless` is not sufficient upstream evidence. In
[CodexPro's pinned launcher](https://github.com/rebel0789/codexpro/blob/d66a2503621fca5b6dd732786a26be855f2c979c/scripts/codexpro.mjs#L2961),
that option suppresses clipboard use, browser opening, and the interactive
control panel while retaining the local server. It is not evidence that its
ChatGPT browser runs in Chrome's pure-headless mode.

## Method and boundaries

Each candidate was built on its existing architecture-native experimental
container image, retaining package `0.40.18` and selecting the stock executable
at `/opt/prodex-cft/chrome` through `PRODEX_CHROME`. Only the disposable smoke
script was overlaid; the new product classifier was not installed in those
images. Final candidate image IDs are pinned in every JSON trial row.

Every trial used a new `--rm --init --read-only` container, UID 1000,
`--cap-drop ALL`, `no-new-privileges`, and the existing seccomp profile. Resource
limits were two CPUs, 2 GiB RAM, 1 GiB shared memory, 256 PIDs, and separate
256 MiB tmpfs mounts for `/tmp` and `/home/node`. There were no saved profile
volumes, host-directory mounts, or published ports.

The four capability checks ran with `--network none`:

```sh
env -u DISPLAY -u XAUTHORITY -u WAYLAND_DISPLAY node scripts/browser-launch-smoke.mjs
xvfb-run -a -s '-screen 0 1440x900x24 -nolisten tcp' node scripts/browser-launch-smoke.mjs --headed
```

Each checked actual launched process identity/mode, `Runtime.enable`, DOM
evaluation, keyboard/mouse input, synthetic file selection, same-profile restart
marker, graceful browser close, and cleanup. Initial x64 execution exposed
`expected one loopback fixture page, found 2`; the fix pins readiness to the
exact navigated target ID plus URL rather than treating restored same-URL tabs
as the requested page. The four final runs passed with the corrected script.

After local checks, one public probe per mode/target used ordinary Docker
networking and a fresh tmpfs profile. The probe verified PID/profile/port, actual
launch mode, retained sandbox flags, and namespace/seccomp diagnostics before
issuing at most one `Page.navigate` to `https://chatgpt.com/`. It read only
allowlisted HTTP/DOM/status fields, not headers, cookies, tokens, conversation
contents, or account identifiers. CDP commands had a 10-second deadline and the
outer wrapper a 90-second limit. No online retry followed a blocker or timeout.
The later virtual-mode diagnostic checks had networking disabled and issued
zero public navigations. All ten final trial containers were removed.

## Product corrections

- Status and answer snapshots now keep separate blocker-safe control labels,
  excluding navigation and conversation content. Previously a sidebar title
  such as `Just a moment...` could trigger `cloudflare_check` despite the text
  scan already excluding navigation. Genuine non-navigation protection, login,
  and limit evidence still blocks; exact login/signup controls remain valid
  even inside navigation and with an anonymous composer. Regular visible labels
  remain available for login and response-generation detection.
- The account-free restart smoke follows the CDP target it actually navigated.
  Other tabs with the same fixture URL neither fail that pinned lookup nor
  satisfy it when its target is missing or at the wrong URL. Unpinned ambiguous
  lookups still fail instead of selecting an arbitrary tab.

These are correctness fixes, not a protection bypass or a fix for the observed
headless HTTP 403. Tests first reproduced each failure before implementation.

## Source and package verification

- PASS: `npm test` (123 files, 1,755 passed, 3 skipped) after both fixes. An
  earlier full run exposed a login regression; the final auth-control handling
  corrected it instead of changing its expected result.
- PASS: independent focused run of `tests/browser-launch-smoke-options.test.ts`,
  `tests/chatgpt-browser.test.ts`, `tests/chatgpt-browser-selection.test.ts`, and
  `tests/chatgpt-browser-auth-redirect.test.ts` (207 tests).
- PASS: `npm run typecheck`, `npm run build`, and `npm run smoke:package`.
  Installed-package HTTP/stdio MCP, writes, receipts, artifact tamper rejection,
  CLI, and onboarding checks used isolated fixtures, not the account.
- FAIL on the Windows-mounted checkout: `npm run release:check -- --metadata-only`
  rejected executable bits on 49 ordinary packed files. No source chmod or
  metadata churn was applied to hide this environment-specific failure.
- PASS: the existing `npm run release:pack -- --pack-destination <temporary-dir>`
  path rebuilt source, normalized modes in a private Linux-backed staging copy,
  validated package metadata, and produced the test tarball. The existing
  `publishTarballDryRun` helper passed against its read-only loopback registry
  with GET requests only. No package was published. Its git publication gate
  correctly remained blocked while this worktree was uncommitted.
- PASS with existing configuration warnings: `node dist/cli.js doctor` completed
  its synthetic MCP checks. It also reported the local non-expiring token and
  an unrelated HTTP listener on configured port 8787; neither was modified.
- PASS: independent final code review, document local-link/ASCII checks,
  structured validation of all ten final trial records, and `git diff --check`.

The test tarball is a private validation artifact of unreleased source, not a
replacement publication of version `0.40.18`. Native remote CI results for the
source commit are tracked in the PR separately; local Linux checks are not
reported as native Windows or macOS passes.

## Installation and publication scope

WSL's original image/start time remained
`sha256:1f5cf6a36323635c2f03bd3b011f89f9e5223cc955f10737bd187de7e89cfd18` /
`2026-09-17T04:36:34.956128153Z`. A final read-only check returned reachable,
logged-in-likely, composer present, and no blocker; the service remained healthy.
No re-login or container restart was needed.

M3's original image/start time remained
`sha256:73de64cca2889500e7683dd10e269cbf05f8997e6830d09641e44047cee5d6ac` /
`2026-09-17T03:11:22.942538376Z`. It remained healthy and separately reported
`login_required`; this test did not supply its first login. The existing SSH
viewer tunnel remained alive. No host browser, current Codex, MCP configuration,
authentication volume, or installed service was replaced.

The two stock-browser images are retained only under the experimental local tag
`prodex-browser:stock-chrome-153-check`. Repository corrections and evidence are
source changes on `feat/headless-browser-compatibility`, not an npm publication,
GitHub Release, installed runtime upgrade, or change of browser default. The
version-specific publication record is therefore not advanced by this trial.
The corresponding [PR](https://github.com/youdie006/prodex/pull/7) records the
source commit and remote CI results separately from the retained installation.
