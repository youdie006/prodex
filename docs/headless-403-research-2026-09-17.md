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

Preserve the existing authenticated runtime. Do not import cookies, disguise
browser identity, rotate proxies, automate a challenge, or open another login
window based on a 403. There is no demonstrated new re-login requirement here.

## Verification and publication scope

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
