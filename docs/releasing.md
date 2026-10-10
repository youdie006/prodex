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
17 * * * * PATH=<node bin>:/usr/bin:/bin PRODEX_CLI=~/.local/share/prodex-maint/prodex PRODEX_WATCHDOG_CWD=/mnt/d/MyProject/gptprouse <node> ~/.local/share/prodex-maint/repo/scripts/ui-watchdog.mjs --canary --file-issue >> ~/.local/state/prodex-watchdog.log 2>&1
```

**What each run does**
- It runs `scripts/page-canary.mjs`, which only reads the page:
  - It records ChatGPT's build id and whether each control prodex relies on is present.
  - It compares with `~/.local/share/prodex/page-canary.json`.
  - It skips while a consult holds the send lock.
  - A broken read is read again up to twice, 10 s apart, and counts only if it stays broken. Right after a browser restart on 2026-10-10 the first read found no model selector because the composer had not rendered yet.
- Only when the canary reports changed (3) or broken (2) does the watchdog run `pro browser smoke` (a fresh chat, 5-minute budget). If that fails, it files or extends a GitHub issue by blocker code.
- A busy browser is logged as skipped and never filed.

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
