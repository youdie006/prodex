# Fresh-chat model selector incident: 2026-09-27

## Reproduction

After the WSL adapter replacement and the original client's successful MCP
reconnect, the user requested a real Pro reply check and the equivalent M3
update. A fresh WSL MCP consult with `new_chat: true` and `effort: Pro` stopped
before typing, recording task `task_20260927_143253_gpt-pro-consult` with
`browser_send_failed`: `ChatGPT model menu did not open after clicking the selector`.
No research question was replayed and this failed attempt sent no prompt.

The temporary verifier initially reported a non-JSON MCP response because it
expected JSON even for a plain-text MCP tool error. Reading only this verifier's
own durable task/result established the actual model-selection blocker. A
successful MCP handshake and ordinary browser readiness had not exercised that
selection path.

On the settled page, one guarded native model-menu open/read/close succeeded.
The exact `Select ChatGPT model` button gained `aria-controls` when expanded,
and the visible menu pointed back through `aria-labelledby`. The installed
menu expression recognized it. This falsified a missing linked-menu selector
as an explanation for the settled state; no broader menu matching was needed.

A single no-send root-to-root navigation then measured two distinct problems:

- The existing fresh-page predicate accepted a new document while
  `document.readyState` was `loading` and no composer was present. Root URL and
  zero message counts alone did not establish usability. The old-document
  marker was already absent in this observation; an old-document race was not
  claimed as its measured cause.
- Later, the model-trigger expression returned a click point labelled
  `Explore` while no actual model trigger or menu existed. Its broad editor
  lookup could find an incomplete/hidden editor without a form, causing the
  lookup to search the entire document for an unrelated popup control.

The inspection's empty-composer guard refused input in that incomplete state.
No `Explore` click was issued by that probe. The original failed consult was
not event-instrumented, so its exact historical click target is not asserted.
The measured false-trigger path is independently reproducible evidence.

## Correction Scope

The correction is limited to fresh-root readiness and model-trigger ownership:
wait for the new usable document, and select only a genuine trigger in one
rendered composer. Missing or ambiguous controls must fail closed rather than
fall back to arbitrary document-wide popup buttons. Existing ARIA menu linking,
request identity, pinned continuation, protection stops and prompt budgets
remain required. Verification and installed revisions are recorded below when
the correction is exercised; this reproduction record alone is not deployment
or Pro-response acceptance.

## Source Verification

The new-chat path reuses the existing document-stamp and rendered-home
predicate before checking empty transcript counts. It does not expand the
answer-reader contract or change pinned continuation. The model trigger is
resolved within one rendered composer using the observed exact current ARIA
label or existing intelligence-trigger attribute. Every model-trigger click
uses strict hit testing. An already-open linked menu is inspected before
resolving its temporarily aria-hidden background trigger.

- PASS, expected RED: the new trigger/readiness file produced ten failures on
  the prior behavior, including an `Explore` hit at x=170, y=189.
- PASS, expected RED: the already-open-menu regression reproduced
  `composer_not_ready` before the guard was corrected.
- PASS: `npm test -- tests/model-trigger-readiness.test.ts tests/chatgpt-browser.test.ts tests/reload-mark.test.ts tests/picker-current-ui.test.ts tests/browser-selection-check.test.ts tests/model-listing-scope.test.ts tests/composer-tools-button.test.ts`, 240 tests.
- PASS: `npm run typecheck` and scoped `git diff --check`.
- PASS: `npm test -- --reporter=dot`, 139 files, 1,965 tests passed and
  three existing skips; 218.57 seconds on WSL. Skipped checks are not passes.
- PASS: `npm run build`; built adapter SHA-256
  `079a054574c48fee7e3b5f0db4c936eb4158da080acecff82afa8aff01e80400`.

The complete suite, built artifacts and per-machine runtime results are
recorded separately after execution. No source-only result proves Pro model
provenance or public pure-headless acceptance.
