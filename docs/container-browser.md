# Experimental container browser

## Approved experiment

The user approved trying the persistent virtual-desktop candidate in
[the research record](headless-methods-research.md) on 2026-09-16. This is ordinary
Chromium on an isolated Linux display, not true headless Chromium. The host
browser, login profile, and installed package remain separate. The later client
setup below explicitly selects the container; it does not migrate a host profile
or reconnect an already-running agent.

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
- [x] Verify one user-authorized Pro response and one continuation after manual
  authentication. The [installed WSL check](#installed-container-acceptance-2026-09-17)
  passed on 2026-09-17; M3 authenticated acceptance remains untested.

The later [live host Pro acceptance](pro-acceptance-2026-09-16.md) passed using
the separate existing WSL host browser. It does not satisfy this container gate:
the container requires independent authentication and response verification.
The [initial 2026-09-17 check](#authenticated-container-check-2026-09-17) confirmed
manual login but returned no answer. The later corrected WSL installation passed
both live response gates; the earlier failed checks below are retained as history.

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

Open <http://127.0.0.1:39333/vnc.html> on the computer hosting this container
(or its Windows host when running under WSL). `127.0.0.1` refers to the computer
running the web browser, not the server selected in an SSH terminal. Separate
WSL and Mac containers can serve that same URL with different viewer passwords.

Use the checkout helper in your own interactive terminal to select the matching
Docker context, show the viewer URL, and copy the **local viewer password** to
your clipboard. It is separate from your ChatGPT password:

```sh
node scripts/container-client.mjs --context default viewer --copy-password
```

The command does not print the password, open a browser, or start a tunnel. It
refuses password access unless both stdin and stdout are real terminals. macOS
uses `pbcopy`, Windows/WSL use `clip.exe`, and Linux needs `wl-copy` or `xclip`
with a working desktop clipboard. Linux waits for one paste, for at most 60
seconds; a timeout fails instead of leaving a background clipboard process.
Clear the clipboard after login; macOS/Windows clipboard history can retain it.
An SSH terminal's clipboard belongs to the machine running the command, not
necessarily the computer displaying your viewer. Do not run this command through
an agent or a recorded/shared terminal, and do not paste its contents into chat.

The eight-character password is the VNC protocol's effective limit. Keep the
published port on localhost; the viewer is not an internet service and has no
public TLS/access gateway. Do not put this password in a URL, repository, issue,
or shared log. For another computer, use an authenticated SSH tunnel to the host's
loopback port rather than publishing the container on a network interface.

### Viewer on another computer

First identify **the computer running the user's web browser**, not the computer
running the agent or terminal. `127.0.0.1` always refers to the viewer computer.
A URL tested on Windows/WSL does not establish reachability from a Mac, and an
SSH tunnel created on WSL is not available at the same localhost port on a Mac.

- Browser on the container host: use that host's published loopback viewer port.
  For the installed M3 service this is port `39333`, with Docker context
  `colima-prodex-check`; no WSL tunnel is needed.
- Browser on a different computer: establish forwarding on **that viewer
  computer** and use its local forwarded port, as below.
- Copy the password into the viewer computer's clipboard. A helper run in an SSH
  shell copies to the remote host's clipboard, which is correct only when that
  host is also where the user is viewing the browser.

From the computer running your web browser, forward an unused local port to the
container host, replacing `user@container-host` with your existing SSH target:

```sh
ssh -NT -o ExitOnForwardFailure=yes -L 127.0.0.1:39334:127.0.0.1:39333 user@container-host
```

Keep that connection open and use
<http://127.0.0.1:39334/vnc.html?host=127.0.0.1&port=39334&path=websockify&encrypt=0&reconnect=0&autoconnect=1&resize=scale>.
The explicit viewer settings override a previously saved endpoint. The password
still comes from the **container host**, not a container on the viewer computer.
Confirm the forwarding listener is loopback-only before using it. Do not reuse an
occupied port or bind it to `0.0.0.0`; keep SSH authentication and VNC authentication
enabled. Closing this SSH connection removes the forwarding, not the browser or
its profile. No password belongs in this URL or the SSH command.

For `password check failed`, identify the actual server before resetting anything:
check the selected Docker context and which container records the failed
authentication. A healthy HTTP page alone proves neither the target identity nor
successful password authentication. Do not paste passwords into support messages.

### M3 local-viewer correction: 2026-09-18

The user was viewing the link on M3, but the agent had provided a WSL-local SSH
forward on port `39335`. WSL and Windows HTTP checks passed; that did not make
the same localhost URL valid on M3. M3's direct viewer on port `39333` returned
HTTP 200. The WSL forward also passed a WebSocket/RFB greeting check with no
password, narrowing the reported failure to the wrong viewer-computer route.

The existing M3 viewer was opened directly on M3. An operator-owned M3 Terminal
window was prepared with an explicit Return-to-copy / Ctrl+C-to-cancel prompt,
followed by the already-installed helper's `viewer --copy-password` command and
explicit `colima-prodex-check` context. The operator, not the agent, triggers the
private clipboard transfer; no password is printed, embedded in a URL, or read
back. No product code or helper was installed or changed. The dedicated WSL
`39335` tunnel was closed and its listener confirmed absent; unrelated tunnels,
the M3 service, saved profile, and viewer password were left unchanged.

PASS: 18 container-client tests, direct M3 HTTP check, WSL/Windows HTTP checks,
unauthenticated WebSocket/RFB greeting, existing helper SHA-256 match, and
successful M3 browser/Terminal launch commands. These checks do not prove the
user sees the page or has completed VNC or ChatGPT authentication. Login and
authenticated M3 Pro acceptance still require subsequent verification.

### Authenticate ChatGPT

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

### Everyday checkout helper

The source checkout includes a Node 20+ launcher for an **already-running**
container. It never builds, starts, replaces, or logs in a browser automatically:

```sh
node scripts/container-client.mjs --context default status
node scripts/container-client.mjs --context default pro -- "Review this short plan: ..."
node scripts/container-client.mjs --context default pro --continue-task TASK_ID -- "Clarify the previous answer."
node scripts/container-client.mjs --context default mcp
node scripts/container-client.mjs --context default viewer
```

Replace `default` with your Docker context (`colima-prodex-check` in the M3
verification). Use `--container NAME` before the command for a nondefault name.
`pro` is an explicit send, defaults to Pro effort only when no model/effort was
chosen, and preserves native continuation and `--stdin` options. Login and
private bridge/browser path overrides are refused. Other native ask options
retain their existing validation. Status shows actual process mode, image ID,
version, and readiness without conversation URLs, titles, or authentication data.

The bridge is always `/home/node/bridge`. `--file` and `--attach` refer to
container-relative files, not your host repository. No repository is mounted.
Your host agent may include specifically authorized text in `prompt`, or your
terminal can pipe that text to `pro --stdin`. Do not send unrelated local files.

For a remote Docker endpoint, `viewer` requires `--forwarded-port PORT` for an
existing local loopback tunnel. It cannot verify which endpoint an SSH tunnel
reaches; establish and check the tunnel first. TCP Docker endpoints are treated
as remote even when their hostname is localhost. Without password copying,
`viewer` prints only the URL to stdout and target identity to stderr.

Register the same helper with your client using absolute executable and checkout
paths. Keep Docker on that client's PATH:

```sh
codex mcp add prodex -- /absolute/path/to/node /absolute/path/to/prodex/scripts/container-client.mjs --context default mcp
claude mcp add prodex -s user --transport stdio -- /absolute/path/to/node /absolute/path/to/prodex/scripts/container-client.mjs --context default mcp
```

Replace an existing Claude entry in the same scope before adding it. Preserve
unrelated settings. For Codex, set these values in the existing server section:

```toml
[mcp_servers.prodex]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/prodex/scripts/container-client.mjs", "--context", "default", "mcp"]
startup_timeout_sec = 30
tool_timeout_sec = 3900
```

Reconnect through your agent's supported MCP controls before expecting its tools
to use the new command. Saving configuration does not replace an existing stdio
process. Until then, the explicit terminal `pro` command uses the selected
container without restarting your coding session. This helper is source-only,
not a new npm command or a public container image release.

### Direct Docker transport

An MCP client can use `docker` as the executable with these arguments, replacing
the compose path with an absolute path:

```text
compose -f /absolute/path/to/prodex/containers/browser/compose.json exec -T browser node /app/dist/cli.js mcp --cwd /home/node/bridge
```

For a named Docker context, put `--context CONTEXT` before `compose`. The `-T`
option is required for clean stdio; do not allocate a terminal. Each client gets
its own MCP process while the same-container bridge locks serialize shared work.
The account-free smoke tests task locking, not real conversation identity.

The compose file intentionally does not mount host repositories. The commands
above change client settings only when explicitly run. A green
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

## Viewer target correction: 2026-09-16

A reported password failure was traced to a cross-host target mix-up: in the
same 45-minute diagnostic window, WSL recorded no password rejection while the
separate M3 container recorded six failed authentication attempts. The WSL
password succeeded in direct RFB and WebSocket authentication. A disposable
headless, incognito viewer also passed the actual noVNC password form, connected,
and rendered a nonblank 1440 x 900 canvas in view-only mode. No account screenshot
or credential value was printed or saved; the test browser/profile/container were
removed, and the existing browser identity, service start time, and restart count
were unchanged.

The user-specific correction forwards M3 loopback port `39334` over the existing
authenticated SSH connection to WSL loopback port `39333`. This reverse forwarding
was started from WSL because that SSH direction was already available. The M3
listener was verified as `127.0.0.1` only; HTTP 200 and an actual RFB greeting through
the forwarded WebSocket passed. The original M3 viewer on `39333` remains separate.
The same SSH connection also provides a WSL loopback `39334` alias through the
M3 forwarding port, so the new URL reaches WSL from either computer. That local
listener is also loopback-only; native Windows HTTP access returned 200. This
temporary alias depends on the SSH connection, not on a changed container port.
A separate authentication-only probe through the complete `39334` forwarding
path accepted the unchanged WSL viewer password, without displaying credentials
or sending framebuffer/input requests; that probe container was also removed.
The controlled temporary SSH connection is left running for manual authentication;
its private local operational note records how to check and close only that tunnel.

All 27 container configuration, service, and viewer regression tests passed.
An initial remote log-summary command used an unavailable Docker executable path;
retrying the read-only summary with the resolved executable succeeded. Only
failure counts were emitted, never raw logs or credentials. The routing correction
does not demonstrate ChatGPT login or authenticated Pro operation in the container.
No package release, browser restart, profile transfer, or password change occurred.

## Authenticated container check: 2026-09-17

After the user reported completing ChatGPT login through the corrected viewer,
the WSL container returned `reachable=true`, `loggedInLikely=true`,
`hasComposer=true`, and no rendered blocker. Runtime inspection verified a
headed Linux x64 Chromium `152.0.7977.82`, not pure headless Chromium. This used
the existing `prodex-browser-browser-1` service and its original named home volume;
no login command, new browser window, mode change, or profile copying occurred.

Source baseline: `8b5c4786838a02f87cfe002e5f616d43afb2ea9e`. The unchanged
development image was
`sha256:973e16dbbe4d0b988fa099fa76906809b53d4687029a3bbf11fa5fdcf9fa0cb2`.
Both temporary stdio MCP handshakes reported `prodex` version `0.40.18`.
They ran inside the container with `/home/node/bridge` as the durable workspace,
`PRODEX_NO_AUTO_LOGIN=1`, and ordinary shared send locking. These connections
did not reconnect the MCP already attached to Codex or change client settings.

| Check | Result |
| --- | --- |
| Manual ChatGPT authentication and composer readiness | PASS |
| Zero established VNC clients observed while browser/login remained available | PASS, point-in-time observation; user viewer was not forcibly disconnected |
| Fresh Pro request, no model fallback, exact synthetic answer | FAIL: `send_timeout` at the explicit 300-second test budget |
| One recovery of the original thread and exact request, no new send | FAIL: `no_recoverable_answer` after the additional 120-second recovery budget |
| Rendered Pro model and completed-answer identity | NOT VERIFIED: no completed answer returned |
| Planned same-thread continuation | NOT RUN: first-answer acceptance failed |
| Temporary MCP child cleanup | PASS: both children closed and their PIDs were absent |
| Container configuration/service/viewer regression tests | PASS: 27 tests across three files |

The only sent prompt created `task_20260917_011931_gpt-pro-consult`. It asked
for 31 x 37, with the expected answer `PDX_CONTAINER_20260917_Q9 FIRST 1147`,
and supplied a synthetic label for a possible later memory check. A read-only
rendered-DOM probe confirmed the request marker was present, but the assistant
message had no text at that observation. The task and session were durably
recorded as blocked with `send_timeout`. Recovery used the exact request ID from
that task's recorded recovery instruction, never an arbitrary latest answer.
Private conversation URLs and raw records remain inside the container.

The 300-second ceiling was an explicit acceptance-test limit, shorter than the
current CLI's 20-minute default for a Pro selection. These observations establish
a failed bounded check, not a proven login failure, model-selection defect,
service outage, or permanent inability to answer. Nothing was automatically
resent. The follow-up branch stopped before sending because it required a
finished, request-verified, Pro-verified first answer.

Verification used inline Node MCP SDK clients via
`docker exec --workdir /app prodex-browser-browser-1 node --input-type=module`.
Each client launched `/app/dist/cli.js mcp --cwd /home/node/bridge`, required the
`0.40.18` initialization handshake, and closed its transport and child process.
The first call requested `effort: "Pro"`, `allow_model_fallback: false`,
`new_chat: true`, and `timeout_ms: 300000`; recovery requested
`timeout_ms: 120000`. Rendered-state probes used the existing container-loopback
CDP connection only, without cookies, hidden endpoints, or page reloads.

```sh
npm test -- tests/container-browser-service.test.ts tests/container-browser-config.test.ts tests/container-viewer-smoke.test.ts
docker inspect --format '{{.State.Status}} {{.State.Health.Status}} {{.State.StartedAt}} {{.RestartCount}}' prodex-browser-browser-1
```

The final service check remained `running healthy`, with the unchanged start
time `2026-09-16T02:21:14.870311519Z` and restart count `0`. No authenticated
restart test, M3 live request, or full OS matrix was performed in this follow-up.
This is a verification-record update, not a runtime fix, package installation,
image publication, or release. Commit/push verification is recorded in PR #7.

The user also identified the manual Docker command for viewer-password retrieval
as an onboarding problem. That workflow is still present; no automatic viewer
handoff command was implemented or installed in this check. Improving it must
retain local/SSH access controls and VNC authentication, without putting the
credential in URLs, logs, command arguments, or support messages.

## Launch correction and candidate verification: 2026-09-17

Source baseline: `d00f17f46abb539d9081e04f9246db906cd4d344`. This follow-up
corrects two reproduced defects; it does not close the authenticated Pro gate.

### Observed failures and root-cause limits

A later rendered-DOM check of the original synthetic request still found an empty
assistant message, now with `data-message-model-slug="gpt-6-pro"`. Copy/rating
controls were present and no generation indicator was active. Loading that exact
test thread in a new tab showed the same empty answer. A model tag without answer
text is not a passing response or a valid continuation parent.

Reloading the test thread subsequently produced a renderer crash. An in-memory,
view-only noVNC observation showed Chromium's `SIGILL` error page. The browser's
main process and container health checks remained alive, demonstrating that
service health alone cannot certify a responsive ChatGPT renderer. Cgroup memory
and PID-limit event counters were zero, and neither the home volume nor temporary
mounts were full. These checks do not establish the cause of `SIGILL`.

After replacing only the crashed test tab, one separately authorized, bounded
Pro check used the normal 20-minute budget. Task
`task_20260917_014821_gpt-pro-consult` failed with `browser_tab_crashed` while
applying model selection, before any prompt-sent progress. Submission was not
confirmed. No continuation or automatic resend followed; the temporary MCP child
was closed. A request marker in blocker metadata is not itself proof of a send.

Inspection of the installed Debian launcher found a concrete mismatch:
`/etc/chromium.d/dev-shm` appends `--disable-dev-shm-usage` whenever available
shared memory is below 4,080,218,931 bytes. This container allocates 1 GB there,
so Chromium instead used its much smaller 256 MB `/tmp` mount. The wrapper also
added `--enable-gpu-rasterization`. Both injected arguments were observed on the
live process. This mismatch is proven; its causal relationship to the crash or
empty answer is not.

The container now launches `/usr/lib/chromium/chromium` directly and checks that
path during image build. Container-only arguments explicitly retain restrictions
on background networking, extensions, hyperlink pings, and media routing. Shared
host-browser launch defaults, browser version, seccomp, namespace sandbox,
mount permissions, named home volume, and authentication behavior are unchanged.

An isolated JIT/WebAssembly/worker/SharedArrayBuffer/reload probe passed with
non-executable temporary mounts using both the wrapper and direct binary on WSL,
and the direct binary on M3 ARM64. A noexec-related crash hypothesis was therefore
not demonstrated; no mount permissions were relaxed. A disposable package probe
found the installed Chromium version also remained the Debian candidate version.

The account-free viewer smoke exposed a separate race: a newly created target
could still evaluate its completed `about:blank` document after target metadata
had changed. Importing noVNC's relative module then failed. Both fixture and
viewer readiness now require the actual committed document URL as well as a
completed load state. Four regression cases reproduce the wrong-document and
loading states. The old candidate failed this smoke; rebuilt candidates passed.

### Candidate evidence

Both candidates use package `0.40.18` and Chromium `152.0.7977.82`:

| Target | Candidate image ID |
| --- | --- |
| WSL Linux x64 | `sha256:1f5cf6a36323635c2f03bd3b011f89f9e5223cc955f10737bd187de7e89cfd18` |
| M3 Linux ARM64, explicit `colima-prodex-check` context | `sha256:73de64cca2889500e7683dd10e269cbf05f8997e6830d09641e44047cee5d6ac` |

| Check | WSL x64 | M3 ARM64 |
| --- | --- | --- |
| Final candidate image build | PASS | PASS |
| Non-root full service, local CDP/noVNC health | PASS | PASS |
| Actual main-process memory/GPU flags absent, privacy flags present | PASS | PASS |
| Open Chromium file descriptors on `/dev/shm` | PASS | PASS |
| Actual PID/network namespaces and Seccomp-BPF sandbox | PASS | PASS |
| Viewer `--seed` and `--verify`: authentication, nonblank pixels, disconnect, same browser | PASS | PASS |
| Two independent MCP clients, task identity, exclusive claim, survivor after disconnect | PASS | PASS |
| Temporary test containers stopped and removed | PASS | PASS |
| Authenticated candidate Pro answer and same-thread continuation | NOT RUN | NOT RUN |

Each candidate service ran with `--network none`, no published ports or host
mounts, disposable `/home/node` and `/tmp` tmpfs, user 1000, dropped capabilities,
`no-new-privileges`, the existing seccomp profile, 1 GB shared memory, 2 GB memory,
256 PID limit, and two CPUs. Synthetic screenshots stayed inside temporary
containers and were removed with them; no account screenshot or secret was saved.
These `--seed`/`--verify` checks exercise the same candidate runtime, not an
authenticated restart. They must never be run against a real ChatGPT profile.

Reproduction commands for each disposable service:

```sh
docker exec prodex-candidate-service-check-20260917 node /app/containers/browser/health.mjs
docker exec --workdir /app prodex-candidate-service-check-20260917 node /app/scripts/container-viewer-smoke.mjs --seed
docker exec --workdir /app prodex-candidate-service-check-20260917 node /app/scripts/container-viewer-smoke.mjs --verify
docker exec --workdir /app prodex-candidate-service-check-20260917 node /app/scripts/container-mcp-smoke.mjs
```

M3 commands used `/usr/local/bin/docker --context colima-prodex-check` explicitly.
Its first build failed because the noninteractive SSH PATH omitted the installed
`docker-credential-desktop` executable. Adding Docker's existing application bin
directory to that command's PATH allowed the build to pass; no credential or
Docker configuration was changed. No default Docker context was switched.

Local `npm test` passed **1,723 tests across 122 files**, with three existing
Windows-only cases skipped on Linux. `npm run typecheck`, both image builds, and
`git diff --check` passed. Focused container/crash suites passed 49 tests.
Regression tests were observed failing before each corresponding fix. A read-only
review identified the wrapper restrictions that are now explicit and covered.

### Installation and remaining gate

Both candidate images are local build artifacts only. Neither replaced the
installed `experimental` image or restarted an authenticated service. WSL still
runs image `973e16dbbe4d`, started `2026-09-16T02:21:14.870311519Z`; M3 still
runs `b027f4ccfaf77`, started `2026-09-16T02:21:52.350093875Z`. Both report
`running healthy`, restart count zero. The WSL ChatGPT renderer had crashed;
its healthy supervisor is not a passing application check. Existing login data,
viewer password, Codex process, host browsers, and user viewer tunnel were left
untouched.

Applying the candidate to the login-bearing WSL container requires the separately
requested targeted restart approval. Preserve its existing named home volume and
hostname, then verify saved-login readiness, one request-bound completed Pro
answer, and one exact-thread continuation. Stop on a login/protection prompt or
another crash; do not label synthetic or model-tag-only evidence as acceptance.
No npm release, image publication, GitHub Release, native Windows test, or complete
OS acceptance is claimed. Commit/push evidence belongs in PR #7 alongside this
durable record.

## Installed container acceptance: 2026-09-17

The user authorized applying the tested candidate and restarting only the WSL
ProDex container. This supersedes the preceding installation-pending checkpoint.
The 49 focused container/crash regression tests passed again before installation.

### Installed target

- Implementation commit: `fd85d377f7977da8a50f534a1f2beaa94efb7169`.
- Target: WSL Linux x64, `prodex-browser-browser-1`.
- Installed image: `sha256:1f5cf6a36323635c2f03bd3b011f89f9e5223cc955f10737bd187de7e89cfd18`.
- Package: `0.40.18`; Chromium: `152.0.7977.82`, ordinary headed Chromium on Xvfb.
- Service started: `2026-09-17T02:26:01.057464106Z`; final state `running healthy`, restart count `0`.
- Preserved: `prodex-browser_browser-home:/home/node`, hostname `prodex-browser`, and viewer-password file inode, size, permissions, and modification time.
- Actual launch flags: wrapper shared-memory/GPU overrides absent, explicit container privacy restrictions present, browser sandbox retained.

The approved update tagged the already-tested image locally, then ran:

```sh
docker compose -f containers/browser/compose.json up -d --no-build --no-deps --force-recreate browser
docker exec prodex-browser-browser-1 node /app/containers/browser/health.mjs
```

No volume deletion, profile copying, cookie/token extraction, password reset,
host-browser window, Codex restart, or protective-control interaction occurred.
One ChatGPT tab was opened inside the existing virtual display after startup.
Its first bounded status read returned `loggedInLikely=true`, `hasComposer=true`,
and no blocker, without another login. The user's existing loopback viewer tunnel
remained alive and returned HTTP 200.

### Actual response and continuation

Two independent temporary stdio MCP clients each required the `0.40.18` handshake
and used the same private bridge workspace and ordinary shared send lock. The
first requested `new_chat: true`, `effort: "Pro"`, no model fallback, and a
20-minute maximum budget. It asked for a short safe onboarding flow, an exact
test prefix, and retention of a fictional label. The second used the first
verified result's continuation handle, not an arbitrary current/latest tab.
Each client closed and its process exit was verified before the check finished.

| Evidence | First request | Continuation |
| --- | --- | --- |
| Task | `task_20260917_022732_gpt-pro-consult` | `task_20260917_022847_gpt-pro-consult` |
| Request ID | `b20e6a8ee2584daf83bbbf64f12cf1fe` | `8550649076021c8f79761d45b6a480a2` |
| Completed answer length | 795 characters | 45 characters |
| Rendered model | `gpt-6-pro` | `gpt-6-pro` |
| `request_verified` / `pro_verified` | `true` / `true` | `true` / `true` |
| Task and session status | `done` | `done` |
| Persistence warnings | 0 | 0 |

The second prompt did not repeat the fictional label. Its exact answer was:

```text
PDX_CONTAINER_20260917_APPLIED_C6 SECOND N4J8
```

The test asserted equal conversation URLs internally, distinct request IDs, and
`continued_from` equal to the first task ID. Exactly two prompts were submitted;
no timeout, recovery, or automatic resend occurred. The earlier failed tasks
were not overwritten. Private conversation URLs and raw account state were not
published.

A separate local read-back used `getFinalizedResultReadOnly`,
`readFinalizedResultArtifactText`, `getTrustedReceipt`, and `getSessionReadOnly`.
Both completion seals, saved model/request evidence, artifact SHA-256 checks,
answer contents, and parent/session links passed. An initial diagnostic assertion
incorrectly expected `integrity_status.trusted=true`; the display API emits that
field only for untrusted receipts. The corrected check called the actual trusted
receipt verifier and passed. No product code or record was changed to satisfy it.

Final browser readiness remained logged in with a composer and no blocker. No
temporary MCP processes remained. A point-in-time socket check found zero
established raw VNC or web-viewer connections. SIGILL was not reproduced during
these two live requests; this bounded pass does not establish that every possible
renderer crash or upstream service failure is eliminated.

### CI and publication scope

[CI run 35173719307](https://github.com/youdie006/prodex/actions/runs/35173719307)
completed successfully for the installed implementation: Ubuntu 24.04 on Node
20/22/24, macOS 15 ARM64 and Intel on Node 22, and Windows Server 2025 x64 on Node
22. All six jobs include build, account-free headless-browser smoke, and release
verification. The existing GitHub Actions Node-20 deprecation annotation is
non-blocking and is not suppressed. These native CI jobs do not exercise a
signed-in ChatGPT account.

**Acceptance:** the installed WSL virtual-display container passes saved-login
retention, a real Pro response, and exact-thread continuation across MCP processes.
This is not pure-headless authenticated access. M3's installed service remains
unchanged and has no authenticated Pro pass; Codex's already-attached MCP was not
reconnected by these fresh container clients. No npm publication, image-registry
publication, release tag, or GitHub Release was made. The source and this durable
installation record are tracked on the existing branch and PR #7.

## Container client installation: 2026-09-17

The later [measured mode comparison](headless-mode-comparison-2026-09-17.md)
tests the exact native headless argument builder, records 12 account-free
WSL/M3 observations, and updates the WSL restoration timestamp. It does not
replace the verified virtual-display operating mode.

The user subsequently authorized finishing both machine installations and client
setup. This checkpoint supersedes the previous M3-installation-pending statement;
the earlier measurements above remain historical, not current service state.

### Same-profile pure-headless check

The authenticated WSL container was stopped gracefully before one disposable
trial used its existing named volume and hostname with direct Chromium
`--headless=new`. Process inspection confirmed headless mode without DISPLAY,
XAUTHORITY, or WAYLAND_DISPLAY. The first ChatGPT navigation returned
`cloudflare_check`, without a usable signed-in composer. **Zero prompts were
sent.** No protection interaction, fingerprint change, profile copying, token
extraction, or retry was attempted.

The trial browser was closed and its disposable container removed. Restarting
the known-good virtual-display container restored `loggedInLikely=true`,
`hasComposer=true`, and no blocker without asking for another login. Therefore
the tested operating mode remains virtual-display Chromium, not authenticated
pure headless. A persistent signed-in profile alone did not pass the latter.

### Installed machines and clients

Both images retain package `0.40.18`, Chromium `152.0.7977.82`, the direct-binary
implementation from `fd85d377f7977da8a50f534a1f2beaa94efb7169`, the named home
volume, stable hostname, viewer password, and browser sandbox.

| Target | Installed image | Service start (UTC) | Readiness |
| --- | --- | --- | --- |
| WSL x64 | `sha256:1f5cf6a36323635c2f03bd3b011f89f9e5223cc955f10737bd187de7e89cfd18` | `2026-09-17T03:09:21.168498573Z` | Healthy, signed in, composer ready |
| M3 ARM64, `colima-prodex-check` | `sha256:73de64cca2889500e7683dd10e269cbf05f8997e6830d09641e44047cee5d6ac` | `2026-09-17T03:11:22.942538376Z` | Healthy, `login_required` |

M3's first replacement began before the local image tag operation completed;
inspection caught the old image, and a second explicit replacement installed
the verified immutable image. Password-file metadata remained unchanged. M3
has not been signed in automatically, received no Pro prompt, and needs its own
manual first login. WSL credentials were not copied to it.

The host-side helper was installed from this source checkout on WSL and copied
to the versioned operator directory on M3. It is not inside the image and does
not require another browser restart. Both machines' user-scoped Codex and Claude
`prodex` entries now select their explicit local Docker context. Codex startup
and tool timeouts are 30 and 3900 seconds. M3 also sets the public executable
PATH for its noninteractive client. Unrelated MCP entries were preserved.

| Client check | WSL | M3 |
| --- | --- | --- |
| Helper status reports actual process mode and immutable image | PASS | PASS |
| Two independent helper-launched MCP handshakes, 20 tools, version 0.40.18 | PASS | PASS |
| One client closes; the second remains usable | PASS | PASS |
| Claude `mcp get prodex` reports Connected to the helper | PASS | PASS |
| Codex `mcp get prodex --json` confirms command, context, and timeouts | PASS | PASS |

These checks do not claim a live Claude-model consultation. Real clipboard
copying was deliberately not invoked by the agent; its TTY guard, value
validation, platform command selection, private pipes, and bounded cleanup are
covered by tests using synthetic values. Remote viewer URLs still require the
operator to establish the intended loopback tunnel.

Both installed helper files have SHA-256
`436d120c1ae7f3c1390b7b82e6b63ef3b7c6866c2e1ce9d0a4ec401a7229b89e`.
The final WSL read remained signed in and ready; both containers had zero
remaining temporary MCP processes after disconnect. The user's existing SSH
viewer tunnel stayed alive. No host browser or visible login window was opened.

The current Codex session was not restarted or disconnected. Its existing host
MCP process is not changed by these saved settings. The installed Codex protocol
does expose `config/mcpServer/reload`, but this session has no reachable managed
app-server control socket. A separate temporary app-server was used only for
M3's structured timeout configuration write and then closed, not as evidence of
reconnecting the current session.

### Fresh Codex continuation

A separate Codex CLI `0.154.0` process initialized the helper MCP using existing
Codex authentication without copying credentials or restarting the current
session. The readiness wrapper initially kept stdin open, so the new CLI waited
for piped input; closing that owned input pipe corrected the harness check.
The first MCP attempt used `approval_policy="never"` and was refused by Codex
before any browser send. The subsequent invocation retained a read-only sandbox,
exposed only `pro_consult`, and used the built-in automatic approval reviewer
with `approval_policy="on-request"`. It did not globally bypass approvals or
change persistent approval settings.

Exactly one Pro prompt was sent through that actual Codex MCP tool call:

- Task: `task_20260917_034029_gpt-pro-consult`.
- Request: `ea34149f28c6c29352ca900e38c2c828`.
- `continued_from`: `task_20260917_022732_gpt-pro-consult`.
- Rendered model: `gpt-6-pro`; status `done`.
- `request_verified=true`, `pro_verified=true`, zero persistence warnings.
- Answer: `PDX_REAL_CODEX_C7 THIRD N4J8`.

The prompt did not repeat `N4J8`. A separate read-back verified the same original
thread, trusted completion and model receipt, saved session/task links, and the
answer artifact hash. The owned fresh Codex/MCP processes exited afterward. This
is actual fresh-agent acceptance, not a claim that the older current attachment
was replaced.

The independent code review caught a context named `DOCKER_HOST` being mistaken
for the environment-selected endpoint when deriving the viewer URL. A regression
first reproduced the incorrect local/remote classification, then passed after
routing was based on explicit context selection rather than its display label.
The helper's 18 focused tests passed, including this collision and the unchanged
environment-endpoint path. Automated password-copy and nonexistent-context
negative probes both failed safely without reading a password or starting a
container.

Final local verification after the review fix: `npm test -- --reporter=dot`
passed all 123 test files (1,741 passed, three platform exclusions); `npm run
typecheck`, `node --check scripts/container-client.mjs`, and `git diff --check`
passed. The review regression was observed failing before the correction. No
real clipboard credential was read during any of these automated checks.

No new npm version, registry image, release tag, or GitHub Release is published
by this source-only helper installation. The existing six-platform CI pass
above applies to the installed image implementation; the helper's own checks
and source commit are recorded in the follow-up PR deployment comment.

## Live recheck: 2026-09-18

**Overall pure-headless acceptance remains blocked.** This user-authorized
recheck verifies the already-installed WSL virtual-display operating mode, not a
substitute headless pass. No new headless navigation or protection retry occurred;
the latest correlated public observation remains [307 -> 403 with a final
challenge header](navigation-diagnostics-2026-09-18.md#one-public-observation).

The WSL service retained image
`sha256:1f5cf6a36323635c2f03bd3b011f89f9e5223cc955f10737bd187de7e89cfd18`,
package `0.40.18`, container ID prefix `39b4ed5b4b12`, start time
`2026-09-17T04:36:34.956128153Z`, and restart count zero. Before and after,
`node scripts/container-client.mjs --context default status` reported healthy,
actual `headed` mode, ready, and no blocker. No login window, service restart,
profile transfer, password read, or configuration change was needed.

Two temporary SDK clients launched the container helper sequentially. Each MCP
handshake reported `0.40.18`; the first client closed before the second connected.
Both requests selected `effort: "Pro"`, disabled model fallback, used the same
explicit session key, and had a 20-minute maximum budget without retries.

| Check | First request | Exact-task continuation |
| --- | --- | --- |
| Task | `task_20260917_160512_gpt-pro-consult` | `task_20260917_160602_gpt-pro-consult` |
| Request ID | `3cc004e5f8d65ae957243645ff422040` | `099720a9b5caecc1086cd42e69471b47` |
| Rendered model | `gpt-6-pro` | `gpt-6-pro` |
| Completed / request verified / Pro verified | PASS | PASS |
| Expected answer | Test prefix, `FIRST 1763` | Same prefix, `SECOND`, remembered fictional label, `1780` |

The first prompt asked for 41 times 43 and retention of a random fictional label.
The second did not repeat the label and asked to add 17 to the original result.
Both exact answers matched. Internal assertions confirmed the same conversation,
distinct request IDs, and `continued_from` equal to the first task. The test prefix
was `PDX_FINAL_20260918_02DFFFDE`. Private conversation URLs remain local.

Exactly two prompts were submitted. A subsequent `pro_recover` using the second
request's exact thread and request ID returned the identical verified answer
without sending another prompt. Independent store read-back verified both
completion seals, trusted saved-answer receipts, model/request evidence, session
links, artifact byte counts and SHA-256 hashes, and zero persistence warnings.
An initial read-back assertion incorrectly required project verification for a
root conversation. The existing destination contract omits that field when no
project was requested; the corrected assertion checked `observed: "root"` and
the exact conversation linkage. No product code or stored result was altered.

Point-in-time checks found zero viewer connections before and after the requests;
the final check covered IPv4 and IPv6. Both owned helper processes exited, and
the final container process check found no remaining MCP process. The original
Codex MCP attachment was neither replaced nor used as evidence for these fresh
container-client handshakes.

M3's unchanged Linux ARM64 service was healthy and reachable, but its read-only
status returned actual `headed` mode and `login_required`. No M3 prompt, login,
or protection interaction occurred; its authenticated acceptance is not passed.

Verification:

- PASS: the two real WSL Pro answers, continuation, no-send recovery, durable
  result integrity, retained readiness, unchanged service identity, and cleanup.
- PASS: `npm test -- tests/container-client.test.ts tests/mcp-consult.test.ts tests/continue-thread.test.ts tests/pro-selection-contract.test.ts`
  (92 tests across four files). These source-checkout tests are separate from
  the installed image's live checks.
- PASS: `npm test -- tests/destination-verification.test.ts` (nine tests),
  including the root-chat contract used by the corrected read-back assertion.
- PASS: `git diff --check` and Node assertions for explicit acceptance limits,
  ASCII additions, local document links, the changelog backlink, and absence of
  private conversation URLs in this record.
- PASS: [CI 35239179272](https://github.com/youdie006/prodex/actions/runs/35239179272)
  completed all six native jobs for source commit
  `bdfd9303d380562c66d1fbfb0fae257ed45cf480`. It does not exercise signed-in Pro.
- FAIL, harness assertion only: the initial project-verification assumption
  described above; corrected read-back passed without another browser request.
- NOT PASSED: pure-headless Pro access, authenticated M3 operation, and current
  attached-client reconnection. None is inferred from the WSL virtual-display pass.

This is a verification-record update only. No npm/image publication, release tag,
installation, or runtime change was made. Commit/push details are recorded in
[PR 7](https://github.com/youdie006/prodex/pull/7); the user's untracked `Makefile`
remains untouched.
