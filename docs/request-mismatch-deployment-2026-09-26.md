# Request-matching deployment: 2026-09-26

## Scope And Authorization

After reviewing the source-only fix, the user explicitly requested verification
and replacement of the running ProDex installation. This record supersedes the
[installation-pending incident checkpoint](request-mismatch-inline-code-2026-09-26.md).

Both existing WSL x64 and M3 Linux ARM64 services now run the browser adapter
built from `08d69f4147e0681c08137cef7442a0588d03afd9`. The package/server version
remains `0.40.18`; the adapter revision and immutable image identify this local
update. It is not a claim that every module in the image matches that source
commit, nor a new public package release.

Each candidate derives from that machine's already-installed immutable image and
adds exactly one layer replacing `/app/dist/chatgpt-browser.js` with mode `0644`.
The installed module SHA-256 on both targets is:

```text
601b940f6479a3d93796663d7edc19a8b365416ebeb1555ce18cb653ff955de6
```

Image labels record `io.prodex.browser-adapter.revision` and
`io.prodex.browser-adapter.sha256`. Base layers, user, environment and startup
command were compared programmatically and were unchanged. Chromium remains
`152.0.7977.82`; no browser/package-manager upgrade was performed.

## Installed Targets

| Target | Context | Container prefix | Started UTC |
| --- | --- | --- | --- |
| WSL Linux x64 | `default` | `031109931cff` | `2026-09-25T16:10:22.715590748Z` |
| M3 Linux ARM64 VM | `colima-prodex-check` | `268a17e7998b` | `2026-09-25T16:13:09.605951542Z` |

WSL installed image:

```text
sha256:a3d8998ebdcecba7e71661a4f31b4aef508402fa02bfb94bc19f7d2befe9eeba
```

M3 installed image:

```text
sha256:ce4fc47726c5e3297353222a961d7dbbe379964462c5dd03694dfef95eac45d6
```

Both retain container name `prodex-browser-browser-1`, hostname `prodex-browser`,
user `1000:1000`, read-only root, the original security configuration and named
volume `prodex-browser_browser-home` mounted at `/home/node`. Viewer-password
file inode, mode, size and modification time were unchanged. Password contents,
cookies, tokens and profile contents were not exported, copied or printed.

The actual mode remains ordinary headed Chromium on the private virtual display.
No host browser/login window or noVNC viewer was opened. On startup, the service
provided `about:blank`; one ChatGPT tab was opened inside each existing virtual
display, under the send lock. Both became READY using their saved logins.

## Replacement Procedure

The maintenance preflight acquired the existing process-shared send lock, then
required exactly one ready ChatGPT page, no response generation and an empty
composer. A response detected earlier during preparation was left alone until
finished. The lease stayed held until that container was replaced; subsequent
normal lock acquisition safely reaped its dead owner.

After verifying each candidate and preserving its old image under a rollback tag,
only the existing Compose browser service was recreated:

```sh
docker compose -f containers/browser/compose.json up -d --no-build --no-deps --force-recreate browser
```

M3 used the existing Compose file discovered from its installed container labels
and explicitly selected `colima-prodex-check`. No volume deletion, hostname
change, profile reset, permission relaxation or Codex process restart occurred.

Rollback images are retained locally:

| Target | Rollback tag | Previous immutable image |
| --- | --- | --- |
| WSL | `prodex-browser:rollback-pre-08d69f4-wsl` | `sha256:1f5cf6a36323635c2f03bd3b011f89f9e5223cc955f10737bd187de7e89cfd18` |
| M3 | `prodex-browser:rollback-pre-08d69f4-m3` | `sha256:73de64cca2889500e7683dd10e269cbf05f8997e6830d09641e44047cee5d6ac` |

Rollback would retag the recorded previous image as `prodex-browser:experimental`
and recreate the same idle service while preserving its volume. It was not needed.

## Verification

- PASS: pre-installation regression rerun, 229 tests in
  `tests/chatgpt-browser.test.ts`, `tests/browser-slow-vs-dead.test.ts` and
  `tests/store.test.ts`; `npm run build`.
- PASS: all six native [CI jobs for the fix](https://github.com/youdie006/prodex/actions/runs/36157769330):
  Ubuntu Node 20/22/24, macOS ARM/Intel Node 22 and Windows Node 22.
  Relevant Linux/ARM jobs had passed before replacement; the remaining native
  jobs completed successfully during live verification.
- PASS: WSL candidate matcher import, exact module hash, rendered inline-code
  acceptance, changed-content rejection and wrong-request rejection in a
  network-disabled disposable container without an account volume.
- PASS: `scripts/container-mcp-smoke.mjs` in both candidate images using
  network-disabled, read-only disposable containers and fresh tmpfs storage.
  Two independent clients retained task identity, exactly one concurrent claim
  succeeded, disconnect left the other client usable, and cleanup completed.
- PASS: both installed image IDs, module hashes, service health, preserved volume,
  hostname, password-file metadata and saved-login readiness.

### Actual Pro Replies

Exactly two prompts were sent per target, with no automatic resends. Each first
question included four single-backtick inline-code spans, a unique synthetic
verification prefix and a fictional label. It asked for `17 + 25 = 42`. A second
independent MCP client continued the exact first task, asked for subtraction of
two, and recalled the label without repeating it in the follow-up question.

| Target / turn | Task | Request ID | Rendered model |
| --- | --- | --- | --- |
| WSL first | `task_20260925_161242_gpt-pro-consult` | `aa545b3e01141e60c19621ac5630926b` | `gpt-6-pro` |
| WSL continuation | `task_20260925_161321_gpt-pro-consult` | `399ddefcbeb8e89f6d3641b1558728ec` | `gpt-6-pro` |
| M3 first | `task_20260925_161416_gpt-pro-consult` | `21e009781d904614fe4f50134736e21a` | `gpt-6-pro` |
| M3 continuation | `task_20260925_161448_gpt-pro-consult` | `f30df310fc15e0fe4c6db8dc9bacbf2b` | `gpt-6-pro` |

All four returned `done`, `request_verified:true`, `pro_verified:true`, the exact
expected calculation/prefix/remembered label and zero persistence warnings.
Each continuation retained the first thread, had a distinct request ID, and
recorded `continued_from` equal to that first task. Every fresh MCP handshake
reported `prodex` / `0.40.18` and exposed 20 tools.

Read-back through the same MCP runtime passed trusted finalized-result validation
and artifact SHA-256/byte checks. Artifact bytes were 711 and 782 on WSL, 709 and
762 on M3. Verification clients were closed, and all four owned host transport
PIDs were confirmed exited. A later WSL check saw another MCP client connected;
it was left alone. Both send locks were free and both browsers were READY.

The bounded operator harness was
`/tmp/prodex-deploy-08d69f4.xvB8aO/verify-live.mjs`, invoked once with `wsl` and
once with `m3`. It did not replay the user's failed research questions. Private
conversation URLs and real account content are excluded from this record.

## Attempts And Limits

An initial Docker `FROM` argument used a bare local image ID, which BuildKit
interpreted as a registry tag and refused. The inspected existing image was
then given a local rollback tag and the build succeeded without updating its
base. An SSH alias's configured remote command conflicted with an explicit
command; `RemoteCommand=none` corrected that before any remote changes.
One operator-owned inspection process stalled and was terminated by its exact
PID. No unrelated process was killed. Maintenance holder exits during container
replacement were expected, and their exec sessions were reaped.

Publication channels: source was already pushed at the implementation commit;
these two local Docker/Colima images are now installed and verified. No npm
publication, image-registry publication, release tag or GitHub Release occurred.
The deployment-record commit and push are recorded in PR #7.

Replacing a container disconnects its old MCP subprocesses. Fresh connections
have been verified; this does not claim every already-open client automatically
reattached. An old client reporting a closed transport needs only its ProDex MCP
connection refreshed, not a browser/login reset or whole Codex restart.

This closes the bounded local request-matching deployment gate. It does not
promote pure-headless mode or claim that Cloudflare restrictions were removed.
