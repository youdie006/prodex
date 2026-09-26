# Model and project selector incident: 2026-09-26

## Report and reproduction

The harness_eg report identified two consultations that stopped before prompt
submission: the saved `Codex` project was not found, and an explicit
`--no-project` attempt could not open the model menu. Earlier successful
consultations do not identify the exact time or cause of the UI rollout.
The reported task files were not present in the initially inspected bridge;
their historical contents were not reconstructed at that stage. The reporter
later supplied the actual working directory; see the follow-up below.

The installed WSL host CLI reproduced the false-positive health check: saved
defaults were `model=Pro, project=Codex`, while the command returned `chatgpt: ok`
based only on a logged-in session and an available composer.

Bounded DOM inspection of that running browser confirmed:

- No old project-option labels or project-folder test IDs were present.
  The actual row had `data-app-action-sidebar-project-label="Codex"` and
  a nested `New chat in Codex` button.
- The `Select ChatGPT model` trigger opened a real Radix menu, but the old
  `composer-intelligence-picker-content` test ID was absent. The old menu-open
  expression returned false even while the trigger reported expanded.
- The visible reasoning keyboard owner wrapped an `aria-hidden` slider thumb.
  Focusing that hidden thumb could not reliably move the reasoning control.
- The unhovered project button's center was clipped outside its row. Hovering
  the project row revealed it and moved its coordinates. Finding a rectangle
  alone was therefore insufficient evidence of a usable project action.

These observations explain the currently reproduced failures. They do not
establish an account failure, cross-session prompt interference, or an upstream
change at a particular minute.

## Correction and scope

Picker discovery retains the old layout and supports the measured current
layout using the unique trigger, `aria-controls`, menu role and reciprocal
`aria-labelledby` relationship. It does not take an arbitrary menu or slider
elsewhere in the document. Keyboard focus uses the measured reasoning owner.

Project matching remains exact, with only an unambiguous case-insensitive
fallback. Actions/options menus, substring matches, duplicate names and missing
new-chat controls do not authorize a project selection.
The locator hovers the identified row, resolves the revealed button again,
then requires the hit-test to reach that button or its descendant. The final
click retains that strict rule; hitting a containing row is not sufficient.

The health check now resolves the same effective defaults as a send. With
configured selectors it takes the shared send lock without waiting, rechecks
the live page, refuses drafts and open overlays, opens the model menu, and
inspects the bounded effort ladder. Original model/effort restoration, original
URL and menu closure must be verified. Unknown sub-modes or uninspected model
and effort combinations remain unverified, not silently accepted.
Unselected model controls require strict hover hit-testing; unsupported model
submenus do not pass. Cleanup has a separate five-second ceiling, attempts
menu closure even after a restoration read fails, and never drives the picker
after detecting an external conversation change.

Project health checks inspect the navigation control without entering the
project. They cannot guarantee that the subsequent page will load or that an
answer will be generated. No defaults means an explicitly labelled
`scope=session-only` check, not verification of Pro. A busy browser with
configured selectors is unverified and exits nonzero; it is not a login error.

The check never submits a prompt, navigates a conversation, starts a browser,
opens login, or retries an authentication/protection blocker. Selector
verification is not proof of the response's underlying model.

## Verification ledger

- RED: four current-picker regressions, eight current-project regressions and
  nine no-send selector-check regressions failed before implementation.
- PASS: 21 initial focused browser tests after implementation. The two first
  probe failures after implementation were a test fixture using `keyDown`
  instead of the adapter's real `rawKeyDown`; correcting that fixture passed.
- PASS: actual WSL host browser no-send probe opened the current menu, read
  `Instant / Medium / High / Extra High / Pro`, and verified original-setting
  restoration, menu closure and unchanged conversation URL.
- PASS: a separate lock-held, empty-composer project navigation test after row
  hover reached a project URL and the exact `New chat in Codex` composer,
  then restored the original conversation. Zero prompts were sent. The first
  diagnostic stopped before input because it assumed a legacy composer ID;
  the corrected guard then exposed the clipped button before any click.
- FAIL, corrected before final rerun: first full suite had 1,911 passes, three skips
  and one failure. New defaults-error output had not rewritten source-checkout
  remediation commands. The existing regression caught it; no assertion was
  relaxed.
- FAIL, corrected before final rerun: the next full suite had 1,917 passes,
  three skips and one old help-text expectation; package smoke also caught
  the same obsolete `--timeout-ms 1500` example. Both expectations now require
  the documented 15-second example, sufficient for selector inspection.
- PASS: 217 focused browser tests after the strict model-hit and cleanup fixes.
  Cleanup-read failure, external navigation, covered model controls and
  unsupported submenus had dedicated failing regressions before correction.
- PASS: the completed project-hover helper itself, starting with the pointer
  away from the sidebar, reached the exact project composer and project URL,
  then restored the original conversation. This supersedes the earlier manual
  hover prerequisite. The built CLI check against the initially assumed repository's
  defaults returned `readiness=VERIFIED`, `model-menu=OPENED`, model `Pro`
  verified and project `Codex` verified by strict hover hit-testing, exit zero.

- PASS: final `npm test -- --reporter=dot`, 1,921 passed, three skipped,
  134 files, zero failures (136 seconds). The preceding green full run had
  1,920 passes; the final extra case rejects checked submenu rows as selected
  models. Final focused selector tests: 62 passes across four files.
- PASS: final `npm run typecheck`, `npm run build`, `git diff --check`, and
  normalized `node scripts/release-pack.mjs --pack-destination <private-temp>`.
- PASS: `npm run smoke:package`, including installed CLI, HTTP/stdio MCP,
  task/result integrity, repo write gates and isolated publication dry runs.
  That complete packaging run preceded the final one-line checked-radio guard;
  the final guard has the subsequent full regression, build and live no-send
  check above, not a second full package-smoke claim.
- Independent review found the hover, cleanup and selected-submenu issues
  described above. They were fixed and covered by failing-then-passing tests;
  the final focused review found no remaining blocker.

Private conversation URLs, account data, project IDs and task contents are not
included in this record.

## Delivery boundary

Target branch: `feat/headless-browser-compatibility`,
[PR 7](https://github.com/youdie006/prodex/pull/7). Package version remains
`0.40.18`; any local candidate must be identified by source commit and hashes,
not by implying a new npm version. No release tag or public publication is
part of this incident correction. Existing WSL/M3 containers and already
attached MCP processes are separate deployments; a source build does not
replace them. No deferred harness decision prompt is automatically resent.

### WSL host installation

On 2026-09-26 at approximately 07:58 UTC, the normalized local candidate was
installed into the existing Node 22.22.0 global `@youdie006/prodex` location,
under the fail-fast browser send lock. The previous package was backed up in
a private temporary directory before installation. The install used
`npm install --global --ignore-scripts --no-audit --no-fund <local-tarball>`;
no login data, browser profile, browser process, container or attached MCP
process was replaced or restarted.

Installed development package version: `0.40.18`. Identity is pinned by:

| Artifact | SHA-256 |
| --- | --- |
| Candidate tarball | `9e43b2568d9a278466924fdc27ed075cc6444b57b453937211a3bc76083fe6eb` |
| Installed `dist/chatgpt-browser.js` | `eb6918450063dead52228db74d0cc28c1dac8bf0d1e0be509faed65d5ecd9eaa` |
| Installed `dist/cli-pro.js` | `e01605871198af7e1e64848452261fe3490f4b319674910f284616d134c142f3` |

Both installed module hashes match the final source build. The new **installed**
`prodex pro browser check --cwd <initially-assumed-reporting-repository>` returned exit zero,
`scope=configured-selection`, `model-menu=OPENED`, model `Pro=VERIFIED`, and
project `Codex=VERIFIED` after strict hover hit-testing. Login remained active.
The installed `prodex pro browser models --timeout-ms 15000` also succeeded and
listed the full effort ladder, including Pro, restoring the previous setting.
These are actual post-install checks of the installed command. The reporter
subsequently identified a different working directory, checked separately below.
They do not establish that old in-memory MCP modules or M3 installations were
updated.

This source change's commit and delivery status are preserved in the PR's
deployment comment. Native CI for this change is separate from local WSL
verification and must not be inferred from the older green run below.

The previous baseline's native CI passed at
[run 36215592209](https://github.com/youdie006/prodex/actions/runs/36215592209).
It is not verification of this new patch. This incident does not change the
pure-headless protection result or promote an experimental browser backend.

## Reporter Path and MCP Follow-Up

The reporter subsequently supplied the exact host CLI, actual working directory
and three task records. The following checks used those authorized paths, not
the initially assumed repository. No prompt or answer contents were needed.

- The actual host command is the updated Node 22.22.0 global ProDex package,
  still version `0.40.18`. Its selector source commit is
  `77feb382930069cce2c29706cbb22b2f121925b8`; the hashes above identify the
  installed build rather than claiming an npm release.
- The two failed records confirm `project_not_found` and `browser_send_failed`.
  Both the project failure and the earlier successful consultation persist
  `project: "<project>"`. `sendChatGptPrompt` receives the selected project before
  redaction; the persisted selection and blocker are redacted afterward.
  This is not evidence of a substitution bug. The historical original argument
  cannot be recovered or independently proved from these redacted records.
- Current defaults at the actual working directory are `model=Pro` and
  `project=codex`. A bounded installed CLI check there exited 1 with
  `readiness=UNVERIFIED`, reason `browser_send_lock_busy`. Another consultation
  owned the shared browser; no menu operation or prompt was attempted and the
  check was not retried. This does not establish selector readiness in that
  working directory.

### Separate MCP Transport

The optional bridge HTTP URL used port 8787, which was owned by `swapdex`.
Its `/health` returned 404. However, the reporter's actual Claude `prodex`
configuration was **stdio**: Node running `scripts/container-client.mjs
--context default mcp`. That path uses Docker `exec -i`, not port 8787.
Changing the HTTP port would not repair this configured connection, so neither
service's port, configuration nor process was changed. The swapdex owner was
notified of that decision.

A fresh MCP client used the exact configured command, arguments and reporting
working directory. Initialization and `listTools` passed: server `prodex
0.40.18`, 20 tools including `pro_consult` and `pro_recover`, zero stderr bytes,
zero tool calls and zero prompts. The client transport closed and its child
process was confirmed reaped. The existing browser container remained running
and healthy, with zero restarts and its unchanged September 25 start time.

This reproduces a successful **new** stdio connection, not the existing Claude
client's failed connection. The owner was asked to reconnect only ProDex if that
failure remained and report the result or first error. No owner-confirmed
reconnection or new Pro response is claimed. The container package and already
attached MCP runtimes were not updated by the host CLI installation above.

### Follow-Up Verification

- PASS: `npx vitest run tests/browser-selection-check.test.ts tests/project-sidebar-current-ui.test.ts tests/cli-product-check.test.ts tests/picker-current-ui.test.ts` (62 tests).
- PASS: `npx vitest run tests/recorded-selection.test.ts tests/privacy-remediation.test.ts tests/project-composer-binding.test.ts` (34 tests).
- PASS: `npx vitest run tests/cli-pro-browser-send.test.ts -t 'redacts the project name in the persisted blocked consult'` (one selected test; 123 intentionally unselected).
- PASS: exact-config, no-tool-call stdio MCP initialization/catalog/cleanup
  probe described above. The original client failure was not reproduced.
- PASS: `git diff --check` and a local documentation check of all 31 relative
  link targets in the four changed files, the follow-up anchor and HTTP scope.
- Native CI for selector commit `77feb38` is
  [run 36228450030](https://github.com/youdie006/prodex/actions/runs/36228450030).
  At this follow-up, Ubuntu Node 20/22/24 and macOS ARM64 completed successfully;
  macOS Intel and Windows were still running. This is not an all-platform pass.

This follow-up changes documentation only: transport troubleshooting, HTTP tool
scope and interpretation of redacted project names. No release, installation,
login, browser restart, service replacement or automatic consult resend occurred.
