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
