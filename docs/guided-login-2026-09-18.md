# Guided container login: 2026-09-18

## Scope

The user approved replacing the manual local noVNC URL, Docker command and
viewer-password copying workflow with `prodex login`. This implementation targets
an existing running local ProDex container, not new-machine container installation.
It leaves both installed browser services, account profiles, viewer passwords and
the current Codex MCP attachment unchanged.

The command first discovers and pins the local Docker context endpoint, container
ID, image and loopback viewer binding. A ready session returns immediately.
Otherwise it opens a short-lived authenticated viewer on the selected computer;
the user performs ChatGPT sign-in/security verification manually. Only a missing
ChatGPT tab can be opened, under the existing send lock. No prompt is submitted.

The viewer retains VNC authentication and privately supplies its original password
to noVNC on demand. It has an exact-host/origin, single-use random bootstrap,
HttpOnly SameSite cookie, no-store responses, restricted asset paths and bounded
socket/timer cleanup. It never prints the password, copies it to a clipboard or
stores it in browser storage. See [the threat model](../SECURITY.md#guided-local-login),
including the short-lived launch capability's local-process visibility.

Missing/stopped/ambiguous/remote services fail closed. SSH defaults to refusing a
screen on an uncertain computer; `--local-screen` explicitly opts into the SSH
host's desktop. This does not implement automatic remote forwarding or change
MCP routing. Closing or cancelling the viewer leaves the saved browser running.

## M3 Live Pro Check

This closes the previously unpassed **M3 virtual-display** authenticated check.
It does not pass pure-headless Pro access. The user had already completed login;
the test first confirmed readiness and did not open another login screen.

The unchanged M3 Linux ARM64 service retained package `0.40.18`, container prefix
`d980f897a6af`, image
`sha256:73de64cca2889500e7683dd10e269cbf05f8997e6830d09641e44047cee5d6ac`,
start time `2026-09-17T03:11:22.942538376Z`, and restart count zero. The installed
container helper used local context `colima-prodex-check`. Fresh independent
stdio MCP connections each reported `0.40.18`; neither was inferred from the
older Codex attachment.

| Check | First question | Exact-task continuation |
| --- | --- | --- |
| Task | `task_20260918_002925_gpt-pro-consult` | `task_20260918_003000_gpt-pro-consult` |
| Request | `00e7df51c643a7f66d5b7e27b63f351b` | `be9ee575120964f25328edd278584c09` |
| Rendered model | `gpt-6-pro` | `gpt-6-pro` |
| Done / Pro verified / request verified | PASS | PASS |
| Expected answer | Test prefix, `FIRST 2491` | Same prefix, `SECOND`, remembered label, `2472` |

The first prompt asked for 47 times 53 and retention of a random fictional label.
The second did not repeat the label and asked to subtract 19. Both exact answers
matched, in the same conversation with distinct request IDs and `continued_from`
equal to the first task. Test prefix: `PDX_M3_20260918_ECE2A1FD`. Private conversation
URLs and account details are not included in this record.

Exactly two prompts were submitted, without retries. A subsequent exact-thread,
exact-request `pro_recover` returned the identical second answer with no new send.
Independent `BridgeStore` read-back passed both trusted completion seals, saved
answer receipt verification, model/request evidence, root destination, session
links and artifact SHA-256/byte checks (684 and 966 bytes), with zero warnings.

Both owned SSH/helper clients exited. A final container process check found only
one MCP process, started `2026-09-17T05:39:02.910Z`, before this test; it was left
alone. Readiness remained true, with actual `headed` mode and no blocker.

The WSL service likewise retained container prefix `39b4ed5b4b12`, image
`sha256:1f5cf6a36323635c2f03bd3b011f89f9e5223cc955f10737bd187de7e89cfd18`,
start time `2026-09-17T04:36:34.956128153Z`, and restart count zero. No WSL Pro
prompt was needed for this change; its separate earlier live check remains in
[the container record](container-browser.md#live-recheck-2026-09-18).

## Guided Login Verification

- PASS: previous helper/login regressions, 54 tests, before implementation.
- PASS: actual account-free noVNC/password authentication, nonblank canvas pixels,
  keyboard input, fragment removal, zero page errors, one private credential read
  and automatic readiness disconnect at 1440x1000 and 390x844.
- PASS: screenshots inspected at both sizes with no document overflow. The remote
  desktop scales to the available width; this is not a native mobile login form.
- PASS: the synthetic container used a fresh tmpfs home and no account volumes.
  It rendered only an injected `about:blank` fixture. Its sandbox stayed enabled;
  its owned browser, viewer and container were closed/removed afterward.
- PASS: built WSL `node dist/cli.js login --check` returned READY without a viewer.
- PASS: native M3 Node `22.22.3` ran the staged source build's `login --check`,
  ordinary `login` and `login --help`. Both readiness paths returned READY through
  local Colima discovery, with no viewer or credential read.
- PASS: final `npm test`, including the default-port and stopped-service
  regressions: 1,847 passed, three skipped, across 129 test files.
- PASS: final `npm run typecheck` and `npm run build`.
- PASS: final `npm run smoke:package`, including the installed `login --help`
  route and presence of all four guided-login modules in the packed package.
- PASS: `node scripts/release-pack.mjs --pack-destination <private-temp-dir>`
  rebuilt source and produced a normalized tarball with metadata/file-mode checks
  passing. Its staging directory was removed; no publish command was executed.
- PASS: independent security review. Corrected concurrent bootstrap reuse,
  context endpoint revalidation, remote Windows named pipes, default HTTP port
  normalization and stopped-service diagnostics have regression coverage.
- PASS: `git diff --check` and Node assertions for ASCII additions, acceptance
  limits, local links, changelog backlink and absence of private conversation URLs.

The native M3 check staged build files privately in
`/tmp/prodex-guided-login-native.5W4fgZ` and reused installed dependency modules.
It did not replace the installed package or claim a new package version. All four
guided module SHA-256 hashes matched the final local build, and both readiness
paths were rerun successfully after the last fixes. The UI
test was a bounded local Playwright harness, `node /tmp/prodex-guided-login-smoke.mjs`;
final screenshots were retained locally at `/tmp/prodex-login-proof-6SW32G/`.
No account screenshots or real viewer passwords were captured.

Failures retained for audit:

- RED tests reproduced the absent top-level command, duplicate simultaneous
  bootstrap claims, remote Windows-pipe acceptance, context changes, HTTP default
  port normalization and misleading stopped-service diagnostics before correction.
- The initial UI harness's Docker internal network did not publish its requested
  viewer port. The disposable fixture was rerun with a loopback-published bridge
  network; no real service was changed. Initial keyboard assertions needed an
  actual viewer click to move focus out of Chrome's address bar. One fixture-only
  evaluation returned `undefined` and was corrected to return a JSON value.
- The first manual M3 source staging omitted existing packaged release-helper
  scripts and failed import resolution. Including the files already listed in
  `package.json` fixed that harness packaging error; no product fix was required.
- Direct `npm run release:check -- --metadata-only` failed on this Windows-mounted
  WSL checkout's existing executable file modes. The package smoke's normalized
  staging checks and explicit normalized release pack passed; this is not
  permission to publish the raw checkout. Git publication readiness correctly
  remained blocked by then-uncommitted changes and the user's untracked file.

## Publication And Limits

Implementation is on `feat/headless-browser-compatibility`, tracked in
[PR 7](https://github.com/youdie006/prodex/pull/7). Final source commit, push and CI
results are recorded in that PR's deployment comment. The user's untracked
`Makefile` is not part of the change.

No release tag, npm/image publication, global package installation, service
replacement, account-profile migration or current-client restart was performed.
This branch's guided command is not yet present in the published `0.40.18` npm
package. Source verification is not an installed-runtime update.

Pure-headless ChatGPT access remains blocked by the previously recorded challenge.
Native Windows/macOS/Linux test coverage and real authenticated M3/WSL operation
are separate claims: no new Windows desktop login or native Linux desktop opener
was exercised. The UI test used a headless test client to view synthetic noVNC;
that does not mean ChatGPT itself ran headless.
