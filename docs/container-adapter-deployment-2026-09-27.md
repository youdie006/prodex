# WSL container adapter deployment: 2026-09-27

## Scope And Installed Revision

The user explicitly approved the previously pending WSL container replacement.
Only Docker context `default`, service `prodex-browser-browser-1`, was replaced.
The host CLI, M3 service, swapdex port 8787 and client configuration were not
changed. No Codex restart, viewer or visible login window was opened.

This is a local `0.40.18` adapter update, not a new public package release.
Source revision: `3f48185cbc5a587783db300fa7ba6ecdf1dc50d4`.
The candidate derives from the installed immutable image and adds exactly one
layer replacing `/app/dist/chatgpt-browser.js`, mode `0644`, owner `1000:1000`.
Other modules, including the container's CLI, remain from the existing image.
This does not claim the whole container matches the latest source checkout.

| Artifact | SHA-256 |
| --- | --- |
| Previous image | `a3d8998ebdcecba7e71661a4f31b4aef508402fa02bfb94bc19f7d2befe9eeba` |
| Installed image | `be91dc9c6610bb28bb110798c32a486018fe96803a04904beb50aca0c76d1ea1` |
| Previous adapter | `601b940f6479a3d93796663d7edc19a8b365416ebeb1555ce18cb653ff955de6` |
| Installed adapter | `071297d709b48295f0a23f71129f10b4a690dbbc3f14e110bb525d3c236620bf` |

Installed service start: `2026-09-27T14:12:02.365474146Z`.
Final browser cleanup/readiness checkpoint: `2026-09-27T14:19:11Z`.
Service health was `healthy`, restart count zero. The image labels retain the
adapter revision and hash. The previous image remains available as
`prodex-browser:rollback-pre-3f48185-wsl-20260927`.

## Cause And Preservation

Immediately before replacement, one read-only comparison under the shared send
lock reproduced the [reported false positive](composer-tools-incident-2026-09-26.md).
The installed parser reported `captcha_required`; the corrected parser reported
no blocker on the same logged-in page. Four fallback transcript nodes contained
the relevant text, which disappeared only from the corrected outside-message
scan. No genuine challenge was dismissed or bypassed.

The maintenance preflight acquired the process-shared send lock and required
one unambiguous ChatGPT page, corrected readiness, no generation or dialog, and
an empty composer. The lock remained held until the old container exited.
Subsequent acquisition safely handled its dead owner; the final lock was free.

The image's base layers and runtime configuration were compared before install.
The installed service was checked against its existing Compose configuration:
same hostname `prodex-browser`, nonroot user, read-only root, dropped capabilities,
seccomp, no-new-privileges, tmpfs, resource limits and loopback-only viewer port.
Environment variables were compared by key and value, not array position.
The same named volume `prodex-browser_browser-home` remains at `/home/node`.
Saved authentication worked without login. Profile contents, cookies, tokens
and viewer-password contents were not copied or printed.

## Verification

- PASS: `npx vitest run tests/composer-tools-button.test.ts tests/composer-tool-scope.test.ts tests/chatgpt-browser.test.ts tests/browser-send-lock.test.ts`
  (211 tests in four files), followed by `npm run build`.
- PASS: independent read-only compatibility review and
  `npm test -- --run tests/container-client.test.ts` (18 tests).
- PASS: all six jobs of the actual tools-fix
  [native CI run](https://github.com/youdie006/prodex/actions/runs/36235810119):
  Ubuntu Node 20/22/24, macOS Intel/ARM Node 22 and Windows Node 22.
- PASS: candidate module import, exact hash/mode, required exports, preserved
  fallback parser, genuine CAPTCHA rejection, accepted rendered inline-code
  matching, changed-content rejection and wrong-request rejection.
- PASS: `scripts/container-mcp-smoke.mjs` inside the candidate with network
  disabled, root read-only, nonroot user, private tmpfs and no account volume.
  Two independent clients retained task identity; exactly one concurrent claim
  succeeded; disconnecting one left the other usable; cleanup completed.
- PASS: actual installed adapter's saved-login readiness and tools lookup.
  Production `enableComposerTools` selected Web search. Native Backspace did
  not remove its token in this layout; the exact, freshly hit-tested `Remove`
  button did. The final read confirmed inactive tool, empty composer, closed
  menu, unchanged verification-root URL and no blocker.
- PASS: `node scripts/container-client.mjs --context default status` returned
  the exact installed image, `healthy`, `ready: true`, `blocker: null`.
- PASS: a fresh client using the actual Claude registration, configured
  environment and harness working directory completed MCP initialization,
  listed 20 tools and called `bridge_list_tasks(status=new)` once (zero tasks).
  Server version was `0.40.18`, stderr zero bytes, owned transport confirmed
  exited after cleanup. No bridge task or question was created.

Candidate build used `--pull=false --network=none`. Disposable checks used
`--rm --network none --read-only --user 1000:1000 --cap-drop ALL`,
`--security-opt no-new-privileges` and a `/tmp` tmpfs. The operator scripts and
non-secret result receipt were retained under
`/tmp/prodex-container-0927.AybOnN`; this repository record is the durable ledger.

## Attempts And Limits

The service was recreated exactly once. An initial post-installation assertion
compared environment arrays positionally and stopped on ordering only. A later
temporary verifier also compared the Compose healthcheck to an image that had
no image-level healthcheck; it was corrected to use the Compose contract.
A temporary nested-template syntax error was corrected before that verifier
could access Docker. These were operator-verification errors, not changes to
the application or evidence of failed authentication.

The interrupted maintenance script kept the previous conversation URL only in
memory, so it did not restore that tab. After validating the installed settings,
one navigation from the service's `about:blank` tab opened the ChatGPT root in
the existing private virtual display. No conversation was deleted or replayed.
The pre-install same-page differential remains the direct false-positive
reproduction; post-install readiness was measured at the root, not claimed as
a second comparison of the original conversation.

The first no-send UI preflight stopped at its composer guard before clicking.
A subsequent read-only check confirmed exactly one visible empty editor and
form. The activation attempt then stopped on its Backspace cleanup assertion;
a bounded cleanup-only operation used the measured `Remove` control and
verified restoration. Failed attempts are not counted as uninterrupted passes.

No Pro answer was generated, no failed research request was resent and no
automatic prompt retry occurred. Browser mode remains ordinary headed Chromium
on the private virtual display. This is not pure-headless acceptance or removal
of ChatGPT protection requirements.

## Delivery And Reconnect

Source and deployment records use branch `feat/headless-browser-compatibility`,
[PR 7](https://github.com/youdie006/prodex/pull/7). The source fix was already
pushed; this deployment record and its commit are recorded in the PR ledger.
Publication channel: local WSL Docker image only. No npm publication, registry
image publication, release tag or GitHub Release was created.

Container replacement terminates its old MCP subprocesses. The fresh configured
connection above passed; this does not prove every already-open session has
reattached. An affected Claude session needs only `/mcp` -> ProDex reconnect,
not a login reset or full agent restart. The reporting harness session was
notified and asked for one read-only connection check, without a consult resend.

### Reporting Session Reconnected

The original reporting Claude session confirmed that replacement had closed
its old transport and removed its ProDex tools. The user then reconnected
ProDex through `/mcp`, which reported `Reconnected to prodex`.

At `2026-09-27T14:21:35Z`, that same session successfully called
`mcp__prodex__bridge_list_tasks(status=new)` once and received the normal
`{"tasks":[]}` response. This evidence was reported by the owning session,
not inferred from the separate fresh-client check above. It reported no
consult submission, task creation or browser interaction during verification.

The deployment/reconnect incident is closed for this reporting session.
Other already-open clients are not covered by that confirmation; no new
Pro-answer or pure-headless verification is implied. The deployed image and
adapter were not changed during this follow-up.

Rollback, if required, retags the recorded old image as
`prodex-browser:experimental` and recreates only the idle existing Compose
browser service while preserving the named volume. Rollback was not needed.
