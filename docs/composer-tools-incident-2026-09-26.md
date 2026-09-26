# Composer tools and stale-container blocker: 2026-09-26

## Separate Reports

The reporting Claude session had already recovered its stdio MCP connection.
Two subsequent consultation failures came from different browser runtimes:

- The host CLI stopped before submission with `composer tools button not found`
  when `--tool web-search` was requested. A separate host consultation without
  that option had completed. The failed record confirms `browser_send_failed`.
- The container-backed MCP recorded `captcha_required` before submission.
  A transport handshake passing does not establish browser readiness.

The host warning `model_is_now_an_effort` is the existing compatibility mapping
from `--model Pro` to the measured Pro effort step. It does not itself identify
a failure or prove the response's underlying model.

No original questions, answers, conversation URLs or project identifiers are
included here. The reporter's failed consultations were not replayed.

## Measured Host UI

The first shared-lock attempt stopped because another consultation was active.
A bounded wait then acquired the lock after it finished. Read-only DOM inspection
found one visible, empty composer inside a form, with no generation or dialog:

- Zero `[data-testid="composer-plus-btn"]` elements.
- One same-form button with exact `aria-label="Add files and more"`,
  `type="button"`, `aria-expanded="false"`, `data-state="closed"` and a visible
  36-by-36 rectangle. It had no test ID, popup role or controls relationship.
- The separate model selector remained `Select ChatGPT model`.

A guarded menu-open/read/close check found the unchanged `Web search` and
`Find real-time news and info` leaf labels. This menu still had no menu-role
ancestor; requiring an invented popup relationship would reject the real UI.
Escape restored menu closure, the empty composer and the original URL. No tool
was selected during that initial measurement.

## Scoped Correction

The trigger lookup reuses the existing composer helpers, requires one visible
composer root, and recognizes either the legacy test ID or the measured current
button. Distinct candidates fail closed; one element carrying both identifiers
is deduplicated. Missing, hidden, disabled, inert and ambiguous controls fail
before input. Initial and retry trigger clicks use strict hover hit-testing,
which accepts the button or its descendant, not a covering parent.

Tool labels, prompt construction and submission behavior are unchanged. The
existing menu-entry and active-token matching remain separate from this trigger
correction; this is not a claim that every future tools-menu layout is supported.

## Container False Positive

The installed container adapter still has SHA-256
`601b940f6479a3d93796663d7edc19a8b365416ebeb1555ce18cb653ff955de6`
and lacks the [already-corrected fallback transcript parser](fallback-transcript-2026-09-26.md).
One read-only comparison under its send lock evaluated installed and corrected
status expressions against the same page:

| Observation | Installed expression | Corrected expression |
| --- | --- | --- |
| Blocker | `captcha_required` | none |
| Composer and likely login | present | present |
| Generating or dialog | false | false |
| Captcha text in full page | present | present |
| Captcha text outside messages | present | absent |

The page had zero legacy message nodes and four measured fallback transcript
nodes. No visible challenge frame was found. The differential transcript scan,
not merely the absence of an iframe, reproduces the false positive: ordinary
conversation text was being treated as a live authentication demand.

This proves the defect in the currently inspected installed runtime. It does
not reconstruct every historical browser state. Genuine outside-message captcha
and verification controls remain blockers, covered by existing regressions.
No protective measure was bypassed or dismissed.

The first temporary comparison script failed at import because the older
container diagnostic helper did not export `withCdpSession`; no browser command
ran in that attempt. The corrected temporary probe passed without installing
files, changing the image, navigating, clicking or sending text.

## Verification

- RED: the initial trigger tests had five expected failures; the added mixed
  trigger/multiple-composer cases had two expected failures before correction.
  Independent review then found hidden alternate composers with nonzero
  geometry. Four new tests failed before adding local editor/root/ancestor
  rendering checks; no shared composer-finder semantics were changed.
- PASS: `npm test -- tests/composer-tools-button.test.ts tests/composer-tool-scope.test.ts`
  initially passed 23 tests. Final `npx vitest run tests/composer-tools-button.test.ts tests/composer-tool-scope.test.ts`
  passed 27 tests, including 21 new trigger regressions.
- PASS: `npx vitest run tests/chatgpt-browser.test.ts -t 'fallback|captcha|blocker'`
  (37 selected tests; 140 intentionally unselected).
- PASS: final `npm test -- --reporter=dot` (1,942 passed, three platform exclusions,
  135 files, zero failures, 176 seconds). The earlier full run passed 1,938
  tests before the four rendering regressions were added.
- PASS: `npm run typecheck`, `npm run build`, `git diff --check`.
- PASS: `npm run smoke:package`, including installed CLI, HTTP/stdio MCP,
  task/result integrity, write gates and isolated publication dry runs. Its
  initial package was built before the final rendering-guard adjustment;
  this is not claimed as a separate smoke run of the final candidate. That
  adjustment has the subsequent full regression, build and installed-runtime
  verification recorded separately.
- PASS: `node scripts/release-pack.mjs --pack-destination <private-temp>`
  produced the final local candidate with normalized file modes. Publication
  remained blocked by the dirty worktree; no npm publish was attempted.
- PASS: built production `enableComposerTools` activated Web search in the real
  host browser under the shared lock. Native composer clearing removed the
  synthetic tool selection. Tool inactivity, empty composer, closed menu and
  unchanged conversation URL were verified; zero prompts were sent.

The final corrected adapter build has SHA-256
`071297d709b48295f0a23f71129f10b4a690dbbc3f14e110bb525d3c236620bf`.
The earlier successful live activation preceded the rendering-guard adjustment.
A final-source live attempt stopped at another consultation's send lock without
browser input; final installed-runtime verification is recorded separately.

## Delivery Boundary

Branch: `feat/headless-browser-compatibility`,
[PR 7](https://github.com/youdie006/prodex/pull/7). Package version remains
`0.40.18`; there is no new release tag, npm publication or public image release.
Commit, host installation hashes and post-install checks are recorded in the
PR deployment ledger after source verification.

The container has a read-only root filesystem. Updating the host package does
not repair its adapter or reload an attached MCP process. Service replacement
must preserve the private login volume and security settings and requires
affected MCP clients to reconnect afterward. The user was asked separately
whether to replace the WSL service; no replacement is implied by this source
fix or by the successful read-only differential check. M3 was not changed.

The earlier selector commit `77feb38` passed all six native jobs in
[run 36228450030](https://github.com/youdie006/prodex/actions/runs/36228450030).
That is not native CI evidence for this newer tools-trigger patch. No new Pro
answer or pure-headless authenticated access is claimed by these checks.
