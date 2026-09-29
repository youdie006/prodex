# Headless method research: 2026-09-16

## Scope and conclusion

Research requested after the same signed-in M3 browser profile reached a usable
composer while headed, then a Cloudflare challenge with navigation HTTP 403 after
an authorized switch to actual headless Chrome. The [recorded local observation](https://github.com/youdie006/prodex/pull/7#issuecomment-5690516717)
is not an authentication expiry diagnosis. This research made no new account
requests, browser transitions, installations, or client restarts.

Sources are public GitHub implementation, issues including closing comments,
maintainer validation records, and firsthand Reddit reports. Official product
documentation was excluded as requested. Source inspection is not a live test.

**Finding:** no independently reproducible source found here establishes sustained
ordinary true-headless ChatGPT Pro access on M3 or WSL. This does not prove it is
universally impossible. There are useful implementations that keep a normal
browser alive while its interface is not on the user's desktop. They are different
runtime modes, not proof of a true-headless fix or guaranteed service access.

**Research priority:** investigate preserving one browser runtime from manual
authentication through consultation, without a headed-to-headless relaunch.
For consistent M3/WSL deployment, a single-user Linux virtual desktop in a
multi-architecture container is a candidate. For a smaller local change, retaining
the existing ordinary browser is simpler. An embedded Electron browser is another
reference, but introduces a desktop application and a larger maintenance surface.
These were proposals at the initial research stage. The subsequent opt-in
[container experiment](container-browser.md) has account-free WSL/M3 validation;
it remains virtual-display Chromium, not verified live Pro access. The follow-up
[candidate audit](headless-candidates-audit.md) checks actual headless modes,
Pro-selection/continuation weaknesses, and the limits of the Windows report.

## Definitions and evidence levels

| Term | Meaning here | What it does not establish |
| --- | --- | --- |
| True headless | Browser actually launched in headless mode | A saved preference or hidden window is insufficient |
| Background headed | Ordinary browser remains running with its UI hidden/minimized | No-display operation on a server |
| Virtual desktop | Ordinary browser draws into a dedicated Linux display, optionally viewed remotely | Native macOS headless Chromium |
| Embedded browser | Application owns Chromium views and their persistent session | An independent Chrome window or headless engine |
| Code verified | The pinned source implements a path | That ChatGPT accepts it today |
| Maintainer reported | Upstream recorded an account-bound test | Independent replication or all-platform success |
| Locally measured | ProDex's recorded account/runtime observation | Results on another OS or browser mode |

## Original reuse candidates revisited

- **CodexPro is a different direction of bridge.** At `587f7fd3a4644a847bba13aeb49336056052e1f6`,
  [its HTTP implementation](https://github.com/rebel0789/codexpro/blob/587f7fd3a4644a847bba13aeb49336056052e1f6/src/http.ts#L1558-L1613)
  manages MCP sessions, expiry, and bounded transport count. It is not a ChatGPT
  browser engine that provides headless authentication or selects/captures Pro
  responses. Its MCP plumbing cannot repair ProDex's browser-side 403.
- **Oracle distinguishes headless from hidden headed.** At `1866b14624db124b50226d3018b4f429d31308d4`,
  [its launch code](https://github.com/steipete/oracle/blob/1866b14624db124b50226d3018b4f429d31308d4/src/browser/chromeLifecycle.ts#L1178-L1185)
  treats them separately and notes macOS hidden-window rendering/input problems.
  Its [preserved-error classifier](https://github.com/steipete/oracle/blob/1866b14624db124b50226d3018b4f429d31308d4/src/browser/index.ts#L174-L185)
  excludes headless runs from that recovery path. This is not proof that Oracle
  can clear the present challenge. Model evidence, answer completion, and shared
  tab ownership are useful references; its entire launch/security/auth stack is
  not approved for copying.
- **codex-chatgpt-control attaches to an existing provider.** At `8704430a5d3f76d281a06acae8e8236b4ede441a`,
  [attachment](https://github.com/adamallcock/codex-chatgpt-control/blob/8704430a5d3f76d281a06acae8e8236b4ede441a/packages/node/src/browser/attach.ts#L27-L87)
  resolves a supplied browser/extension and checks page state. It does not solve
  browser launch or cross-mode login persistence. An extension can reduce profile
  transfer and lifecycle problems, but still needs its ordinary browser running.

## Stronger new references

### Persistent embedded browser: codex-chatgpt-web

Examined `miuuyy/codex-chatgpt-web` at
`e85e3693fdb4e3e033348c08df0298c20fcdb612`.

- A [persistent Electron partition](https://github.com/miuuyy/codex-chatgpt-web/blob/e85e3693fdb4e3e033348c08df0298c20fcdb612/launcher/electron/profile.cjs#L15-L41)
  owns browser state. Task views share that partition, retain separate task
  identities, and [disable background throttling while working](https://github.com/miuuyy/codex-chatgpt-web/blob/e85e3693fdb4e3e033348c08df0298c20fcdb612/launcher/electron/browser-host.cjs#L532-L553).
- [Closing the window can hide it instead of quitting](https://github.com/miuuyy/codex-chatgpt-web/blob/e85e3693fdb4e3e033348c08df0298c20fcdb612/launcher/electron/main.cjs#L357-L361),
  conditional on the keep-running setting and a tray. Active views need explicit
  [nonzero rendering bounds](https://github.com/miuuyy/codex-chatgpt-web/blob/e85e3693fdb4e3e033348c08df0298c20fcdb612/launcher/electron/browser-host.cjs#L1413-L1477).
  This is background headed operation, not true headless.
- The [release validation record](https://github.com/miuuyy/codex-chatgpt-web/blob/e85e3693fdb4e3e033348c08df0298c20fcdb612/docs/release-validation.md#L47-L65)
  reports real Windows 11 Pro turns, continuation, cancellation, and session reuse
  on 2026-08-22. It lists macOS and Linux acceptance gates separately; those lists
  are not records that every gate passed on M3 or WSL.
- Whole-project adoption is inappropriate. In particular, its optional
  [passkey session import path](https://github.com/miuuyy/codex-chatgpt-web/blob/e85e3693fdb4e3e033348c08df0298c20fcdb612/launcher/electron/browser-host.cjs#L2468-L2496)
  transfers authentication state; ProDex must not copy that path. Its Codex-native
  model routing is also outside the current consult-bridge change.

**Potential reuse:** stable session ownership, background rendering tests, explicit
close-versus-quit behavior, and task-bound view leases. No need to require the user
to use the Codex desktop app; this would be a separate ProDex browser host.

### Persistent Linux desktop: GPT-Pro-Cloud

Examined `JingxuanKang/GPT-Pro-Cloud` at
`3543704a52361cc5cd33277dd4ec7d61e6c168d9`.

- The [desktop image](https://github.com/JingxuanKang/GPT-Pro-Cloud/blob/3543704a52361cc5cd33277dd4ec7d61e6c168d9/docker/Dockerfile#L1-L43)
  uses KasmVNC's Linux desktop base. Its [launcher](https://github.com/JingxuanKang/GPT-Pro-Cloud/blob/3543704a52361cc5cd33277dd4ec7d61e6c168d9/docker/autostart#L94-L124)
  starts ordinary Chromium with a persistent profile. It is not headless Chromium.
- The [build workflow](https://github.com/JingxuanKang/GPT-Pro-Cloud/blob/3543704a52361cc5cd33277dd4ec7d61e6c168d9/.github/workflows/docker-publish.yml#L60-L70)
  targets both `linux/amd64` and `linux/arm64`.
  [Run 32589110040](https://github.com/JingxuanKang/GPT-Pro-Cloud/actions/runs/32589110040)
  and both image-build jobs report success. This is stronger than a README's
  architecture claim, but not a real M3 login, sustained session, or Pro-answer test.
- Do not install its full account-sharing gateway. The [Compose defaults](https://github.com/JingxuanKang/GPT-Pro-Cloud/blob/3543704a52361cc5cd33277dd4ec7d61e6c168d9/docker-compose.yml#L29-L55)
  expose a gateway on all interfaces by default and mount the Docker socket.
  Those are unnecessary authority and exposure for a personal local bridge.
- Do not copy its launch/security defaults, unconditional profile-lock removal,
  or [container identity adjustments](https://github.com/JingxuanKang/GPT-Pro-Cloud/blob/3543704a52361cc5cd33277dd4ec7d61e6c168d9/docker/identity.sh#L1-L24).
  Browser-version pinning also needs a security-update policy, not indefinite use
  of an old browser to preserve compatibility.

**Potential reuse:** the lifecycle and packaging pattern only. A ProDex-owned
single-user sandbox could keep its browser and profile together, expose only a
protected local control channel, and allow a user-requested view of that same
desktop for manual authentication. Closing the viewer would not stop the browser.
Starting a new container browser requires its own manual login; do not copy the
existing macOS/Windows authentication profile. Containerization does not remove
Cloudflare challenges, network failures, service limits, or session expiry.

### True-headless claims with important qualifications

| Repository / inspected revision | What the evidence actually says | Decision |
| --- | --- | --- |
| [Draivix/chatgpt-gateway](https://github.com/Draivix/chatgpt-gateway/tree/e9b3f6a4e984409d5bd09f0d0eb1544c0c366e31/camoufox-gateway) `e9b3f6a` | Claims Pro via headless Camoufox; macOS explicitly untested; automated login/IMAP and anti-detection stack | Not an ordinary-Chrome solution; do not adopt auth/evasion paths |
| [chatgpt-pro-web](https://github.com/yudduy/chatgpt-pro-web/blob/98db2abb0c5d96ff12d80764109d6bc9c2b60247/cli.js#L1-L58) `98db2ab` | Optional headless flag, but source defaults to headed and warns that headless may be blocked | Flag existence is not a successful headless test |
| [chatgpt-background-mcp](https://github.com/29988122/chatgpt-background-mcp/blob/3f1390835cc898b0fb0f7e8c2f5b5747e7d7dba8/README.md) `3f13908` | Headless-first with visible recovery; archived 2026-07-13 and explicitly declared no longer usable/maintained | Not a maintained fix; resumable pending-work concept remains relevant |
| [mcp-camoufox](https://github.com/agelyhq/mcp-camoufox) (README checked 2026-09-16) | Its `virtual` setting is headed Firefox on Xvfb, Linux only; an anti-detect browser | Neither native Mac headless proof nor an acceptable bypass dependency |

The Draivix implementation has [separate new-job and continuation queues](https://github.com/Draivix/chatgpt-gateway/blob/e9b3f6a4e984409d5bd09f0d0eb1544c0c366e31/camoufox-gateway/src/cgw/daemon.py#L34-L70),
with continuation assigned to worker zero. It is not simply a single-tab serial
daemon. ProDex should retain explicit conversation identity rather than infer that
the last worker-zero chat belongs to the requesting task.

The small chatgpt-pro-web implementation also reads authentication cookies and
uses [private endpoints for conversation renaming](https://github.com/yudduy/chatgpt-pro-web/blob/98db2abb0c5d96ff12d80764109d6bc9c2b60247/cli.js#L222-L237).
It is not suitable for wholesale reuse under this repository's boundaries.

## Upstream bugs: read the resolution, not only the title

### Playwright #31736: the useful fix is already present

The initial report describes macOS cookie differences between headed and headless
Playwright 1.45.0. Later keychain advice did not work for the reporter. Their
[final successful workaround](https://github.com/microsoft/playwright/issues/31736#issuecomment-2244453197)
was `--headless=new`. ProDex already uses that flag in
[chatgpt-browser.ts](../src/chatgpt-browser.ts). Removing a mock-keychain flag from
ProDex is not a new fix: its ordinary raw launch does not add one. This issue is
not a ChatGPT Pro test or proof that changing keychain settings repairs HTTP 403.

### Playwright #35466: a surviving browser, not established corruption

The macOS ARM report initially called the symptom profile corruption. A contributor
[traced it to the first browser process remaining alive](https://github.com/microsoft/playwright/issues/35466#issuecomment-2774805112)
after its context/window closed. The [follow-up recommends graceful browser shutdown](https://github.com/microsoft/playwright/issues/35466#issuecomment-2775824152).
The reporter closed the issue saying they would try it, without a final successful
cookie test. Do not promote the opening diagnosis to confirmed engine corruption.

ProDex's [handoff checks](../src/browser-handoff.ts) already require exact profile
ownership and sustained browser/process shutdown before replacement. This remains
an important regression invariant, not evidence for deleting live lock files or
restarting the user's browser again.

## Reddit evidence and its limits

Posts were read as firsthand reports, not platform guarantees. Dates are omitted
where the public page exposed only a relative age.

| Report | What it supports | What is missing |
| --- | --- | --- |
| [Ubuntu VPS browser automation](https://www.reddit.com/r/ClaudeCode/comments/1w8p921/how_to_do_browser_automation_with_mobile/) | Persistent-profile Playwright attempt still reached ChatGPT 403/challenge | Not WSL; no successful Pro answer |
| [Cloudflare blocking automated ChatGPT](https://www.reddit.com/r/webscraping/comments/1lacz78/cloudflare_blocking_browserautomated_chatgpt_with/) | Firsthand failed headed/headless attempts | OS/reproducible working alternative; bypass suggestions excluded |
| [Visible ChatGPT access](https://www.reddit.com/r/codex/comments/1t989ze/access_to_chatgpt/) | User reports manual login and project-chat work in a visible browser | Not true headless or explicit Pro-model evidence |
| [Codex-native ChatGPT Web showcase](https://www.reddit.com/r/codex/comments/1vbtuaj/i_made_chatgpt_web_including_pro_a_native_model/) | Builder reports visible browser integration | Self-promotion, not independent headless validation; newer source takes precedence |
| ["We're so back" discussion](https://www.reddit.com/r/codex/comments/1ut5v2i/were_so_back/) | A commenter says ChatGPT Pro runs headless | No browser/version/mode proof; surrounding text also discusses Codex CLI model routing, so even the transport is ambiguous |

A successful ordinary-browser anecdote does not prove the corresponding headless
setup. Conversely, one failed VPS attempt does not prove every home-network setup
fails. Neither a Pro subscription nor an answer saying "I am Pro" establishes the
selected web model. ProDex should keep UI model selection, request identity, and
new-answer attribution as separate evidence.

## Proposed comparison, not an implementation decision

| Candidate | Fit for the user | New costs / limits | Priority |
| --- | --- | --- | --- |
| Keep the existing ordinary browser running | Smallest change; preserves its current runtime | A desktop runtime remains necessary; user must accept background headed mode | First if background headed is acceptable |
| Dedicated Linux container desktop on each machine | Same browser-host architecture on M3 and WSL; viewer can disconnect | ARM64/AMD64 images, VM resources, display/control security, separate manual setup per host | First experiment for cross-OS consistency |
| ProDex-owned embedded browser | Integrated setup and close-to-background behavior | Electron packaging, updates, OS authentication compatibility, rendering/sleep tests | Later if a desktop companion is desired |
| Ordinary true headless | Closest to strict no-display requirement | Current M3 403 remains unresolved; no new demonstrated fix found | Keep explicit/experimental; no automatic recovery loop |

For any candidate, the useful combination is ProDex's existing task/receipt bus,
request identity and send locking, plus stable browser ownership. Replacing the
consult bridge with a whole account gateway is not necessary. A shared browser
does not imply that concurrent callers may write to the same conversation.

### Bounded acceptance gates for a later authorized experiment

1. Start account-free, in a disposable sandbox: verify real rendering, input,
   DOM/CDP access, persistent synthetic state, graceful shutdown and no host window.
   Test both architectures natively; a multi-arch image build is insufficient.
2. Test two clients, exact tab/conversation ownership, cancellation, disconnects,
   restart, duplicate-send prevention, and viewer-close versus browser-quit.
3. Only after the runtime passes, request one manual sign-in inside that dedicated
   runtime. Do not extract/import credentials or switch browser modes afterwards.
4. Make one explicitly authorized Pro request with unique request identity, then
   one same-thread continuation. Record visible model selection and actual new
   answer attribution, not the model's self-description.
5. Record behavior after client reconnection and a later browser restart separately.
   Stop on login, protection, permission, or rate-limit prompts. No automatic
   challenge handling, stealth changes, proxy rotation, or repeated resubmission.
6. Publish per-platform results and remaining failures. Do not label CI, packaging,
   or a synthetic local marker as a successful ChatGPT Pro login.

## Research verification and publication scope

- Public source was retrieved read-only with GitHub's API; JSON/base64 content was
  decoded in memory, and relevant files were inspected at the pinned commits.
- GitHub issue closing comments were fetched through `gh api` because page
  extraction omitted them. The #31736 and #35466 conclusions above use those
  comments, not just search summaries.
- The GPT-Pro-Cloud workflow and run/job conclusions were checked separately.
- Documentation checks passed: `git diff --check` and an in-memory Node link
  audit parsed 33 links, fetched 16 pinned source files for 19 source citations,
  validated their line anchors, checked two local targets, and checked ASCII.
  Runtime tests/builds were not rerun for this documentation-only change.
- Reddit page text was accessible; Reddit JSON endpoints were unavailable to one
  research worker. No authenticated Reddit or ChatGPT browser was used.
- Runtime source, dependencies, login profiles, MCP configuration, and installed
  versions are unchanged. No new live Pro test or release is claimed.
- This document and its changelog entry are research records, not approval to
  relax strict-headless settings. No third-party code was imported. License
  metadata alone is not a dependency/license or security audit.
