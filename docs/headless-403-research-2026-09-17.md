# Headless HTTP 403: GitHub and Reddit evidence

Date: 2026-09-17. Research only, following the stock Chrome comparison.
Official product documentation was excluded. No upstream package was installed
or executed, and no new ChatGPT navigation, login, prompt, or browser transition
was attempted. This is not a fix, release, or installed-runtime update.

## Conclusion

The evidence supports investigating a browser-context-dependent protection
decision, not assuming that the saved ChatGPT login expired. It does not identify
the exact server-side rule, establish an IP ban, or prove that ordinary headless
Chrome can never work. A successful page navigation is also not a verified Pro
answer or sustained reliability result.

Our [stock Chrome observations](stock-chrome-comparison-2026-09-17.md) include
actual document HTTP 403, an interstitial title, and no composer in fresh anonymous
profiles on both architectures. That is not merely our classifier reporting a
block. The virtual-display controls timed out without a preserved navigation
phase, so they cannot isolate mode as the cause. Two architectures do not establish
two independent public network exits.

The probe did not retain response headers. Its `cloudflare_check` label is a local
interpretation of the interstitial-like page, not a captured server explanation.
The actual 403 is confirmed; the exact protection mechanism is not.

The earlier [same-profile comparison](headless-mode-comparison-2026-09-17.md)
reported a headless protection page and restored the authenticated virtual-display
composer without re-login. This weakens an expired-login explanation but is not
a controlled identification of the protection rule. It used Chromium 152, not
the fresh-profile Chrome 153 setup.

## GitHub findings

### A directly relevant failure report, with weaker success verification

At `guberm/chatgpt-web-provider` revision
`e18fc0da7f60dd2c22af80d4b4cae64aa5ef7b81` (2026-07-28), the author
[reports](https://github.com/guberm/chatgpt-web-provider/blob/e18fc0da7f60dd2c22af80d4b4cae64aa5ef7b81/README.md#L356-L376)
headless Chromium stopping at the protection page while headed operation returned
answers. This resembles our symptom but is an operator report, not an independent
WSL/M3 acceptance test.

The [implementation](https://github.com/guberm/chatgpt-web-provider/blob/e18fc0da7f60dd2c22af80d4b4cae64aa5ef7b81/src/chatgpt_web_provider/backends.py)
does use a persistent browser context. However, it modifies an automation-related
launch setting, its health hint tests only the title, and failed model selection
can still return the requested model name. Do not treat its output label as Pro
verification or copy its launch/authentication behavior wholesale.

### A useful investigation that retracted its IP-only diagnosis

At `stufently/gpt-web-gateway` revision
`efb01a32e9e4c7fbebb8acff204c8c2a448c476c` (2026-08-19), a
[July 26 investigation and correction](https://github.com/stufently/gpt-web-gateway/blob/efb01a32e9e4c7fbebb8acff204c8c2a448c476c/docs/2026-07-26-cloudflare-block-fingerprint-vs-egress.md)
first blamed network egress, then retracted that conclusion after recording
different outcomes from the same exit. Its reported headless passes used an
evasion stack, not unmodified Chrome; the probes were not committed. This is
useful evidence against an overconfident IP diagnosis, not a reproduced fix.

The [July 29 follow-up](https://github.com/stufently/gpt-web-gateway/blob/efb01a32e9e4c7fbebb8acff204c8c2a448c476c/docs/2026-07-29-patchright-compat-probe.md)
records a July 27 move to headed Chrome under Xvfb. The pinned
[Dockerfile](https://github.com/stufently/gpt-web-gateway/blob/efb01a32e9e4c7fbebb8acff204c8c2a448c476c/Dockerfile)
confirms `HEADLESS=false` and a virtual display. Its newer configuration is not
proof of a pure-headless solution. Its automated challenge handling, evasion,
credential handling, and retry policy are outside ProDex's boundaries.

### A real false positive that does not explain our measured 403

[Oracle issue 79](https://github.com/steipete/oracle/issues/79) contains several
different symptoms. A
[July 10 firsthand report](https://github.com/steipete/oracle/issues/79#issuecomment-4933423794)
describes a normal signed-in composer incorrectly classified as a challenge
because a passive protection script existed. Another user reports a local
classifier correction helped. Read the comments, not just the opening title.

This supports requiring independent page evidence. It does not explain our
document-level 403 plus missing composer. Our sidebar-label correction and the
remote access refusal remain separate problems.

### Browser mode is relevant, not a universal guarantee

[Playwright CLI issue 318](https://github.com/microsoft/playwright-cli/issues/318)
(2026-03-25) describes ChatGPT work on Apple Silicon using headed Chrome 146 and
requests a less disruptive window. The maintainer later recommends headless
generally but provides no ChatGPT-specific successful reproduction in the
[closing comment](https://github.com/microsoft/playwright-cli/issues/318#issuecomment-4159179362).
Neither side establishes a universal headless verdict.

[Puppeteer issue 11046](https://github.com/puppeteer/puppeteer/issues/11046)
(2023-09-27) reports a challenge loop even with headed Google Chrome on another
site. It was marked not reproducible and closed without a product fix. This old,
different-site report is only a caution against assuming headed always passes.

## Reddit findings

Original post text was inspected, not just search snippets or suggested tools.
The public pages expose relative ages; exact dates are not inferred from them.

- [Headless initially worked, then browsing answers degraded](https://www.reddit.com/r/ChatGPT/comments/1iaparc/shadowbanned_in_chatgpt/):
  the author reports a headless browser plus proxies and later loss of ChatGPT's
  web-search behavior. No browser version, HTTP status, or causal test is given.
  This is an anecdotal success claim, not verified ordinary-headless Pro access
  or evidence of a shadow ban. It cannot explain our pre-login document 403.
- [Multiple automation tools stopped at the protection page](https://www.reddit.com/r/webscraping/comments/1hs7333):
  the author reports Selenium, Puppeteer, and Playwright attempts stuck before
  the UI loaded. The mode, browser version, and HTTP status are not specified.
  This corroborates the symptom, not an isolated headless cause.
- [Playwright ChatGPT UI requests were blocked](https://www.reddit.com/r/ChatGPT/comments/1nurfs1/simulating_queries_on_the_chatgpt_ui/):
  the original report describes frontend automation failure but omits mode and
  status. Promotional replies and unsupported explanations about mouse timing
  are not treated as findings.

The first two posts have the same author and are not independent replications.
These reports do not establish that headless always fails or provide a reproducible
ordinary-Chrome solution for our two targets. The older
[Reddit source audit](headless-methods-research.md#reddit-evidence-and-its-limits)
also includes an Ubuntu VPS post whose technical diagnosis is pasted agent output,
not a completed headed-versus-headless experiment. Do not count it as independent
proof of the exact cause.

## Deeper measurement audit

The follow-up inspected the actual stock-Chrome probe and replayed its response
callback offline. The reviewed temporary `public-probe.mjs` has SHA-256
`8b06e83b13a1882f88ab6d36ea7e7a32f1833565a884cae2d5a44d7bcb639fa6`.
This is the later instrumented file, not a claim that its added phase logging
existed during the original public trials.

### Confirmed observer limitations

The callback accepts any `Document` response with the exact root URL. It does not
associate the response with a main frame, navigation request, or loader. Replaying
the actual callback extracted through the TypeScript parser produced these
sequential results without launching a browser or making a network request:

| Synthetic event | Stored status after event | Meaning |
| --- | --- | --- |
| Main-frame root document, 403 | 403 | Exact-root failure is recorded |
| Main-frame query-string document, 200 | 403 | Changed URL is ignored |
| Child-frame root document, 200 | 200 | Another frame can overwrite the value |
| Root URL with resource type `Fetch`, 500 | 200 | Non-document response is ignored |

These are reproduced measurement limitations, not evidence that a child frame
actually contaminated the earlier trial. The recorded 403 and separate blocked
DOM remain evidence of that observation. What is missing is a complete,
navigation-bound response history, not proof that no refusal occurred.

<details>
<summary>Offline replay of the audited callback</summary>

The callback below is copied from the audited source. All URLs and events are
synthetic data; this program has no browser or network operations.

```javascript
import assert from "node:assert/strict";

let publicHttpStatus = null;
const receive = r => {
  if (r.method !== "Network.responseReceived" || r.params?.type !== "Document") return;
  const response = r.params.response;
  if (response?.url === "https://chatgpt.com/") publicHttpStatus = response.status;
};
function feed(url, status, frameId = "main", loaderId = "first", type = "Document") {
  receive({
    method: "Network.responseReceived",
    params: { type, frameId, loaderId, response: { url, status } }
  });
  return publicHttpStatus;
}

assert.equal(feed("https://chatgpt.com/", 403), 403);
assert.equal(feed("https://chatgpt.com/?challenge=synthetic", 200), 403);
assert.equal(feed("https://chatgpt.com/", 200, "child", "other"), 200);
assert.equal(feed("https://chatgpt.com/", 500, "main", "later", "Fetch"), 200);
console.log("PASS: four offline observer assertions; no browser or network");
```

</details>

### Upstream implementations show the missing associations

At Puppeteer revision `abdc0785df19f5f4a7e935d0eb4757cf260758ab`,
[LifecycleWatcher](https://github.com/puppeteer/puppeteer/blob/abdc0785df19f5f4a7e935d0eb4757cf260758ab/packages/puppeteer-core/src/cdp/LifecycleWatcher.ts#L157-L198)
filters navigation requests by frame and responses by request ID. Its
[Frame navigation](https://github.com/puppeteer/puppeteer/blob/abdc0785df19f5f4a7e935d0eb4757cf260758ab/packages/puppeteer-core/src/cdp/Frame.ts#L172-L227)
also tracks loader identity and treats an HTTP error response separately from a
protocol-command failure. Its
[navigation tests](https://github.com/puppeteer/puppeteer/blob/abdc0785df19f5f4a7e935d0eb4757cf260758ab/test/src/navigation.test.ts#L363-L406)
cover HTTP errors and the final redirect response. Playwright's
[network manager](https://github.com/microsoft/playwright/blob/f1ea64bd00626329fe981e31ca4db4726eda50a3/packages/playwright-core/src/server/chromium/crNetworkManager.ts#L435-L467)
likewise associates response handling with a tracked request.
These are inspected source contracts, not upstream tests run here or a proposed
library swap that would cure 403.

### Timing and navigation are not equivalent to production

- The probe visits `chrome://sandbox/` and then the public page using raw
  `Page.navigate` on the same target, with a 10-second command timeout. Its public
  response observer is enabled only after the sandbox inspection. Production
  [navigation helpers](../src/chatgpt-browser.ts) use guarded in-tab navigation;
  recovery code even records a historical `Page.navigate` crash. This difference
  is worth controlling, but is not proof of the cause of either timeout or 403.
- The report is assembled only after all status reads succeed. A later command
  failure can lose earlier observations. The original virtual-display timeout
  does not identify which navigation failed; newer phase logs cannot fill it in.
- The successful measurement path waits three seconds before a status snapshot.
  `dom_complete: true` describes the observed document, not authentication,
  challenge completion, a Pro answer, or long-term availability. Likewise,
  `public_navigations: 1` counts a command, not every HTTP redirect or request.
- The four extra background-network/extension/ping/media-router flags match the
  [container service launch plan](../containers/browser/service.mjs). They are
  not an experiment-only difference from that baseline. No evidence justifies
  removing these restrictions as a fix.

## Runtime.enable hypothesis, checked against the tested version

`Runtime.enable` reporting console arguments is real, but the familiar explanation
that it necessarily invokes a custom `Error.stack` getter is version-sensitive.
It cannot be carried forward unchanged as the cause of our 403.

1. V8's [May 7, 2025 change](https://github.com/v8/v8/commit/e08e97347454255a337dcea361808fb25ca09077)
   added guarded error-property reads to avoid executing user getters during
   inspector previews. It includes a regression test that enables the runtime,
   logs error objects, and expects the custom stack getters not to run.
2. The tested Chrome version's
   [Chromium 153.0.8010.47 dependency file](https://github.com/chromium/chromium/blob/153.0.8010.47/DEPS#L344)
   pins V8 `6b96683d44174e78ff4e65cb274bad56dc108231`. At that exact revision,
   [getErrorProperty and descriptionForError](https://github.com/v8/v8/blob/6b96683d44174e78ff4e65cb274bad56dc108231/src/inspector/value-mirror.cc#L262-L350)
   contain the guard, including rejection of bound-function and proxy getters as
   builtins. The [upstream expected test results](https://github.com/v8/v8/blob/6b96683d44174e78ff4e65cb274bad56dc108231/test/inspector/runtime/error-preview-sideeffects-expected.txt)
   record no getter calls in these cases. These source/test artifacts were read,
   not executed against our browser binaries.
3. Current V8 still [reports cached console messages when enabling the runtime](https://github.com/v8/v8/blob/e320cd8db5c93a37d29bf69a37fba10065245e79/src/inspector/v8-runtime-agent-impl.cc#L1126-L1156)
   and [wraps console arguments](https://github.com/v8/v8/blob/e320cd8db5c93a37d29bf69a37fba10065245e79/src/inspector/v8-console-message.cc#L258-L315).
   That describes a conditional inspector operation, not a site-specific server
   refusal or a guarantee that every possible side effect is gone.
4. Puppeteer's [page initialization](https://github.com/puppeteer/puppeteer/blob/abdc0785df19f5f4a7e935d0eb4757cf260758ab/packages/puppeteer-core/src/cdp/FrameManager.ts#L229-L247)
   sends `Runtime.enable` without selecting a different path for headless mode.
   Our two local probe modes also use it. Its presence alone does not separate
   those modes; the inconclusive virtual public control cannot supply a causal
   comparison.

Conclusion: neither removing `Runtime.enable` nor switching to a patched
automation stack is justified as a demonstrated 403 fix. This source audit does
not establish that CDP is unobservable or that headless access must work. The
earlier local `Runtime.enable` protocol error and an HTTP 403 are different
failure layers; no evidence here proves a common cause.

## Deeper success-claim audit

The follow-up checked implementation and commit-level verification claims, not
just whether a repository advertises a headless option.

| Candidate and pinned revision | Strongest inspected evidence | Limit for ProDex |
| --- | --- | --- |
| `Draivix/chatgpt-gateway`, `e9b3f6a` | Real Camoufox headless launch path; separate maintainer reports of live Pro indicator selection and continuation | Different browser stack with behavior/identity customization; no linked ordinary-Chrome WSL/M3 Pro-plus-continuation acceptance artifact |
| `yudduy/chatgpt-pro-web`, `98db2ab` | Headless option exists, but README explicitly advises against it for ChatGPT | Requested model URL and latest-answer extraction do not establish actual Pro selection or headless success |
| `Goudu666/chatgpt-web-mcp`, `4a87c7` | Pro routing checks and continuation code; offline CI | Model self-description is used as identity evidence; not live headless Pro verification |

Draivix's [launch code](https://github.com/Draivix/chatgpt-gateway/blob/e9b3f6a4e984409d5bd09f0d0eb1544c0c366e31/camoufox-gateway/src/cgw/browser.py#L66-L79)
and [daemon](https://github.com/Draivix/chatgpt-gateway/blob/e9b3f6a4e984409d5bd09f0d0eb1544c0c366e31/camoufox-gateway/src/cgw/daemon.py#L220-L229)
establish a genuine headless path, not proof that the reported live checks used
that mode. The [June 27 commit](https://github.com/Draivix/chatgpt-gateway/commit/38cc048d12b32507792242ec7ae1383855817519)
reports a corrected Pro effort indicator, and the
[June 30 commit](https://github.com/Draivix/chatgpt-gateway/commit/78f4c205ae966564fabb46395652e5c99bb1d202)
reports live continuation and instance isolation. These are meaningful author
reports, but they do not jointly pin mode, platform, and returned Pro output.
Its [continuation branch](https://github.com/Draivix/chatgpt-gateway/blob/e9b3f6a4e984409d5bd09f0d0eb1544c0c366e31/camoufox-gateway/src/cgw/chat.py#L553-L596)
can start a fresh chat after a missing-composer timeout while still labeling the
result `continue`. ProDex must not adopt that silent context-loss fallback.

Yudduy's [README](https://github.com/yudduy/chatgpt-pro-web/blob/98db2abb0c5d96ff12d80764109d6bc9c2b60247/README.md#L45-L56)
is a negative operator report, not a universal browser rule. Its
[request/answer flow](https://github.com/yudduy/chatgpt-pro-web/blob/98db2abb0c5d96ff12d80764109d6bc9c2b60247/cli.js#L166-L251)
does not supply the missing Pro verification.

Goudu666's [identity probe](https://github.com/Goudu666/chatgpt-web-mcp/blob/4a87c728bacbadc4ff05cdffa061eb5cf3265e49/src/browser.js#L2734-L2814)
classifies the assistant's answer about its own identity. Its
[CI](https://github.com/Goudu666/chatgpt-web-mcp/blob/4a87c728bacbadc4ff05cdffa061eb5cf3265e49/.github/workflows/ci.yml)
is offline. [Open PR 2](https://github.com/Goudu666/chatgpt-web-mcp/pull/2)
explicitly proposes replacing self-report with response metadata; it remained
unmerged when inspected. This corroborates the verification gap, not a tested
fix. Its private-response inspection is not adopted by ProDex.

The newly inspected firsthand
[Reddit launcher report](https://www.reddit.com/r/codex/comments/1vbtuaj/i_made_chatgpt_web_including_pro_a_native_model/)
claims Windows/macOS end-to-end use but explicitly says the transport is visible
browser automation; Linux is CI-only in that post. Continuing a Codex task also
does not, by itself, prove reuse of the same ChatGPT conversation. This is useful
positive evidence for a different operating mode, not pure-headless acceptance.

None of these inspected sources jointly verifies ordinary pure-headless Chrome,
the intended Pro selection, completed output, and exact-thread continuation on
our targets. That is a limit of the evidence found, not proof of impossibility.

## Diagnostic priorities

1. Preserve the failing navigation phase and partial observations even when a
   CDP command times out. Separate local sandbox navigation from the public
   document. Test this instrumentation with local fixtures first; increasing the
   timeout alone does not identify the failure.
2. On a separately authorized future normal navigation, retain only allowlisted
   response diagnostics, such as status, content type, protection-indicator
   header, and a redacted support correlation identifier. Do not collect cookies,
   authorization, all headers, raw challenge URLs, or response bodies. Missing
   diagnostics stay unknown, not inferred.
3. Keep executable/version, actual launch mode, profile provenance, target identity,
   and observation time explicit. Do not combine anonymous-profile results with
   authenticated-profile results or raw HTTP/private API failures with browser
   navigation. Stop at a protection page; this research does not authorize retries.
4. Replace URL-only experiment accounting with frame/request/loader association,
   bounded event timing, and a preserved partial result. Offline fixtures should
   cover redirects, child frames, HTTP errors, and protocol timeouts before any
   future public comparison. A stored status must identify its observation,
   rather than silently adopting another document's response.

Preserve the existing authenticated runtime. Do not import cookies, disguise
browser identity, rotate proxies, automate a challenge, or open another login
window based on a 403. There is no demonstrated new re-login requirement here.

## Verification and publication scope

### Initial research pass

- Public issues, comments, and pinned source files were read through web search
  and GitHub's read-only API. Some pinned pages were unavailable to the web reader;
  their complete source was retrieved successfully through `gh api` instead.
- Local comparison Markdown and JSON were reviewed without running their online
  probe scripts. Upstream experiments are attributed reports, not local passes.
- PASS: `git diff --cached --check` and a Node assertion check of the research
  document's ASCII text, 13 GitHub/Reddit links, three existing local link targets,
  and changelog backlink. This checks document structure, not browser access.
- Documentation-only update; no application tests, live browser tests, package
  installation, account operations, npm publication, or release were performed.
- The accompanying changelog records the diagnostic distinction. The existing PR
  records this research commit and documentation verification separately from
  earlier implementation CI and installed-service acceptance.

### Deeper research pass

- PASS: `npm test -- tests/chatgpt-browser.test.ts tests/browser-launch-smoke-options.test.ts`
  completed with 166 passing tests across two files. This exercises the existing
  browser changes, not live ChatGPT access. No full-suite or build result is claimed.
- PASS: the actual temporary probe callback was extracted with the TypeScript
  parser and replayed in a Node VM with four synthetic assertions. The source
  SHA-256 is retained above; no upstream code was executed.
- PASS: the documented JavaScript replay was executed with four assertions. Its
  callback was compared with the audited source using the TypeScript parser and
  printer, with an exact match. A Node assertion check also verified ASCII text,
  35 GitHub/Reddit links, five existing local link targets, and the changelog
  backlink. `git diff --check` passed. These are offline evidence/structure checks,
  not a live browser acceptance result.
- GitHub commits/source and original Reddit post text were inspected. The web
  reader could not fetch some pinned GitHub pages; read-only `gh api` retrieval
  succeeded instead. No official product documentation was used.
- Research/documentation only. No new account access, public ChatGPT navigation,
  login, prompt, browser launch, service restart, package installation, release,
  or installed-runtime change occurred. The pre-existing untracked `Makefile`
  is outside this change.
