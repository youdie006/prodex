# Fresh-selector deployment: 2026-09-27

## Installed Scope

Source: [eaf25d2efddaa08296d2aea8fed35dd98ad78a4e](https://github.com/youdie006/prodex/commit/eaf25d2efddaa08296d2aea8fed35dd98ad78a4e),
branch `feat/headless-browser-compatibility`,
[PR 7](https://github.com/youdie006/prodex/pull/7).

Both existing browser containers now contain the fresh-selector correction,
current tools trigger and fallback-transcript parser. Package version remains
0.40.18; the source revision and built module hash identify these local
corrections more precisely than the unchanged package version.

Adapter SHA-256 on both machines and the WSL host installation:
`079a054574c48fee7e3b5f0db4c936eb4158da080acecff82afa8aff01e80400`.

| Target | Docker context | Started at, UTC | Installed image |
| --- | --- | --- | --- |
| WSL x64 | `default` | 2026-09-27T15:07:12.58337621Z | `sha256:7635c70fb84096a8fe6c6e18fefbfedc70fe8bc5831e72364ef1e98a741c64a2` |
| M3 Linux ARM64 | `colima-prodex-check` | 2026-09-27T15:05:27.183777565Z | `sha256:395f67d40bd9a052588da1571318cac20ee93ea76da3a64eb496ef9a4a05dd79` |

Both use `prodex-browser-browser-1` and retain the named
`prodex-browser_browser-home` volume. Each candidate has exactly one additional
adapter layer over its installed base, with unchanged runtime image settings.
The service was replaced once per machine under the shared browser-send lock,
after an idle, empty-composer check. The existing conversation was restored in
the private display; no visible browser or login window was opened.

Final independent checks at 15:11:10Z and 15:11:12Z confirmed the expected image,
module hash, healthy state, zero restarts, unchanged service/security/volume
configuration and unchanged saved viewer-file metadata. Viewer secret contents
were not read. Configuration comparison normalized environment ordering;
its invariant SHA-256 was
`82c0984ce7efa7c1af47ffe7b619b942203689b6084dadbacee260bae782172d`.
Browser version and mode were not changed: ordinary Chromium on private Xvfb,
not pure browser headless or the experimental Ozone backend.

## Actual Reply Checks

One synthetic question per target requested `new_chat: true`, `effort: Pro`,
17 + 25, and an exact per-run nonce. Inline-code values and a quoted `captcha`
topic exercised request matching and transcript/blocker separation. No real
research request was replayed, and neither successful request needed recovery
or an automatic resend.

| Target | Task | Completed, UTC | Identity and answer | Model provenance |
| --- | --- | --- | --- | --- |
| M3 | `task_20260927_150753_gpt-pro-consult` | 15:08:16.900Z | Done, exact nonce + 42, `request_verified=true` | `model_used=null`, `pro_verified=false` |
| WSL | `task_20260927_150755_gpt-pro-consult` | 15:08:37.511Z | Done, exact nonce + 42, `request_verified=true` | `model_used=null`, `pro_verified=false` |

Both trusted result reads and artifact reads passed without artifact warnings.
Recomputed byte counts and SHA-256 matched the stored receipt:

- M3: 651 bytes, `0fda85ee42043c9e70e153c299872f61b3c0632473e0ca3411938179b4be93f5`.
- WSL: 653 bytes, `6d036348da8ef276447c3de536b78f39a227b1690b3c8862c3b7136ee8519f1a`.

The current UI supplied no response-level model identifier. Consequently both
strict Pro verifiers exited **2**, not 0. These are successful consultations
with the Pro effort requested and selected, but **not verified Pro provenance**.
Correct arithmetic, current selector text or the model's own claim cannot
replace missing response metadata. The verification rule was not weakened.

The earlier WSL check, `task_20260927_143253_gpt-pro-consult`, failed before
typing with the model-menu error. Its own receipt was checked before the
post-fix test; it sent zero prompts. See the
[incident record](fresh-chat-selector-incident-2026-09-27.md).

## MCP And Host CLI

- Both candidate images passed the offline two-client MCP smoke: independent
  processes, distinct synthetic task identities, exclusive claims and client
  disconnect cleanup. No browser prompt was sent by those checks.
- Both installed containers accepted fresh MCP handshakes with twenty tools,
  then completed the real consult and read-only receipt checks above. Owned
  client processes exited after transport closure.
- The actual configured `container-client.mjs --context default mcp` entrypoint
  also passed a new connection at 15:15:56.516Z: twenty tools and one
  `bridge_list_tasks(status=new)` response with zero tasks. Transport cleanup
  passed; no task creation or browser input occurred in that check.
- The WSL Node 22.22.0 global CLI was installed from a locally packed,
  permission-normalized tarball at 15:14:18.646Z. A new CLI process reported
  0.40.18 and the installed module matched the expected hash. Tarball SHA-256:
  `3348e769438b5252d264fa27cc6e3e810cd8d165de59f7a592cffab5b4a328fe`.
  Installation held the host shared-send lock; no host browser restart,
  navigation or login occurred. The previous package was archived for rollback.
- Already-running MCP processes can retain old modules or lose their transport
  during container replacement. Fresh-client success does not attest every
  existing session. An affected Claude session needs ProDex reconnect through
  `/mcp`, not another ChatGPT login or a full agent restart. The owning harness
  session was notified; inbox acceptance is not proof of message consumption
  or of that session's reconnect.

## Failures And Limits

Initial builds incorrectly passed a local image ID as a Dockerfile `FROM`
reference. BuildKit treated it as a registry repository; WSL reported access
denied and M3 reported an unavailable registry credential helper. No running
service changed. Explicit local tags bound to the same inspected IDs fixed
delivery; successful builds used `--pull=false --network=none` and were verified
against their exact base layers.

M3's first post-replacement verifier stopped before any input because the tools
button had not finished rendering. The installation and security checks had
already passed. A subsequent read-only check at 15:07:09Z confirmed login,
empty composer, exact model/tools triggers and no blocker. No second service
restart or login was used. The WSL verifier waited for the tools trigger as
well as the composer and passed in the original replacement run.

The full source suite passed 1,965 tests with three existing skips across
139 files; focused selector tests passed 240/240, typecheck and build passed.
Candidate module hash, ownership/mode, expression compilation, request identity
positive/negative controls and genuine CAPTCHA stopping passed on both
architectures. A failed or skipped check is not counted as a pass.

## Delivery And Rollback

Publication channels: pushed source/records on the feature branch, local WSL
and M3 Docker images, and the local WSL global npm installation. No release tag,
GitHub Release, public npm version or registry image was published. Packaging
succeeded but correctly reported public-release readiness blocked by the
uncommitted experiment work at that moment. Local installation is not public
release acceptance. PR 7 records the final documentation commits.

Rollback tags retain the exact prior images:

- WSL: `prodex-browser:rollback-pre-selector-ready-wsl-20260927`,
  `sha256:be91dc9c6610bb28bb110798c32a486018fe96803a04904beb50aca0c76d1ea1`.
- M3: `prodex-browser:rollback-pre-selector-ready-m3-20260927`,
  `sha256:ce4fc47726c5e3297353222a961d7dbbe379964462c5dd03694dfef95eac45d6`.

Rollback, if needed, requires the same idle lock and preservation of the named
volume before recreating only the browser service. No rollback was needed.
Non-secret operator receipts remain in `/tmp/prodex-m3-0927.8JnWB1`; this file
is the durable deployment record. Separate account-free headless research is
recorded [here](separate-load-focus-2026-09-27.md), not promoted to production.
