# Pro-assisted Ozone no-display experiment

Date: 2026-09-26 (Asia/Seoul). Source baseline:
`309376440a1f492c0b4fc4f53723621ebdb5829c` on
`feat/headless-browser-compatibility`.

## Decision

**A new no-external-display candidate runs on both Linux targets, but is not
promoted.** Stock full Chrome can use `--ozone-platform=headless` without Xvfb
or `--headless`. WSL's local workflow passes. M3's first keyboard check failed;
an instrumented run and an unchanged isolated repeat passed. This is an
unresolved intermittent failure, not a repaired or reliably passing workflow.

No candidate ChatGPT navigation, login, prompt, production-profile switch or
protection retry has been performed in this investigation. This does not change
the earlier [browser-headless protection result](headless-paired-control-2026-09-26.md).

| Target | Full local workflow | Separate initial/restart render checks |
| --- | --- | --- |
| WSL Linux x64 | Original smoke passes | Both pass |
| M3 Colima Linux ARM64 | Original fails keyboard; instrumented and unchanged repeat pass | Both pass |

The [JSON evidence](ozone-headless-trial-2026-09-26.json) retains the failure,
executable hashes, process flags, realized dimensions and screenshot hashes.
It contains no account data or private conversation URL.
The later [focus evidence](experiments/ozone-2026-09-26/focus-evidence.json)
records an invalid resource-constrained A/B matrix, not an input comparison.

## Why this candidate is distinct

The pinned Chromium source distinguishes the browser mode from its display
backend. `IsHeadlessMode()` checks the `--headless` switch; explicit Ozone
selection bypasses the default X11/Wayland choice. The Ozone headless platform
creates its own window/screen objects and a minimal input method. It does not
provide a system input injector; this alone does not decide whether CDP input
works, which must be tested separately.

Primary GitHub source, checked through the GitHub contents API:

- [Browser-mode check](https://github.com/chromium/chromium/blob/154.0.8037.57/chrome/browser/headless/headless_mode_util.cc#L19-L25).
- [Linux platform selection](https://github.com/chromium/chromium/blob/154.0.8037.57/ui/linux/display_server_utils.cc#L50-L87).
- [Ozone window, screen and input implementation](https://github.com/chromium/chromium/blob/154.0.8037.57/ui/ozone/platform/headless/ozone_platform_headless.cc#L55-L108).

These are source-level architectural evidence, not a claim that the vendor
binary's complete build configuration matches an independently reproduced build.
Actual launch and functionality were measured with the pinned binaries below.
No third-party source was copied into the bridge.

| Arrangement | Browser `--headless` | External display server |
| --- | --- | --- |
| Earlier pure browser-headless tests | Present | None |
| This Ozone experiment | Absent | None |
| Installed Xvfb services | Absent | Xvfb |

The existing smoke truthfully reports `headed_process: true` for Ozone because
it checks the browser-mode switch. Do not reinterpret that field as proof of a
display connection, or label this candidate `--headless=new`. Production mode
checks and defaults are unchanged.

## Consultation and runtime identity

One real ProDex consultation requested a falsifiable next experiment, not
stealth flags or another identical public retry. It exceeded its five-minute
wait. `pro_recover` recovered the original request without resending and verified
request identity. A separate same-thread check against the actual host browser
confirmed the topic marker and rendered model slug `gpt-6-pro`.

Local receipts: `task_20260926_022438_gpt-pro-consult` (timeout) and
`task_20260926_023153_gpt-pro-consult-recovered` (verified answer). Recovered
artifact SHA-256:
`24ab1d3832a41d8ff82770af1b975cae3c9f48cd741f262bfb0a5474f3b63c40`.
The full prompt/answer remains private in `.bridge`, not in this document.

Important correction: the already-attached MCP reports version 0.40.16 and uses
the host's headed Chrome `144.0.7559.132`. It is not either installed 0.40.18
Chromium 152 container. The initial prompt mistakenly attributed the consult
to the operating container; the follow-up explicitly corrected that attribution.
An attempted model-only recovery in the wrong container refused the request
identity and supplied no answer; it is not evidence of concurrent-session
interference. No client, browser or account was restarted to change this.

Pro proposed this stock Ozone experiment and an independent local
navigation/focus investigation. Its suggestions were treated as advice and
checked against source and measurements, not as permission to change security
boundaries or declare success. The pinned same-thread follow-up completed as
`task_20260926_024501_gpt-pro-consult`, with exact request verification,
`model_used: gpt-6-pro` and `pro_verified: true`, without warnings. It used this
checkout's 0.40.18 CLI and the same host browser; the older MCP was not restarted.

The follow-up recommends deferring even the WSL public-root check until the
local input instability is understood. Its next experiment compares immediate
input with an observed focus barrier after one ordinary local input click.
Both arms keep passive event traces; a passing repeat is not a correction.
This is independent of the earlier 403 cause and does not claim focus readiness
would change remote admission.

## Isolation and measured behavior

- WSL base image:
  `sha256:e3e3b7c886e1f37c08c97956604977f3d41d132f080eaaf01513e023ae37e7b9`.
- M3 base image:
  `sha256:7741e053af2b9336b458049b31ba3a5f004a3034bae0fba42f9223a7d1ece5e9`.
- Both contain stock full Chrome `154.0.8037.57` and the September 23 smoke
  build. WSL mounted only the experimental launcher/probe read-only. M3 added
  only those files in a disposable local image; its Chrome hash stayed unchanged.
- Every execution used `--network none`, fresh temporary profiles, read-only
  root, UID 1000, dropped capabilities, no-new-privileges, the existing seccomp
  policy, 2 CPUs, 2 GiB RAM, 1 GiB shared memory and a 256-PID limit.
- No production volume, host display socket, viewer or published port was used.
  DISPLAY, XAUTHORITY and WAYLAND_DISPLAY were unset at browser launch. The
  render probe checked those keys on the actual process, not the environment
  inherited by a later `docker exec` process.
- Initial and restarted processes used the stock executable and the Ozone flag,
  lacked `--headless` and `--no-sandbox`, retained NoNewPrivs=1 and CapEff=0, and
  had no observed display server or X11/Wayland socket in the container.
- Both render passes on both architectures yielded content 1440x757, outer
  window 1440x900, screen 1x1, DPR 1 and visible document state. Our launcher
  and probe add no overrides for user agent, client hints, navigator or graphics
  properties. This statement describes the reviewed experiment inputs, not a
  claim that the geometry probe attests every internal browser property.
- Both canvas samples matched the expected red/green pixels. All four PNGs
  were 15,667 bytes with identical SHA-256; WSL initial/restart and M3 initial
  screenshots were visually inspected and nonblank. This is synthetic 2D
  rendering evidence, not a complete graphics or ChatGPT acceptance test.
- Initial WSL preflight logged EGL/X-display initialization errors, then the
  browser selected software rendering itself. No graphics fallback flags were
  added. Browser-generated GPU fallback is not silently reported as hardware
  acceleration.

## M3 input failure

The first full M3 smoke, while its separate render probe also ran, exited 1:
`CDP keyboard input did not update the loopback fixture`. No public phase exists
in that command, and the disposable container was removed.

The observational patch adds event/readiness logging only. It recorded
`activeElement=keyboard` but `document.hasFocus()=false` immediately after
`DOM.focus`. After key down/up, focus was true, the value was `k`, and focus,
keydown, beforeinput, input and keyup events were present. That run passed all
remaining checks. A subsequent original, unmodified isolated smoke also passed.

Additional observation changes timing, and the failing run did not record the
same focus trace. Neither the logger nor the unchanged repeat establishes a
fix. Load, focus ordering and backend input handling remain possible causes.
No fixed sleep, foreground activation or production input change was applied.

## Bounded focus comparison and resource failure

Following the second Pro answer, the probe predeclared eight counterbalanced
A/B pairs per architecture: cold/restarted profile, isolated/render load, two
repeats per cell. A keeps immediate DOM.focus followed by key down/up; B adds
one ordinary input click and an event-driven focus barrier. Both retain passive
event traces, request timings and document identity. No public site is involved.

Both architectures passed only the first cold/isolated A/B pair. WSL's third
attempt failed at Page.enable before any input; M3's failed during prime-browser
cleanup. Later attempts mostly could not inspect processes. Each command exited
1. The original summary incorrectly called 16 attempts "measuredTrials";
there were only **two completed input measurements per target**. The record
preserves that original summary alongside corrected classification. No loaded
A/B comparison or focus-fix conclusion is valid.

This load generator used two browsers inside one container, unlike the original
separate-container concurrency. A separate bounded about:blank preflight
confirmed both targets exhausted the shared 256-task cgroup limit:

| Target | pids.current / pids.max | pids.events max | Memory use / limit | OOM kills |
| --- | --- | --- | --- | --- |
| WSL | 256 / 256 | 44 | 462,340,096 / 2,147,483,648 bytes | 0 |
| M3 | 256 / 256 | 11 | 444,887,040 / 2,147,483,648 bytes | 0 |

The WSL preflight exited 0 because its final counter snapshot was not evaluated
by that diagnostic; it is explicitly **not a pass**. M3 exited 1. These counters
establish a harness resource failure, not the cause of the original isolated
keyboard failure or a remote 403. Limits were not raised. Cleanup inside the
matrix could not always be verified; subsequent Docker inspection confirmed
all owned disposable containers were removed on both hosts.

The recorded runner now stops on infrastructure/cleanup failure, captures
cgroup counters without spawning another process, and distinguishes planned,
attempted and valid input trials. Its classification tests pass, including
incomplete matrices and missing traces. This correction has not been used for
another live matrix; existing result rows belong to the earlier runner.

The next meaningful comparison needs separately bounded load and target
containers, matching the original topology and preserving each browser's PID
budget. Repeating the exhausted shared-container matrix or sending a candidate
ChatGPT request would not answer the unresolved local input question.

## Reproduction materials

[Experimental files](experiments/ozone-2026-09-26/) are container-only research
artifacts, not supported product commands. Keep the existing sandbox, use a
network-disabled disposable container, and never mount an account profile.
Use an outer `timeout -k 10 120` for smoke/render (300 seconds for the archived
focus matrix); container removal bounds cleanup even if the
probe cannot close Chrome. The render probe itself checks graceful owned-process
exit after both stages. It refuses an existing profile directory, non-loopback
network interfaces or inherited display variables before launching. Its security
booleans record successfully asserted process/socket conditions, not configured
preferences.

The `chrome` wrapper adds only the display-backend/window-size selection. Run
the existing `/app/scripts/browser-launch-smoke.mjs --headed` with
`PRODEX_CHROME=/opt/prodex-ozone/chrome`, then the separate `render-probe.mjs`.
The optional `input-observation.patch` applies to the baseline smoke; it is not
an input correction. The render probe emits base64 PNGs only from its synthetic
data page; the durable JSON record omits those payloads.

Final freshness-guarded render probes passed initial/restart checks on both
architectures with graceful cleanup. The checked render source SHA-256 is
`24a9cb1a773906562821b28e5ee75358477bf076fdd371f43207a2bd71c8f912`.
The tested images were WSL
`sha256:76d110f5a1e9a0ac76c2c9f34c39c49a2d5376486f850d20c988edd5767271fc`
and M3
`sha256:463fd52c8cc6f3a5ee46313d7e767709bb46117a2bb925c1754bef172e6927fa`.
Docker inspection confirmed each retains every base layer, adds only three
research-file layers, and preserves User, Env, Entrypoint and Cmd. The later
focus fail-stop helper is source-only and is not in those tested images.

M3 setup initially failed because its Colima VM does not mount the chosen host
path. Docker copy into a read-only root was rejected, and copying to tmpfs left
the wrapper unexecutable because `/tmp` is `noexec`. These were harness-delivery
failures before Chrome launch. They were resolved by adding the research files
to an image layer, not by relaxing root or tmpfs security. That helper container
was stopped and removed. No account browser was involved.
The final WSL render command initially named a nonexistent `/app/scripts/`
path and exited before browser launch; correcting it to the Dockerfile's
`/opt/prodex-ozone/render-probe.mjs` passed without changing the probe.

## Verification and delivery

- PASS: prior behavioral change re-exercised before this investigation:
  `npx vitest run tests/background-login.test.ts tests/window-mode-lifecycle.test.ts tests/cli-pro-browser-login-wait.test.ts`
  (99 tests, three files).
- PASS: WSL original smoke, M3 instrumented and unchanged repeated smoke,
  and initial/restart rendering/security evidence on both targets.
- FAIL: M3 first original smoke keyboard check. It remains part of acceptance,
  not a discarded run. Public and authenticated candidate checks are not run.
- PASS: `node --check` on the experimental render and input-observation scripts.
- PASS: the initial helper version passed three `node --test` checks;
  `node --check` passes on the focus runner. The helper tests first failed
  before implementation. The file now uses the repository's Vitest runner so
  full-suite discovery also runs these checks instead of reporting no suite.
- PASS: replaying both saved logs through the corrected fail-stop classifier
  stops at attempt three, reports two valid input trials and thirteen unrun
  trials, and classifies each replay as INVALID_INFRASTRUCTURE. This is a
  diagnostic replay, not a fresh browser run.
- FAIL: both live focus matrices and their resource preflight interpretation;
  neither is accepted as a candidate input failure or success.
- PASS: all six native/Node jobs for source baseline `3093764` in
  [CI run 36211265141](https://github.com/youdie006/prodex/actions/runs/36211265141).
  These results belong to the prior source correction, not Ozone product support.

No production backend, package version, launch mode or installed service is
changed by the Ozone work. A separate [transcript parser correction](fallback-transcript-2026-09-26.md)
was discovered during read-only operating-browser inspection and is included
as a source fix, not an installed service update. There is no release tag, npm
publication or image-registry publication. Local experimental images are not deployments.
Source/evidence publication belongs to [PR 7](https://github.com/youdie006/prodex/pull/7).
The user's untracked Makefile is untouched.
