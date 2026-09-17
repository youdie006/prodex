# Navigation-correlated browser diagnostics

Date: 2026-09-18 (work began September 17, Asia/Seoul).
This implements the [403 audit's diagnostic priorities](headless-403-research-2026-09-17.md#diagnostic-priorities).
It fixes the measurement tooling, not the remote protection decision.

## Behavior

- The collector selects a main-frame document request and follows its request ID
  and loader across redirects. Another frame, request, loader, or resource type
  cannot replace the selected document's status.
- A matching `Page.navigate` acknowledgement confirms correlation. If it times
  out, response history remains available as `provisional`, while the certified
  `httpStatus` stays null. Missing evidence is not converted into success.
- Each response has elapsed milliseconds, status, redirect/final kind, a small
  allowlisted content type, and a boolean for an exact `cf-mitigated: challenge`
  header. Raw URLs, IDs, cookies, authorization, arbitrary headers, bodies, and
  protocol error messages are not persisted in the diagnostic report. A false
  challenge flag means no matching header was observed, not proof of no protection.
- The runner reports the failed phase and retains partial evidence. Commands and
  observation have independent bounded deadlines. It sends one navigation,
  never retries, and removes its event subscription on exit.
- A matched document load is distinct from receiving HTTP headers. HTTP errors
  and final challenge responses stop observation without waiting for a composer.
  A redirect's challenge metadata alone cannot certify a final protection page.
- Histories are bounded. Truncation is explicit and prevents a certified status.
  Early session closure rejects pending commands and clears their timers.

Implementation: [collector](../scripts/browser-navigation-diagnostics.mjs),
[runner](../scripts/browser-navigation-probe.mjs), and
[disposable browser smoke](../scripts/browser-launch-smoke.mjs).

## Running the checks

From a built source checkout, the existing default command remains account-free
and contacts only a local fixture:

```sh
npm run build
npm run smoke:browser
```

It now checks a 302 redirect to a query-string URL, a main document returning 200
with a child document returning 418, and a synthetic main-document 403. Original
CDP capabilities, profile-marker restart, process ownership, and cleanup checks
remain enabled. Existing CI runs this default on its native OS matrix.

For a separately authorized manual public-root measurement only:

```sh
npm run smoke:browser -- --public-chatgpt
```

This adds one navigation to the public ChatGPT root after the local checks,
inside the same disposable, anonymous profile. There is no port/profile/account
selection option, login, prompt, Pro selection, challenge handling, or automatic
retry. The diagnostic JSON is emitted before cleanup so a later close failure
cannot erase it. A public failure sets `browser_launch_smoke=failed` and exits
nonzero even when local capabilities passed. A `response` outcome certifies only
the observed HTTP document, not authentication, Pro access, or reliability.

These are source-checkout scripts, not a new installed `prodex` CLI command.

## Isolated browser verification

| Target | Browser and actual mode | Local navigation fixtures | Cleanup |
| --- | --- | --- | --- |
| WSL Docker x64 | Stock Chrome 153.0.8010.47, pure headless | PASS: 302 -> 200, child excluded, main 403 | PASS |
| M3 Colima Linux ARM64 | Stock Chrome 153.0.8010.47, pure headless | PASS: same cases | PASS |

The dedicated offline runs used `--network none`. Both also passed Runtime/DOM,
keyboard, mouse, synthetic file selection, and same-profile synthetic marker
restart checks. These are two Linux architectures, not native macOS or Windows
acceptance results. Native CI status is recorded separately in the PR.

Containers were disposable, read-only, UID 1000, with dropped capabilities,
`no-new-privileges`, the existing seccomp profile, two CPUs, 2 GiB RAM, 1 GiB
shared memory, 256 PIDs, and separate 256 MiB temporary home and `/tmp` mounts.
No login volume or published port was used. WSL mounted only the three diagnostic
source files read-only. M3 used an experimental image overlay with those same
files, not a replacement of the installed browser service.

The WSL base image was
`sha256:73bf6af5bd67e6a2a39baf16313414275d7ac20ef20c31dcdebf9f60c1eb19cf`.
The final M3 experimental overlay was
`sha256:efe245dfa006c8dc161d0b555b1975bd32179ddc5dc689b4ffe4a27b870ae411`.
Final offline runs after review used smoke-script SHA-256
`560655c15684a06ba904057972093be0095e2f59bdf222782276fbd5f56c56de`
and runner SHA-256
`ce54e7d179498f22b3a8d071175a82fc4e7e32a5eb043fbfa6fa55175e4ed04f`;
the collector hash was unchanged from the public trial below.

## One public observation

After offline checks, one WSL pure-headless public-root navigation returned the
following allowlisted report. This includes a redirect that the old exact-URL
observer could not describe as a correlated chain:

```json
{
  "schemaVersion": 1,
  "outcome": "http_error",
  "phase": "complete",
  "failedPhase": null,
  "elapsedMs": 156,
  "navigationCommands": 1,
  "diagnostics": {
    "httpStatus": 403,
    "correlation": "confirmed",
    "responses": [
      { "atMs": 87.70157900000049, "status": 307, "kind": "redirect", "contentType": null, "challenge": false },
      { "atMs": 127.79378300000008, "status": 403, "kind": "response", "contentType": "text/html", "challenge": true }
    ],
    "transportFailure": null,
    "truncated": false,
    "documentLoaded": false
  },
  "error": null
}
```

The command exited 1, closed its browser, and removed its trial container. Zero
logins or prompts were attempted. No public retry or M3 public request followed.
The final response explicitly carried the challenge header; this is stronger
evidence than a local title-based classifier. It does not identify the protection
rule, prove an IP ban or expired login, or establish a supported workaround.
`documentLoaded: false` here means observation stopped at the refusal, not that
the document could never finish loading. One navigation command may have multiple
HTTP requests/redirects.

Public-trial source SHA-256 values:

| File | SHA-256 |
| --- | --- |
| `browser-launch-smoke.mjs` | `44441c573fc03499d8a4c462900874fdfa4e08dcb1a48d004509e2fabf49c855` |
| `browser-navigation-probe.mjs` | `fdb39e5cdc391aee0eccc17371f44bc22f65b91f73614eb1dad20504fa1c1912` |
| `browser-navigation-diagnostics.mjs` | `786a55236ddc2383aa26b2a18f1748ed1545bab1d89c65a28135b8118693a467` |

Independent review identified two follow-ups: the old unconditional smoke-success
marker was misleading on a public failure, and redirect-only challenge metadata
could prematurely stop observation. Both were reproduced and corrected after this
trial; the measured final 403/challenge remains valid. Those corrections were
verified offline, without requesting the blocked public page again.

## Verification and deployment scope

- PASS: 54 focused collector, runner, CDP-session, and smoke-option tests.
- Tests first reproduced attribution failures, partial-timeout loss, HTTP versus
  protocol failure, HTTP-200 challenge handling, redirect-only challenge
  misclassification, and misleading public-success markers before their fixes.
- PASS: `npm run typecheck` and `npm run build`.
- PASS: `npm run smoke:package`, including isolated installed-package HTTP/stdio
  MCP, task/results, artifact tamper rejection, CLI/onboarding, and publish dry-run
  checks. No package was published.
- PASS: final WSL and M3 network-disabled pure-headless runs after both review
  fixes; both trial containers were removed and browser cleanup confirmed.
- PASS: independent review rechecked both findings after regression fixes.
- PASS: final `npm test -- --reporter=dot` completed with 126 test files,
  1,806 passing tests and three existing skips after all review fixes.
- PASS: `node --check` for all three diagnostic scripts, ASCII/local-link and
  recorded-JSON/source-hash assertions, `git diff --check`, and staged diff checks.
- Source publication is recorded with the commit SHA in PR 7. Remote native CI
  results are separate from the local Linux-architecture checks above; no pending
  native job is a pass.
- Existing WSL container identity remained unchanged and healthy after the
  public trial. No existing WSL/M3 service, profile, viewer password, or client
  attachment was replaced or restarted. No authenticated re-check is claimed.
- M3's existing service also remained running and healthy; its experimental
  overlay did not replace that container.
- No version bump, npm publication, release tag, or product installation. The
  experimental image overlay is test tooling only. The user's untracked
  `Makefile` is unrelated and remains untouched.
