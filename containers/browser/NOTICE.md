# Third-party attribution

`seccomp.json` is based on Playwright's Docker seccomp profile:

- Source: https://github.com/microsoft/playwright/blob/18205280b6112a4a08238195942c4fa30c199a62/utils/docker/seccomp_profile.json
- Revision: `18205280b6112a4a08238195942c4fa30c199a62`
- License: Apache-2.0, included in `LICENSE.playwright`
- Retrieved: 2026-09-16
- Local modification: allow `chroot` alongside the upstream namespace syscalls.
  With all container capabilities dropped, Chromium's sandbox otherwise fails
  its own user-namespace `chroot` initialization. The kernel still checks the
  capability in that namespace; no capability is added to the container.

The profile retains a deny-by-default syscall filter while allowing user namespace
creation needed by Chromium's sandbox. This is not an unconfined/privileged
container. Revalidate on Docker, kernel, and browser upgrades; do not silently
disable the browser sandbox when a host cannot support it.

The image installs Debian Chromium, Xvfb, xauth, x11vnc, noVNC, websockify, and fonts
from the distribution, retaining their package copyright/license records. They
are not relicensed by the ProDex MIT license. No image is published by this
experimental change.
