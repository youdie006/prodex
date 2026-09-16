# Experimental container browser

## Approved experiment

The user approved trying the persistent virtual-desktop candidate in
[the research record](headless-methods-research.md) on 2026-09-16. This is ordinary
Chromium on an isolated Linux display, not true headless Chromium. The existing
host browser, login profile, MCP settings, and installed package remain separate.

The bounded implementation keeps Chromium, Xvfb, and ProDex in one single-user
container. CDP stays on container loopback. A password-protected local noVNC viewer
can display the same browser for manual authentication; disconnecting the viewer
must not restart Chromium. New containers start on `about:blank`, never by sending
a ChatGPT prompt. No private endpoints, session copying, stealth settings, or
automatic protection handling are part of this experiment.

## Implementation gates

- [x] Re-run the previous authentication/handoff regressions before building on them.
  Result: 97 tests passed on 2026-09-16.
- [x] Add explicit headed evidence to the disposable, account-free browser smoke;
  keep the default headless checks and exact-owned-process cleanup.
- [x] Build a non-root Chromium/Xvfb image with a restricted Docker seccomp profile,
  no added capabilities, no host profile/display/socket mounts, and no exposed CDP.
- [x] Test account-free operation on WSL x64 and native M3 ARM64 independently.
- [x] Test same-runtime viewer disconnect, two separate MCP clients, graceful stop,
  and same-volume synthetic-state persistence after container restart.
- [x] Only after those checks, navigate the isolated browser for manual login.
  A protection or login prompt is a blocker for automation, not a retry instruction.
- [ ] Verify one user-authorized Pro response and one continuation after manual
  authentication; never call account-free smoke a successful Pro consultation.

The later [live host Pro acceptance](pro-acceptance-2026-09-16.md) passed using
the separate existing WSL host browser. It does not satisfy this container gate:
the container profile still requires its own manual authentication.

## Scope limits

Initial transport is `docker compose exec -T browser node /app/dist/cli.js mcp`
inside the same container. The bridge workspace is container-private; host
repositories and credentials are not mounted. Host MCP installation and broad file
access are not enabled as a side effect of this experiment. A later host-repository
workflow needs explicit mount/path policy review.

The browser sandbox must remain enabled. Docker's ordinary syscall filter blocks
user-namespace creation here, so the experiment uses the pinned upstream
Playwright Docker seccomp profile, with attribution and the sandbox's `chroot`
syscall allowed, rather than privileged mode
or disabling seccomp. This allows namespace creation for Chromium's own sandbox;
it does not grant container capabilities or permit bypassing website protections.

## Start and connect

This is an opt-in source-checkout experiment, not part of the npm installation.
Use a Linux Docker engine with Compose, user-namespace support, at least 2 GB of
container memory, and sufficient disk for Chromium and fonts. macOS and Windows
need a Linux VM; native Windows containers are not supported. Do not weaken the
sandbox to accommodate a host that fails the account-free checks.

From the repository root:

```sh
docker compose -f containers/browser/compose.json build browser
docker compose -f containers/browser/compose.json up -d --no-build browser
docker compose -f containers/browser/compose.json ps
```

Open <http://127.0.0.1:39333/vnc.html>. Retrieve the **local viewer password** on
your own terminal; it is separate from your ChatGPT password:

```sh
docker compose -f containers/browser/compose.json exec -T browser cat /home/node/.vnc/viewer-password
```

The eight-character password is the VNC protocol's effective limit. Keep the
published port on localhost; the viewer is not an internet service and has no
public TLS/access gateway. Do not put this password in a URL, repository, issue,
or shared log. For another computer, use an authenticated SSH tunnel to the host's
loopback port rather than publishing the container on a network interface.

After the account-free checks, open ChatGPT **inside the existing container
browser**, not in another browser profile:

```sh
docker compose -f containers/browser/compose.json exec -T browser prodex pro browser login --headed --wait --wait-timeout-ms 15000
docker compose -f containers/browser/compose.json exec -T browser node /app/dist/cli.js pro browser check --runtime
```

The bounded wait opens at most one missing ChatGPT tab in the already-running
browser, then stops on an authentication/protection blocker. `--no-wait` alone
does not open a missing tab when the browser already exists. The native CLI's
generic `--background` suggestion does not apply to this container flow; retain
the current runtime and use the viewer.

Sign in manually only when that page requests it. This new dedicated profile
does not copy a host login. Stop automation for login, protection, permission, or
rate-limit prompts. Do not use `--background`, `--headless`, or a host login
command to finish this flow: those select a different runtime or mode.

Closing the viewer tab disconnects the display only. Keep the container and, on
macOS/Windows, its Linux VM running for MCP use. Stopping the container stops
Chromium, but retains its profile and viewer password in the named volume.
Persistent storage is not a guarantee that ChatGPT will never expire a session.

```sh
docker compose -f containers/browser/compose.json stop browser
docker compose -f containers/browser/compose.json up -d --no-build browser
```

Do not run `down -v` unless intentionally deleting the entire profile. Do not
share or mount the profile into another running browser.

## MCP transport

An MCP client can use `docker` as the executable with these arguments, replacing
the compose path with an absolute path:

```text
compose -f /absolute/path/to/prodex/containers/browser/compose.json exec -T browser node /app/dist/cli.js mcp --cwd /home/node/bridge
```

For a named Docker context, put `--context CONTEXT` before `compose`. The `-T`
option is required for clean stdio; do not allocate a terminal. Each client gets
its own MCP process while the same-container bridge locks serialize shared work.
The account-free smoke tests task locking, not real conversation identity.

The compose file intentionally does not mount host repositories. This example
is not installed into the user's Codex or Claude settings automatically. A green
container healthcheck means local CDP and viewer reachability only; it does not
mean signed-in, Pro-ready, or attached to an existing MCP client.

## Verification record: 2026-09-16

Both installations are isolated development images based on package version
`0.40.18`; neither replaces the host-installed package. No npm, image-registry, or
GitHub Release publication is part of this experiment. The implementation commit
and per-image identities are recorded in the PR deployment comment after push.

| Check | WSL x64 | M3 native ARM64 Linux VM |
| --- | --- | --- |
| Image build and architecture-native execution | PASS | PASS |
| Chromium version | 152.0.7977.82 | 152.0.7977.82 |
| Headed process, Runtime/DOM, keyboard/mouse, file selection | PASS | PASS |
| Disposable-profile restart marker and owned cleanup | PASS | PASS |
| Two stdio MCP processes, distinct synthetic tasks, exclusive claim | PASS | PASS |
| One MCP client disconnects; other remains usable | PASS | PASS |
| Host-loopback viewer HTTP 200 and local service health | PASS | PASS |
| Unexpected blank-browser exit stops container without restart | PASS | NOT RUN |
| Chromium internal PID/network namespace and seccomp diagnostics | PASS | PASS |
| Authenticated noVNC connection, nonblank pixels, disconnect without browser replacement | PASS | PASS |
| Graceful container stop, same-volume restart, synthetic marker retained | PASS | PASS |
| Viewer password unchanged after restart (private comparison only) | PASS | PASS |
| Manual ChatGPT authentication and a Pro continuation | NOT RUN | NOT RUN |

The M3 trial uses a separate Colima profile/context, `prodex-check` /
`colima-prodex-check`, with a native ARM64 VM and no host directory mounts. It
does not activate/change the default context or open Docker Desktop. The WSL
trial uses its existing Linux Docker engine. Both publish only the viewer on
their own host's `127.0.0.1:39333`; CDP and raw VNC are not published.

Account-free browser command (use an absolute seccomp path for a remote context):

```sh
docker run --rm --init --network none --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777,size=256m \
  --tmpfs /home/node:rw,nosuid,nodev,uid=1000,gid=1000,mode=700 \
  --workdir /app --user 1000:1000 --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --security-opt seccomp=containers/browser/seccomp.json \
  --shm-size 1g --pids-limit 256 prodex-browser:experimental \
  xvfb-run -a -s '-screen 0 1440x900x24 -nolisten tcp' \
  node /app/scripts/browser-launch-smoke.mjs --headed
docker compose -f containers/browser/compose.json exec -T browser node /app/scripts/container-mcp-smoke.mjs
```

Initial attempts caught and corrected a missing `prodex.mjs` build input, an
`xvfb-run` PID-1 signal issue in the disposable test (fixed by `--init`), blocked
sandbox `chroot` under the all-capabilities-dropped seccomp policy, and an
unreachable published viewer when its internal listener was bound to container
loopback. The final configuration keeps host binding on loopback while allowing
Docker's internal forwarding. No `--no-sandbox`, unconfined seccomp, added
capability, or website-protection workaround was used.

A later crash/recreation test found Chromium refusing a stale profile lock when
Docker generated a different hostname. Compose now uses the stable single-user
hostname `prodex-browser`; the repeated crash plus forced-recreation check passed
without clearing a lock. The pre-fix, never-authenticated test volume needed one
explicit removal of its exact verified stale `SingletonLock` while no container
was using the volume. There is no automatic profile/lock deletion in the service.

Failure injection selected the single browser main process with the dedicated
profile/port and verified its service parent before sending SIGTERM. Docker
reported exit 1, `running=false`, PID 0, and restart count 0. PID-namespace teardown
terminates the container's remaining descendants; the supervisor is not intended
as a host-level process manager. X11 authentication is supplied over stdin, not
process arguments, and display/browser child environments are allowlisted.

The original default (headless) disposable smoke also passed on WSL, with the
same Runtime/DOM, input/file, and synthetic-profile assertions. This did not
contact ChatGPT. The initial full local suite passed 1,704 tests with three
platform-specific skips. The final full suite passed **1,717 tests**, with the same
three skips, across 122 files. Typecheck, build, focused security/lifecycle tests,
compose validation, and both images' `prodex --version` checks passed.
The final portability follow-up pins LF for the Linux launcher/container files
and makes the build-context assertion accept CRLF too. It does not modify either
running image or restart the pending login browser.

The viewer probe uses a background tab of the same browser to authenticate to the
local noVNC service while the synthetic fixture is active. It samples actual VNC
canvas pixels, disconnects, and verifies the original browser PID/socket and
marker. It is not a separate host desktop browser. The synthetic screenshot was
also inspected visually. `docker cp` could not export the tmpfs screenshot on
this WSL engine, so the generated PNG was read through container exec instead.

```sh
# Only on a never-authenticated trial with blank/synthetic pages:
docker compose -f containers/browser/compose.json exec -T browser node /app/scripts/container-viewer-smoke.mjs --seed
docker compose -f containers/browser/compose.json stop browser
docker compose -f containers/browser/compose.json up -d --no-build --wait --wait-timeout 45 browser
docker compose -f containers/browser/compose.json exec -T browser node /app/scripts/container-viewer-smoke.mjs --verify
```

`--verify` only reads the synthetic origin's marker; it cannot create the expected
result. The probe refuses existing real site/settings pages before mutation and
closes only the targets it creates. Never run it after real authentication or
during a consultation. Its temporary PNG is a synthetic fixture, not a screenshot
of account content.

After all synthetic checks, the WSL login wait opened one ChatGPT tab in the
existing container browser. It stopped with **`login_required`**; Cloudflare and
502 were not reported in that observation. Manual login was requested through the
local viewer. No login submission, account credential extraction, Pro prompt, or
continuation was automated. M3 remains an account-free browser. Actual signed-in
operation and connection of the user's existing Codex MCP remain pending; the
fresh MCP smoke is not evidence of either.

## Isolated true-headless baseline: 2026-09-16

After the [candidate audit](headless-candidates-audit.md), the user approved
retaining the virtual-display experiment while checking true headless separately.
The following checks used new disposable containers, never the existing service,
its named volume, or a host browser profile. They do not change the container
service's headed mode, authentication, installed version, or MCP attachment.

Both targets ran ordinary Chromium `152.0.7977.82`, CDP `1.3`, using the existing
development images, without rebuilding or installing anything:

- WSL x64 image: `sha256:973e16dbbe4d0b988fa099fa76906809b53d4687029a3bbf11fa5fdcf9fa0cb2`.
- M3 ARM64 Linux VM image: `sha256:b027f4ccfaf77c05abc784e9b5b60ed15be61dfb52145d96ef2a3166b941178e`.

M3 means native ARM64 execution inside the dedicated Colima Linux VM, not native
macOS Chrome. Native Windows, native macOS, and alternative browser engines were
not tested in this follow-up.

### Results

| Check | WSL x64 | M3 ARM64 Linux VM |
| --- | --- | --- |
| Actual headless process, Runtime/DOM, keyboard/mouse, file selection | PASS | PASS |
| Same disposable profile restarted; synthetic localStorage marker retained | PASS | PASS |
| No display environment or X11 socket directory in the public-page probe | PASS | PASS |
| Chromium internal PID/network namespace and seccomp diagnostics | PASS | PASS |
| Actual synthetic PNG pixels, not just DOM/layout assertions | PASS | PASS |
| One fresh-profile navigation to public `https://chatgpt.com/` | HTTP 403 | HTTP 403 |
| First bounded ProDex status observation | `chatgpt_page_missing` | `cloudflare_check` |
| Composer observed | No | No |
| Login attempts / prompt submissions | 0 / 0 | 0 / 0 |
| Graceful test-browser exit and disposable container removal | PASS | PASS |
| Authenticated Pro response / continuation | NOT RUN | NOT RUN |

The WSL document response was independently observed as HTTP 403 even though
the immediate status read returned `chatgpt_page_missing`. That single early
status is not evidence of expired authentication or a confirmed classifier bug.
No second navigation, refresh, login, mode switch, or protection interaction was
attempted. The M3 status explicitly identified a Cloudflare check. These results
do not identify which browser/network signals caused rejection, nor prove that
all headless environments fail.

### Isolation and method

The existing `browser-launch-smoke.mjs` ran first with external networking
disabled. Its default is true headless; `--headed` was not passed. The container
command replaced the service supervisor, so Xvfb/noVNC never started. Both home
and temporary directories were disposable tmpfs; no host directories, profile
volumes, control ports, or Docker socket were mounted/published.

```sh
# IMAGE is the platform-specific immutable image ID recorded above.
docker run --rm --init --network none --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777,size=256m \
  --tmpfs /home/node:rw,nosuid,nodev,uid=1000,gid=1000,mode=700 \
  --workdir /app --user 1000:1000 --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --security-opt seccomp=containers/browser/seccomp.json \
  --shm-size 1g --pids-limit 256 --memory 2g --cpus 2 \
  --env PRODEX_HEADLESS=1 "$IMAGE" \
  env -u DISPLAY -u XAUTHORITY node /app/scripts/browser-launch-smoke.mjs
```

The M3 invocation explicitly selected `colima-prodex-check` and its absolute
seccomp-file path. It did not switch the default Docker context.

A separate one-off probe used the same restrictions with Docker bridge
networking, a new tmpfs profile, no display variables, and a 90-second watchdog.
It verified the launched PID/profile/port and actual headless flag, checked
`chrome://sandbox/`, and captured a synthetic 128 x 64 PNG before any public-site
navigation. Decoded screenshot samples matched `[220,30,60,255]` and
`[20,160,90,255]` exactly. Unlike DOM-only checks, this demonstrates nonblank
rendered pixels; it does not prove ChatGPT rendering or post-restart pixels.

The probe then navigated once to the public ChatGPT home page, observed only the
main-frame document's response status and bounded DOM readiness, and stopped.
No direct private-API calls, network response bodies, credentials, cookies,
storage-state exports, account screenshots, or protective controls were read or
handled. Both probes closed their own browsers through CDP and confirmed exit;
`docker ps -a` subsequently found no test containers on either target.

The pre-existing services remained healthy with unchanged container IDs, host
PIDs, start times, image IDs, and restart counts (zero). No service restart or
account-state inspection was performed. Local focused regressions passed
**56 tests in six files**, including smoke-option rejection, process identity,
compatibility, container configuration, lifecycle, and viewer guards.
`git diff --check` and an in-memory audit of eight local links/heading anchors
and ASCII content in both updated experiment documents passed.

**Decision:** retain the existing virtual-display service and leave true
headless experimental. Browser mechanics pass on both Linux architectures;
ChatGPT access remains blocked in these fresh headless trials. Do not ask for
another login or present the passing synthetic checks as a Pro-access fix.
This verification record and its changelog entry are source-only updates, not
an npm/image/GitHub Release or an installed-runtime update.
