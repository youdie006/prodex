# Same-build headed and pure-headless public controls

Date: 2026-09-26 (Asia/Seoul). User-authorized continuation of the
[headless investigation](headless-options-matrix-2026-09-26.md), following the
[request-matcher deployment](request-mismatch-deployment-2026-09-26.md).

## Result

**Pure-headless access remains blocked, not fixed.** The missing public headed
controls now succeed with the same Chrome 154 images used for the headless tests.
Each platform's subsequent pure-headless observation still receives a correlated
307 -> 403 protection response. All browsers passed their local operation checks
and closed cleanly. Neither working service nor its saved login was changed.

| Target | Actual mode | Public main document | Process result |
| --- | --- | --- | --- |
| WSL Linux x64 | Headed on isolated Xvfb | 200, loaded, no challenge header | Exit 0 |
| WSL Linux x64 | Pure headless, no display environment | 307 -> 403, challenge header | Exit 1; stopped |
| M3 Colima Linux ARM64 | Headed on isolated Xvfb | 200, loaded, no challenge header | Exit 0 |
| M3 Colima Linux ARM64 | Pure headless, no display environment | 307 -> 403, challenge header | Exit 1; stopped |

The [JSON record](headless-paired-control-2026-09-26.json) preserves the four
allowlisted public navigation reports, including failed exit codes. The 403 in
the separate local diagnostic fixture is synthetic and is not counted as a
public observation. No page text, account identifiers, cookies, tokens or private
conversation URLs are retained.

## Hypothesis and bounds

The previous [Chrome 154 trial](stock-chrome-154-trial-2026-09-23.md) measured
public access only in pure headless. It could not distinguish a mode-associated
refusal from a fresh-profile/build/environment failure shared by headed Chrome.
The new control asks whether ordinary headed Chrome using those pinned images
can load the anonymous public root at the time of this comparison.

Each target first passed an offline headed smoke with `--network none`. It then
received one headed public navigation. Only after that returned a completed 200
did the corresponding pure-headless comparison run, once. There were four public
`Page.navigate` commands in total, not four attempts per mode. Browser-generated
subresources and redirects are not counted as additional commands. There was no
retry after either protection response, no login, prompt, challenge interaction,
authentication transfer, proxy change, user-agent rewrite or stealth package.

## Controlled inputs and remaining limits

- Both modes used stock full Chrome `154.0.8037.57`, the same immutable image
  per architecture and the same diagnostic scripts inside that image. These
  images retain the September 23 product build, not the newer request matcher.
- WSL image: `sha256:e3e3b7c886e1f37c08c97956604977f3d41d132f080eaaf01513e023ae37e7b9`.
- M3 image: `sha256:7741e053af2b9336b458049b31ba3a5f004a3034bae0fba42f9223a7d1ece5e9`.
- The images retain `/opt/prodex-cft154/chrome` as `PRODEX_CHROME`. Distribution
  artifact and executable hashes are in the September 23 provenance record;
  this run verified immutable image identity, not a new artifact download.
- Every run used a fresh disposable profile. The smoke writes only a synthetic
  marker at its own loopback fixture and verifies its persistence across a
  browser restart. No production profile volume was mounted.
- Both modes used a read-only root, UID 1000, all capabilities dropped,
  no-new-privileges, the existing Chromium-compatible seccomp profile, 2 CPUs,
  2 GiB RAM, 1 GiB shared memory, 256 PIDs and separate 256 MiB home/tmp tmpfs.
  No host display socket, VNC viewer or published port was present.
- Public runs used the same target's default Docker network without a custom
  proxy. Outbound IP was not measured, and the runs were sequential rather than
  simultaneous. Do not infer an exactly controlled external network path.
- Actual main-process headless/headed mode was checked on initial launch and
  restart. Headless unset DISPLAY, XAUTHORITY and WAYLAND_DISPLAY; headed used
  an isolated Xvfb display of 1440x900. As in the earlier runner, only headless
  fixes the browser window size. Exact viewport equality was not established.

This comparison narrows the failure to a mode-associated remote access result
under these conditions. It does not identify the server's classification rule,
isolate every rendering difference, prove headless is universally impossible,
or establish authenticated Pro acceptance from an anonymous HTTP 200. Replacing
the CDP library or asking the user to log in again is not an evidence-backed fix
for this main-document refusal.

## Commands

WSL used `docker`; M3 used `/usr/local/bin/docker --context colima-prodex-check`
through `ssh -T -o BatchMode=yes -o RemoteCommand=none -o ConnectTimeout=8 m3`.
For each image, the container command had this form:

```sh
docker run --rm --init --name "$CASE" \
  --read-only --user 1000:1000 --cap-drop ALL \
  --security-opt no-new-privileges:true --security-opt "seccomp=$SECCOMP" \
  --cpus 2 --memory 2g --shm-size 1g --pids-limit 256 \
  --tmpfs /home/node:rw,nosuid,nodev,uid=1000,gid=1000,mode=0700,size=256m \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777,size=256m \
  --entrypoint /usr/bin/timeout "$IMAGE" -k 10 120 \
  env -u DISPLAY -u XAUTHORITY -u WAYLAND_DISPLAY \
  xvfb-run -a -s '-screen 0 1440x900x24 -nolisten tcp' \
  node /app/scripts/browser-launch-smoke.mjs --headed --public-chatgpt
```

The offline controls additionally set `--network none` and omitted
`--public-chatgpt`. The pure-headless cases removed `xvfb-run` and its arguments
and omitted `--headed`. The WSL seccomp file was
`containers/browser/seccomp.json`; M3 used its existing installed copy. The six
case names begin with `prodex-headless-control-` and end with
`{wsl,m3}-{offline,public,headless}-0926`.

## Verification and disposition

- PASS: two offline headed runs and local capabilities in all four public runs:
  actual process mode, Runtime/DOM, keyboard/mouse, synthetic file attachment,
  synthetic profile restart, correlated local redirect/refusal fixtures.
- PASS: two public headed controls, graceful close/cleanup for all six runs,
  and final `docker ps -a --filter name=prodex-headless-control-` empty on both
  targets. FAIL: both pure-headless public access checks, exit 1 for protection.
- PASS: `npm test -- tests/browser-launch-smoke-options.test.ts tests/browser-navigation-probe.test.ts tests/browser-navigation-diagnostics.test.ts tests/browser-compatibility.test.ts`
  (71 tests, four files). No source edit or build; the full suite and native OS
  CI were not rerun as part of this documentation-only investigation.
- PASS: final read-only status on both installed services was reachable,
  logged-in-likely, composer present, blocker null, exactly one headed browser.
  Both remained healthy with restart count zero and unchanged identity below.

| Installed target | Container prefix | Image prefix | Unchanged start time (UTC) |
| --- | --- | --- | --- |
| WSL | `031109931cff` | `a3d8998ebdce` | `2026-09-25T16:10:22.715590748Z` |
| M3 Colima | `268a17e7998b` | `ce4fc47726c5e` | `2026-09-25T16:13:09.605951542Z` |

No candidate is promoted. The installed package remains 0.40.18 with the
previously deployed request-matcher adapter and Chromium 152 on Xvfb. There is
no new Pro response, installation, service restart, client reconnection, release
tag, npm publication or image-registry publication in this update. Source/evidence
publication belongs to `feat/headless-browser-compatibility` and
[PR 7](https://github.com/youdie006/prodex/pull/7). The user's untracked Makefile
was not changed or staged.

Further public tests require a new, specific compatibility hypothesis or a
reproducible ordinary-browser success setup. The present measurements do not
justify repeated login prompts, identical retries or weakening protection and
sandbox boundaries. Pure-headless Pro acceptance remains an unresolved external
access gate, not a completed implementation task.
