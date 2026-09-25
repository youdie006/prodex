# Pure-headless evidence follow-up

Date: 2026-09-26 (Asia/Seoul). Read-only upstream research and review of existing
ProDex evidence, following the user's request to look beyond the earlier search.
Official product documentation was excluded. No upstream software was installed
or executed, and no ChatGPT request, login, browser transition or service restart
was performed.

## Conclusion

There is a concrete upstream report of a headless ChatGPT answer, not just a
headless option in a README. Oracle PR 368 includes a completed answer and model
picker evidence. Its exact Chromium build and authentication preparation are not
disclosed, and the selected model is not Pro. This improves the evidence for
feasibility but is not a reproducible ProDex solution.[^oracle368]

The subsequent [eighteen-path options matrix](headless-options-matrix-2026-09-26.md)
adds independent engines, embedded hosts and runtime/authentication alternatives
to this response-evidence audit, with pinned source checks and investigation order.

Our measured result remains narrower: the September 23 stock Chrome 154
anonymous headless trials received correlated 307 -> 403 protection responses on
WSL and M3. The exact remote rule is unknown. Neither "headless is impossible"
nor "switching libraries fixes it" follows from these observations.

## Upstream evidence

| Source | What was actually found | What it does not establish |
| --- | --- | --- |
| Oracle PR 368, merged August 13 | Author-reported completed browser request, `headless: true`, `attachRunning: false`, selected GPT-5.6 Sol and an exact response marker | Stock-browser identity, authentication method, Pro response, continuation, or our independent reproduction |
| pi-oracle at `4d96ffc` | Headless default, direct headless launch code, Pro preset support, and a release note reporting live preset validation | A public artifact tying a Pro answer to observed headless process identity and a reproducible ordinary-browser setup |
| Reddit-linked browser-benchmarks at `2cc95c5` | Per-site public-page screenshot classifications, including ChatGPT | Logged-in composer readiness, selected Pro model, answer correctness, or thread continuity |
| Oracle issue 510 / PR 515, September 23-24 | Configured Chrome could differ from the persistent browser being reused; upstream added an explicit warning | A protection fix or a reproduced ProDex executable-selection bug |

### Oracle: a real response report with missing reproduction inputs

PR 368 repairs an ignored CLI flag: `buildBrowserConfig()` discarded the explicit
headless choice even though the launcher already supported it. The merge is
`3104799d84a3b991bacc03ca35e7996add281163`. The attached manual run reports a
completed GPT-5.6 Sol response in about 28 seconds, with UI model-selection
evidence. The browser path is redacted and no binary version/hash is provided.
Its configuration and terminal output are stronger than a feature claim, but
not an independently inspected process or a reproducible ordinary-Chrome Pro
acceptance record.[^oracle368]

Porting that flag repair is not a justified 403 fix: ProDex's existing smoke
already verifies actual pure-headless process mode. The useful next upstream
question is the successful run's browser build and permitted authentication
setup, not whether a headless flag exists. No upstream comment or request was
posted during this research.

### pi-oracle: actual headless implementation, different assumptions

Pinned revision: `4d96ffc076774215067b1571cf4e9d77d4fd1347` (September 21).
`config.ts` defaults to headless and a Pro preset. `run-job.mjs` directly launches
Chrome with the headless option unless headed mode was selected; this is not
merely a terminal application described as headless.[^pi-config][^pi-launch]

The same implementation imports browser cookies into a seed profile, clones that
profile per job, and changes automation-identification settings. Those are
material differences from ProDex's ordinary-browser investigation and are not
adopted under the project's current boundaries.[^pi-readme][^pi-config][^pi-worker]

The 0.7.15 changelog reports live validation of every canonical ChatGPT preset.
The proof checker requires completed persisted jobs, response markers and model
configuration logs. However, that checker does not require observed headless
process mode. The inspected tracked tree contains the checker, not its referenced
live job artifacts. Therefore the release claim must not be relabeled as a
publicly reproduced pure-headless Pro pass.[^pi-changelog][^pi-proof]

### Reddit: inspect the raw rows, not aggregate success rates

The benchmark author explicitly discloses ownership of one evaluated product.
The reported metric is page access judged from screenshots, with proxy/stealth
conditions that differ from our tests. It is not a ChatGPT answer benchmark.
The linked raw CSV contains 400 result rows.[^reddit-benchmark][^benchmark-readme]

For `https://chatgpt.com/`, the published CSV labels Playwright, Selenium,
Obscura and Hyperbrowser unsuccessful; it labels bro, Browserless, Browserbase,
Browser Use and Firecrawl successful. These are the authors' classifications,
not our image reclassification or verification of those services. They establish
neither a general stock-headless pass nor Pro acceptance.[^benchmark-results]

A separate firsthand ChatGPT automation report says both headful and headless
attempts were blocked. It supplies no controlled comparison or successful Pro
transcript. Its comments are suggestions, not verified fixes.[^reddit-chatgpt]

### New diagnostic lesson: configuration is not runtime identity

Oracle issue 510 describes a persistent Canary process reused after the user
configured stable Chrome. PR 515, merged as
`9c8684db43037069b412a52515e34f491f244a61`, adds reuse warnings while preserving
the shared browser's lifetime. It does not change browser discovery or resolve
headless protection.[^oracle510][^oracle515]

For ProDex, this supports recording requested executable, actual main process,
CDP version/revision and container/image identity together. It does not justify
killing the working browser or assuming the same bug exists locally.

## What our experiments identify

| Variable | Existing evidence | Remaining limit |
| --- | --- | --- |
| Headless launch/control | Actual mode, local DOM/input and sandbox checks passed on both targets | Browser mechanics are not remote authorization |
| Chrome 154 public response | Two confirmed anonymous main-document 307 -> 403 protection responses | Exact server rule, IP effect and authenticated behavior unidentified |
| Same-build public headed control | September 23 headed tests were offline only | No Chrome 154 public headed outcome; Chrome 153 headed timeouts were inconclusive |
| Saved authentication | September 17 WSL trial reused the same volume/hostname, then restored the signed-in headed composer | Headless was challenged before authenticated readiness; this was not merely a fresh-profile experiment |
| Version comparison | Browser/image/source hashes recorded | Chrome 153 versus 154 also changed the product build, so browser version was not the only variable |
| Runtime/network identity | Container architecture, browser version and process mode recorded | No fully joined requested/observed executable record or controlled host-direct/egress comparison |

Sources: [Chrome 154 trial](stock-chrome-154-trial-2026-09-23.md),
[machine-readable observations](stock-chrome-154-trial-2026-09-23.json),
[Chrome 153 comparison](stock-chrome-comparison-2026-09-17.md), and
[same-profile trial and restoration](headless-mode-comparison-2026-09-17.md#authenticated-result-and-restoration).

Do not explain every failure as a missing login: the earlier same-profile trial
also stopped at a protection page. Conversely, reusing the profile does not prove
that the refused request reached authenticated ChatGPT. Both limits matter.

## Next decision

Keep the [parallel investigation gates](headless-parallel-track-2026-09-23.md)
and the working virtual-display service unchanged. The highest-value missing
inputs are the successful upstream binary/authentication conditions and a
same-build, same-network public headed control. The latter is a future scoped
experiment, not permission to retry blocked access now. Before any later
comparison, also pin product build and viewport and record actual runtime identity.

Any candidate still needs saved-session readiness, a verified Pro answer,
exact-thread continuation through an independent client, trusted receipts and
cleanup on each claimed platform. A homepage screenshot or configuration field
cannot replace those gates. No stealth changes, protection solving, profile or
cookie copying, automatic retries, or authentication resets were introduced.

## Verification and publication

- PASS: branch/worktree inspection and `git fetch origin`; the user's untracked
  `Makefile` was not read, changed or staged.
- PASS: primary GitHub PR/issue bodies, pinned source files and benchmark CSVs
  retrieved through `gh api`; CSV rows parsed with Python's standard `csv`
  module, not guessed from aggregate percentages.
- PASS: independent read-only review of the existing local trial evidence;
  no new browser, service, account or M3 command was needed.
- WARN: the web fetcher could not open Oracle PR 368 (cache miss); `gh api`
  returned the PR body and merge metadata. Reddit pages were readable.
- PASS: all six native jobs in [CI run 35820519708](https://github.com/youdie006/prodex/actions/runs/35820519708)
  completed successfully for the preceding source commit
  `5be698a8e61bc9b6fa438624bfceb7c5896e7674`: Ubuntu Node 20/22/24, macOS ARM/Intel
  Node 22, and Windows Node 22. This is not new authenticated headless acceptance,
  and it does not explain the earlier Ubuntu CDP-start timeout.
- This update is documentation only. Local document checks and source push/CI
  status are recorded in [PR 7](https://github.com/youdie006/prodex/pull/7).
  Full application tests were not rerun locally for this research record.
  No release tag, npm/image publication, installation, MCP reconnect or runtime
  readiness refresh is claimed. Existing READY observations retain their dates.

[^oracle368]: [Oracle PR 368](https://github.com/steipete/oracle/pull/368).
[^pi-config]: [pi-oracle config](https://github.com/fitchmultz/pi-oracle/blob/4d96ffc076774215067b1571cf4e9d77d4fd1347/extensions/oracle/lib/config.ts#L453-L471).
[^pi-launch]: [pi-oracle direct headless launch](https://github.com/fitchmultz/pi-oracle/blob/4d96ffc076774215067b1571cf4e9d77d4fd1347/extensions/oracle/worker/run-job.mjs#L643-L680).
[^pi-worker]: [pi-oracle worker](https://github.com/fitchmultz/pi-oracle/blob/4d96ffc076774215067b1571cf4e9d77d4fd1347/extensions/oracle/worker/run-job.mjs#L316-L342).
[^pi-readme]: [pi-oracle authentication description](https://github.com/fitchmultz/pi-oracle/blob/4d96ffc076774215067b1571cf4e9d77d4fd1347/README.md#L90-L96).
[^pi-changelog]: [pi-oracle 0.7.15 validation](https://github.com/fitchmultz/pi-oracle/blob/4d96ffc076774215067b1571cf4e9d77d4fd1347/CHANGELOG.md#L50-L62).
[^pi-proof]: [pi-oracle preset proof checker](https://github.com/fitchmultz/pi-oracle/blob/4d96ffc076774215067b1571cf4e9d77d4fd1347/scripts/oracle-chatgpt-preset-proof.mjs#L140-L220).
[^reddit-benchmark]: [Benchmark author's Reddit post](https://www.reddit.com/r/OpenAI/comments/1w1gv6j/i_spent_200_benchmarking_9_cloud_browsers_against/).
[^benchmark-readme]: [Pinned benchmark methodology](https://github.com/jsonifyco/browser-benchmarks/blob/2cc95c5b02ed6b3ece98b0e8f681e8ea5f430566/README.md#L30-L39).
[^benchmark-results]: [Pinned per-site results CSV](https://github.com/jsonifyco/browser-benchmarks/blob/2cc95c5b02ed6b3ece98b0e8f681e8ea5f430566/official_results/v1/results.csv).
[^reddit-chatgpt]: [Firsthand ChatGPT automation blocker report](https://www.reddit.com/r/webscraping/comments/1lacz78/cloudflare_blocking_browserautomated_chatgpt_with/).
[^oracle510]: [Oracle issue 510](https://github.com/steipete/oracle/issues/510).
[^oracle515]: [Oracle PR 515](https://github.com/steipete/oracle/pull/515).
