# Releasing prodex

How a version of `@youdie006/prodex` gets from `main` to npm, and the checks that guard it. Moved here from the README so the README can stay about using the tool.

## 0.40.13 Verification Record

Release target: `v0.40.13` on `main`. The GitHub Release records the resolved commit, publication workflow and final installation checks; an installed candidate is not proof of public publication or a restarted MCP process.

- PASS: `npm run release:verify` after updating the obsolete window-closing assertions. This ran the full tests, typecheck, build, installed-package CLI/HTTP-MCP/stdio-MCP smoke and doctor.
- PASS: `npx vitest run tests/browser-handoff.test.ts tests/background-login.test.ts --maxWorkers=2`, 30 tests. Targeted regressions first failed for stale mode, incognito/guest, explicit Chrome sub-profile and incorrect launch-mode recording, then passed with the fixes.
- PASS: Node 20 imports the built handoff module; background dry-run works without opening a browser. This is not a Node 20 live Pro test.
- PASS: M3 candidate CLI without tmux refused the existing Chrome account confirmation, returned exit 1, did not report READY, and preserved the same browser PIDs and page targets. Runtime modules matched the tested local build by SHA-256.
- BLOCKED: M3's native account confirmation requires manual action before the actual close/relaunch can be tested. Not every OS dialog is exposed through CDP; native confirmations must be finished before requesting a handoff.
- BLOCKED: local WSL headless startup with the saved profile reached `cloudflare_check`, not READY. No Pro request was sent and no protective check was bypassed.
- Earlier full checks failed on two outdated CLI guidance assertions and then one installed-document assertion. Those expectations were corrected; the subsequent complete verification passed. WSL packaging used normalized staging because mount file modes are not publishable directly; the user's unrelated untracked file was left untouched.

The release adds a guarded, opt-in transition and more accurate blocker reporting. It does not claim that headless Pro consultation is verified on either deployment target or that authentication can be retained indefinitely.

## Cloudflare Wait After Reload and Container Swaps 2026-11-27

This fixes the prodex side of the 03:45 UTC `cloudflare_check` (see "WSL Browser Container Memory 2026-11-27"), on the user's go-ahead to fix it and swap the containers. Not released to npm yet.

**The change**
- Main PR #132 (`fix/cloudflare-after-reload`, `ae083b0`, merge `2ca9784`). After prodex's own crashed-tab reload, a `cloudflare_check` is waited out for up to three minutes, or the send's budget if shorter.
  - prodex only reads the page while it waits, every 3 s.
  - If the check clears, the send goes ahead and carries `cloudflare_check_cleared`.
  - If it stays, the send stops with `cloudflare_check` and nothing is typed.
  - A check already on the page when a send arrives still stops it at once.
  - The general `cloudflare_check` next step now says the check can clear by itself within a few minutes.
- Three new tests in `tests/browser-crash-recovery.test.ts`: the two for the wait failed before the change and pass after it; the guard passed both times.
  - main: 165 files, 2056 passed, 3 skipped.
  - CI passed all 7 checks.
- Container PR #133 (`port/cloudflare-after-reload`, `21082cb`, merge `cccad7c`) ports it. The diffs applied unchanged.
  - The same tests failed before the change and pass after it.
  - Container suite: 183 files, 2367 passed, 3 skipped. CI passed all 7 checks.

**Container swaps to `cccad7c` (send lock free before each, no thread errors after)**
- `scripts/` and `containers/` did not change since `3b0d0c7`, so neither host's client was replaced. Both built `dist` trees contain `cloudflare_check_cleared`.
- WSL: image `4a51968fa048`, started 07:49:01 UTC. Healthy, 4 GiB memory limit, using 330 processes and 1.9 GiB.
- M3 (colima `prodex-check`): image `9fe71dfab3a1`, started 07:49:39 UTC. Healthy, 4 GiB memory limit, using 189 processes and 0.8 GiB. The M3 checkout is at `cccad7c`.
- `status` reported both containers ready with no blocker. `pro browser check` on both: `chatgpt: ok logged_in=true composer=true`, `model_hints: 6 Pro`.
- `pro browser smoke` passed on both: WSL in 30 s, M3 in 25 s, `requestVerified: true`, no warnings.
- The new wait was not exercised live; it needs a crashed tab whose reload Cloudflare checks.
- Both shared tabs were returned to `https://chatgpt.com/`.

## 0.40.61 Release Record

Release commit `4230da7` on `main` (cut after PR #130, merge `44f0f27`); tag `v0.40.61`, published 2026-11-27, on the user's go-ahead. It carries one fix: `prompt_not_delivered`. The next section covers the change and the container swaps.

**Publishing**
- `npm run release:verify` passed on the release commit (scratchpad `release61.sh`).
- `publish.yml` run 45949751420 passed on its first attempt, all 7 jobs (06:06-06:23 UTC). It published to npm with SLSA v1 provenance and created the GitHub Release (06:23:51 UTC) from the one `CHANGELOG.md` entry.

**Installed**
- WSL, M3, Mac mini: `prodex --version` reports 0.40.61.
- The maintainer watchdog checkout was pulled to `4230da7` and rebuilt.
- No native host-side `prodex mcp` or `prodex start` was running on WSL, M3 or the Mac mini. The 21 `node /app/dist/cli.js mcp` processes visible on WSL belong to the browser container.
- MacBook M4: `ssh m4` timed out, so it still runs 0.40.51. Scratchpad `m4install-0.40.61.sh` has to be run once M4 answers.
- The containers already carry the fix, through container PR #131 (`3b0d0c7`).

## prompt_not_delivered Fix and Container Swaps 2026-11-27

This fixes the prodex side of M3's 5-minute smoke timeout (see the next section), on the user's go-ahead to fix it and swap the containers. Not released to npm yet.

**The change**
- Main PR #130 (`fix/prompt-not-delivered`, `98ea6ea`, merge `44f0f27`). A send whose conversation is still at ChatGPT's local address (`/c/local-chatgpt:<id>`) a minute after the prompt was posted, with nothing being generated and no assistant message, now stops with `prompt_not_delivered`.
  - The blocker is `retryable: true` and has no `thread`. Its next step says to send the prompt again, because there is nothing to recover.
  - A budget shorter than a minute ends the same way, instead of with the timeout's recover advice.
  - An answer being written at a local address keeps the wait going.
- Three new tests: the two for the stop failed before the change and pass after it; the guard for an answer being written passed both times.
  - main: 165 files, 2053 passed, 3 skipped.
  - CI passed all 7 checks.
- Container PR #131 (`port/prompt-not-delivered`, `b248e5b`, merge `3b0d0c7`) ports it. The hunks applied with reduced context.
  - On that branch the same tests failed before the change and pass after it.
  - Container suite: 183 files, 2364 passed, 3 skipped. CI passed all 7 checks.

**Container swaps to `3b0d0c7` (send lock free before each, no thread errors after)**
- `scripts/` and `containers/` did not change since `b97b190`, so neither host's client was replaced. Both built `dist` trees contain `prompt_not_delivered`.
- WSL: image `6580d714ffa0`, started 05:54:59 UTC. Healthy, 4 GiB memory limit, using 338 processes and 2.0 GiB.
- M3 (colima `prodex-check`): image `3fde548252b1`, started 05:55:33 UTC. Healthy, 4 GiB memory limit, using 190 processes and 0.8 GiB. The M3 checkout is at `3b0d0c7`.
- `status` reported both containers ready with no blocker. `pro browser check` on both: `chatgpt: ok logged_in=true composer=true`, `model_hints: 6 Pro`.
- `pro browser smoke`, the first send after each swap, passed on both: WSL in 32 s, M3 in 25 s, `requestVerified: true`, no warnings.
- The new stop was not exercised live, because the stuck state did not recur.
- Both shared tabs were returned to `https://chatgpt.com/`.

## WSL Browser Container Memory 2026-11-27

The WSL browser container's ChatGPT tab was ended by the cgroup OOM killer during a long Pro answer, at 2026-11-27 02:18:54 UTC. The container itself kept running.
- The kernel log names the container's cgroup (`465fa131b903`) and a Chromium renderer with 1 GiB of anonymous memory, against the 2 GiB limit. The cgroup's `memory.events` counted one `oom_kill` and 928,820 `max` events since the last start (2026-11-25 05:05 UTC).
- The other large share was 28 connected stdio MCP clients' servers inside the container, using 774 MB in all.
- The send stopped as `browser_tab_crashed`. The browser's history and the bridge records give the rest of the morning; an earlier version of this entry said the tab was reopened about 40 minutes later, which was wrong.
  - 02:19 UTC: a recover task navigated the tab back to that conversation and saved the crashed send's answer.
  - By 02:50 the tab had crashed again on the same conversation, and `status` reported `ready: false` with `browser_tab_crashed`. The kernel log shows no second OOM kill. The container log from before the 05:06 recreate is gone, so the second crash's cause is not known.
  - 03:45:16: a Codex consult found the crashed tab. prodex reloaded it once at the same address before typing, as designed (history: a reload at 03:45:17).
  - That page load got Cloudflare's challenge page: the address carried Cloudflare's `__cf_chl_rt_tk` parameter. The pre-send check, 0.5 s after the reload, reported `cloudflare_check` (retryable), and nothing was sent. The detection was correct, not a false match.
  - 03:47:22: the challenge completed by itself, 125 s later, and redirected back to the conversation. Nobody resent that consult. Whether the tab was usable between 03:47 and 04:50 was not checked.
  - 04:50 UTC: the tab was reopened at the home page (below), about 2.5 hours after the OOM kill.
- M3's container has the same 2 GiB limit, but with 8 clients it never reached it (`max 0`).

**Fixed in place, on the user's go-ahead (no restart; MCP connections kept)**
- `docker update --memory 4g --memory-swap 8g prodex-browser-browser-1`. Afterwards `memory.max` reports 4294967296.
- The send lock was free. The crashed page target was sent to `https://chatgpt.com/` with CDP `Page.navigate`, and the composer came back.
- Afterwards:
  - `status` reported ready, with no blocker.
  - `pro browser check`: `chatgpt: ok logged_in=true composer=true`.
  - `pro browser smoke`: `PRODEX_PRO_SMOKE_OK`, `requestVerified: true`, no warnings.
  - The container used 400 processes and 1.8 GiB, with no thread errors. The tab was returned to `https://chatgpt.com/`.
- Container PR #129 (`fix/browser-container-memory-4g`, `7775273`, merge `b97b190`) sets `mem_limit` to `4g` in `compose.json`, so a recreated container keeps the higher limit. Its CI passed all 7 checks.

**Container swaps to `b97b190` (on the user's go-ahead; send lock free before each, no thread errors after)**
- Only `compose.json`, its test, the container doc and `CHANGELOG.md` changed since `66066fc`, so neither host's client was replaced.
- WSL: image `4eb7c9081c6a`, started 05:06:39 UTC. Healthy, memory limit 4294967296 (swap total 8 GiB), 1024 process limit, using 376 processes and 2.2 GiB.
- M3 (colima `prodex-check`): image `a92e5200758f`, started 05:06:30 UTC. Healthy, memory limit 4 GiB, which equals the VM's 4 GiB, so `docker stats` shows the VM's 3.8 GiB as the ceiling. Using 189 processes and 0.8 GiB. The M3 checkout `~/.local/share/prodex-maint/container-src` is at `b97b190`.
- `status` reported both containers running, healthy and ready, with no blocker. `pro browser check` on both: `chatgpt: ok logged_in=true composer=true`, `model_hints: 6 Pro`.
- `pro browser smoke`:
  - WSL passed in 26 s: `PRODEX_PRO_SMOKE_OK`, `requestVerified: true`, no warnings.
  - M3's first smoke after the swap timed out after 5 minutes. Its conversation address stayed at a `local-chatgpt:` id, and the container log showed nothing for it. Its tab was then sent home, so the page state was not kept.
  - A second M3 smoke passed in 26 s. A read-only structure probe during it showed the stop button and no error notice.
  - Investigated afterwards (from the browser's history, the rendered page and the host and VM logs):
    - A new ChatGPT chat first gets a local address, `/c/local-chatgpt:<id>`, and then a server id. In 36 sends on both hosts since 2026-11-18 that took 1.5 to 18.4 s.
    - The failed smoke's local address appeared 5 s after the home page loaded, as usual, but never got a server id. At 5 minutes there was no stop button.
    - The next new chat reused the same local id and got a server id 6 s later. That conversation shows one exchange only, so the first prompt never reached ChatGPT; it was not sent with the second one either.
    - Ruled out: memory (`max 0`, no OOM), the colima VM journal, colima port forwarding (only the swap's own restart at 05:06:30), macOS sleep (none in `pmset -g log`), and a ChatGPT-wide outage (WSL sends at the same time passed). prodex only reads the page after the submit, so it did not move the tab.
    - Why the page kept the prompt locally is inside ChatGPT's page and cannot be seen from rendered content.
  - prodex then waited the whole 5 minutes and advised `recover --target-url .../c/local-chatgpt%3A...` and not resending. Neither fits a prompt that never reached ChatGPT. `conversationIdFromThreadUrl` does not accept a local address, so the wait never pinned a thread.
  - A probe of ChatGPT's IndexedDB during this investigation printed fragments of a ChatGPT routing token into the session's tool output. That broke the rendered-page-only rule. Nothing from it was saved, and browser storage was not read again.
- Both shared tabs were returned to `https://chatgpt.com/` afterwards.

**Not explained:** between 03:08 and 05:05 UTC on 2026-11-25, Chromium in the WSL container exited six times with SIGTRAP. Each exit followed a loop of "Network service crashed or was terminated", 34,447 lines in all, and the service restarted it each time. The kernel log shows no OOM kill in that window. It has not recurred since 05:05 UTC that day.

## 0.40.60 Release Record

Release commit `ee11093` on `main` (cut after PR #127, merge `69baa40`); tag `v0.40.60`, published 2026-11-25, on the user's go-ahead to merge, swap the containers and publish. It carries one fix: the blocker scan no longer reads what the model writes while a Pro answer is in progress.

**The change (PR #127, `fix/blocker-scan-answer-activity`)**
- On 2026-11-24 a Pro consult stopped as `usage_limit` five minutes in, and the answer finished about twelve minutes later.
- Measured in the page: while an answer is written, ChatGPT shows the model's progress lines in the answer's turn but outside the message unit, as markdown in an activity area. One of those lines contained "model limit".
- The blocker scan now leaves out `[data-markdown-text-style]` and `[data-spacing="activity"]`. ChatGPT's own notices, including one in the turn outside the model's text, are still reported.
- The new test failed before the change, with the progress lines in `blockerScanTextSample`, and passes after it. Full suite: 165 files, 2050 passed, 3 skipped. CI passed all 7 checks.

**Publishing**
- `npm run release:verify` passed on the release commit (scratchpad `release60.sh`).
- `publish.yml` run 45523601161 passed on its first attempt, all 7 jobs (01:09-01:26 UTC). It published to npm with SLSA v1 provenance and created the GitHub Release (01:26:22 UTC) from the one `CHANGELOG.md` entry.

**Installed**
- WSL, M3, Mac mini: `prodex --version` reports 0.40.60.
- The maintainer watchdog checkout was pulled to `ee11093` and rebuilt.
- No native host-side `prodex mcp` or `prodex start` was running on WSL, M3 or the Mac mini. The WSL `docker exec ... /app/dist/cli.js mcp` processes are container relays.
- MacBook M4: `ssh m4` timed out, so it still runs 0.40.51. Scratchpad `m4install-0.40.60.sh` has to be run once M4 answers.

**Container branch**
- Container PR #128 (merge `66066fc`) makes the same change to the container's blocker scan. Main's test was inserted by hand, because the surrounding lines differ; it failed before the change and passes after it.
- Container full suite: 183 files, 2360 passed, 3 skipped. CI passed all 7 checks.

**Container swaps (both built from `66066fc` before the release; send lock free before each, no thread errors after)**
- Only `CHANGELOG.md`, `src/chatgpt-browser.ts` and its test changed between `028c6b9` and `66066fc`, so neither host's client was replaced.
- The built `dist` in both images contains the activity-area selector.
- WSL: image `4f7f9562d72c`, started 01:00:03 UTC. Healthy, 1024 process limit, using 351 processes.
- M3 (colima `prodex-check`): image `243b2a9ceba7`, started 01:01:55 UTC. Healthy, using 192. The M3 checkout `~/.local/share/prodex-maint/container-src` is at `66066fc`.
- `status` reported both containers running, healthy and ready, with no blocker.
- `pro browser check` from a temporary directory inside each container: `browser_selectors: readiness=SKIPPED scope=session-only reason=none_configured`, `chatgpt: ok logged_in=true composer=true` and `model_hints: 6 Pro`.
- `pro browser smoke` on both: `PRODEX_PRO_SMOKE_OK`, `requestVerified: true`, no warnings (WSL 28 s, M3 24 s).
- The fix itself was not exercised live: no Pro answer long enough to show progress lines was sent.
- Both shared tabs were returned to `https://chatgpt.com/` afterwards.

## 0.40.59 Release Record

Release commit `f641255` on `main` (cut after PR #121, merge `fb48083`); tag `v0.40.59`, published 2026-11-24, on the user's go-ahead to merge and publish. It carries one change, from another session's branch: `pro browser check` verifies saved model, effort and project selections before it reports readiness.

**The change (PR #121, `fix/configured-browser-readiness`)**
- `pro browser check` used to report `ok` from login and an available composer alone. It now inspects the saved model, effort and project controls under the shared send lock, without sending or navigating, and checks that the original setting, conversation and closed menu are restored. Missing, busy or incomplete checks are reported as unverified. A check with no saved selection says `scope=session-only`.
- With both a model and an effort saved, both must be offered on one slider step. A button showing `GPT-5.6` no longer counts as `GPT-5`, at check time or at send time. Diagnostic reads stop at a JavaScript confirmation without answering it.
- The branch conflicted with `main` in `CHANGELOG.md` only, after the 0.40.56-0.40.58 entries; `fb5349e` merged `main` into it. After that merge:
  - Typecheck and build passed.
  - The full suite had 2047 passed, 3 skipped and 1 failed. The failure was the slow-vs-dead closed-port test, which passed alone, 8/8.
  - The branch's first CI run passed all 7 checks.
- The PR's own record says live acceptance is incomplete. One account-backed, no-send check exited 1 before the hover fix, and the fix was not rerun live. This release did not add a live check.

**Publishing**
- `npm run release:verify` passed on the release commit (scratchpad `release59.sh`).
- `publish.yml` run 45310522938 passed on its first attempt, all 7 jobs (02:11-02:30 UTC). It published to npm with SLSA v1 provenance and created the GitHub Release (02:30:15 UTC), which lists the three entries from `CHANGELOG.md`.

**Installed**
- WSL, M3, Mac mini: `prodex --version` reports 0.40.59.
- The maintainer watchdog checkout was pulled to `f641255` and rebuilt.
- No native host-side `prodex mcp` or `prodex start` was running on WSL, M3 or the Mac mini.
- MacBook M4: `ssh m4` timed out, so it still runs 0.40.51. Scratchpad `m4install-0.40.59.sh` has to be run once M4 answers.

**Container branch**
- `container/redesign-patches` already had the configured check, from `77feb38`. PR #121's review follow-ups were ported in container PR #126 (`af08fc3`, merge `028c6b9`).
- The ported cases from #121's tests failed against the old source, except two that the old check already failed closed on.
- Container full suite after the port: 183 files, 2358 passed, 3 skipped. CI passed all 7 checks.

**Container swaps (both built from `028c6b9`, on the user's go-ahead; send lock free before each, no thread errors after)**
- `scripts/` and `containers/` did not change between `9a9d76a` and `028c6b9`, so neither host's client was replaced.
- WSL: image `5e56a8f23466`, started 02:52:51 UTC. Healthy, 1024 process limit, using 364 processes.
- M3 (colima `prodex-check`): image `5138485b9c3e`, started 02:53:18 UTC. Healthy, using 187. The M3 checkout `~/.local/share/prodex-maint/container-src` is at `028c6b9`.
- `status` reported both containers running, healthy and ready, with no blocker.
- `pro browser check` from a temporary directory inside each container, so no saved selection: `browser_selectors: readiness=SKIPPED scope=session-only reason=none_configured` and `chatgpt: ok logged_in=true composer=true`. The command exited 1 because that directory has no bridge; `model_hints` was `Medium`. The saved-selection path was not exercised live.
- `pro browser smoke` on both: `PRODEX_PRO_SMOKE_OK`, `requestVerified: true`, no warnings.
- Both shared tabs were returned to `https://chatgpt.com/` afterwards.

**PR #7 closed**
- PR #7 (`feat/headless-browser-compatibility`) was closed as superseded at the user's choice; the branch is kept.
- All 46 of its commits are in `container/redesign-patches`.
- It had conflicted with `main` since before 2026-11-23, and nothing builds or releases from it.

## 0.40.58 Release Record

Release commit `7a1267e` on `main` (cut after PR #124, merge `71079f4`); tag `v0.40.58`, published 2026-11-23. Released on the user's go-ahead after the container swaps below. It carries one change: an answering model the ChatGPT page does not name is reported in one note line, not as a warning.

**The change (PR #124, `f62daaa`)**
- Since ChatGPT stopped naming the answering model (2026-11-17), every consult carried a `model_unverified` warning. An MCP response carried it twice, in `warnings` and in `notes`. The calling Codex session repeated "Pro was selected, but the answering model was not confirmed" after each answer, and the user asked for one line.
- The warning is gone. The note line now reads `model_used: unknown (the ChatGPT page does not name the answering model)`.
- `model_used: "unknown"`, `picker_effort` and the missing `pro_verified` in the result and receipt are unchanged, and nothing parsed either string.
- Build, typecheck and the full suite (164 files, 2021 passed, 3 skipped) passed locally; CI passed all 7 checks.
- Container PR #125 (`ec2e440`, merge `9a9d76a`) ports it with a plain `git apply`. The three updated tests failed with the source change stashed. Full suite: 183 files, 2351 passed, 3 skipped. CI passed all 7 checks.

**Container swaps (both built from `9a9d76a`, send lock free before each, no thread errors after)**
- WSL: image `513d40537ccb`, recreated 06:31:58 UTC. Healthy, 1024 process limit, using 354 processes after the checks below.
- M3 (colima `prodex-check`): image `6c45b4a19c6b`, started 06:32:06 UTC. Healthy, using 191. The M3 checkout `~/.local/share/prodex-maint/container-src` is at `9a9d76a`.
- `scripts/` and `containers/` did not change between `178e6ec` and `9a9d76a`, so neither host's client was replaced; `status` reported both containers running, healthy and ready.
- `pro browser check` on both: logged in with a composer, `model_hints: Pro`. `pro browser smoke`: `PRODEX_PRO_SMOKE_OK`, `requestVerified: true`, no warnings, WSL after 30 s and M3 after 26 s.
- On WSL, one `pro browser ask --temporary --json` with no model flag finished `done` in 29 s.
  - The output had the single line `model_used: unknown (the ChatGPT page does not name the answering model)` and no `model_unverified` line.
  - The JSON warnings were `temporary_chat` and `model_selection_warning`, both expected for that test.
  - The shared tab was returned to `https://chatgpt.com/` afterwards.

**Publishing**
- `npm run release:verify` passed on the release commit after a build (scratchpad `release58.sh`).
- `publish.yml` run 45124746230 passed on its first attempt, all 7 jobs included. It published to npm with SLSA v1 provenance and created the GitHub Release (06:50 UTC), which lists the one entry from `CHANGELOG.md`.

**Installed**
- WSL, M3, Mac mini: `prodex --version` reports 0.40.58.
- The maintainer watchdog checkout was pulled to `7a1267e` and rebuilt.
- No native host-side `prodex mcp` or `prodex start` was running on WSL, M3 or the Mac mini; the MCP relays are `docker exec` sessions into the swapped containers.
- MacBook M4: `ssh m4` timed out, so it still runs 0.40.51. Scratchpad `m4install-0.40.58.sh` has to be run once M4 answers.

## 0.40.57 Release Record

Release commit `7ac8298` on `main` (cut after PR #122, merge `b544a09`); tag `v0.40.57`, published 2026-11-23. Released on the user's go-ahead after the container swaps below. It carries one fix: names the user gave to chats and projects no longer reach the browser blocker check.

**The fix (PR #122, `d4ee765`)**
- After 0.40.56, the user asked for the remaining risk to be closed: names the user controls that contain a blocker phrase.
- Measured read-only in the WSL browser container. The probes printed structure, lengths and hashes only, and the tab was returned to `https://chatgpt.com/` after each one.
  - On a project's chat page, nothing in the scanned text was the project name: what was there besides UI text was a date separator (`<time>`) and the effort picker label.
  - On a project's home page, where a send into the project types its prompt, 65 scanned text nodes were the project's conversation list (links to `/g/g-p-<id>/c/<id>`). The page is titled `ChatGPT - <project name>` and shows the name as its `h1`.
- Changes:
  - Links to conversations, projects and GPTs are excluded from the blocker scan.
  - The scan skips the project name, as it skips the conversation title.
  - `main` gets the container branch's `blockerButtonLabels` (`692ded3`, 2026-09-17). Until now, every visible control label on `main`, sidebar conversation links included, reached the blocker check.
- Build, typecheck and the full suite (164 files, 2021 passed, 3 skipped) passed locally; CI passed all 7 checks.
- Container PR #123 (`ab90224`, merge `178e6ec`) ports the link and title changes; that branch already had the label split. Full suite: 183 files, 2351 passed, 3 skipped. CI passed all 7 checks.
- Before the swap, on one project's home page, the installed scripts' blocker scan read 2022 characters (81 lines) and 113 status labels; the new scripts read 49 characters (7 lines, UI text) and 63 labels. Neither reported a blocker there.
- Not changed: the bare `권한` alternative of the permission pattern.

**Container swaps (both built from `178e6ec`, send lock free before each, no thread errors after)**
- WSL: image `6b2b7ccfe828`, recreated 05:57:16 UTC. Healthy, 1024 process limit, using 354 processes after the checks below.
- M3 (colima `prodex-check`): image `112c887fe694`, started 05:57:22 UTC. Healthy, using 190. The M3 checkout `~/.local/share/prodex-maint/container-src` is at `178e6ec`.
- `scripts/` and `containers/` did not change between `dc91ec5` and `178e6ec`, so neither host's client was replaced; `status` reported both containers running, healthy and ready.
- `pro browser check` on both: logged in with a composer, `model_hints: Pro`. `pro browser smoke`: `PRODEX_PRO_SMOKE_OK`, `requestVerified: true`, no warnings, WSL after 26 s and M3 after 29 s.
- After the swap, the installed scripts read the same project home page as 49 characters and 63 labels.
- The Codex session that consults through the WSL container was not using prodex at the swap. Its last consult (05:36 UTC) had finished `done`.

**Publishing**
- `npm run release:verify` passed on the release commit after a build (scratchpad `release57.sh`).
- `publish.yml` run 45121332783 waited in GitHub's queue for a runner, then passed on its first attempt with all 7 jobs. It published to npm with SLSA v1 provenance and created the GitHub Release (06:17 UTC), which lists the one entry from `CHANGELOG.md`.

**Installed**
- WSL, M3, Mac mini: `prodex --version` reports 0.40.57.
- The maintainer watchdog checkout was pulled to `7ac8298` and rebuilt.
- No native host-side `prodex mcp` or `prodex start` was running on WSL, M3 or the Mac mini; the MCP relays are `docker exec` sessions into the swapped containers.
- MacBook M4: `ssh m4` timed out, so it still runs 0.40.51. Scratchpad `m4install-0.40.57.sh` has to be run once M4 answers.

## 0.40.56 Release Record

Release commit `182a7a5` on `main` (cut after PR #119, merge `38dc21b`); tag `v0.40.56`, published 2026-11-23. Released on the user's go-ahead after the container swaps below. It carries one fix: a prompt containing a blocker phrase no longer stops its own send.

**The false blocker (PR #119, `be6d83b`)**
- A Codex consult from WSL on 2026-11-23 (`task_20261123_022852_gpt-pro-consult`) was reported `permission_required` ("ChatGPT requires account verification or permission handling") 11 s after it was claimed. No verification screen existed. ChatGPT had taken the prompt and answered it. On the user's go-ahead, the Codex session recovered that answer with `pro_recover` at 04:52 UTC.
- Cause: right after a send, ChatGPT shows the sent prompt as the conversation title, in the page header (`header[data-app-shell-titlebar]`) and in `document.title`. The blocker scan excluded messages, the composer and the sidebar, but not the header. The prompt's only "권한" was in its last line, and that matched the bare `권한` alternative of the permission pattern.
- Reproduced in the WSL browser container with one temporary-chat send containing the word: blocked as `permission_required` after 9 s. A read-only DOM probe found the only scanned occurrence in the header title, equal to `document.title`. Before the fix, sends whose prompts contained other blocker phrases ("rate limit", "captcha") last completed on 2026-11-01. That predates the current page header.
- The blocker scan in `statusExpression` and `answerExpression` now skips the text node that equals `document.title`. Build, typecheck and the full suite (164 files, 2011 passed, 3 skipped) passed locally; CI passed all 7 checks.
- Container PR #120 (`4b5c8cc`, merge `dc91ec5`) applies the same change by hand, because that branch's scan also skips transcript units. Build, typecheck and the full suite (183 files, 2349 passed, 3 skipped) passed locally; CI passed all 7 checks.
- Before the swap, on the live tab still showing the test chat, the old and new page scripts were evaluated read-only. The installed scripts reported `permission_required`; the new scripts reported no blocker.
- Not changed: the bare `권한` alternative itself, and other labels the user controls that the header can show, such as a project name.

**Container swaps (both built from `dc91ec5`, send lock free before each, no thread errors after)**
- The user asked for the swaps and the release together.
- WSL: image `5b8527296f95`, recreated 04:53:32 UTC. Healthy, 1024 process limit, using 349 processes after the checks below.
- M3 (colima `prodex-check`, Running): image `a0d44301f2f0`, started 04:53:41 UTC. Healthy, 1024 process limit, using 190. The M3 checkout `~/.local/share/prodex-maint/container-src` is at `dc91ec5`.
- `scripts/` and `containers/` did not change between `fa4cb0a` and `dc91ec5`, so neither host's client was replaced; `status` reported both containers running, healthy and ready.
- `pro browser check` on both: logged in with a composer, `model_hints: Pro`. `pro browser smoke` (new chat, bridge in a temporary directory inside the container): `PRODEX_PRO_SMOKE_OK`, `requestVerified: true`, no warnings, WSL after 29 s and M3 after 28 s.
- The fix on WSL after the swap: the same temporary-chat send with the word finished `done` with the answer "OK" in 34 s.
- Each test send left the shared tab on its test chat. A send checks the current page for blockers before it navigates, so the tab was returned to `https://chatgpt.com/` both times and `check` passed afterwards.

**Publishing**
- `npm run release:verify` passed on the release commit after a build (scratchpad `release56.sh`, `release55.sh` with the version changed).
- `publish.yml` run 45114822705 passed on its first attempt, all 7 jobs included. It published to npm with SLSA v1 provenance and created the GitHub Release (05:13 UTC), which lists the one entry from `CHANGELOG.md`.

**Installed**
- WSL, M3, Mac mini: `prodex --version` reports 0.40.56.
- The maintainer watchdog checkout was pulled to `182a7a5` and rebuilt.
- No native host-side `prodex mcp` or `prodex start` was running on WSL, M3 or the Mac mini. The 25 MCP relays on WSL and the 6 on M3 are `docker exec` sessions into the swapped containers.
- MacBook M4: `ssh m4` timed out before and after the publish, so it still runs 0.40.51. Scratchpad `m4install-0.40.56.sh` has to be run once M4 answers.

## 0.40.55 Release Record

Release commit `c5ab976` on `main` (cut after PR #117, merge `e0f59e4`); tag `v0.40.55`, published 2026-11-19. Released on the user's go-ahead. It carries one test fix: the send-lock serialization test and its sibling no longer give a queued send a fixed time window to reach the lock.

**The flaky test (PR #117, `d968648`)**
- `tests/cli-pro-browser-send.test.ts` "serializes concurrent browser sends via the machine-global lock" failed once on CI's macOS Intel runner (run 43987836115, 2026-11-17): the queued send printed nothing within 10 s of its start.
- Cause: before the lock a send writes five records. On macOS and Windows each write runs in a child process (`runAnchoredWrite`), started through tsx in tests. That run's test report put the median test in this file at 3.6 s on that runner, against 141 ms locally. Reproduced locally by forcing that path and delaying each write 2.5 s: the unchanged test failed with the CI assertion.
- Both tests now wait until the send reports it is queued, and fail at once if it ends without queueing. In this release's publish run the two took 6.9 s and 7.5 s on macOS Intel.

**Publishing**
- `npm run release:verify` passed on the release commit after a build (scratchpad `release55.sh`).
- `publish.yml` run 44431591175 passed on its first attempt, all six platform jobs included. It published to npm with SLSA v1 provenance and created the GitHub Release (01:03 UTC), which lists the one entry from `CHANGELOG.md`.

**Installed**
- WSL, M3, Mac mini: `prodex --version` reports 0.40.55.
- The maintainer watchdog checkout was pulled to `c5ab976` and rebuilt.
- No host-side `prodex mcp` or `prodex start` was running on WSL, M3 or the Mac mini.
- The browser containers were not rebuilt: the release changes a test only, and they already run every runtime change in it (`fa4cb0a`).
- MacBook M4: `ssh m4` timed out, so it still runs 0.40.51. Scratchpad `m4install-0.40.55.sh` has to be run once M4 answers.

## 0.40.54 Release Record

Release commit `19719d5` on `main` (cut after PRs #114 and #115 and their record `0d52a6c`); tag `v0.40.54`, published 2026-11-18. Released on the user's go-ahead after the container swaps below. It carries two fixes: the `model_not_applied` wording and the Windows registry rename.

**Publishing**
- `npm run release:verify` passed on the release commit after a build (scratchpad `release54.sh`, `release53.sh` with the version changed).
- `publish.yml` run 44422100875 passed on its first attempt, all six platform jobs included. It published to npm with SLSA v1 provenance and created the GitHub Release (23:52 UTC), which lists the two entries from `CHANGELOG.md`.

**Installed**
- WSL, M3, Mac mini: `prodex --version` reports 0.40.54.
- The maintainer watchdog checkout was pulled to `19719d5` and rebuilt.
- No host-side `prodex mcp` or `prodex start` was running on WSL, M3 or the Mac mini. The MCP entries on WSL and M3 relay into the browser containers, which have run both fixes since the swaps below.
- MacBook M4: `ssh m4` timed out before and after the publish, so it still runs 0.40.51. Scratchpad `m4install-0.40.54.sh` has to be run once M4 answers.

**Fix**
- `main` PR #114 (`95f97d1`, merge `a9c0e80`): the `model_not_applied` warning for a listed but inert model row said the power slider was "the only lever prodex has on the model". The keyboard walk runs before the click and the warning only appears once both fail, so it now says that. CI passed all 7 checks.
- `main` PR #115 (`70d599d`, merged with `main` as `f5fa2ff` after a CHANGELOG conflict with #114; merge `e5187b4`): `registerBridgeRoot` replaced `bridges.json` with a plain rename, which Windows refuses while another process reads the file, and the error was swallowed, so the bridge was left out. It now uses `renameReplacingFile`. CI passed all 7 checks, before and after the conflict fix.
- Container PR #116 (`4f4a36a`, `5906ce4`, merge `fa4cb0a`) ports both unchanged. Build, typecheck and the full suite (183 files, 2348 passed, 3 skipped) passed locally; CI passed all 7 checks.

**Container swaps (both built from `fa4cb0a`, send lock free before each, no thread errors before or after)**
- The user asked for the swaps after the merges.
- WSL: image `b7a7c69f14a7`, recreated 07:57:54 UTC. Healthy, 1024 process limit, using 347 processes after the checks below.
- M3 (colima `prodex-check`, Running): image `737bde30a88f`. Healthy, 1024 process limit, using 191. The M3 checkout `~/.local/share/prodex-maint/container-src` is at `fa4cb0a`.
- `scripts/` and `containers/` did not change between `49fdd05` and `fa4cb0a`, so neither host's client was replaced; `status` reported both containers running, healthy and ready.
- `pro browser check` on both: logged in with a composer, `model_hints: Thinking effort | Pro`. `pro browser smoke` (new chat, bridge in a temporary directory inside the container): `PRODEX_PRO_SMOKE_OK`, `requestVerified: true`, no warnings, WSL after 29 s and M3 after 28 s.

## 0.40.53 Release Record

Release commit `6cec5e3` on `main` (cut after PR #112 and its record `a36edc0`); tag `v0.40.53`, published 2026-11-18. It carries one fix: the answering model cannot be read from ChatGPT's page any more, so `model_used` says `"unknown"` and the response explains why.

**Publishing**
- The user approved publishing this fix as 0.40.53. The agent's permission classifier refused the release script the first time; after the user said to continue, the same script (scratchpad `release53.sh`) ran unchanged.
- `npm run release:verify` passed on the release commit after a build.
- `publish.yml` run 44249145319 passed on its first attempt, all six platform jobs included. It published to npm with SLSA v1 provenance and created the GitHub Release (06:25 UTC), which lists the one entry from `CHANGELOG.md`.

**Installed**
- WSL, M3, Mac mini: `prodex --version` reports 0.40.53.
- The maintainer watchdog checkout was pulled to `6cec5e3` and rebuilt.
- No host-side `prodex mcp` or `prodex start` was running on WSL, M3 or the Mac mini. The MCP entries on WSL and M3 relay into the browser containers, which have run the fix since the swaps below.
- MacBook M4: `ssh m4` timed out, so it still runs 0.40.51. Scratchpad `m4install-0.40.53.sh` has to be run once M4 answers.

**Found**
- 2026-11-17: a Pro consult through the WSL container came back with `model_used` and `pro_verified` missing, so the calling session could not show the answer came from Pro. It also carried `model_is_now_an_effort`.

**Cause, checked read-only on the live WSL container tab**
- The page had no `data-message-model-slug` (the tag both branches read), and no attribute name matched `model` or `slug`.
- The answer's buttons (Copy, Rate response, Read aloud, Share, More actions) name no model. The More actions menu was opened once and closed: it lists the time, Regenerate response, View sources and Branch conversation. Regenerate response was not pressed.
- During the investigation one diagnostic read of ChatGPT's own conversation record was made from inside the tab. It returned only the model fields, which named `gpt-6-pro` on each answer message, and nothing from it was printed or saved beyond that. The user chose to keep the rendered-page-only rule (README "What it will not do"), so prodex does not use that record.
- `model_is_now_an_effort` came from both containers' saved default `browser_defaults: {model: "Pro"}`; Pro is an effort step of the picker now.

**Fix**
- `main` PR #112 (`c0bbd5a`, merge `d294d3e`): `model_used` is `"unknown"` when the page does not name the model, a `model_unverified` warning says why `pro_verified` is left out, and `picker_effort` records the step the effort slider read before the prompt was typed. `npm run release:verify` passed locally; CI passed all 7 checks.
- Container PR #113 (`dbe1e24`, merge `49fdd05`) ports it. The test hunk in `tests/chatgpt-browser.test.ts` needed `git apply -C1`. Typecheck, build and the full suite (2346 passed, 3 skipped) passed locally; CI passed all 7 checks.

**Saved defaults**
- WSL and M3 containers: `prodex setup --clear-model --effort Pro` in `/home/node/bridge`, with the send lock free. `status` now shows `browser_defaults: {effort: "Pro"}`; the token was kept.

**Container swaps (both built from `49fdd05`, send lock free before each)**
- WSL: image `5c019e0024ca`, recreated 03:43:00 UTC. Healthy, 1024 process limit, using 344 processes afterwards.
- M3 (colima `prodex-check`, Running): image `4e045e1a8105`. Healthy, 1024 process limit. The M3 checkout `~/.local/share/prodex-maint/container-src` is at `49fdd05`.
- `scripts/container-client.mjs` did not change, so neither host's client was replaced; `status` reported both containers running, healthy and ready.
- `pro browser check` on both: logged in with a composer. `pro browser smoke` (new chat, bridge in a temporary directory inside the container): `PRODEX_PRO_SMOKE_OK` with `requestVerified: true` on both (M3 after 28 s).
- WSL, `prodex ask --json --new-chat --effort Pro` from a temporary directory inside the container: `model_used: "unknown"`, `picker_effort: "Pro"`, `request_verified: true`, and the `model_unverified` warning.

## 0.40.52 Release Record

Release commit `51da80d` on `main` (cut after PRs #100 and #105-#109, last merge `36bda26`); tag `v0.40.52`, published 2026-11-17. Released on the user's go-ahead as a batch, together with the container swaps:
- #100: `release:verify`'s 15 minute `npm test` budget, and a launch test's fixed 200 ms wait. Both stopped the 0.40.51 publish run.
- #105: one untrusted result hid every other result from `results show latest`, `results artifact latest` and `bridge_list_results`; `pro blockers --cwd` reported a repo with one corrupt result as having no consults; `sessions cancel` made the cancelled session the latest; `--since 2026-02-30` rolled into March.
- #106: macOS and Windows started a process per record read; Windows record replacement failed with `EPERM` while another process read the record; an unreadable record was not named.
- #107: a single-value option given twice kept the first value without a word; a value starting with `--` was refused as missing; `ui --help`, `version --bogus` and help wording.
- #108: the picker's progress bar ignored the send's budget, long lists scrolled the screen away, the attach line split quoted paths and some emoji were measured one column wide; `repo_write_file_apply` failed for names over about 192 bytes.
- #109: MCP tools refused Korean text at about a third of the advertised character limits; `repo_id: ""` returned a raw validation dump; setup printed follow-ups that did not work, replaced a config with one invalid field, and left a non-loopback host a dead end.

**Publishing**
- `npm run release:verify` passed on the release commit after a build.
- `publish.yml` run 44005418895 passed on its first attempt, all six platform jobs included (macOS Intel finished inside #100's 25 minute budget). It published to npm with SLSA v1 provenance and created the GitHub Release (03:04 UTC), which lists the 29 entries from `CHANGELOG.md`.

**Installed**
- WSL, M3, Mac mini: `prodex --version` reports 0.40.52.
- The maintainer watchdog checkout was pulled to `51da80d` and rebuilt.
- No host-side `prodex mcp` or `prodex start` was running on WSL, M3 or the Mac mini. The MCP entries on WSL and M3 relay into the browser containers.
- MacBook M4: `ssh m4` timed out before and after the publish, so it still runs 0.40.51. The install script is the 0.40.51 one with the version changed; it has to be run once M4 answers.

**Container: `request_mismatch` on every consult (container PR #110, merge `58650ce`)**
- Found 2026-11-17: every consult through the browser container failed with `request_mismatch` after its prompt was posted, including a one-line test prompt; reconnecting did not help.
- Cause: ChatGPT now keys each transcript unit as `<turn uuid>:<position>:<role>` (`data-content-search-unit-key`), and the container branch's transcript reader accepted only `fallback-turn-<n>:<position>:<role>`. It read no messages, so it could not find the prompt it had just sent. Checked read-only on the live tab: the deployed reader saw 0 user and 0 assistant messages, `main`'s reader and the fix 1 and 1, with the request marker.
- npm installs were not affected: `main`'s reader matches the new keys.
- The four blocked consults had been posted, and ChatGPT answered them. The agent did not resend them.

**Container swaps**
- Each swap was gated on the send lock being free. None held it.
- First, to unblock consults, both images were built from `58650ce`:
  - WSL: image `d7db8be91bec`, recreated 02:39:23 UTC. Healthy, 1024 process limit, using 339, no thread errors.
  - M3 (colima `prodex-check`, Running): image `b3498d38b98a`, started 02:40:29 UTC. Healthy, using 185 processes, no thread errors.
- Then container PR #111 (merge `9969a64`) ported #100 and #105-#109, one commit per PR (`131f0b9`..`fa69a66`):
  - Each diff (src, tests, docs, scripts, README.md, CONTRIBUTING.md) applied unchanged. #100's change to `tests/launch-port-unavailable.test.ts` and its CHANGELOG line were left out, as that test does not exist on the branch.
  - Build, typecheck, the full suite (2343 passed, 3 skipped) and `release:verify` passed locally; the PR's CI passed.
  - `scripts/release-check.mjs` now matches `main`.
- Both images were rebuilt from `9969a64`:
  - WSL: image `cac6d199afeb`, recreated 03:05:36 UTC. Healthy, using 360 processes, no thread errors.
  - M3: image `ed5db5c55385`, started 03:06:28 UTC. Healthy, using 198 processes, no thread errors. The M3 checkout `~/.local/share/prodex-maint/container-src` is now at `9969a64`.
- After each swap, on both hosts:
  - `pro browser check` reported logged in with a composer, and `model_hints: Thinking effort | Pro`.
  - `pro browser smoke`, in a new chat with a bridge in a temporary directory inside the container, answered `PRODEX_PRO_SMOKE_OK` with `requestVerified: true`: WSL after 30 s and 37 s, M3 after 29 s and 27 s.
- After the second swap, `scripts/container-client.mjs status` reported each container running, healthy and ready.
- An MCP `pro_consult` from a WSL Claude Code session, through the relay into the WSL container, answered `OK` with `request_verified: true` at 03:12 UTC (new chat, no project). The session whose four consults had been blocked was told it can send again.
- The host-side client did not change: `scripts/container-client.mjs` and `scripts/colima-start.sh` are the same at `9969a64` as at `19eb1cb`. The WSL pinned checkout stays at `19eb1cb`, and M3's installed client copy was not replaced.

## 0.40.51 Release Record

Release commit `952e8bb` on `main` (cut after PRs #88-#99, last merge `52f76d6`); tag `v0.40.51`, published 2026-11-10. Released on the user's go-ahead as a batch, together with the container swaps:
- #88: model hints were read from more than the visible composer.
- #89: repo writes dropped a file's mode, its final newline or a non-UTF-8 encoding, and staged paths as git patterns.
- #90: `repo_search` skipped hidden files and threw away partial results.
- #91: `tasks complete --artifact` wrote files before checking the task.
- #92: a record read failed while another process replaced the record.
- #93: a claim and a completion of the same task could interleave.
- #94: a missing artifact was named by its absolute machine path.
- #95: `prodex ui` dropped all but the first line of a pasted prompt, plus picker fixes.
- #96: stdio MCP 1 MiB limit, `pro_consult` cancellation, HTTP MCP sessions never released.
- #97: `doctor`'s port check.
- #98: "help" and options after `--` in `ask` prompts.
- #99: the picker's progress line wrapped.

**Publishing**
- `npm run release:verify` passed on the release commit after a build.
- `publish.yml` run 42733208248 failed on its first attempt, and the publish job was skipped:
  - macOS Intel: `release:verify` stopped `npm test` at its 15 minute budget with no test failed. It reported npm's banner line as the failure.
  - Windows: `launch-port-unavailable`'s fixed 200 ms wait for a closed browser's exit event ran out.
- The failed jobs were rerun on the same commit and passed. The run then published to npm with SLSA v1 provenance and created the GitHub Release (01:46 UTC), which lists the 26 entries from `CHANGELOG.md`.
- Both causes were fixed afterwards in #100 (`f5c9c70`):
  - the suite gets 25 minutes, and a check stopped at its budget says so;
  - the launch test awaits the exit event.
  - It ships in the next release.

**Installed**
- WSL, M3, Mac mini: `prodex --version` reports 0.40.51.
- The maintainer watchdog checkout was pulled to `952e8bb` and rebuilt.
- MacBook M4: `ssh m4` timed out before the cut and again after the publish. It was installed on 2026-11-14, once it answered, going from 0.40.49 straight to 0.40.51.
  - The auto-mode classifier refused the agent's `npm i` over SSH, so the user ran the agent's install script. The script updated the antigravity runtime copy behind `~/.local/bin/prodex` and the `/opt/homebrew` global copy.
  - Both report 0.40.51. `package.json` now requires `^0.40.51`, and `~/.local/bin/prodex` still links to `runtime-prodex/node_modules/.bin/prodex`.
  - An `initialize` sent to `prodex mcp` answered with `serverInfo` version 0.40.51.
  - Four `prodex mcp` processes started by Codex or Claude sessions were running during the install. They keep running 0.40.49 until their clients restart.
- No host-side `prodex mcp` or `prodex start` was running on WSL, M3 or the Mac mini. The MCP entries on WSL and M3 relay into the browser containers.

**Container**
- `container/redesign-patches` `88a8d96` ports #88-#99 on top of `c7c9f35`, one commit per PR (`35bb83b`..`88a8d96`).
  - Each diff (src, tests, docs) applied unchanged.
  - tsc, the full suite (2247 passed, 3 skipped) and `release:verify` pass on it.
- The agent ran both build-and-swap scripts; the user had asked for the swaps.
- WSL: image `9171fbf313e0`, recreated 01:08:29 UTC.
  - No send held the browser lock.
  - It came up healthy with the 1024 process limit, using 318, and logged no thread errors.
  - `pro browser check` reported logged in with a composer, and `model_hints: Thinking effort | Pro`.
- M3 (colima `prodex-check`): the VM had been stopped since M3 restarted about a day earlier, so its container was not running and the M3 relays had nothing to reach.
  - The agent started the VM (01:09 UTC), then built image `15ee6095e2e3` and started the container at 01:10:26 UTC.
  - It came up healthy with the 1024 process limit, using 165.
  - `pro browser check` reported logged in with a composer.
  - `pro browser smoke` answered `PRODEX_PRO_SMOKE_OK` with its request verified, after 42 s.
  - Afterwards, on the user's request, a LaunchAgent now starts the VM at login. It is `~/Library/LaunchAgents/io.github.youdie006.prodex.colima-prodex-check.plist` on M3 and runs `colima start --profile prodex-check`.
    - A failed start is retried every 60 s. The log is `~/Library/Logs/colima-prodex-check.log`.
    - When loaded at 02:27 UTC it found the VM running, logged "already running, ignoring" and exited 0. The VM and container were left untouched.
    - A cold start from a stopped VM was not exercised.
    - M3 has no automatic login, so after a restart the VM starts once someone logs in at the console.
    - Replaced later that day by container PR #101 (merge `aa2bbea`). The agent now runs `/bin/sh ~/.local/bin/prodex-colima-start prodex-check`, a copy of `scripts/colima-start.sh`.
      - When `colima list` shows the VM Broken, which a macOS restart can leave, it runs `colima stop --force` first.
      - It was installed with the snippet in `docs/container-browser.md` at 04:42 UTC. The plist lints, and the agent ran once at load: it logged "prodex-check is already running" and exited 0. The VM stayed Running.
      - The old plist is kept as `~/Library/io.github.youdie006.prodex.colima-prodex-check.plist.2026-11-10.bak`.
      - M3 has FileVault on, so macOS keeps automatic login off.

**Container client (container PR #101, merge `aa2bbea`, 05:40 UTC)**
- `scripts/container-client.mjs` used to give one message for every way of not reaching the container. It now says which case it is and what to start:
  - for an engine that is not answering: colima, Docker Desktop, OrbStack, or Linux and WSL;
  - an unknown context, a refused user, or `docker` missing from PATH;
  - a missing container, or a stopped one.
  An MCP request held 60 s now gets the same reason. The client still starts nothing itself.
- WSL: the pinned checkout `~/.local/share/prodex-maint/container-src` moved from `cd3b671` to `aa2bbea`.
  - `status` reports the container running, healthy and ready.
  - An unknown context gets its own message.
- M3: the installed copy `~/.local/share/prodex/container-installed-8d7a094-wP3RK2/container-client.mjs` was replaced. The previous copy is kept as `container-client.mjs.cd3b671.bak`.
  - Both copies hash to the merge's file (sha256 `ba842081...`).
  - `status` reports the container running, healthy and ready.
  - A missing colima socket names `colima start --profile ...`.
- MCP sessions that were already connected keep the old code until they reconnect. New sessions use the new copy.
- The image was not rebuilt: the client runs on the host.
- CI: the branch also got `dc5b399`, a cherry-pick of main's `8f999ce`, which gives Windows and macOS Intel a 90 s test timeout.
  - Without it, `tests/pro-list-receipts-once.test.ts` timed out at 30 s on Windows in both attempts. It took 51 s on main's Windows run.
  - Port commits carry only `src`, `tests` and `docs`, so this root config had never reached the branch.
  - Two Ubuntu jobs failed first on a stalled `apt-get update`. Their reruns passed.

**Cold start on M3 (on the user's request, 06:06-06:09 UTC)**
- First, no send held the browser lock. The container had been up since 01:10 UTC, healthy and ready.
- An MCP relay probe connected through the new client copy.
- **Stop:** `colima stop --profile prodex-check` at 06:06:59 shut the VM down in 5 s. The container stopped with it.
- **Start:** at 06:08:23, `launchctl kickstart` ran the LaunchAgent the way login does.
  - `colima-start.sh` saw the VM Stopped and started it. It was Running after 5 s.
  - The container came back by itself (`unless-stopped`) and was healthy after 20 s, at 06:08:36. It had restarts=0, 154 processes and no thread errors in its log.
  - The first `status` after the start reported it ready: logged in, composer present, no blocker. No prompt was sent.
- **Relay:** the probe reconnected 5 s after the container started, sent `tools/list_changed`, and a new `tools/list` returned 20 tools.
  - A Claude Code relay already connected on M3 since 02:29 UTC (old client copy) reconnected at the same time.
- **Downtime:** about 1 min 45 s from stop to healthy. That includes a 60 s wait for the held-request check below.
- **Two defects found, fixed in container PR #102 (merge `d1ec949`, 06:31 UTC):**
  - With the VM stopped, `status` and the held MCP request said "Docker context colima-prodex-check does not exist here". The cause: `colima stop` deletes the profile's Docker context, and `~/.colima/prodex-check/colima.yaml` stays. The client now says the VM looks stopped and names `colima start --profile prodex-check`.
  - Run from macOS `/tmp` (a link to `/private/tmp`), the client exited 0 and did nothing. Its main-module check compared a resolved path with an unresolved one.
- **Installed:** both client copies moved to `d1ec949` (sha256 `728b7d08...`).
  - WSL: the pinned checkout.
  - M3: the installed copy. The previous copy is kept as `container-client.mjs.aa2bbea.bak`.
  - `status` reports both containers running, healthy and ready.
  - On M3, with an empty `DOCKER_CONFIG` (the context missing while the profile stays, as in the cold start), the client named `colima start --profile prodex-check`.
- **Not exercised:** a real macOS restart and console login, and a real `Broken` VM.

**WSL after a Windows restart (on the user's request, 2026-11-10)**

This was checked from logs, without restarting Windows: a restart would end every session on that PC. The sources were the Windows System log, pm2's log, systemd and Docker.

- **What starts WSL:** two Startup-folder items in the Windows user's profile, both enabled. Windows has no automatic logon, so neither runs until someone signs in.
  - `wsl.lnk` runs `wsl.exe -d Ubuntu -u xncb135 -- true`.
  - `bsghcal-autostart.bat` runs `wsl ... pm2 resurrect`.
- **Inside WSL:** docker and containerd are enabled under systemd, and the containers are `unless-stopped`.
- **Last restart, 2026-10-28, KST:**
  - Windows booted at 21:35:34 and the user logged on at 21:35:44.
  - The distro started at 21:36:54 and shut down at 21:37:12, 18 s later.
  - It started again at 21:37:24 and shut down at 21:37:42.
  - It started again at 21:46:42 and has stayed up since, most likely because a terminal was opened.
  - Each time the distro started, docker and its `unless-stopped` containers came back within about 3 s (docker active 21:46:45, containers started 21:46:44).
- **Cause:** `.wslconfig` `[general] instanceIdleTimeout` defaults to 15000 ms, after which an idle distro shuts down ([Microsoft docs](https://learn.microsoft.com/en-us/windows/wsl/wsl-config)). The Startup items' `wsl.exe` calls exit at once, so the distro idles out with docker and the browser container. This `.wslconfig` does not set it.
  - The browser container was therefore down from about 21:37 to 21:46 after that restart.
  - The same applies whenever every WSL window is closed.
- **Unrelated:** the logon task `WSL-PortProxy-Refresh` failed at that logon with result 0xFFFD0000. Its script `C:\Scripts\refresh-wsl-ssh.ps1` could not be read.
- **Fix (on the user's request, 2026-11-10):** `[general] instanceIdleTimeout=-1` was appended to `C:\Users\KBS\.wslconfig`.
  - The original file is kept as `.wslconfig.2026-11-10.bak`, and its other settings are unchanged.
  - The setting takes effect the next time WSL starts. It has not been observed across a Windows restart yet.
  - After the next restart, check:
    - `journalctl --list-boots` shows one boot since logon;
    - pm2's log shows no "Stopping app" lines shortly after logon;
    - `docker inspect prodex-browser-browser-1` shows a StartedAt a minute or two after the Windows logon (System log event 7001).
  - The container doc's WSL guidance was corrected in container PR #103.

**Verified live on the WSL container (#96)**
- A `prodex mcp` stdio session in the container got a 2,000,070-byte `ping` after initialize, then a small one. Both were answered, and nothing went to stderr. Before #96 the server closed on any message over 1 MiB.
- `pro_consult` cancellation was not exercised live; it is covered by #96's tests.

## 0.40.50 Release Record

Release commit `759065f` on `main` (cut after PRs #84-#87, last merge `d8333f2`); tag `v0.40.50`, published 2026-11-04. Released on the user's go-ahead as a batch, together with the container swaps:
- #84: session ids carried the start of the prompt.
- #85: the model lookup took an open "Edit message" editor for the composer.
- #86: the tool-state check read a hidden workspace's composer.
- #87: an MCP follow-up refused before submitting still spent the automatic follow-up budget.

**Publishing**
- `npm run release:verify` passed on the release commit after a build.
- `publish.yml` run 41746949557 passed. It published to npm with SLSA v1 provenance and created the GitHub Release, which lists the four entries from `CHANGELOG.md`.

**Installed**
- WSL, M3, Mac mini: `prodex --version` reports 0.40.50.
- The maintainer watchdog checkout was pulled to `759065f` and rebuilt.
- MacBook M4: not installed. `ssh m4` timed out before the cut and again after the publish, so it stays on 0.40.49 until it can be reached.
- No host-side `prodex mcp` was found running on WSL, M3 or the Mac mini. The MCP entries on WSL and M3 relay into the browser containers. Those relays reconnected into the new containers when they were swapped, at 00:24:39 UTC on M3 and 00:50:51 UTC on WSL.

**Container**
- `container/redesign-patches` `c7c9f35` ports #87, on top of the ports of #85 (`8ce48b9`) and #86 (`e8e3c68`); #84 was ported in `f2d13e6`.
  - tsc, the full suite (2179 passed, 3 skipped) and `release:verify` pass on it.
- The agent ran both build-and-swap scripts this time; the user had asked for the swaps.
- M3 (colima `prodex-check`): image `5760b1464db6`, started 00:24:41 UTC.
  - It came up healthy with the 1024 process limit, using 193.
  - `pro browser check` reported logged in with a composer, and the model selection was verified.
  - `pro browser smoke` answered `PRODEX_PRO_SMOKE_OK` with its request verified.
- WSL: image `ea56b6ee0f42`, recreated 00:51 UTC.
  - Another session's send held the browser lock about 25 minutes before the swap. The swap script recreates the container only once the lock is free.
  - It came up healthy with the 1024 process limit, using 298, and logged no thread errors.
  - `pro browser check` reported logged in with a composer.

**Verified live on the WSL container (#87)**
- The check was run through `performBrowserConsultForMcp` in a fresh chat with no project, budget 5. It sent two prompts.
  - Root: answered `ALPHA`.
  - A follow-up naming a tool the menu does not offer was refused before anything was typed (`tool_not_offered`).
  - The next follow-up answered `BETA` and reported `followup_budget` used 1 of 5.
- The ledger holds a single reservation for that conversation, written at 00:52:49 UTC. That is three seconds after the second follow-up's task was created, right before it was submitted. Before #87 the refused follow-up would have been reservation 1, and this one reservation 2.

## 0.40.49 Release Record

Release commit `74b9c4d` on `main` (cut after PRs #79-#83, last merge `be947df`, docs `7b6a3bd`); tag `v0.40.49`, published 2026-11-01. Released on the user's go-ahead as a batch: #79 (the page's render error saved as the answer), #80 (blank `--tool`), #81 (`--continue` matching a project by the end of its name) and #83 (projects behind the sidebar's "Show more"). #82 changed a test only and has no changelog entry.

**Before the cut**
- `main` CI on `7b6a3bd` (docs only) failed on macOS Intel: `npm test` ran past the release check's 15-minute budget on a slow runner, with no failing test. On the four runs before it that step took 10.5 to 11.8 minutes. The failed job was rerun and passed.

**Publishing**
- `npm run release:verify` passed on the release commit after a build.
- `publish.yml` run 41283791768 passed all six platforms, then npm publish with SLSA v1 provenance and the GitHub Release, which lists the four entries from `CHANGELOG.md`.

**Installed**
- WSL, M3, Mac mini: `prodex --version` reports 0.40.49.
- The maintainer watchdog checkout was pulled to `74b9c4d` and rebuilt.
- MacBook M4 (`m4`), added to the install targets this release. It had two copies:
  - `~/.local/bin/prodex`, which its Codex MCP entry runs directly, links into `~/.gemini/harness-antigravity/runtime-prodex` (an npm project, 0.40.32). It was updated there with `npm i @youdie006/prodex@0.40.49`.
  - A global copy under `/opt/homebrew` (0.40.0) was updated with `npm i -g --prefix /opt/homebrew`.
  - The link pointed at `dist/cli.js`, which is not executable in the new install, because the package's executable has been `prodex.mjs` since 0.40.18. Run directly, it failed with "permission denied", so Codex could not have started the MCP server again. The link now points at the runtime's `node_modules/.bin/prodex`. Through it, `--version` reports 0.40.49 and `prodex mcp` answers `initialize` as 0.40.49.
- Running services were not restarted. They keep the old code until their client starts them again:
  - M4: Codex's `prodex mcp`, started before the install.
  - M3: a `prodex mcp` running since 2026-09-15.
  - Mac mini and WSL: none on the host. WSL's MCP entry goes through the browser container.

**Verified live on installed 0.40.49 (WSL host browser, scratch repo)**
- `pro browser projects` listed 25 projects; 0.40.48 listed 9 of the same 25.
- `pro browser smoke` returned `requestVerified: true`.

**After the release**
- PR #84 (merge `b7b5d61`, unreleased): session ids no longer carry the start of the prompt.

**Container**
- `container/redesign-patches` `f2d13e6` ports #84 on top of the ports of #79-#83 (`f93b63f`, `661b2c6`, `106bd0a`, `facd4fd`) and the 1024 process limit (`55f2f3e`). tsc, the full suite (2161 tests) and `release:verify` pass on it.
- The agent's permission classifier refused the WSL `docker compose build`, so the user ran the build-and-swap scripts. Both images were built from `f2d13e6`. Both swaps waited for the container's send lock to be free.
- M3 (colima `prodex-check`): image `4bc8fac19752`, started 07:57 UTC.
  - It came up healthy with the 1024 process limit, using 146.
  - `pro browser check` reported logged in with a composer.
  - `pro browser smoke` answered `PRODEX_PRO_SMOKE_OK` with its request verified.
  - A dry-run `pro ask "Draft the payroll memo"` (nothing sent) got the id `sess_20261101_075935_93598ff4`, with no prompt words in it.
- WSL: image `e2e3523b640a`.
  - The first run built the image but did not swap, because a Pro consult from another session had held the send lock since 07:54 UTC.
  - The swap waited for that consult, which finished `done`. The lock cleared at 08:06:32, and the container was recreated at 08:06:35.
  - It came up healthy with the 1024 process limit, using 177, and logged no thread errors.
  - `pro browser check`, `smoke` and the dry-run id check gave the same results as on M3 (id `sess_20261101_080804_33e445d8`).
  - The swap dropped every MCP client of the WSL container, so each WSL Claude Code session needs `/mcp`.
- Both containers' `prodex --version` still prints 0.40.18, because the container branch never bumps its version.

**MCP clients kept connected across container swaps (2026-11-01, after the swaps)**
- Both swaps had dropped every MCP client of their container: `scripts/container-client.mjs mcp` piped the client into `docker exec` and ended with it, so each Claude Code session needed `/mcp` typed by hand.
- `container/redesign-patches` `964b847` turns that command into a relay that reconnects:
  - it answers requests in flight with an error that names `pro_recover`;
  - it runs `docker exec` again until the container is back, holding new requests for up to 60 seconds;
  - it replays the client's handshake, tells the client its tools may have changed, and then passes the held requests on.
- Verified:
  - 6 new tests; suite 2167 passed; `release:verify` ok.
  - On a throwaway container from the same image, one client connection listed 20 tools, survived a restart and then a delete-and-recreate, and listed 20 tools again each time.
- WSL deployment:
  - The prodex MCP entries used to run the script from `/mnt/d/myproject/gptprouse`, a checkout another task keeps on its own branch.
  - Three Claude configs now run it from a checkout pinned for this purpose, `~/.local/share/prodex-maint/container-src` at `964b847`: `~/.claude.json` and the two swapdex slot configs that had the entry.
  - The Codex config (`~/.codex/config.toml`) was changed the same way.
  - `claude mcp get prodex` reports Connected. A handshake through it reached the WSL container (server 0.40.18, 20 tools).
- M3 deployment:
  - Its Claude and Codex configs run an installed copy, `~/.local/share/prodex/container-installed-8d7a094-wP3RK2/container-client.mjs`.
  - That file was replaced in place with `964b847`'s; the old one is kept beside it as `container-client.mjs.8d7a094.bak`. The configs are unchanged.
  - A handshake through it reached the M3 container.
- Sessions that were open during the swaps still need one `/mcp`. After that, a container restart or swap no longer disconnects them.
- When `container-client.mjs` changes again, both copies must be updated:
  - WSL: move the pinned checkout to the new commit;
  - M3: replace the installed copy.

## Container consults ran on the last model selected (2026-11-01)

**What happened**
- The user reported that some sessions' consults did not use Pro but whatever model the browser last had.
- In the WSL container's results, 20 consults since 2026-10-10 carry `model_selection_warning: no model/effort was selected`. Today's 07:54 UTC Pro consult from another session is one of them.
- Cause: a consult that names no model, with no saved or environment default, keeps the picker's current selection. That is the designed fallback, but in a shared browser the current selection is whatever another session (or an Instant smoke test) picked last.
  - The container's MCP server had neither default. `container-client.mjs mcp` passed no variables into the container, so an MCP entry's env block could not reach it, and the bridge in the container had no saved config.
  - The host entries on WSL that run `prodex mcp` directly set `PRODEX_DEFAULT_MODEL=Pro` and were not affected.

**Fixes**
- `container/redesign-patches` `cd3b671`: `mcp` passes the client's `PRODEX_DEFAULT_MODEL`, `_EFFORT`, `_PRO_MODE` and `_PROJECT` into the container, and adds `PRODEX_DEFAULT_MODEL=Pro` when none of them names a model or a reasoning step. A consult's own `model` or `effort` still wins.
  - Verified: 3 new tests, suite 2170 passed, `release:verify` ok.
  - In the container, the resolved defaults went from `null` to `{"model":"Pro"}`.
  - A consult that named no model, sent through the new client, came back done.
- Deployed to the WSL pinned checkout (`~/.local/share/prodex-maint/container-src` at `cd3b671`) and to the M3 installed copy.
- The 16 WSL sessions had reconnected (17:35-17:37 KST) before `cd3b671` was in place, so their relays still run the version without the default.
  - So the bridge inside each container now saves Pro: `setup --cwd /home/node/bridge --model Pro` on WSL and M3. That writes `.bridge/config.local.json` with a loopback HTTP profile; no HTTP server runs there.
  - Each consult reads this default, so it applies to connected clients at once. A consult through one of the old relays, naming no model, came back done from Pro.
- Each such consult carries the warning `model_is_now_an_effort`, because the current picker has Pro as an effort step. The model default is kept because a model or effort the consult names itself overrides it. A saved effort default would be applied on top of a model the consult names.

**M4 and Mac mini (host `prodex mcp`, 2026-11-03)**
- Neither machine's Claude or Codex entry set `PRODEX_DEFAULT_MODEL`. On M4, `.bridge/results` held one consult of five with the no-model warning (`~/.gemini/harness-antigravity/verification`).
- M4:
  - `~/.claude.json` now has `env: {PRODEX_DEFAULT_MODEL: Pro}`, set with `claude mcp remove` and `add-json`.
  - `~/.codex/config.toml` `[mcp_servers.prodex]` now has `env = { PRODEX_DEFAULT_MODEL = "Pro" }`. A backup is kept as `config.toml.bak-prodex-default-20261103`, and `codex mcp get prodex` parses it.
  - The three running `prodex mcp` processes keep their old environment until their clients restart them.
- Mac mini: the same change, made on the user's explicit request after the first attempt was refused:
  - Claude `~/.claude.json` now carries `env: {PRODEX_DEFAULT_MODEL: Pro}`.
  - Codex `~/.codex/config.toml` has the same `env` line, with the backup `config.toml.bak-prodex-default-20261103`. `codex mcp get prodex` shows the variable set.
  - No `prodex mcp` was running there, so the next client start uses it.
- A WSL Codex session started on 2026-10-28 still runs the client from the old path until it restarts. Its config, `~/.codex/config.toml` (linked from every swapdex slot), already points at the pinned checkout.

## Browser Incident 2026-10-30: WSL browser container out of threads

**What happened**
- A probe consult through the WSL container (`prodex-browser-browser-1`, branch build reporting 0.40.18) came back `done`, request verified, with the answer "This response couldn’t load". The conversation held the real answer ("OK"). The page had drawn its own error in its place (`div[role=status][data-dil-render-failed]`).
- Cause: the container allowed 256 processes and threads. Chromium and the service used about 171 with one ChatGPT tab, and 17 stdio MCP servers (16 Claude Code sessions on the host, about 7 threads each) took the rest. Chromium logged `pthread_create: Resource temporarily unavailable` during the send.
- A reload of that thread while diagnosing it failed the same way, and then `Zygote could not fork`. After that Chromium could start no renderer at all. The tab stayed `browser_tab_crashed`, and prodex's one same-address reload before a send crashed again within 300 ms, so every consult through the container failed.
- M3's container was checked the same day: 151 of 256 in use, with 1 MCP server and no thread errors in 72 hours.

**Recovery (maintainer approved each step)**
- `docker update --pids-limit 1024 prodex-browser-browser-1` raised the limit in place. The thread errors stopped, but the browser still could not start renderers.
- `docker restart prodex-browser-browser-1`, after the container's send lock was confirmed free. The limit stays 1024 across restarts. Health was `healthy` within seconds, `container-client.mjs status` reported `ready: true`, and a fresh-chat consult with markdown in its prompt answered "OK" with its request verified. No thread errors were logged after the restart.
- The restart dropped every client's MCP connection to the container. Each WSL Claude Code session needs `/mcp` to reconnect.

**Fixes**
- `main` PR #79 (merge `eab9340`, not yet released): a send no longer saves the page's render error as the answer, and recovery loads the thread again to draw it. It was ported to `container/redesign-patches` as `f93b63f`.
- `container/redesign-patches` `55f2f3e`: `compose.json` sets `pids_limit` to 1024. The running WSL container already has it through `docker update`. M3's container gets it on its next rebuild.
- Neither container image has been rebuilt with these commits yet.

## Browser Incident 2026-10-20: M3 headless browser behind Cloudflare

**What happened**
- A read-only `prodex pro browser check` on M3 (0.40.38) reported `cloudflare_check`: the dedicated browser had run headless since 2026-09-16 and its ChatGPT tab sat on Cloudflare's human-verification page. Consults from M3's stdio MCP servers could not send.
- `login --headed --recover-visible` could not take it over (`Chrome DevTools command timed out: Runtime.enable` on the stuck tab), and `reset` declined because the browser itself still answered.

**Recovery**
- The dedicated browser was closed with CDP `Browser.close` (send lock idle), then started with a window. Cloudflare passed. `--minimized` was not kept: this macOS desktop reports a minimized window as hidden, so prodex restored it.
- The profile's ChatGPT login had expired; the maintainer signed in on the Mac. `pro browser check` then reported `ok logged_in=true composer=true`, and `pro browser smoke` answered `PRODEX_PRO_SMOKE_OK`.

**Headless handoff, then the cause (same day)**
- `login --background` handed the signed-in profile to headless (after PR #35's lock-wait problem was worked around by retrying), and the headless tab was immediately back on Cloudflare's "Just a moment" page (`NOT READY - cloudflare_check ... not ready headlessly`).
- Read over CDP: the headless browser reports `HeadlessChrome/155.0.0.0` in its user agent and an 800x600 screen. WSL never runs headless - its dedicated browser is ordinary Chrome on the Xvfb display - which is why the same account works there. macOS has no Xvfb. Faking the user agent was not done: the container design excludes stealth settings.
- M3's Claude and Codex MCP configs already use the browser container (`container-client.mjs --context colima-prodex-check mcp`), which runs ordinary Chromium on Xvfb and was logged in and ready. Three long-running sessions (two Claude, started via cmux with `--resume`, and a Codex running since 2026-09-15) still held host `prodex mcp` connections; they reach the container after a `/mcp` reconnect.
- M3's container was rebuilt from `container/redesign-patches` `a870b0c` (image `feb5a47aae06`, restart `unless-stopped`) under the container's send-lock check. Its login was kept, the ChatGPT tab opened by itself, `pro browser check` was ok and the smoke answered `PRODEX_PRO_SMOKE_OK`. The container's `prodex --version` still prints 0.40.18 because that branch never bumped its version.

**Open**
- A long-running headless browser ends up behind Cloudflare's check (also noted on WSL, where the Xvfb display is used instead). On macOS there is no virtual display, and a minimized window counts as hidden, so the remaining no-headless option there is a window kept behind others. Changing the headless preference is a design decision that was not made here.

## 0.40.48 Release Record

Release commit `406ae25` on `main` (cut after PRs #74-#78, last merge `7a88f85`); tag `v0.40.48`. Released on the user's go-ahead, promptly because of #76: on 0.40.47, with the machine under load, the page often ignored the press on the model selector and the send was blocked as "ChatGPT model menu did not open after clicking the selector" (9 of 23 sends across five runs, every one starting from a conversation; also twice the same day without added load). #74 (horizontal rules), #75 (block content inside list items), #77 (inline code holding backticks) and #78 (table column alignment), found comparing live answers with the page, went out with it.

**Publishing**
- `npm run release:verify` passed on the release commit after a build, with nothing else running on the machine.
- `publish.yml` run 40819980786 passed all six platforms, then npm publish with SLSA v1 provenance and the GitHub Release, which lists the five entries from `CHANGELOG.md`.

**Installed**
- WSL, M3, Mac mini: `prodex --version` reports 0.40.48. Running services were not restarted: no host stdio MCP servers on WSL, 1 on M3, none on the Mac mini.
- The maintainer watchdog checkout was pulled to `406ae25` and rebuilt.

**Container**
- `container/redesign-patches` `7f1a7b9` ports #74, `e8b970d` #75, `4f1670e` #76, `3b947c7` #77 and `e30e649` #78. That branch recognises the picker only through its trigger, so #76's test case for a stray picker beside a closed trigger is left out there. tsc, build, the full suite (2144 tests) and `release:verify` pass on `e30e649`.
- The images were not rebuilt: the WSL container still runs the `facbd9d` image (`c03be48c060d`) and the M3 container `cfaf881d2fd6`.

**Verified live on installed 0.40.48 (WSL, scratch repo, Instant)**
- One answer holding a numbered step with a code block, the inline code ``a`b``, a rule and a table aligned left and right came back as written: the code block indented under its step, ``a`b`` intact, `---`, and `| :--- | ---: |`.
- Six sends with two test suites running on the machine (load average up to 9.4) all went through; a read-only page watcher showed one of them pressing the model selector twice before its menu opened.

## 0.40.47 Release Record

Release commit `609b1c9` on `main` (cut after PRs #71-#73, last merge `40d7eee`); tag `v0.40.47`. Released promptly because of #72: on 0.40.46 any prompt carrying a url with "&" (a query string, bare or in a markdown link) was answered and then refused as `request_mismatch`, so the answer was not returned. #71 (italic and strikethrough in the newer renderer) and #73 (the `utm_source=chatgpt.com` parameter ChatGPT appends to rendered links) went out with it.

**Publishing**
- `npm run release:verify` passed on the release commit after a build, with nothing else running on the machine.
- `publish.yml` run 40656237042 passed all six platforms, then npm publish with SLSA v1 provenance and the GitHub Release, which lists the three entries from `CHANGELOG.md`.

**Installed**
- WSL, M3, Mac mini: `prodex --version` reports 0.40.47. Running services were not restarted: no host stdio MCP servers on WSL, 1 on M3, none on the Mac mini.
- The maintainer watchdog checkout was pulled to `609b1c9` and rebuilt.

**Container**
- `container/redesign-patches` `63b060c` ports #71, `62376fa` #72 and `facbd9d` #73 (#71 and #73 did not cherry-pick cleanly and their hunks were applied by exact replacement; tsc, build, the full suite, 2128 tests, and `release:verify` pass on `facbd9d`).
- WSL, on the user's request after the release: the image was built from `facbd9d` (`c03be48c060d`) and the container swapped while its send lock was idle. The old container had been `unhealthy` (its health check's fetch failed) and its last consult, from another session at 03:41 UTC, was blocked as `browser_unreachable`; that consult was left for its owner to recover. The new container came up healthy, `pro browser check` reported logged in with a composer, and an Instant smoke whose prompt linked `https://example.com/s?q=a&page=2` returned `PRODEX_PRO_SMOKE_OK`, status done. Its `prodex --version` still prints 0.40.18 because the branch never bumps its version.
- M3, on 2026-10-29: the build over ssh was refused by the agent's permission classifier, so the user ran the build-and-swap script. The image was built from `facbd9d` in the M3 container checkout (`cfaf881d2fd6`, replacing the 0.40.42 port `59747258b693`) and the container swapped while its send lock was idle. It came up healthy, `pro browser check` reported logged in with a composer, and the same Instant smoke (prompt linking `https://example.com/s?q=a&page=2`) returned `PRODEX_PRO_SMOKE_OK`, status done.

**Verified live on installed 0.40.47 (WSL, scratch repo, Instant)**
- A send whose prompt linked `https://example.com/s?q=a&page=2` returned status done. The user turn was stored with `\&` in the autolink's href half, the shape 0.40.46 refused.
- Its answer came back as "The ~~old~~ *new* [search](https://example.com/s?q=a&page=2) page." while the page's anchor href was `https://example.com/s?q=a&page=2&utm_source=chatgpt.com`.

## 0.40.46 Release Record

Release commit `807f245` on `main` (cut after PRs #69 and #70, last merge `9253ee9`); tag `v0.40.46`. A batch released on the user's go-ahead: terminal-column widths in the interactive picker (#69) and line breaks kept inside answers from ChatGPT's newer `white-space: pre-line` renderer (#70).

**Publishing**
- `npm run release:verify` passed on the release commit after a build, with nothing else running on the machine.
- `publish.yml` run 40645773352 passed all six platforms, then npm publish with SLSA v1 provenance and the GitHub Release, which lists the two entries from `CHANGELOG.md`.

**Installed**
- WSL, M3, Mac mini: `prodex --version` reports 0.40.46, and each installed `dist/chatgpt-browser.js` carries the line-break reader. Running services were not restarted: no host stdio MCP servers on WSL, 1 on M3, none on the Mac mini.
- The maintainer watchdog checkout was pulled to `807f245` and rebuilt.

**Container**
- `container/redesign-patches` `5d021d1` ports #69 and `ad24ce2` ports #70 (the #70 cherry-pick conflicted in `src/chatgpt-browser.ts` and the PR diff was applied instead; tsc, build, the suite and `release:verify` pass on it).
- The images were still not rebuilt: `docker compose build` is refused by the agent's permission classifier on WSL and over ssh on M3. The running WSL container is the #49-#58 port and the M3 container the 0.40.42 port.

**Verified**
- Before the release, on the live tab: the reader in 0.40.45 returned "alpha beta" for an answer showing "alpha" and "beta" on two lines; the #70 build returned "alpha\nbeta" from the same page, with the list after it unchanged.
- After installing, the tab no longer showed a multi-line answer, so the line-break fix was not re-read live on the installed build; the installed reader ran on the current answer without error.

## 0.40.45 Release Record

Release commit `5e5f965` on `main` (cut after PRs #59 and #63-#68, last merge `52243f4`); tag `v0.40.45`. A batch released on the user's go-ahead: machine-wide send pacing (#59), accurate advice for a busy tab (#63), word-bounded project-name redaction (#64), the IPv6 loopback message (#65), no cancelling of finished sessions (#66), a blank saved default project stopped before the browser (#67), and the project-delete preview (#68).

**Publishing**
- `npm run release:verify` passed on the release commit after a build (nothing else was run on the machine meanwhile, after 0.40.44's load-related flake).
- `publish.yml` run 40634873154 passed all six platforms, then npm publish with SLSA v1 provenance and the GitHub Release, which lists the seven entries from `CHANGELOG.md`.

**Installed**
- WSL, M3, Mac mini: `prodex --version` reports 0.40.45. Running services were not restarted: no host stdio MCP servers on WSL, 1 on M3, none on the Mac mini.
- The maintainer watchdog checkout was pulled to `5e5f965` and rebuilt.

**Container**
- `container/redesign-patches` `7f40247` ports #59, #60 and #63-#68 (full suite, 165 files and 2112 tests, and `release:verify` pass on it). #62 changes main's CI only and is not ported.
- The images were still not rebuilt: `docker compose build` is refused by the agent's permission classifier on WSL and over ssh on M3. The running WSL container is the #49-#58 port and the M3 container the 0.40.42 port.

**Verified live on installed 0.40.45 (WSL, scratch repo, unreachable CDP port)**
- `setup --host ::1`: "HTTP MCP host ::1 (IPv6 loopback) is not supported ... Use --host 127.0.0.1 or localhost."
- A repo whose config holds project " ": the send stops with "The default project saved for this repo ... is blank" before any browser step; `--no-project` goes on to the browser.
- The send-pacing marker was written beside the send lock (`last-browser-send`), not in the repo's `.bridge`.
- `sessions cancel` on a blocked session: "is already blocked; its outcome is recorded, so there is nothing to cancel."

## 0.40.44 Release Record

Release commit `060d71c` on `main` (cut after PRs #60-#62, last merge `95c5ddc`); tag `v0.40.44`. Released promptly because of #61: 0.40.43's stale-lock check (#54) derived a holder's wall-clock start from `/proc/stat` btime, which drifts on WSL2 (measured 2026-10-27: 3 to 4 seconds every 30 seconds, 30 minutes over a day), so a send a few minutes into another session's consult freed the live lock and drove the same tab. #60 (picker paths with escaped spaces) went out with it; #62 changes CI only. #59 (machine-wide send pacing) was not ready and is not in this release.

**Publishing**
- The first local `release:verify` failed on `tests/browser-slow-vs-dead.test.ts` "tiny timeout on a closed port" while other tests loaded the machine; it passed alone (8/8), the uncommitted release edits were discarded and the release rerun passed `release:verify`.
- `publish.yml` run 40618706024 passed all six platforms, then npm publish with SLSA v1 provenance and the GitHub Release, which lists the two entries from `CHANGELOG.md`.

**Installed**
- WSL, M3, Mac mini: `prodex --version` reports 0.40.44. Running services were not restarted: no host stdio MCP servers on WSL, 1 on M3, none on the Mac mini.
- The maintainer watchdog checkout was pulled to `060d71c` and rebuilt.

**Container**
- `container/redesign-patches` `1258052` ports #61 (tsc, build, lock/send/follow-up tests and `release:verify` pass on it).
- The images were not rebuilt: the agent's permission classifier refused the `docker compose build` on WSL and the build over ssh on M3. The WSL container still runs image `1d48d753fbf7` (the #49-#58 port, with the drifting check) and the M3 container the 0.40.42 port, until someone with access rebuilds them.

**Verified live on installed 0.40.44 (WSL)**
- A live `sleep` holding a lock that records its start ticks, with `started_at` set 40 minutes back to stand in for a clock step: the send waited ("another prodex send holds the browser"); installed 0.40.43 had reaped the same lock and sent.

## 0.40.43 Release Record

Release commit `834e3e2` on `main` (cut after PRs #49-#58, last merge `a6bbf85`); tag `v0.40.43`. Ten fixes, including two that block or corrupt work: a send lock left by a dead send whose pid was reused blocked every later send (#54), and two processes opening a fresh repo could fail one with a false "receipt-key.local is corrupt" (#58).

**Publishing**
- `publish.yml` run 40451563636 first failed on macOS 15 Intel only: `tests/cli.test.ts` "uses an explicit --cwd target for local HTTP MCP start" timed out at 90 s; the same commit passed on the five other platforms and in PR CI. The failed job was rerun and passed, then npm publish with SLSA v1 provenance and the GitHub Release ran. The GitHub Release lists the ten entries from `CHANGELOG.md`.
- `npm run release:verify` passed on the release commit after a build.

**Installed**
- WSL, M3, Mac mini: `prodex --version` reports 0.40.43. Running services were not restarted: no host stdio MCP servers on WSL, 1 on M3, none on the Mac mini.
- The maintainer watchdog checkout was pulled to `834e3e2` and rebuilt.

**Container**
- `container/redesign-patches` `f72862c` ports #49-#58; full suite (164 files, 2098 tests) and `release:verify` pass on it.
- WSL: image rebuilt and the container swapped to `1d48d753fbf7`; the in-container send lock was idle before and after.
- M3: not rebuilt in this release. The build over ssh was refused by the agent's permission classifier; the M3 container still runs the 0.40.42 port.

**Verified live on installed 0.40.43 (WSL)**
- `pro blockers --since 7` refused: "--since expects a date or an age like 7d or 24h".
- `pro blockers --json` across the machine: 21 roots and 657 consults (before: 27 roots, about twice the consults, counting case-variant paths of the same repo).
- `ask --project "  "` refused: "--project is blank".

## 0.40.42 Release Record

Release commit `9c97a14` on `main` (cut after PR #48, merge `cc129d8`); tag `v0.40.42`. Released on its own: before it, `--attach` and MCP `attach` uploaded `.env`, `.git` contents, key files and outward symlinks.

**Publishing**
- `publish.yml` run 40284687723 passed all six platforms, then npm publish with SLSA v1 provenance and the GitHub Release (2026-10-26 07:15 UTC start). The GitHub Release lists the one entry from `CHANGELOG.md`.
- `npm run release:verify` passed on the release commit after a build.

**Installed**
- WSL, M3, Mac mini: `prodex --version` reports 0.40.42. Running services were not restarted: no host stdio MCP servers on WSL, 1 on M3, none on the Mac mini.
- The maintainer watchdog checkout was pulled to `9c97a14` and rebuilt.

**Verified live on installed 0.40.42 (WSL, scratch repo)**
- `--attach .env` refused: "Path .env is sensitive and cannot be read through repo tools".
- `--attach link.pdf` (symlink to a file outside the repo) refused: "escapes the repository root after resolving symlinks".
- `--attach note.txt` still uploads; ChatGPT answered with the code word from the file, `request_verified: yes`.

**Browser container**
- `container/redesign-patches` `41c34de` ports PR #48. Branch suite: 2081 passed, 3 skipped; `release:verify` ok.
- WSL image `491971a34a26` and M3 image `59747258b693`, each swapped after an idle send-lock check; in both, `--attach .env.probe` is refused and smoke returned `requestVerified: true`.

## 0.40.41 Release Record

Release commit `e0ea707` on `main` (cut after PRs #45-#47, last merge `6911f3e`); tag `v0.40.41`. Released ahead of the usual batch for PR #46, which withheld answers from requests that had posted.

**Publishing**
- `publish.yml` run 40274938156 passed all six platforms, then npm publish with SLSA v1 provenance and the GitHub Release (2026-10-26 05:34 UTC start).
- `npm run release:verify` passed on the release commit after a build. The release script now refuses to tag when the release section has duplicate lines or an `## Unreleased` section survives the rename; the GitHub Release lists the same three entries as `CHANGELOG.md`.

**Installed**
- WSL, M3, Mac mini: `prodex --version` reports 0.40.41. Running services were not restarted: no host stdio MCP servers on WSL and 1 on M3; the Mac mini had none.
- The maintainer watchdog checkout was pulled to `e0ea707` and rebuilt.

**Verified live on installed 0.40.41 (WSL)**
- `Reply with only OK. Run npm test first, then \`npm test\` again.`: `request_verified: yes` (0.40.40 refused it as `request_mismatch`). Before the fix, the 2026-10-24 thread whose two sends had been refused also matched when re-read with the fixed extraction.
- `--model Instant` in a repo with a saved Pro effort: applied to the slider with `model_is_now_an_effort`, answered in 9 s.
- `pro browser recover --target-url "https://chatgpt.com/c/abc def"`: refused before the send lock; the shared tab did not move.

**Browser container**
- `container/redesign-patches` `60a49da` ports #45, `5154330` ports #46 (applied by hand: the container's message helpers differ from `main`), `6a9ea08` ports #47. Branch suite at `6a9ea08`: 2080 passed, 3 skipped; `release:verify` ok.
- WSL images `1ce5bcde0ace` (#45, `--model Instant` applied live), `88bd2a8f427a` (#46, the backtick repro verified), `e83a90389d02` (#47, bad URL refused, smoke `requestVerified: true`).
- M3 (colima `prodex-check`) images `c289e00e756d`, `ee6f98e1588d` (backtick repro verified), `5cd5a5642917` (bad URL refused, smoke ok). Every swap waited for an idle send lock.

**Incidents**
- 2026-10-22: the WSL disk filled to 100% from another project's session scratch data, so command output stopped being written mid-port. Nothing in prodex was involved; the #45 container port resumed after that session's data was cleaned up on its side.
- 2026-10-26: probing recovery input with `--target-url "https://chatgpt.com/c/abc def"` on 0.40.40 moved the shared ChatGPT tab to that URL (the bug PR #47 fixes); no send was in flight and the tab was moved back to the home page.

## 0.40.40 Release Record

Release commit `3d671f5` on `main` (cut after PRs #38-#44, last merge `5609f4c`); tag `v0.40.40`.

**Publishing**
- `publish.yml` run 39563515199 passed all six platforms, then npm publish with SLSA v1 provenance and the GitHub Release (2026-10-21 07:39 UTC start).
- `npm run release:verify` passed on the release commit after a build.

**Changelog defect**
- The released `CHANGELOG.md` (also inside the npm tarball) repeats five entries in the 0.40.40 section and leaves the token TTL fix (#44) under a stray `## Unreleased` heading below it. Cause: the script that resolved CHANGELOG conflicts while rebasing queued PRs copied the branch's whole Unreleased section, which already held the entries merged before it, and #44's branch added a second Unreleased section. `main` was corrected right after the release, and the GitHub Release notes were replaced with the corrected eight entries. The npm tarball cannot be changed. The rebase script now carries only lines missing from `main` and stops on duplicate lines or a second Unreleased section; the release script stops if an Unreleased section survives the rename.

**Installed**
- WSL, M3, Mac mini: `prodex --version` reports 0.40.40. Running services were not restarted: 9 stdio MCP servers on WSL and 1 on M3 keep older code until their clients reconnect. The Mac mini had none running.
- The maintainer watchdog checkout was pulled to `3d671f5` and rebuilt.

**Verified live**
- Installed 0.40.40 on WSL: a prompt with `[the docs](https://en.wikipedia.org/wiki/Function_(mathematics))`, refused twice as `request_mismatch` by 0.40.39, returned `done` with `request_verified: yes`.
- Over MCP on installed 0.40.40: `repo_search "("` explains that the query is a regular expression.
- `pro report-issue` preview shows `blocked at` and `prodex filing this report`; `pro ask --tool web-search` names the send command.

**Browser container**
- `container/redesign-patches` `1f4baa6` ports PRs #38-#41 and `5812053` ports PRs #42-#44. Branch suite at `5812053`: 2074 passed, 3 skipped; `release:verify` ok. One full run failed `project-sidebar-current-ui` "retries a covered target three times" (untouched; passed 3/3 alone and on the rerun).
- WSL: image `75828cfb7ed5` after #38-#41 (the autolink prompt went through live with `request_verified: yes`), then `6042260bebe7` after #42-#44 (smoke `requestVerified: true`). Both swapped under the send lock check.
- M3 (colima `prodex-check`): image `59fd7b2f0e89`, then `2ab687763354`; smoke `requestVerified: true` after each swap, under the send lock check.

## 0.40.39 Release Record

Release commit `c8a170f` on `main` (cut after PRs #33-#37, last merge `09ad42e`); tag `v0.40.39`. First batched release: five fixes merged on green CI and released together.

**Publishing**
- `publish.yml` run 39525668044 passed all six platforms, then npm publish with SLSA v1 provenance and the GitHub Release (2026-10-21 01:09 UTC start).
- `npm run release:verify` passed on the release commit after a build.

**Installed**
- WSL, M3, Mac mini: `prodex --version` reports 0.40.39. Running services were not restarted: 10 stdio MCP servers on WSL and 4 on M3 keep older code until their clients reconnect. The Mac mini had none running.
- The maintainer watchdog checkout was pulled to `c8a170f` and rebuilt.

**Verified live**
- Installed 0.40.39 on WSL: `prodex ask "- list these"` refuses with the hint to put `--` before the prompt.

**Browser container**
- `container/redesign-patches` `d3d7b66` ports PRs #34-#37 (UTF-16 decoding from #33 was already on the branch). The mermaid serializer was applied by hand because the container's transcript helpers differ from `main`. Branch suite: 2061 passed, 3 skipped.
- WSL: image `67b473c3e850`, swapped under the send lock check. Live: a prompt asking for a mermaid flowchart saved the answer with a ```` ```mermaid ```` fence and its source.
- M3 (colima `prodex-check`): image `ad0746f93e40`, swapped under the send lock check; `pro browser smoke` in the container returned `requestVerified: true`.

## 0.40.38 Release Record

Release commit `9541727` on `main` (cut after PR #32, merge `2c049b5`); tag `v0.40.38`.

**Publishing**
- `publish.yml` run 39362699716 passed all six platforms on the first attempt, then npm publish with SLSA v1 provenance and the GitHub Release (2026-10-20 03:08 UTC).
- `npm run release:verify` passed on the release commit after a build.

**Installed**
- WSL, M3, Mac mini: `prodex --version` reports 0.40.38. Running services were not restarted: 9 stdio MCP servers on WSL and 3 on M3 keep older code until their clients reconnect. The Mac mini had none running.
- The maintainer watchdog checkout was pulled to `9541727` and rebuilt.

**Verified live**
- Over a fresh stdio MCP server on installed 0.40.38: a `pro_consult` with a 15 s timeout returned `status: "blocked"` (`send_timeout`) with `recover`, and `pro_recover` with `recover.arguments` returned `status: "done"`. On 0.40.37 the same consult returned only error text naming a CLI command.
- Earlier the same day over MCP: `files`, `continue_thread`, and refusals for a path outside the repo, `.env`, a missing attachment, `new_chat` with `continue_thread`, and `deep-research` all behaved as documented.

**Browser container**
- `container/redesign-patches` `9c8a3d9` ports PR #32. Image `7486d2054a82`; branch suite 2049 passed, 3 skipped. Swapped under the send lock check. Live over MCP in the container: the same timeout returned `recover`, and `pro_recover` returned `done`.

## 0.40.37 Release Record

Release commit `437590d` on `main` (cut after PR #31, merge `fd0ef2e`); tag `v0.40.37`.

**Publishing**
- `publish.yml` run 39351689919 passed all six platforms on the first attempt, then npm publish with SLSA v1 provenance and the GitHub Release (2026-10-20 01:07 UTC).
- `npm run release:verify` passed on the release commit after a build.

**Installed**
- WSL, M3, Mac mini: `prodex --version` reports 0.40.37. Running services were not restarted: 9 stdio MCP servers on WSL and 3 on M3 keep older code until their clients reconnect. The Mac mini had none running.
- The maintainer watchdog checkout was pulled to `437590d` and rebuilt.

**Verified live**
- Before the fix, on installed 0.40.36, two sends started together took 311 s (`answer_incomplete`, though the answer was on screen) and failed after 306 s in the queue: a hidden, zero-size "Stop" button stayed in the composer after a Pro answer.
- Installed 0.40.37: the same two concurrent sends both completed, with no `answer_incomplete`.

**Browser container**
- `container/redesign-patches` `7ea2015` ports PR #31. Image `452d4ae8fc85`; branch suite 2045 passed, 1 failed (a sidebar retry timing test, 3/3 green alone), 3 skipped. Swapped under the send lock check. Live: two concurrent sends finished in 29 s and 61 s, both complete.

**Not acted on**
- An unsolicited email (2026-10-20) proposed `"exports": {".": {"import": "./dist/index.js", "require": "./dist/index.cjs"}}`. The package is CLI-only by design (`d46034c`, 2026-06-24), `dist/index.cjs` does not exist, and applying it in a scratch checkout made `npm run smoke:package` fail ("Installed package unexpectedly allowed import(@youdie006/prodex)"). Nothing was changed; the sender was not contacted.

## 0.40.36 Release Record

Release commit `eee7a7c` on `main` (cut after PR #30, merge `1e53f4e`); tag `v0.40.36`.

**Publishing**
- `publish.yml` run 39220885039 passed all six platforms on the first attempt, then npm publish with SLSA v1 provenance and the GitHub Release (2026-10-19 08:10 UTC).
- `npm run release:verify` passed on the release commit after a build.

**Installed**
- WSL, M3, Mac mini: `prodex --version` reports 0.40.36. Running services were not restarted: 9 stdio MCP servers on WSL and 2 on M3 keep older code until their clients reconnect. The Mac mini had none running.
- The maintainer watchdog checkout was pulled to `eee7a7c` and rebuilt.

**Verified live**
- Host, installed 0.40.36: an answer with a markdown code block showing a fenced `js` example was saved with a four-backtick fence and no toolbar label line. Code blocks with HTML entities and backslashes, a table with an escaped pipe, and inline and display math were saved intact.

**Browser container**
- `container/redesign-patches` `3233bdc` ports PR #30 by hand. Image `3945d3d38af0`; branch suite 2042 passed, 3 skipped. Swapped under the send lock check. Live: the same nested block was saved intact.

**Known and left as is**
- An answer's text `&lt;tag&gt;` is saved as `<tag>`, as displayed; rendering the saved markdown again may treat it as an HTML tag.

## 0.40.35 Release Record

Release commit `4c711c7` on `main` (cut after PR #29, merge `fdf7501`); tag `v0.40.35`.

**Publishing**
- `publish.yml` run 39211269776 passed all six platforms on the first attempt, then npm publish with SLSA v1 provenance and the GitHub Release (2026-10-19 06:40 UTC).
- `npm run release:verify` passed on the release commit after a build.

**Installed**
- WSL, M3, Mac mini: `prodex --version` reports 0.40.35. Running services were not restarted: 10 stdio MCP servers on WSL and 2 on M3 keep older code until their clients reconnect. The Mac mini had none running.
- The maintainer watchdog checkout was pulled to `4c711c7` and rebuilt.

**Verified live**
- Host, installed 0.40.35: the special-character stdin prompt (paths, HTML tags and entities, markdown, a link, `$`, tabs, a table, Korean) answered `SPECIAL_OK`; 0.40.34 had refused it as `request_mismatch`.

**Browser container**
- `container/redesign-patches` `62b713e` ports PR #29. Image `9b46b724ea31`; branch suite 2041 passed, 3 skipped. Swapped under the send lock check. Live: the same prompt answered `SPECIAL_OK` (the previous image refused it); smoke `PRODEX_PRO_SMOKE_OK`.

## 0.40.34 Release Record

Release commit `574e5f0` on `main` (cut after PR #28, merge `1d93de4`); tag `v0.40.34`.

**Publishing**
- `publish.yml` run 39201678797 passed all six platforms on the first attempt, then npm publish with SLSA v1 provenance and the GitHub Release (2026-10-19 04:52 UTC).
- `npm run release:verify` passed on the release commit after a build.

**Installed**
- WSL, M3, Mac mini: `prodex --version` reports 0.40.34. Running services were not restarted: 10 stdio MCP servers on WSL and 2 on M3 keep older code until their clients reconnect. The Mac mini had none running.
- The maintainer watchdog checkout was pulled to `574e5f0` and rebuilt.

**Verified live**
- Host, installed 0.40.34: `--model "GPT-5.6 Sol" --effort Pro` and then `--model GPT-6 --effort Pro` both answered; the picker ended on GPT-6, 5/5 Pro. Installed 0.40.33 had refused the Sol selection ("another element covers its click point").
- Before the fix, on ChatGPT build `bfc3a09a` the host matrix passed: `--continue-task`, `--temporary`, `--tool web-search`, `--attach`, `--project`, `recover --request-id`, `--effort High`, `--model Pro`.

**Browser container**
- `container/redesign-patches` `ab1c6e1` ports PR #28. Image `a3746b490dbb`; branch suite 2038 passed, 3 skipped. Swapped under the send lock check; the ChatGPT tab opened on its own. Live: GPT-5.6 Sol then GPT-6 Pro both answered.

## 0.40.33 Release Record

Release commit `0497134` on `main` (cut after PR #27, merge `6083c6a`); tag `v0.40.33`.

**Publishing**
- `publish.yml` run 39181118204 passed all six platforms on the first attempt, then npm publish with SLSA v1 provenance and the GitHub Release (2026-10-19 00:51 UTC).
- `npm run release:verify` passed on the release commit after a build.

**Installed**
- WSL, M3, Mac mini: `prodex --version` reports 0.40.33. Running services were not restarted: 10 stdio MCP servers on WSL and 2 on M3 keep older code until their clients reconnect. The Mac mini had none running.
- The maintainer watchdog checkout was pulled to `0497134` and rebuilt.

**Verified live**
- With 0.40.33 installed, `login --virtual-display` on the affected machine printed the taken-port message for 9333 and left no Chrome running on the profile.

## Browser Incident 2026-10-18: Windows reserved port 9333

**What happened**
- The WSL machine restarted at 2026-10-18 18:08 KST. From 19:17 KST the hourly canary logged `skipped - the browser is not available`.
- The watchdog's first revive (19:17 KST) started Chrome, which loaded ChatGPT logged in but never opened its DevTools port; login reported "did not expose a reachable DevTools endpoint ... check the display, profile lock". Later revives refused the leftover Chrome as wedged (`ui_watchdog_revive=failed ... still running ... stopped answering`).
- The browser container was unaffected (port 9333 is inside its own network namespace).

**Cause**
- Windows (Hyper-V/WinNAT) reserved TCP ports 9240-9339 at boot (`netsh interface ipv4 show excludedportrange protocol=tcp`). The machine runs WSL with `networkingMode=mirrored`, so the reservation applies inside WSL, and Chrome logged `bind() failed: Address already in use` and `Cannot start http server for devtools`.
- The Windows TCP dynamic port range starts at 1024 (13,977 ports) instead of the default 49152, which lets these reservations land on 9333.

**Recovery and fixes**
- The leftover Chrome was ended with `prodex pro browser reset --confirm`. PR #27 (0.40.33) makes login close a browser whose control port never appears and name a taken port.
- Not changed: the Windows port settings. Bringing the host browser back needs an administrator on Windows: `net stop winnat` then `net start winnat` for now, and `netsh int ipv4 set dynamicport tcp start=49152 num=16384` (and `udp`) plus a restart to keep it from recurring. As of this record the range was still reserved and the host browser was down.
- Resolved 2026-10-19 11:51 KST: the maintainer ran the elevated script (`netsh int ipv4 set dynamicport tcp|udp start=49152 num=16384`, then `net stop winnat` / `net start winnat`). The 9240-9339 reservation was gone and 9333 could be bound. `login --virtual-display` was ready in 2 s; the canary reported the new ChatGPT build `bfc3a09a` as changed; the smoke answered `PRODEX_PRO_SMOKE_OK`, and a 500-line `--file` send on 0.40.33 answered correctly with the request verified.

## 0.40.32 Release Record

Release commit `e0e260e` on `main` (cut after PR #26, merge `f57f413`); tag `v0.40.32`.

**Publishing**
- `publish.yml` run 38339570276 passed all six platforms on the first attempt, then npm publish with SLSA v1 provenance and the GitHub Release (2026-10-13 02:59 UTC).
- `npm run release:verify` passed on the release commit after a build.

**Installed**
- WSL, M3, Mac mini: `prodex --version` reports 0.40.32. Running services were not restarted: 4 stdio MCP servers on WSL and 4 on M3 keep older code until their clients reconnect. The Mac mini had none running.
- The maintainer watchdog checkout was pulled to `e0e260e` and rebuilt.

**Verified live**
- Before the fix, installed 0.40.31 refused a 500-line (12 KB) `--file` send as `request_mismatch`; installed 0.40.32 answered it (`amber-19`).
- With the PR build: a 2,400-line `--file` is refused with the `--attach` pointer, and a 57 KB inline prompt answered in 84 s.

**Browser container**
- `container/redesign-patches` `f408fda` ports PR #26 onto the container's own transcript reader. Image `05c65e5dd1f4`; branch suite 2034 passed, 3 skipped. The swap was gated on the send lock; the ChatGPT tab opened on its own afterwards (the restart change from 2026-10-10, `42a027e`).
- Live in the container: the 2,400-line `--file` refusal, the 500-line `--file` answer (`amber-19`), and the smoke (`PRODEX_PRO_SMOKE_OK`).

**Also on 2026-10-11 to 10-13**
- `container/redesign-patches` `42a027e`: the container restarts unless stopped and opens the ChatGPT root itself. Verified by sending SIGTERM to its Chromium: Docker restarted it and the smoke answered without a login step.
- The canary stayed `ok` on build `314720d0` hourly from 2026-10-11 to 10-13.

## Browser Incident 2026-10-10: earlyoom

**What happened**
- The host's dedicated browser (port 9333) stopped answering twice: around 11:49 and at 17:45 KST. The browser container exited at 11:49 KST (exit 1, `chromium exited (SIGTRAP)`, restart policy `no`) and stayed down.
- The hourly canary logged `skipped - the browser is not available` from 18:17 KST on, and filed nothing.

**Cause**
- The machine's `earlyoom` (override from 2026-08-14: `-m 15 -s 40`) sent SIGTERM to Chrome and Chromium processes: 25 between 11:45 and 11:49, 17 at 17:45. It acts when available memory is under 15% and free swap under 40%. Swap was 88% used (1 GiB free of 8), so every dip under 15% memory picked a process, and Chrome's processes carried the highest badness (800-876).
- Earlier days show the same: 248 Chrome kills on 2026-10-08 (09:00-11:59 KST), which likely explains that day's browser losses.
- At 19:03 earlyoom also killed `chrome-headless`, `swapdex`, `ssh` and `dbus-daemon` processes, so the pressure is machine-wide, not prodex's.

**Recovery**
- Host browser restarted once on the Xvfb display (`login --virtual-display`, logged in, 4 s); the container started from the same image `547e852632b5` and its tab reopened (2 s). The canary from `12aab1e` (PR #24, re-read before reporting broken) then reported `ok` on build `314720d0`.

**Not changed**
- The earlyoom configuration and the container restart policy. Both are the maintainer's machine-level choices.

## 0.40.31 Release Record

Release commit `0b10dd1` on `main` (cut after PR #23, merge `d5296e0`); tag `v0.40.31`.

**Publishing**
- `publish.yml` run 38019182789 passed all six platforms on the first attempt, then npm publish with SLSA v1 provenance and the GitHub Release (2026-10-10 03:03 UTC).
- `npm run release:verify` passed on the release commit after a build.

**Installed**
- WSL, M3, Mac mini: `prodex --version` reports 0.40.31. Running services were not restarted: 4 stdio MCP servers on WSL and 4 on M3 keep older code until their clients reconnect. The Mac mini had none running.
- The maintainer watchdog checkout (`~/.local/share/prodex-maint/repo`) was pulled to `0b10dd1` and rebuilt, so the hourly canary now uses the live build check and the renderer markers.

**Verified live**
- Host 0.40.31: a Markdown `--file` new-chat send answered (`opal-5`).
- The host's dedicated browser had stopped answering on port 9333 after about 11:18 KST; it was restarted once on the Xvfb display (`login --virtual-display`, logged in, 5 s). Cause not established.
- The canary's first run right after that restart reported `broken: model selector`, because the composer had not rendered yet; the next run was `ok` on build `314720d0`. The model picker lists GPT-6, GPT-5.6 Sol and GPT-5.5.

## Browser Container Rebuild 2026-10-10

**Patches**
- `container/redesign-patches` `5047ef9` ports 0.40.28-0.40.30 and PR #23 (newer answer renderer, sent turn drawn as markdown) onto the container branch. It is based on `b5eac7d`; `feat/headless-browser-compatibility` itself is unchanged.

**Image**
- `547e852632b5`, built from `5047ef9`; the branch suite passed (2027 passed, 3 skipped).
- Both swaps were gated on the send lock being free. After the swap the browser had no ChatGPT tab, so `prodex pro browser login --wait` reopened it (logged in, 3 s). MCP clients of the container need `/mcp` reconnects.

**Verified live**
- Image `9b51e0639a37` (the port without the fence fix): web search with bold and `[GitHub+1]` badges, continued and temporary attach, recover, models (the picker now lists GPT-6), smoke in a new chat, `pro list` in 5 s. A Markdown `--file` send posted but was refused as unverified: the container's ChatGPT drew the sent turn as markdown and dropped the ```` ```text ```` fence line.
- Image `547e852632b5`: the same `--file` send answered 2/2, and the smoke answered `PRODEX_PRO_SMOKE_OK`.

**Not a bug**
- A host 0.40.30 `--file` run failed during this check only because another send held the browser lock past its wait budget; the next run answered.

## 0.40.30 Release Record

Release commit `e566efc` on `main` (cut after PR #22, merge `c0964f2`, plus the docs commit `09e80bc`); tag `v0.40.30`.

**Publishing**
- `publish.yml` run 37798469373 passed all six platforms on the first attempt, then npm publish with SLSA v1 provenance and the GitHub Release (2026-10-08 15:32 UTC).
- `npm run release:verify` passed on the release commit after a build.

**What it fixes**
- `pro browser smoke` always uses a fresh chat instead of whatever conversation was open.
- Its default budget is 5 minutes instead of 90 s.
- The page canary and the watchdog changes from the same PR are maintainer tooling and are not in the package. See Maintainer Watchdog.

**Installation on 2026-10-09**
- Global npm with `--prefer-online`, each verified with `prodex --version` = 0.40.30.
- WSL, M3, Mac mini: installed. Running services were not restarted: 21 stdio MCP servers on WSL and 10 on M3 keep older code until their clients reconnect. The Mac mini had none running.
- M4: not reachable (hostname does not resolve); not updated.

**Live check after install (installed 0.40.30, shared WSL browser)**
- With the tab on an existing conversation, `pro browser smoke` answered `PRODEX_PRO_SMOKE_OK` in a new conversation, not the open one.
- A new-chat attachment answered.
- The hourly watchdog had already logged `canary: ok` runs for build `4c511f80`.

## Maintainer Watchdog

On the maintainer's WSL machine, cron runs the UI watchdog every hour (since 2026-10-08):

```
17 * * * * PATH=<node bin>:/usr/bin:/bin PRODEX_CLI=~/.local/share/prodex-maint/prodex PRODEX_WATCHDOG_CWD=/mnt/d/MyProject/gptprouse <node> ~/.local/share/prodex-maint/repo/scripts/ui-watchdog.mjs --canary --revive --file-issue >> ~/.local/state/prodex-watchdog.log 2>&1
```

**What each run does**
- It runs `scripts/page-canary.mjs`, which only reads the page:
  - It records ChatGPT's build id and whether each control prodex relies on is present.
  - It compares with `~/.local/share/prodex/page-canary.json`.
  - It skips while a consult holds the send lock.
  - A broken read is read again up to twice, 10 s apart, and counts only if it stays broken. Right after a browser restart on 2026-10-10 the first read found no model selector because the composer had not rendered yet.
- Only when the canary reports changed (3) or broken (2) does the watchdog run `pro browser smoke` (a fresh chat, 5-minute budget). If that fails, it files or extends a GitHub issue by blocker code.
- A busy browser is logged as skipped and never filed.
- With `--revive` (since 2026-10-10), a canary that finds the dedicated browser gone, or without a ChatGPT tab, makes the watchdog run `pro browser login --virtual-display --wait` once and read the page again. It does this at most once every 6 hours (`~/.local/state/prodex-maint/revive.json`), so a machine short of memory does not get a new Chrome every hour. A consult holding the lock, or a tab that stopped answering, is never touched. This came from the earlyoom incident below, where the browser stayed down for hours.

**Where it runs from**
- `~/.local/share/prodex-maint/repo` is a clone of `main`, built with `npm ci && npm run build`.
- `~/.local/share/prodex-maint/prodex` runs its `dist/cli.js`, so the round trip uses current `main` rather than whatever version is installed.

**Updating it**
- After merging watchdog or smoke changes, run `git -C ~/.local/share/prodex-maint/repo pull --ff-only && (cd ~/.local/share/prodex-maint/repo && npm ci && npm run build)`.

**What it replaced**
- A daily 09:23 round trip run from the main checkout:
  - It sent its prompt into whatever conversation was open.
  - It timed out at 90 s on high efforts (issue #4).
  - It filed a busy browser as broken (issue #20, closed as a false positive).
- The crontab before the change is saved at `~/.local/state/prodex-maint/crontab.backup-20261008`.
- `--revive` was added to the cron line on 2026-10-11 after PR #25 (merge `9c9a1b4`); the checkout was pulled to that merge and rebuilt, and one manual run was `ok`. The crontab before that edit is saved at `~/.local/state/prodex-maint/crontab.backup-20261011`.

## 0.40.29 Release Record

Release commit `220d609` on `main` (cut after PR #19, merge `d0a7793`); tag `v0.40.29`.

**Publishing**
- `publish.yml` run 37717711177 passed all six platforms on the first attempt, then npm publish with SLSA v1 provenance (job log: `+ @youdie006/prodex@0.40.29` at 02:48:10 UTC) and the GitHub Release (2026-10-08 02:48 UTC).
- The registry served the new version about four minutes after the publish step.
- `npm run release:verify` passed on the release commit after a build.

**What it fixes**
- The CHANGELOG lists the full set: fixes found by a live feature hunt from 2026-10-06 to 2026-10-08.
- Also checked against ChatGPT's new build, which changed `html[data-build]` from `8089c0e4...` to `36d7890c...`. The core selectors still held. Code blocks moved from CodeMirror to plain `<pre><code>`, a `data-markdown-copy="blank-lines"` marker appeared, and a thread keeps its tool token in the composer. All three were exercised live and are handled.

**Installation on 2026-10-08**
- Global npm, each verified with `prodex --version` = 0.40.29.
- WSL, M3, Mac mini: installed. M3 and the Mac mini first reinstalled 0.40.28 from a stale registry view, and needed `--prefer-online`.
- Running services were not restarted: 7 stdio MCP servers on WSL and 10 on M3 keep older code until their clients reconnect. The Mac mini had none running.
- M4: not reachable (hostname does not resolve); not updated.
- The browser container still runs `container/redesign-patches` `1233603` (image `sha256:ce0240c0e8a4`), and does not have this release's fixes.

**Browser incidents on 2026-10-08, during the hunt**
- **Host tab crash:** the host browser's ChatGPT tab renderer crashed. `pro browser check` reported `browser_tab_crashed`, and the next send reloaded the tab once and answered.
- **Both browsers stopped at 00:31 UTC:** the host browser stopped entirely, and the browser container exited after its Chromium logged "GPU process exited unexpectedly: exit_code=15" three times and "GPU process isn't usable. Goodbye." The cause was not established.
- **Recovery:** the container was restarted with `up -d --no-build browser` and found the session READY. The host profile came back logged out; the user logged in through `--headed`, and the browser was relaunched on its virtual display.
- **Related defect found and fixed in this release:** host-side prodex counted the container's Chromium as its own browser. With the host browser down, `pro browser reset` offered to end 12 container processes. It was previewed only, and nothing was ended. Whether that path caused the 00:31 stop is not established: the host's automatic recovery matches by its recorded profile, which excludes the container.

**Live check after install (installed 0.40.29, shared WSL browser, new ChatGPT build)**
- Answered:
  - new-chat attach
  - project attach
  - `--continue`
  - markdown `--file`
  - a formatted answer, with heading, numbered list and fenced code
  - create-image
- `pro list` took 2.5 s on a repo with 260 consults; it had taken 238 s before this release.

## 0.40.28 Release Record

Release commit `8100c37` on `main` (cut after PR #18, merge `8afda89`); tag `v0.40.28`.

**Publishing**
- `publish.yml` run 37432329959 passed all six platforms on the first attempt, then npm publish with SLSA v1 provenance and the GitHub Release (2026-10-06 08:11 UTC).
- PR #18's CI on its docs-only head commit passed macOS Intel only on the third attempt:
  - The first attempt was an unrelated 30 s timeout in `tests/cli-pro-browser-send.test.ts`.
  - The second ended with "npm test" failing without naming a test; the output was cut off mid-run.
  - The code commit before it had passed all six platforms.
- `npm run release:verify` passed on the release commit after a build.

**What it fixes**
- On a heavily loaded host, the new-chat page and the composer's controls get 30 s ceilings. Before, back-to-back sends were refused as `composer_not_ready` or `fresh_chat_not_ready` before anything was sent.

**Installation on 2026-10-06**
- Global npm, each verified with `prodex --version` = 0.40.28.
- WSL, M3, Mac mini: installed. Running services were not restarted: 11 stdio MCP servers on WSL and 4 on M3 keep older code until their clients reconnect. The Mac mini had none running.
- M4: not reachable (hostname does not resolve); not updated.
- The browser container already runs the same ceilings (see the afternoon rebuild).

**Live check after install (installed 0.40.28, shared WSL browser, host load average 5.5)**
- Three back-to-back `--model Pro --pro-mode` new-chat sends answered.
- A project send with an attachment answered.
- A create-image send answered.

## Browser Container Rebuild 2026-10-06 (afternoon)

**Patches now committed**
- The patches the container runs on top of `feat/headless-browser-compatibility` `b5eac7d` are now committed on their own branch, `container/redesign-patches`:
  - `0c3a9cc`: every patch from 2026-09-30 to 2026-10-06.
  - `1233603`: the 30 s composer-render ceiling from this change.
- They had lived only in a scratch worktree.
- `feat/headless-browser-compatibility` itself is unchanged.

**Image**
- `sha256:ce0240c0e8a4` was built from `1233603`, and the branch suite passed (2002).
- The swap was gated on the send lock being free.

**Verified**
- Three back-to-back `--model Pro --pro-mode` new-chat sends answered (42-50 s each).
- Before this, a real consult from another session had been refused as `composer_not_ready` (`task_20261006_050125`) under host load average 24-44.

**Host load**
- The load came from an unrelated container, `apo-neo4j`, which had restarted 57,058 times because it could not resolve its own hostname. The user is handling it.

## 0.40.27 Release Record

Release commit `f84ce2b` on `main` (cut after PR #17, merge `9dad219`); tag `v0.40.27`.

**Publishing**
- `publish.yml` run 37419470087 passed all six platforms on the first attempt, then npm publish with SLSA v1 provenance and the GitHub Release (2026-10-06 05:57 UTC).
- `npm run release:verify` on the release commit passed on its second run. The first failed in package smoke, where the fake DevTools endpoint did not answer within 500 ms while the host load average was about 30 (8 cores).

**What it fixes**
- Source pills in page-read answers are spelled out as markdown links or `[label]`.
- Recovery waits for the thread's turns instead of refusing its own request right after navigating.

**Installation on 2026-10-06**
- Global npm, each verified with `prodex --version` = 0.40.27.
- WSL, M3, Mac mini: installed. Running services were not restarted: 5 stdio MCP servers on WSL and 4 on M3 keep older code until their clients reconnect. The Mac mini had none running.
- M4: not reachable (hostname does not resolve); not updated.

**Live check after install (installed 0.40.27, shared WSL browser)**
- All answered:
  - a new-chat attachment
  - a web-search answer, ending in a markdown source link
  - a project send
  - `pro browser recover` with the tab on another conversation, which returned the answer

**Browser container, same day**
- The pill and recovery fixes were adapted to the branch code.
- A consult from another session (task `task_20261006_050125`, 05:01 UTC) had been refused with `composer_not_ready`. Back-to-back `--model Pro` new-chat sends reproduced a related failure, `fresh_chat_not_ready`: the new-chat page took more than 15 s to settle with the host load average at 28-32. The branch's new-chat ceiling was raised to 30 s. It is only a ceiling.
- Image `sha256:2b76266ad524`. The earlier interrupted-looking consult `task_20261006_050200` had finished at 05:07, before the swap.
- The swap was gated on the send lock being free.
- Two branch tests failed in the pre-build run, and the build script did not stop on test failures, so the image was built and swapped anyway. One test advanced a fake clock 25 s against the new 30 s ceiling; it was fixed. The other was a load-sensitive project-sidebar test, which passed on rerun. After that, the full branch suite passed (2002). The image's runtime code is the code that passed.
- Verified: three back-to-back `--model Pro --pro-mode` new-chat sends answered (44-50 s each).

## 0.40.26 Release Record

Release commit `b413c24` on `main` (cut after PR #16, merge `af5cf20`); tag `v0.40.26`.

**Publishing**
- `publish.yml` run 37405732176 passed all six platforms on the first attempt, then npm publish with SLSA v1 provenance and the GitHub Release (2026-10-06 03:07 UTC).
- PR #16's own CI needed one rerun on macOS Intel for an unrelated 30 s timeout in `tests/mcp-consult.test.ts`.
- `npm run release:verify` passed on the release commit after a build.

**What it fixes**
- The ChatGPT page measured on 2026-10-06 broke several flows:
  - Every project send was refused because a hidden, still-mounted conversation was counted.
  - Attachments did not recognize timestamp-renamed uploads, picked a hidden composer form, and ran before the file input existed.
  - Leftover chips were no longer detected.
  - Composer tools were looked up or clicked before they worked.
- Found by a live matrix against the installed 0.40.25, where `--project` sends, project attachments, new-chat attachments after a repeat upload and `--tool create-image` failed.

**Installation on 2026-10-06**
- Global npm, each verified with `prodex --version` = 0.40.26.
- WSL, M3, Mac mini: installed. Running services were not restarted: 11 stdio MCP servers on WSL and 6 on M3 keep older code until their clients reconnect. The Mac mini had none running.
- M4: not reachable (hostname does not resolve); not updated.

**Live check after install (installed 0.40.26, shared WSL browser)**
All eight answered:
- `--project` plain and with `--attach`
- `--tool create-image`
- `--new-chat --attach`
- `--continue --attach`
- `--tool web-search --attach`
- `--temporary --attach`
- plain `--continue`

**Browser container, same day**
- Before the rebuild, the container build failed the same way: a project send was refused and a new-chat attachment timed out. Its tab then stopped answering CDP.
- The same fixes were adapted to the branch code, where the transcript reader and the hover-verified tools click differ. The image `sha256:8e5734ee733c` was rebuilt from `b5eac7d` with all patches so far. These are still uncommitted, and nothing was pushed to `feat/headless-browser-compatibility`.
- Branch suite: 1998 passed. The swap was gated on the send lock being free.
- Verified in the container, all seven answered:
  - a project send
  - a new-chat attachment
  - an attachment on a continued thread
  - a project attachment
  - create-image
  - web search with an attachment
  - a temporary chat with an attachment
- An MCP client reconnect was needed after the swap.

## 0.40.25 Release Record

Release commit `3c66da3` on `main` (cut after PR #15, merge `9bd908c`); tag `v0.40.25`.

**Publishing**
- `publish.yml` run 37394019059 passed all six platforms on the first attempt, then npm publish with SLSA v1 provenance and the GitHub Release (2026-10-06 00:48 UTC).
- `npm run release:verify` passed on the release commit after a build.

**What it fixes**
- A send into an existing conversation from a tab on another one now waits for that page to finish loading.

**Installation on 2026-10-06**
- Global npm, each verified with `prodex --version` = 0.40.25.
- WSL, M3, Mac mini: installed. Running services were not restarted: 19 stdio MCP servers on WSL and 7 on M3 keep older code until their clients reconnect. The Mac mini had none running.
- M4: not reachable (hostname does not resolve); not updated.
- The browser container already carries the same fix (2026-10-02 rebuild, see 0.40.24). An MCP consult through it answered on 2026-10-06 after the client reconnected.

**Live check after install (installed 0.40.25, shared WSL browser)**
- The tab was first moved to a new chat.
- `--continue --attach` answered, with a baseline of 5 earlier user messages.
- `--new-chat --attach` answered.
- A plain `--continue` recalled the word set at the start of the thread.

**Real use since 0.40.24 (2026-10-02 to 2026-10-06)**
- `prodex pro blockers`: 3 of 18 host consults were blocked, all three the probes that reproduced the bugs fixed in 0.40.24 and 0.40.25.
- 0 of 5 container consults were blocked.

## 0.40.24 Release Record

Release commit `e927eee` on `main` (cut after PR #14, merge `393f720`); tag `v0.40.24`.

**Publishing**
- `publish.yml` run 36975443077 passed all six platforms on the first attempt, then npm publish with SLSA v1 provenance and the GitHub Release (2026-10-02 07:10 UTC).
- `npm run release:verify` passed on the release commit after a build.

**What it fixes**
- Attachments into an existing conversation used a second form on the page that has no prompt editor.

**Installation on 2026-10-02**
- Global npm, each verified with `prodex --version` = 0.40.24.
- WSL, M3, Mac mini: installed. Running services were not restarted: 5 stdio MCP servers on WSL and 7 on M3 keep older code until their clients reconnect. The Mac mini had none running.
- M4: not reachable (hostname does not resolve); not updated.

**Live check after install (installed 0.40.24, shared WSL browser)**
- `--new-chat --attach` answered.
- `--continue --attach` failed with "composer has no file input" when the tab started on another conversation. When the tab was already on the target thread it had passed.
- Cause: the conversation page was used before it finished loading. Fixed in the next change.

**Browser container, same day**
- Image `sha256:2a2091354d90`, rebuilt from `b5eac7d` with the earlier uncommitted patches plus two more: the composer-form file input lookup and the loaded-document requirement for thread readiness.
- Full suite 1989 passed on the patched tree. The swap was gated on the send lock being free.
- Verified in the container: `--continue --attach` from another thread answered, and so did `--new-chat --attach`.

## 0.40.23 Release Record

Release commit `1c905e3` on `main` (cut after PR #13, merge `92c26ce`); tag `v0.40.23`.

**Publishing**
- `publish.yml` run 36824322576 passed all six platforms on the first attempt, then npm publish with SLSA v1 provenance and the GitHub Release (2026-10-01 06:43 UTC).
- PR #13's own CI had needed one rerun on Windows for an unrelated 30 s timeout in `tests/cli.test.ts` ("uses an explicit --cwd target for local HTTP MCP start").
- `npm run release:verify` passed on the release commit after a build.

**What it fixes**
- `--new-chat` sends from a tab already on a new chat now wait for the new page, so attachments no longer fail with "composer has no file input".

**Installation on 2026-10-01**
- Global npm, each verified with `prodex --version` = 0.40.23.
- WSL, M3, Mac mini: installed. Running services were not restarted: 9 stdio MCP servers on WSL and 7 on M3 keep older code until their clients reconnect. The Mac mini had none running.
- M4: not reachable (hostname does not resolve); not updated.
- The browser container is unchanged by this release. It runs its own branch build with its own new-chat wait.

**Live check after install**
- Run from WSL through the installed 0.40.23 against the shared browser.
- The same file attached twice with `--new-chat`: both answered. The installed 0.40.22 had failed this three times.
- A plain new chat answered.

## 0.40.22 Release Record

Release commit `a5f9596` on `main` (cut after PR #12, merge `563f381`); tag `v0.40.22`.

**Publishing**
- `publish.yml` run 36817391329 failed on its first attempt on macOS 15 Intel and Windows Server 2025. The failures were 30 s test timeouts in `tests/store.test.ts` (both runners) and `tests/followup-budget.test.ts` (Windows). Neither test touches the change, and PR #12 had passed all six platforms.
- Nothing was published by that attempt.
- Re-running the failed jobs passed all six platforms. npm publish with SLSA v1 provenance and the GitHub Release followed (2026-10-01 05:31 UTC).
- Before tagging, `npm run release:verify` passed on the release commit after a build.

**What it fixes**
- Repeat attachments: ChatGPT shows a re-uploaded name as `name(3).txt`.

**Installation on 2026-10-01**
- Global npm, each verified with `prodex --version` = 0.40.22.
- WSL, M3, Mac mini: installed. Running services were not restarted: 6 stdio MCP servers on WSL and 7 on M3 keep older code until their clients reconnect. The Mac mini had none running.
- M4: not reachable (hostname does not resolve); not updated.
- The browser container builds from its own branch. It received the same fix in its 2026-10-01 rebuild; an npm install does not update it.

**Live check after install**
- A `--new-chat --attach` send from WSL through the installed 0.40.22 failed three times with "composer has no file input". This is a separate defect in the new-chat wait, fixed in the next change.
- With that fix built from source, the same file attached twice answered both times. That also exercises the 0.40.22 renamed-upload fix on the host browser.

## Browser Container Rebuild 2026-10-01

The container image was rebuilt again from `feat/headless-browser-compatibility` `b5eac7d` with uncommitted patches. None of them is pushed to that branch; they still have to be reconciled when that branch merges with `main`.

**Patches**
- The streaming selector from 2026-09-30.
- The new-chat wait raised from 8 s to 15 s.
- The non-text (image) answer detection from 0.40.21, adapted to the branch's message reader.
- The renamed-upload attachment fix from this change.

**Image and checks**
- Image `sha256:d2880fda5ab9`.
- Full suite 1989 passed on the patched tree.
- Each container swap was gated on the send lock being free (lock file absent, or its holder pid dead). The 2026-09-30 check only looked at process names.

**Verified live in the container after the swap**
- Three fresh-chat sends in a row answered, 35-36 s each; this flow failed about one send in three before the patch.
- A create-image send returned the non-text note in 49 s, where it had timed out after 6 min 40 s.
- The same file attached twice in a row answered `plum-7` both times. Before the fix, the second upload, shown by ChatGPT as `attach-probe(3).txt`, waited out the upload budget.
- An MCP `initialize` through `scripts/container-client.mjs` answered (server reports 0.40.18, the branch's version).

**Impact on clients**
- Clients connected to the container's MCP have to reconnect after each swap.

## Browser Container Rebuild 2026-09-30

Not an npm release; the container `prodex-browser-browser-1` builds from `feat/headless-browser-compatibility`, so this section records its state.

A live check of the container build of `b5eac7d` (2026-09-30) found: web search and temporary chats answered; fresh-chat sends failed intermittently with `fresh_chat_not_ready`; `--attach` failed on the upload budget; a create-image send timed out after 6 min 40 s; and streaming was never detected (15 of 15 samples reported idle while ChatGPT showed its Stop button), because the branch's `CHATGPT_STREAMING_SELECTOR` does not match the redesigned composer's plain `aria-label="Stop"` button.

**Rebuild.** Image `sha256:45951848a88b`, built from `b5eac7d` plus one uncommitted line: `CHATGPT_STREAMING_SELECTOR` gained `form button[aria-label="Stop"]` and `form button[aria-label="중지"]`, the same selectors `main` shipped in 0.40.21. Nothing was pushed to that branch; the change lives only in the image. Verified: the selector is present in `/app/dist/chatgpt-browser.js`; container healthy with the profile volume kept; `pro browser login --wait` found the session READY; a fresh-chat send answered in 20 s while a 1 s sampler read the page as generating on all 9 samples during which the Stop button was visible (task `task_20260930_014256`).

**Interrupted consult.** The swap at about 01:37 UTC interrupted a consult that another session had started over MCP at 01:34:31 (`task_20260930_013431`, left `claimed` with no thread), and dropped every client's MCP connection to the container; clients have to reconnect with `/mcp`. The pre-swap check only looked for `pro browser ask` processes and missed MCP consults. Before swapping the container again, check whether the send lock's holder process is alive, not the process names. Whether ChatGPT accepted that prompt was never recorded, so it must not be resent blindly.

**Still open on the branch, not fixed in this image.**

- Fresh-chat flake: the new-chat page took 5.2, 5.2, 5.6 and 8.5 s to become ready in four timed runs inside the container, while `waitForFreshChatGptPage` allows 8 s. The fix is a longer budget.
- `--attach` and create-image failures: `main` 0.40.21 has fixes for both.
- These belong to the branch owner and have to be reconciled when the branch merges with `main`.

## 0.40.21 Release Record

Release commit `936b009` on `main` (cut after PR #10, merge `5e74ba2`); tag `v0.40.21`. `publish.yml` run 36538816944 passed all six platforms on the first attempt, then npm publish with SLSA v1 provenance and the GitHub Release (2026-09-29 08:08 UTC).

What it fixes: what 0.40.20 left broken after the ChatGPT redesign - sends starting on a fresh chat, composer tools, `--project-new`, image answers that timed out, and response streaming that was never detected. Found by a live feature matrix against the published 0.40.20; each fix re-run live before release. `--project-new` created a probe project in the user's account, which was deleted afterwards through the project's own actions menu after checking the menu belonged to that project; the other nine projects were compared by id and left intact.

Installation on 2026-09-29, global npm, each verified with `prodex --version` = 0.40.21:

- WSL, M3, Mac mini: installed. On WSL a fresh-chat consult through the installed binary answered (`v21-ok`). Running services were not restarted: 3 stdio MCP servers on WSL and 4 on M3 keep older code until their clients reconnect; the Mac mini had none.
- M4: not reachable (hostname does not resolve); not updated.
- The browser container still runs its own build of `feat/headless-browser-compatibility` `b5eac7d` (see 0.40.20); it was not rebuilt for this release.

## 0.40.20 Release Record

Release commit `b8f8004` on `main` (cut after PR #9, merge `b134eae`); tag `v0.40.20`. `publish.yml` run 36522237267: the first attempt failed on macOS 15 Intel, where `tests/cli.test.ts` "uses an explicit --cwd target for doctor checks" exceeded its 30 s timeout on the slowest runner (full suite 9.5 min there; the same code had passed that runner in PR #9's CI, and no earlier failed CI run showed this test). Nothing was published by that attempt. Re-running the failed job passed all six platforms, then npm publish with SLSA v1 provenance and the GitHub Release (2026-09-29 05:18 UTC).

What it restores: project consults, and every consult on a machine with a pinned default project, after the ChatGPT redesign measured on 2026-09-29 (sidebar project rows, the hover-only "New chat in" control, the model picker, message markup). Verified live on the shared browser before release: a named-project send and a pinned-default Codex + Pro send both answered inside the requested project.

Installation on 2026-09-29, global npm, each verified with `prodex --version` = 0.40.20:

- WSL, M3, Mac mini: installed. Running services were not restarted: 3 stdio MCP servers on WSL and 4 on M3 keep older code until their clients reconnect; the Mac mini had none.
- M4: not reachable (hostname does not resolve); not updated.

Browser container, same day. The Claude Code MCP entry on WSL goes through `prodex-browser-browser-1`, which builds from `feat/headless-browser-compatibility`, not from npm. That branch had already adapted to the same redesign on its own (not yet merged to `main`), so the image was rebuilt from its CI-passing tip `b5eac7d` as-is - not merged with `main`, because the two parallel implementations conflict in 17 places in `src/chatgpt-browser.ts` and a hand-made hybrid would be unverified. New image `sha256:7b3e53b2fb7f`; it reports 0.40.18, the version in that branch's `package.json`. Verified: no consult in flight before the swap; container healthy with the profile volume kept; MCP handshake through `scripts/container-client.mjs`; `pro browser login --wait` found the session READY; a project consult inside the container answered in the requested project with the destination verified. The two implementations still have to be reconciled when that branch is merged.

## 0.40.19 Release Record

Release commit `8650136` on `main` (cut after PR #8, merge `b5a223f`); tag `v0.40.19`. Published by `publish.yml` run 36510352704: all six native verification jobs passed (Ubuntu Node 20/22/24, macOS 15 arm64 and Intel, Windows Server 2025 / Node 22), then npm publish with SLSA v1 provenance, then the GitHub Release (2026-09-29 02:17 UTC). Before tagging, PR #8 passed the same six jobs and `npm run release:verify` passed locally on the release commit after a build (a fresh checkout without `dist` fails two package-bin cases, because `release:verify` runs tests before building).

Installation on 2026-09-29, global npm, each verified with `prodex --version` = 0.40.19:

- WSL, M3, Mac mini: installed. Running services were not restarted: 3 stdio MCP servers on WSL and 4 on M3 keep the code they started with until their clients reconnect; the Mac mini had none.
- The browser container `prodex-browser-browser-1`, which this machine's Claude Code MCP entry now goes through, runs its own build and still reports 0.40.18; an npm install does not update it. It had exited on 2026-09-28 after Chromium's GPU process kept failing ("GPU process isn't usable") and was restarted with the documented `docker compose ... up -d --no-build browser` before this release.
- M4: not reachable (hostname does not resolve); not updated.

## 0.40.2 - 0.40.7 Release Record

Recorded 2026-09-29, after the fact. These versions went around the tag-and-CI path, so none of them has a git tag, a GitHub Release or npm provenance; this section is their durable record. The commit for each published version was matched to the npm publish time and cross-checked by downloading the published package and finding that version's fixes in its `dist`.

**Channel.** Built with `prodex release pack` (normalized tarball) and published by hand with `npm publish <tarball>` from WSL, because a source-tree publish is refused on the WSL mount's file modes. That route bypasses `publish.yml`, so there is no provenance attestation (0.40.1 and 0.40.8 have one; 0.40.2 - 0.40.6 do not), no tag and no Release. Tags were not backfilled: pushing a `v*` tag runs `publish.yml`, which would re-verify old code and then fail at `npm publish` because the version already exists.

| Version | Commit | npm publish (UTC) | Verification before publish | Live check |
|---|---|---|---|---|
| 0.40.2 | `003d4d7` | 2026-09-09 17:39 | vitest 1126 pass; `release:verify` ok | Defective: installed from the registry on 2026-09-10 and sent into a real project - refused `project_not_bound`. Every project send fails in this version (see CHANGELOG). |
| 0.40.3 | `6f36b47` | 2026-09-10 07:27 | vitest 1184 pass; `release:verify` ok | Registry package sent into an existing project, across projects, and with `--project-new`; `destination.verified: true` on the receipt. |
| 0.40.4 | `2a84bc5` | 2026-09-11 00:21 | vitest 1198 pass; `release:verify` ok | `--continue` with the tab deliberately moved elsewhere, over CLI and over MCP `pro_consult` (`continue_thread`). |
| 0.40.5 | `a9c629d` | 2026-09-14 00:43 | vitest 1248 pass; `release:verify` ok; tarball `publish --dry-run` ok | create-image and web-search sends; back-to-back sends queued on the lock 3/3. |
| 0.40.6 | `4550cad` | 2026-09-14 01:52 | vitest 1259 pass; `release:verify` ok; tarball `publish --dry-run` ok | Dedicated browser killed twice; `--auto-login` relaunched it in about 3 s and the receipt carried `browser_recovered`. |
| 0.40.7 | `678a02e` (tag only) | not published | `publish.yml` run 34816390439 failed at Release verification; logs no longer retrievable | Superseded by 0.40.8. |

**Installation.** Global npm installs, verified with `prodex --version` on each host after install:

- 0.40.3, 0.40.4, 0.40.5, 0.40.6: WSL, M3 and the Mac mini, each upgraded on its publish day (the Mac mini came from 0.37.0 at 0.40.3). M4 was unreachable over SSH every time and was never updated.
- Running services are separate from the install. After 0.40.3 and 0.40.4 the long-lived stdio MCP servers (13 on WSL, 8 on M3) kept the old code. A freshly spawned server reported `serverInfo.version` 0.40.4 and completed a `continue_thread` consult. On 2026-09-14, before 0.40.5, every prodex MCP server was stopped with SIGTERM (20 on WSL, 7 on M3) with no consult in flight; the servers the clients respawned came up on 0.40.4, the install at that moment, and needed another reconnect after the 0.40.5 and 0.40.6 installs.
- State on 2026-09-29: WSL 0.40.18, M3 0.40.18, Mac mini still 0.40.6 (not upgraded since), M4 unreachable (its hostname no longer resolves).
- 2026-09-29: Mac mini upgraded 0.40.6 -> 0.40.18 with `npm i -g @youdie006/prodex@0.40.18`; `prodex --version` reports 0.40.18. No prodex MCP server was running there, so nothing needed a restart; the next one a client starts runs 0.40.18.

## Publishing

Publishing to npm runs entirely in CI with **no long-lived token** — auth is npm [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC), so nothing needs to store or paste an `NPM_TOKEN`, and every release carries a verifiable `--provenance` attestation.

Release flow:

```bash
# 1. bump version + update CHANGELOG on main, commit, push main
# 2. tag the release and push the tag — CI publishes it
git tag v0.8.2
git push origin v0.8.2
```

`.github/workflows/publish.yml` fires on a `v*.*.*` tag: it checks out, installs, verifies the tag equals `package.json`'s version, builds, runs `release:check -- --metadata-only` and `release:verify`, then publishes with `npm publish --provenance --access public --ignore-scripts`. The explicit metadata check also runs for manual workflow dispatches. It is required because `--ignore-scripts` skips `prepublishOnly`; a separate main-branch CI run is not a substitute for checking the commit being published.

One-time setup (owner, on npmjs.com): open the package → Settings → Trusted Publishing → add a GitHub Actions publisher for repo `youdie006/prodex` and workflow `publish.yml`. After that, no npm tokens are needed anywhere; revoke any previously issued automation tokens.

## Release checks

GitHub Actions runs `npm ci`, `npm run build`, `npm run release:check -- --metadata-only`, and `npm run release:verify` on pushes to `main` and pull requests. The metadata step checks package readiness; the verification step runs the full test and package checks once. The workflow installs `ripgrep` because the repo-search smoke checks require `rg`. It verifies release readiness only; it does not publish anything.

Before sharing a package tarball, run:

```bash
npm run smoke:package
```

This packs the project, installs the tarball into a temporary consumer project, runs the installed `prodex` binary, verifies HTTP MCP onboarding through installed token-TTL `setup`/`status`/configured `doctor`/`tunnel url`/`start`, checks `/health`, connects to the installed `/mcp` endpoint, lists tools, calls `bridge_create_task`, verifies explicit `--cwd` task storage, exercises the installed HTTP MCP repo write dry-run/apply/stage flow, exercises the installed HTTP MCP task completion/blocking/result/artifact fetch flow including tampered artifact rejection, verifies installed HTTP MCP receipt/session list/fetch tools, verifies the installed `release-pack` script and `prodex release pack` CLI success paths for normalized publish tarballs, runs `npm publish --dry-run` against those normalized tarballs, verifies git-ready release-pack output includes the tarball publish lifecycle warning and guarded `release_pack_publish` command, verifies installed release git blockers for no remote, dirty worktrees, detached HEAD, no upstream, unpushed, upstream gone, behind, and diverged states, verifies `release pack` blocks publish guidance for those unsafe git states, verifies the package is CLI-only by blocking unsupported deep imports, verifies the installed stdio MCP server exposes the expected tool catalog, exercises the installed stdio MCP repo write dry-run/apply/stage flow, verifies installed stdio oversized repo_search failure output, verifies installed stdio non-git write failure output, exercises the installed stdio MCP task completion/blocking/result/artifact fetch flow including tampered artifact rejection, and verifies installed stdio MCP receipt/session list/fetch tools.

To run the full release verification sequence:

```bash
npm run release:verify
```

This runs tests, typecheck, build, package smoke, and `doctor` without weakening the publish guard.

Package smoke runs tarball publish dry-runs against an isolated, read-only loopback registry. This keeps repeat verification working after the package version has already been published. It does not establish that a version is available on npm; the separate release dry-run and actual publish still enforce registry readiness. No package is uploaded by the smoke check.

If direct `npm pack` is blocked because a WSL/Windows mount reports normal source files as executable, build the publish tarball from a temporary Linux staging directory:

```bash
prodex release pack --pack-destination /tmp/prodex-release
```

For a source checkout, use the built CLI with `--source-cli` so follow-up commands stay in source-checkout form:

```bash
cd /absolute/path/to/prodex
SOURCE_CLI="/absolute/path/to/prodex/dist/cli.js"
node "$SOURCE_CLI" release pack --source-cli "$SOURCE_CLI" --pack-destination /tmp/prodex-release
node "$SOURCE_CLI" release status --source-cli "$SOURCE_CLI"
```

The npm script is equivalent when you only need the tarball:

```bash
npm run release:pack -- --pack-destination /tmp/prodex-release
```

For source-checkout release commands, prefer the CLI wrapper when you want follow-up guidance to stay in `node dist/cli.js ... --source-cli` form. The npm script creates the same normalized tarball, but it cannot know which source CLI path should appear in later recovery commands.

`release pack` does not publish anything. It still refuses missing publish metadata, non-regular or hard-linked packed files, and missing package release checks; it only normalizes packed file modes in the staging copy so package `bin` entries remain executable and other packed files become regular `0644` files. Run `npm run release:verify` and the matching status command before publishing the tarball it creates: `prodex release status` for installed-package use, or `node /absolute/path/to/prodex/dist/cli.js release status --source-cli /absolute/path/to/prodex/dist/cli.js` from a source checkout. When the tarball is ready, `release pack` prints `release_pack_git` and `release_pack_git_next` lines before publish guidance so git remote/upstream blockers stay visible. It always prints `npm publish --dry-run <tarball>` for inspecting the exact tarball. Tarball publish commands bypass npm `prepublishOnly`, so `release pack` prints `release_pack_publish_guard` before `npm publish <tarball>`; run the dry-run command first, then publish only that verified tarball if it succeeds. If git readiness is blocked, it prints `release_pack_publish_blocked` instead.

Add `--keep-workdir` to `prodex release pack`, `node /absolute/path/to/prodex/dist/cli.js release pack --source-cli /absolute/path/to/prodex/dist/cli.js --pack-destination <dir>`, or `npm run release:pack -- ...` when you need to inspect the temporary normalized staging directory.

To see the current publish blocker and next step from the CLI:

```bash
prodex release status
```

It reports package metadata blockers, pack file-mode, non-regular file, or hard-link blockers when package identity is readable, and local git readiness, including a dirty worktree, detached HEAD, missing git remote, branch without upstream tracking, upstream is gone, branch divergence, unpushed local commits, or a branch behind upstream. For a new public repo, create the remote yourself, then run `git remote add origin <git-url>` and `git push -u origin <branch>`; `release status` prints those handoff commands when the local git state is missing a remote or upstream.

Before publishing to npm, make sure `package.json` has an npm-publishable `name` and valid semver `version`, keep the explicit MIT `license` metadata and matching `LICENSE` regular file, and make sure `package.json` does not have `private: true`. `release:check` treats missing or malformed package identity and `private: true` as publish blockers because npm will refuse to publish those packages. It also rejects a `LICENSE` path that is a directory, symlink, or hard link, rejects non-regular or symlinked packed files, blocks packed files with unexpected executable modes outside package `bin` entries, and rejects hard-linked packed files. If you are on a WSL/Windows mount that reports every file as executable, publish from a Linux filesystem, fix mount metadata/chmod first, or use `prodex release pack --pack-destination <dir>` after release verification to create the tarball from normalized staging files. From a source checkout, use `node /absolute/path/to/prodex/dist/cli.js release pack --source-cli /absolute/path/to/prodex/dist/cli.js --pack-destination <dir>` for the same normalized tarball plus source-aware follow-up guidance. Source-tree `npm publish` is intentionally guarded by `prepublishOnly`; it runs:

```bash
npm run release:check
```

If package metadata stops being publishable, `release:check` fails with a metadata error instead of letting an accidental public publish proceed. Use `npm run release:verify` when you only want local verification without claiming publish readiness.
