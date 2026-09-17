# Headless and virtual-display comparison

Date: 2026-09-17. The user explicitly requested another attempt and a comparison,
not an automatic replacement of the verified operating mode.

## Result

- Both modes passed 12 account-free smoke runs across WSL x64 and M3 ARM64.
- Headless had lower median sampled memory and shorter median whole-smoke time
  in these small samples. This is not a ChatGPT latency benchmark.
- One corrected, same-profile WSL headless navigation still returned
  `cloudflare_check`. No prompt was submitted and no Pro answer is claimed.
- Restoring the original virtual-display container immediately restored its
  signed-in composer without another login. Existing client settings are unchanged.

The raw observations, metric definitions, image identities, and live outcome are
in [the JSON evidence](headless-mode-comparison-2026-09-17.json).

## A distinct test, not the same retry

The previous ad hoc authenticated trial took the service's headed arguments and
appended `--headless=new`. It retained `--new-window` and omitted the native
headless path's `--window-size=1440,900`.

This trial instead retained the four existing container privacy restrictions and
called the actual `buildChromeLaunchArgs({ headless: true, ... })` builder. It
asserted both the desktop window-size argument and absence of `--new-window`.
The launched process was independently matched to its PID, profile, and control
port; headless mode, no DISPLAY, and retained sandbox/shared-memory flags were
verified before opening ChatGPT once.

The source's viewport comment concerns local sidebar-based login classification.
It does **not** explain Cloudflare's rejection. The corrected trial still saw a
protection page, so this experiment does not establish its cause or a workaround.
No user-agent change, fingerprint patch, alternate proxy, challenge interaction,
cookie/token extraction, or hidden endpoint was used.

## Account-free method

Source checkout: `ee74d7d4523c8fdacbe2ab384351230b84efde06`; installed image
implementation: `fd85d377f7977da8a50f534a1f2beaa94efb7169`; package `0.40.18`.
Both targets reported Chromium `152.0.7977.82`, protocol `1.3`.

Each observation used a separate `--rm --init --network none --read-only`
container, UID 1000, no capabilities, the existing seccomp profile, and
`no-new-privileges`. Limits were two CPUs, 2 GiB memory, 1 GiB shared memory,
and separate 256 MiB tmpfs mounts for `/tmp` and `/home/node`. No real profile,
host directory, published port, or network access was available to these trials.
The direct Chromium executable and image ID were pinned per target.

Inside each container, the existing smoke command was one of:

```sh
node /app/scripts/browser-launch-smoke.mjs
xvfb-run -a -s '-screen 0 1440x900x24 -nolisten tcp' node /app/scripts/browser-launch-smoke.mjs --headed
```

The wrapper removed inherited DISPLAY/XAUTHORITY/WAYLAND_DISPLAY before launch;
`xvfb-run` established its own isolated display for the virtual case. The order
on each target was headless, virtual, virtual, headless, headless, virtual.
Each smoke checked actual process mode, Runtime and DOM control, keyboard/mouse
input, a synthetic file selection, same-profile restart with a synthetic local
marker, and owned-browser/fixture cleanup. All 12 runs passed every assertion.
These are local fixture operations, not ChatGPT requests or real login tests.

The measurement wrapper sampled cgroup memory every 50 ms and read the cgroup CPU
counter before/after the child. Elapsed time covers the **whole smoke**, including
two browser launches and cleanup, not just startup; Docker/VM startup is excluded.
Working set is `memory.current - memory.stat.inactive_file`, not browser-only RSS.
CPU time includes the sampler and, in virtual mode, Xvfb.

## Observations

Median of three samples per cell:

| Target | Mode | Whole smoke | CPU time | Sampled peak working set |
| --- | --- | --- | --- | --- |
| WSL x64 | Native headless | 2.307 s | 3.721 s | 216.3 MiB |
| WSL x64 | Xvfb virtual display | 2.569 s | 4.385 s | 309.4 MiB |
| M3 ARM64 Linux VM | Native headless | 1.639 s | 1.694 s | 272.6 MiB |
| M3 ARM64 Linux VM | Xvfb virtual display | 1.697 s | 1.823 s | 312.3 MiB |

The observed headless memory reduction was approximately 30% on WSL and 13% on
M3. Whole-smoke time was approximately 10% and 3% shorter, respectively.

Limitations matter: only three observations per mode; first-run/cache charging
and host scheduling were not controlled; actual content viewports were not
normalized beyond the existing mode defaults. The virtual smoke includes Xvfb
but not the full noVNC/x11vnc service. Fifty-millisecond sampling can miss peaks.
Do not infer production savings, actual Pro answer latency, reliability, or
cross-machine hardware rankings from this small functional workload.

## Authenticated result and restoration

Before the transition, WSL had zero MCP processes and zero running bridge tasks;
the shared send lock was available. Only its dedicated container was stopped.
The trial used the same named home volume and hostname after verifying that no
other running container held the volume. No profile or credential was copied.

The native-builder headless process started successfully. Its **first** status
read after the one public navigation reported:

```json
{"reachable":true,"loggedInLikely":false,"hasComposer":false,"blocker":"cloudflare_check"}
```

Automation stopped immediately: zero prompts, zero Pro answers, no retry or
challenge handling. The owned browser closed and the temporary container was
removed. The restoration handler restarted the original virtual-display service
and opened at most one missing ChatGPT tab inside it, not on the host desktop:

```json
{"reachable":true,"loggedInLikely":true,"hasComposer":true,"blocker":null}
```

Final WSL state was `running healthy`, started `2026-09-17T04:36:34.956128153Z`.
The viewer password's inode, size, mode, and modification time were unchanged;
its contents were not read. The user's existing SSH viewer tunnel remained alive.
All 12 disposable benchmark containers and the authenticated trial container were
confirmed absent. No host browser or current Codex session was restarted.

M3's original service was not stopped: it remains healthy with start time
`2026-09-17T03:11:22.942538376Z`. Its account-free benchmark is not an authenticated
M3 Pro pass; the separate first-login requirement is unchanged.

## Verification and decision

- PASS: `npm test -- tests/container-client.test.ts tests/container-browser-config.test.ts tests/container-browser-service.test.ts` (35 tests) before extending the prior work.
- PASS: syntax checks for the temporary measurement/native-trial Node scripts and shell restoration wrapper.
- PASS: 12 actual architecture-native, network-isolated browser smoke runs.
- BLOCKED: the corrected headless ChatGPT access check (expected exit 2), zero sends.
- PASS: retained WSL login/composer after restoration, unchanged password metadata,
  healthy services, live existing SSH tunnel, and disposable-container cleanup.

Pure headless remains a credible lighter-weight **experimental mode**, not a
verified signed-in ChatGPT Pro backend. The current default stays on the mode
with actual Pro response/continuation evidence. No product code, installed image,
MCP configuration, browser default, npm package, or release tag changed in this
comparison. The evidence and changelog are committed on the existing branch.
