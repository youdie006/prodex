# Separate-load Ozone comparison: 2026-09-27

## Result

The corrected offline matrix completed sixteen valid input trials: four on
each architecture without load and four with a separate rendering container.
All inputs and cleanup checks passed. The classification remains
`INCONCLUSIVE_NON_REPRODUCTION`, not a demonstrated fix for the earlier
intermittent M3 keyboard failure.

This experiment uses ordinary stock Chrome with `--ozone-platform=headless`,
not the browser `--headless` switch. No public navigation, ChatGPT login,
account profile, protection bypass or production backend migration occurred.
It does not resolve the separately observed pure-headless HTTP 403 challenge.

## Method

The target now runs the bounded order `cold-A`, `cold-B`, `restart-B`,
`restart-A`. A retains immediate DOM focus followed by keyboard input; B adds
one ordinary input click and an observed focus barrier. Both retain passive
events, document identity and CDP command timing. `PRODEX_FOCUS_TRIAL` can
select exactly one member; an invalid or empty selector is an error.

The former target-internal second browser has been removed. A separate
`load-hold.mjs` creates only an ephemeral loopback canvas fixture. It emits
`READY` only after observing advancing frames and validating the actual browser
process. A bounded hold defaults to 90 seconds and accepts at most 180. After
SIGTERM or the deadline it checks motion again on the same existing page,
revalidates process ownership and version, and closes its owned browser.
Target output explicitly cannot attest external load by itself.

The coordinator observed `READY` before starting each loaded matrix, confirmed
the load container still ran when the target finished, requested graceful
termination, and required the final motion and cleanup evidence. Both load
containers still advanced by sixteen frames during their final two samples.
The WSL hold lasted 23,377.718 ms; the M3 hold lasted 7,139.204 ms.

Each container retained these independent limits and boundaries:

```text
--init --network none --read-only --user 1000:1000 --cap-drop ALL
--security-opt no-new-privileges:true --security-opt seccomp=<existing policy>
--pids-limit 256 --memory 2g --cpus 2 --shm-size 1g
--tmpfs /tmp:rw,nosuid,nodev,mode=1777,size=256m
HOME=/tmp PRODEX_CHROME=/opt/prodex-ozone/chrome PRODEX_NO_AUTO_LOGIN=1
```

There were no mounts or published ports. `DISPLAY`, `XAUTHORITY` and
`WAYLAND_DISPLAY` were unset. The measured browser retained its sandbox,
unmodified identity, existing graphics flags and stock executable. The target
and load have separate 256-PID budgets; the limit was not raised to make a
shared-container test pass. All measured PID-limit event counters and OOM
kill counters remained zero. Before/after PID snapshots are not peak counts.

## Failed Preflight

The first M3 isolated attempt inherited read-only `HOME=/home/node` and exited
with SIGTRAP before CDP readiness. Zero input trials were valid; the remaining
three stopped. This failure is preserved as `INVALID_INFRASTRUCTURE`.

A bounded, account-free diagnostic of the same launcher captured
`chrome_crashpad_handler: --database is required`. Changing only the disposable
home to the already-writable `/tmp` allowed the diagnostic browser to remain
running until graceful termination. The corrected matrix used that ephemeral
home on both targets. No account directory was made writable or copied, and no
Crashpad, sandbox or protection flag was disabled. Ordinary EGL/X-display
initialization warnings still occurred; no forced graphics fallback was added.

## Measurements

| Target | Condition | UTC interval | Valid / planned | Input | Cleanup |
| --- | --- | --- | --- | --- | --- |
| WSL x64 | Isolated | 15:09:59-15:10:33 | 4 / 4 | All pass | Confirmed |
| WSL x64 | Separate load | 15:11:40-15:12:10 | 4 / 4 | All pass | Confirmed |
| M3 Linux ARM64 | Isolated | 15:11:12-15:11:16 | 4 / 4 | All pass | Confirmed |
| M3 Linux ARM64 | Separate load | 15:11:58-15:12:08 | 4 / 4 | All pass | Confirmed |

All intervals are September 27 UTC, September 28 locally in Korea. M3 means
the Linux ARM64 container on the M3 host, not native macOS Chrome.

Images add only the four experimental JavaScript files to the previously
measured stock Chrome 154.0.8037.57 image:

- WSL base: `sha256:76d110f5a1e9a0ac76c2c9f34c39c49a2d5376486f850d20c988edd5767271fc`.
- WSL tested: `sha256:24122d091bc8843224297c2c5c386c1d58180ecdb3c0124d7e6f479561b18edc`.
- M3 base: `sha256:463fd52c8cc6f3a5ee46313d7e767709bb46117a2bb925c1754bef172e6927fa`.
- M3 tested: `sha256:386a863977148a77147dc8cbc0c6ce2bed8f41b0eed9d0b0a652d9eed0b395e9`.

[Machine-readable evidence](experiments/ozone-2026-09-26/separate-load-evidence.json)
contains source hashes, the failed first attempt, event/command traces, resource
snapshots, load continuity and container-removal receipts. All owned experiment
containers were removed, independently confirmed by Docker on both hosts.

## Verification And Delivery

- PASS: `npx vitest run docs/experiments/ozone-2026-09-26/*.test.mjs`,
  four files and twelve tests after the final load-continuity change.
- PASS: `node --check` for each experiment JavaScript file; `git diff --check`.
- PASS: the sixteen local input trials and both load continuity/cleanup gates.
- FAIL, retained: initial read-only-home startup, zero valid input trials.
- NOT TESTED: public ChatGPT admission, authentication, Pro access and native
  Windows/macOS execution for this experimental backend.

Publication is source/evidence on `feat/headless-browser-compatibility` and
[PR 7](https://github.com/youdie006/prodex/pull/7), plus local disposable research
images. No release tag, npm publication, registry image or supported launch-mode
change is implied. The ordinary service adapter deployment is recorded
[separately](selector-ready-deployment-2026-09-27.md).
