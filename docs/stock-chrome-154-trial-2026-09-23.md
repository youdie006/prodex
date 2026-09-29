# Stock Chrome 154 parallel trial

Date: 2026-09-23 (Asia/Seoul). Execution of the approved
[parallel investigation](headless-parallel-track-2026-09-23.md), not a change to
the working WSL/M3 service or its saved authentication.

## Hypothesis and stop rule

The vendor's GitHub distribution metadata now lists Stable `154.0.8037.57`
instead of the previously tested `153.0.8010.47`. An ordinary browser update
could change compatibility; that is a changed candidate, not evidence that it
fixes ChatGPT protection. No fingerprint, user agent, proxy, sandbox-disable
flag, challenge interaction or authentication transfer is part of this trial.

First run local account-free checks with networking disabled. After these pass,
select exactly one anonymous public-root navigation in pure-headless mode on
each target, in a fresh disposable container. A protection response, HTTP error
or timeout ends that case with no retry, login or prompt. A completed 200 document
would advance only the anonymous document gate, not Pro or login acceptance.
Do not open a viewer or change the running browser to perform this experiment.

## Local results

| Candidate | Target | Pure headless | Xvfb headed |
| --- | --- | --- | --- |
| Chrome 153.0.8010.47 baseline | WSL Linux x64 | PASS | PASS |
| Chrome 153.0.8010.47 baseline | M3 Colima Linux ARM64 | PASS | PASS |
| Chrome 154.0.8037.57 candidate | WSL Linux x64 | PASS | PASS |
| Chrome 154.0.8037.57 candidate | M3 Colima Linux ARM64 | PASS | PASS |

All eight runs used `--network none`. Each proved actual main-process mode on
initial launch and restart, Runtime/DOM, keyboard/mouse, synthetic attachment,
same-profile synthetic marker reuse, correlated local 302 -> 200 navigation,
synthetic main-document 403 recognition, graceful close and cleanup. The local
403 was a test fixture, not a ChatGPT request. These are Linux runtime checks on
two architectures, not native Windows/macOS or authenticated Pro acceptance.

Within each architecture and version, the image and resource constraints were
identical. These are mode compatibility checks, not performance benchmarks or
strict viewport-controlled experiments: the existing launcher specifies
1440x900 only for headless, while Xvfb provides a 1440x900 display without fixing
the headed window size. No speed or protection-causality claim follows.

The 153 baseline retained the earlier test-image product build and current
diagnostic scripts. The 154 candidate overlaid a fresh `npm run build` from
source `618b3faed0ee533f11f60d62f4c4a62234fc131d`. A 153-versus-154 comparison is
therefore not a browser-version-only controlled experiment either.

## Artifact provenance

The [GitHub distribution metadata](https://api.github.com/repos/GoogleChromeLabs/chrome-for-testing/git/blobs/e4147f675d79321e4e0b1e3a7ed8b7a3141a31e9)
timestamp was `2026-09-22T23:18:23.201Z`;
its blob was `e4147f675d79321e4e0b1e3a7ed8b7a3141a31e9`. Only structured
distribution metadata and vendor archives were used, not official product
documentation or third-party evasion packages.

| Artifact | Measured archive SHA-256 |
| --- | --- |
| [Linux x64](https://storage.googleapis.com/chrome-for-testing-public/154.0.8037.57/linux64/chrome-linux64.zip) | `ceee2972074d441ea7c4ba8bcc0eaab77e7e87680f6653d73d3065851fe10302` |
| [Linux ARM64](https://storage.googleapis.com/chrome-for-testing-public/154.0.8037.57/linux-arm64/chrome-linux-arm64.zip) | `da83171e552650df34272a9c51f62182bae88d467d1ac19c92dd97917dfa0bca` |

Measured hashes establish local artifact identity, not independent publisher
signatures. Both archives were extracted without altering file contents and
copied with node ownership into disposable candidate images.

| Target | Candidate image ID | Chrome executable SHA-256 |
| --- | --- | --- |
| WSL | `sha256:e3e3b7c886e1f37c08c97956604977f3d41d132f080eaaf01513e023ae37e7b9` | `e528b77a8b250c48a5bbd7aeeabbc2813940c0a2fe39b1b11fbaf1f01fb04f18` |
| M3 | `sha256:7741e053af2b9336b458049b31ba3a5f004a3034bae0fba42f9223a7d1ece5e9` | `6a27f994cf8916471f61695e217824168167c506b595d2f1249540026d98aaa2` |

Sorted relative-path, size and SHA-256 manifest digests matched between the
extracted source artifacts and candidate images: 301 x64 browser files and 303
ARM64 browser files, with zero symlinks. Both images also matched the same 19
script files and 40 freshly built `dist` files. Directory-tree digests:

- x64 browser: `81b521c05f7779d90505c99f24cc7ad4bb50e8a84c6a486b0fb81d5ff5eed4b2`
- ARM64 browser: `0e4326854265090051cfae0461c715832dbf95b91d899a7c7e0fab0f265b4b5d`
- scripts: `6d950af0d94992964d4507cf57b2526f0c433d4dcc8ccbaf1609259afb0f0dfc`
- dist: `838170882bdd6e399f00c99e965cb0ea5cac18518d30aee25b0954764f8c6645`

The fresh `dist/chatgpt-browser.js` digest on the host and both candidates was
`775ff6b7551bf04554fbf7d6dae49636739937c45f636d83ea322e1023c8b4b0`.
These external checks address provenance missing from the smoke's own report;
CDP version text alone does not prove executable/build identity.

## Isolation

Trials use `--rm --init --read-only`, UID 1000, all capabilities dropped,
`no-new-privileges`, the existing Chromium-compatible seccomp profile, two CPUs,
2 GiB RAM, 1 GiB shared memory, 256 PIDs, and separate 256 MiB tmpfs mounts for
home and `/tmp`. No saved-profile volume or published port is present. Headless
runs unset DISPLAY, XAUTHORITY and WAYLAND_DISPLAY. Headed runs use Xvfb only;
no host window, VNC server or viewer is started. Each run has a 120-second outer
deadline with a 10-second termination grace; CDP commands have their own bounds.

The two 154 images are local experimental artifacts only. Their base image IDs
were pinned before building; an initial Dockerfile build incorrectly treated a
bare image ID as a registry repository and failed. A local tag bound to each
verified base ID resolved this, with the resolved digest present in build output.
The first M3 download command failed shell quoting before curl started; the
corrected HTTPS-only command succeeded. Neither failure was a ChatGPT request.

Four additional `--network none` checks used the earlier sandbox probe with
`--sandbox-only`. Chrome's internal `chrome://sandbox/` page reported PID/network
namespaces and Seccomp-BPF active in both modes on both targets, and the process
checks rejected `--no-sandbox`/`--disable-dev-shm-usage`. The probe adds
background-network/extension/ping/media-router suppression flags; these are
separate sandbox diagnostics, not the exact public-run command or proof of
identical viewport behavior. Each reported zero public navigations and prompts
and confirmed browser close. No sandbox disablement was needed.

## Public results and disposition

| Target | Actual browser mode | Public document | Result |
| --- | --- | --- | --- |
| WSL | Chrome 154.0.8037.57, pure headless | Correlated 307 -> 403, final challenge header | BLOCKED; exit 1 |
| M3 Linux VM | Chrome 154.0.8037.57, pure headless | Correlated 307 -> 403, final challenge header | BLOCKED; exit 1 |

Each selected run issued exactly one public `Page.navigate`, then closed the
browser and removed its disposable profile/container. The diagnostic reports
confirmed the redirect/main-document chain without truncation or transport
error. `documentLoaded` was false at the stop point. There were no retries,
login attempts, prompts, viewer windows, challenge interactions or authenticated
candidate tests. The allowlisted [JSON evidence](stock-chrome-154-trial-2026-09-23.json)
retains the reports and exit status instead of calling a measured block a pass.

This ordinary Stable update did not clear the anonymous headless access gate
on either tested target. It does not reveal the server's exact rule, prove that
all headless builds fail, or establish a bypass. No candidate was promoted.
The verified virtual-display operating path remains in place.

## Verification and deployment

- PASS: five existing diagnostic/compatibility test files, 73 tests, before the
  declaration correction; `npm run build` before building candidate images.
- PASS: final `CI=1 npm test` (130 files, 1,848 passed, 3 skipped),
  `npm run typecheck`, an independent TypeScript compiler check of the new
  mode fixture, and `git diff --check`. The new type regression first failed
  against the old declaration, then passed after the correction.
- PASS: eight offline compatibility runs, four additional sandbox checks, and
  source-to-image browser/scripts/dist content-manifest equality.
- BLOCKED: both selected public observations above exited 1 for an actual
  protection response. Cleanup passed; access did not.
- PASS: final `docker ps -a` on both targets found no trial containers. The
  installed WSL and M3 services retained the same container/image IDs, original
  September 17 start times and restart count zero; both helper statuses returned
  version 0.40.18, headed, healthy, reachable, READY and blocker null.
- The companion declaration correction distinguishes headed from headless
  evidence for TypeScript callers; it does not change browser runtime behavior
  or fix the observed 403. The compiler subprocess has its own bounded deadline.
  Source commit, push and native CI status are recorded in
  [PR 7](https://github.com/youdie006/prodex/pull/7); local Linux results are not
  substituted for native Windows/macOS CI results.
- Source/evidence publication is confined to `feat/headless-browser-compatibility`
  and PR 7. No default change, production installation, service restart, MCP
  reconnect, npm/image publication or release tag is part of this trial. Local
  `stock-chrome-154-0923-check` images are experimental, not deployed upgrades.
  The user's untracked `Makefile` remains untouched.
