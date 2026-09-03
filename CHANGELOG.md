# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).## 0.37.1

### Fixed
- `--effort` could not name Pro, the step it was meant to set. The picker's slider has five steps and prodex knew four names for them - measured at both ends of the live control, position 0 of 4 reads "Instant, 1 of 5" and position 4 reads "Pro, 5 of 5". The top was reachable only through `--model Pro`, which answered with a warning advising `--effort Pro`, and that command failed on the spot. Pro is now an effort value in the parser, its aliases, the menu labels, the saved-config schema and the usage lines, so `setup --clear-model --effort Pro` pins it with no warning on any send.
- The pinned-default check warned about settings it had no way to judge. `setup --effort Pro` reported that Pro "was not among what the picker listed" - about a value the very next send used to answer from gpt-5-6-pro - because the slider shows one step at a time and happened to be on Extra High. Values already known to be slider steps are exempt; anything unexpected is still named.

### Added
- Documentation for what 0.37.0 shipped. `pro report-issue` appeared in no help output at all, and the diagnostics variable and the watchdog script were mentioned nowhere. The README now covers reporting from a receipt, capturing the page, noticing a break before a person does, and what a temporary chat costs; the notes agents read at onboarding name the report command and the diagnostics variable.

## 0.37.0

### Added
- A repository bot, in three parts. `pro report-issue` builds a bug report from a blocked consult's receipt - blocker, version, platform, the next step it gave - and never carries the prompt, the answer or the summary; filing is `--confirm` only and goes through `gh`, so prodex stores no token. An issue-triage workflow labels a new issue and asks for exactly the repro fields it is missing. A PR first-pass workflow says what a change touches, whether it carries tests, and which paths deserve a careful read; it never approves. Filing is deduplicated by blocker code, so something that stays broken adds to one issue instead of opening another every run.
- `scripts/ui-watchdog.mjs` notices when ChatGPT's UI stops working, by sending a token and checking the reply rather than inspecting the picker's shape - shape is a proxy, and this project was bitten by a picker that looked right and could not be driven. It needs the logged-in browser, so it runs on a machine that has one, not in CI.
- `PRODEX_BROWSER_DIAGNOSTICS=1` leaves a screenshot and a shape snapshot behind when a send fails: roles, testids, rects, aria-value* and pointer-events for the picker and composer - the last two are what identified an inert row and an unreadable slider step. Captures stay local and are never attached to a report.
- `--temporary` sends into a ChatGPT Temporary Chat, which leaves the account's chat list byte-identical. It warns what that costs: the transcript API does not hold an unsaved chat, so the answer is read from the page, where tables and citation links can be lost, and it cannot be recovered later. It requires `--new-chat`, because a throwaway chat cannot be continued.
- `setup` now asks the picker whether it can provide the default being pinned. Pinning something it cannot is how prodex broke for someone else for weeks. It reports only what it saw: the effort slider shows one step at a time, and reading the others would mean moving it.

### Fixed
- A step the slider does not have warns instead of blocking the send, matching the rule the model path already followed. One account's picker has no "Pro" step at all, so a pinned default of model=Pro killed every plain send there.

## 0.36.5

### Fixed
- A model the picker cannot offer no longer kills the send. ChatGPT's picker stopped listing "Pro" as a model and made its remaining model rows inert (measured: `pointer-events: none`, and laid out outside the menu's own box, so no coordinate reaches them) - while `model=Pro` is the pinned default in every repo configured before that. The result was that a plain `prodex ask` failed in those repos every time, for a selection the UI no longer supports. `--model Pro` is now applied where Pro actually lives, the effort slider, and answers from `gpt-5-6-pro`; any other model the picker will not offer warns and the send proceeds with whatever the composer had. A menu that will not open, or a click that will not land, is still an error - only "this picker has no such thing" is not.
- `--effort` works again. The slider state was read by scanning for the line after "Model"/"Effort", which the current picker does not produce, so it returned nothing and the step walk could never match its own position. It now reads the checked model radio and the menu item that owns the slider: `--effort 즉시` / `중간` / `매우 높음` send and answer where they failed with "did not commit".

## 0.36.4

### Fixed
- A model name was sent to the effort slider. ChatGPT's composer picker holds two controls - a `role="slider"` for effort (Instant..Pro) and `menuitemradio` rows for the models - and selection drove both through the slider, so a model name walked every step looking for one it could never be. Reported from another machine and reproduced here word for word: `--model "GPT-5.6 Sol"` failed with `has no "GPT-5.6 Sol" step. It showed: Instant / Instant, 1 of 5. / ... / GPT-5.6 Sol / GPT-5.5`, which reads as if the name were selectable - it was in the slider's text, not among its steps. `--model Pro` appeared to work only while the slider happened to sit on its top step. An effort now drives the slider and a model clicks its radio; `Pro`, which became that top step rather than a model, is honoured there with a warning instead of failing every repo that has it pinned. This fixes the routing only - clicking a model radio and committing a slider step are still refused by the current UI, and remain open.
- `pro latest` - the command every send prints as its follow-up - took 17s in a repo with real history, and grew with it. Store records were read one file at a time (`await` per file inside a loop), so the cost was the file count times the filesystem's latency: 505 receipts took 12.0s, 146 tasks 4.8s, and verifying a single result reads every receipt. The records are independent, so they are now read 32 at a time: the same work takes 2.1s and 0.4s, and the whole latest-consult path went from ~15s to 1.5-2.0s. What a caller is told is unchanged - the sequential loop reported the earliest corrupt record, and so does this.
- `npm run release:verify` failed on a clean tree for anyone whose umask is 002. The packaging gate asserted an exact 644/755 on installed files, which encodes the INSTALLING user's umask rather than anything about the package, so a developer saw "installed release-pack tarball LICENSE expected mode 644, got 664" while CI at umask 022 passed. It now checks the execute bit, which is the contract the rest of the repo already states.

## 0.36.3

### Fixed
- A saved answer could lose a sentence to a citation marker. Caught by diffing a receipt against the thread it came from: a web-search reply ended at a dangling "Source:", because the line had been `Source: <E200>url<E202>Timeanddate.com — World Clock<E202>turn0search0<E201>` - a marker whose reference carried type `url` and an empty `items` array. Replacements were built only out of `items`, so an empty list became an empty string and took the visible title with it, silently. A marker with nothing to link to now leaves the words it was wrapping. Segments are sorted by shape rather than position, so a `cite` marker carrying several reference ids still resolves to nothing (there is no prose in it) while a title survives - including a title from a marker kind not seen yet.

## 0.36.2

### Fixed
- A requested Pro sub-mode was dropped without a word. The current picker is one five-step power slider (measured `{ok:true, position:4, max:4, model:"GPT-5.6 Sol", effort:"Pro"}`) where Pro is the top EFFORT rather than a model, and selection takes that branch and returns before the sub-mode code runs. A `--model Pro --pro-mode 확장` send finished clean, recorded `gpt-5-6-pro` and an empty warnings list, having never applied 확장 - while the older picker still live on another machine refuses the same request out loud. It now warns, in the receipt as well as on stderr, naming the slider step the send actually used.
- `--model` and `--effort` together silently discarded the model. One slider carries both, so naming each asks for two positions of it, and the send took the effort: measured, `--model Pro --effort 중간` answered from `gpt-5-6-thinking` with no warning at all. Asking for Pro and quietly getting a cheaper model now produces a `model_ignored` warning that says which one was used.

## 0.36.1

### Fixed
- `pro browser models` said the model picker could not be used, while selection through it was working. ChatGPT stopped listing models there: the picker now has an "Advanced" row, a "Model" row reading GPT-5.6 Sol and an "Effort" row reading Pro, with the last two opening a submenu - and Pro moved from being a model to being an effort. The listing read only each row's first line, so it printed the bare word "Model" and appended "not selectable via --model yet" to both. Measured against that same picker, `--model Pro`, `--effort 즉시` and `--pro-mode 확장` all selected and answered; selection walks into the submenu even though the listing could not. It now reads the value line and prints it after an arrow.

### Added
- An FAQ entry for the blocker that needs a person: ChatGPT sometimes parks a thread on "which response do you prefer?", and the two places that enumerate what a send stops on now name `response_choice_pending` alongside login, captcha and the rest.

## 0.36.0

### Fixed
- A shared tab could jam so that every send failed with "still generating" while nothing was generating. ChatGPT parks a thread on "which response do you prefer?" after some answers, and the composer keeps its stop control while it waits - measured unchanged over twenty seconds, and it never clears without a click. That state is now recognized by the testids on the panel (so it survives a UI in any language) and reported as what it is, with the button to press; a send that navigates away (a fresh chat, a project home) is not held back by it at all.
- The same stop control also outlives an ordinary answer. Sampled every two seconds through a real generation: the transcript reports the turn finished about five seconds before the control disappears, and refuses to call it finished while the answer streams. The transcript now decides whether the tab is busy - and only a transcript that can be read AND says the turn ended clears the way. Before this, two concurrent sends into a project both waited five minutes and failed; now both answer.
- Recovery could kill another browser's processes. The scan matched the main process by port but its helpers by a profile path the caller guessed at, using a plain substring test - so a second profile whose name merely starts with the first (`-alt`, `-2`) had its renderers swept into the list that receives SIGKILL, and the unattended path scanned the default profile even for someone running a custom one. The profile is now read off the browser that answered to the port.
- The picker's progress bar promised "ctrl-c to stop" while the terminal was still in the raw mode its pickers needed, which disables the terminal's own ctrl-c. Verified against a real pty: the send could not be interrupted for the whole ten minutes a deep research run takes. The terminal is handed back before the send.
- `prodex ui` with stdin redirected painted the alternate screen, hid the cursor and waited forever for a key that could not arrive, leaving a terminal that needed `reset`. It now says what it needs and names the flag-driven command to use instead.

## 0.22.0

### Added
- `--tool deep-research` now returns the finished report. Deep research renders as a widget app inside an iframe, so the thread looks empty in the DOM no matter how long you wait or how hard you reload - which is why the previous release could only hand back a link. prodex now reads the run from the conversation transcript (`chatgpt_sdk.widget_state`), waits for `status: completed`, and returns `report_message` as the answer. Verified against three finished runs (13k-47k characters).
- `pro browser recover --target-url <thread>` recovers deep research reports too, so a run that outlives its timeout is not lost.
- A run still going when the budget expires blocks with `deep_research_still_running` and the thread to recover from, instead of an unexplained timeout.## 0.23.1

### Fixed
- Onboarding taught none of the capabilities added since it was written. It now covers `--attach` (the only way ChatGPT can open a pdf, pptx, xlsx or image) next to `--file`, `--tool web-search` and `--tool deep-research` with its real cost (~10 minutes, 30-minute budget), and `pro browser recover --target-url`, so a send that outlives its budget is not treated as a lost answer.
- `pro browser help` was missing `projects` and `recover` entirely - the same help onboarding tells agents to read.## 0.25.0

### Fixed
- prodex told ChatGPT that every real send was a preview. The visible-browser send reused the dry-run bundle, so each consult arrived headed "# prodex consult dry run / This preview was not sent anywhere." above the actual prompt - verified from a thread's own transcript. Sends now carry the prompt (and any `--file` contents) with no preview framing, and the receipt records what was really sent.
- A composer tool's progress panel was returned as the answer. A `--tool web-search` consult came back with the 28 characters "Searching the web / Answer now" while the real reply was still being written. The transcript now decides when an answer is finished: if it can read the conversation and says the message is unfinished, the wait continues even when the page looks settled. The page reader also recognizes that panel as a placeholder for when the transcript is unreachable.
- The transcript reader could latch onto the wrong conversation. It re-derived the conversation id from the tab's url on every poll, so a tab that wandered mid-wait would have handed back a stranger's answer - the accident thread pinning exists to prevent. The id is now fixed once, and every transcript read is checked against the prompt that was actually sent (tolerating the `@Tool` prefix a composer tool adds).## 0.26.0

### Fixed
- A send whose browser died sat silent for the rest of its budget. Chrome went away mid deep-research run, every poll threw, the loop swallowed each failure, and nothing was reported for the remaining half hour. Five failed reads in a row now end the wait with `browser_unreachable` carrying the thread, so the answer can be collected; measured live, a killed browser is reported in 7 seconds instead of 20 minutes.
- `pro browser login` ignored how the browser was last opened, so anyone who set up a virtual display got a visible window back every time they followed the `browser_unreachable` advice - the surprise window they went to that trouble to avoid. It now reopens in the saved mode unless a flag or environment variable says otherwise.
- `pro browser recover` read only the page for ordinary answers, inheriting everything the page loses (flattened tables, dropped citation urls) and once saving ChatGPT's "Connection interrupted" notice as the recovered answer. It reads the transcript first now, and that notice is recognized as a placeholder for when the transcript is unreachable.## 0.27.0

### Added
- `prodex ui`, and plain `prodex` in a terminal, now open an interactive consult instead of a wall of commands. It asks for the prompt, where the consult should land (the open chat, an existing project, a new project, or no project), which composer tools to enable, and whether to start a fresh thread - then runs the send with a progress bar that fills against the send's own budget and names what it is waiting on, including queueing behind another agent's send. Piped and scripted callers still get the banner and command list unchanged.
- `--no-project` on `ask` / `pro browser ask`, so a single send can skip a pinned default project. Without it "no project" was unsayable once a repo had one pinned.## 0.27.2

### Fixed
- Keys pressed while the picker was not actively reading were dropped, because a listener was attached per read. Anything typed during a redraw, or across the seconds it takes to read the project list out of the browser, vanished - found by using it: the row number typed first was swallowed and the next key landed on the wrong choice. Keys are queued now.
- The interactive prompt appeared a second or two late, because the context panel's browser check ran before the question. Anything typed into that gap was lost, prompt included. The check now runs while the prompt is being typed, and the panel leads every question after it - which is where it earns its place.## 0.28.0

### Fixed
- A prompt that posted but was not seen to post no longer fails the send. Acceptance was read only off the page, so a change in the ChatGPT DOM would report "ChatGPT never registered the prompt" for a prompt sitting in a conversation - and a caller that retried asked the same question twice. The send now checks the transcript for a conversation holding the prompt it sent, and continues there, warning `prompt_acceptance_unreadable`.
- That check runs 20 seconds in rather than at the deadline. Acceptance ran on the whole send budget, so an unreadable page cost the full twenty minutes before anything was reported. Verified by disabling acceptance detection in a local build: the send recovered and answered in 30 seconds, where it previously spun for the entire budget and failed.## 0.29.0

### Changed
- The interactive picker asks in the order the request is actually formed: what kind of send (normal chat, deep research, web search, create image), then where it goes, then the prompt. Asking for the prompt first was backwards - whether this is an ordinary chat or a ten-minute research run changes what you would type - and it also hid ordinary chat behind a tools multi-select instead of naming it. The seconds spent choosing are now used to fetch the project and conversation lists, so no step waits on the network.
- The logo leads the picker, and the settings panel sits under it.
- Destination is one question instead of two, and it can continue an existing conversation: recent chats are listed by title, and picking one moves the dedicated tab there before the send confirms it with `--target-url`. Continuing was previously unreachable from the picker, and `--target-url` alone does not navigate - it confirms a tab that is already on the thread.## 0.31.0

### Added
- Opening a project now lists the conversations inside it, so a session can be resumed where it lives instead of only starting yet another chat there. Conversations carry the project id they belong to, and the project list now carries that id too - the sidebar gives names only, which is enough to enter a project but not to tell which chats are in it.

### Changed
- The reasoning list reads down from the pinned model: Keep, then Extra high, High, Medium, Instant. Climbing up from Instant put the levels closest to Pro furthest from it.## 0.32.0

### Added
- The picker asks for attachments. Uploading a file is the only way ChatGPT can open a pdf, pptx, xlsx or image, and the interactive path had no way to say so - the capability existed only as a flag. It is asked after the prompt and skipped with enter, so the common case costs one keystroke; quoted paths are accepted because file names have spaces in them.## 0.34.0

### Added
- `pro browser chats` lists recent conversations with their ids, and `pro browser chat-delete` removes one. Same shape as project deletion: a preview by default that deletes nothing, `--confirm-delete` to act, exact titles only, and a title shared by two chats refused with both ids - titles are written by ChatGPT and repeat far more often than project names do.## 0.35.1

### Fixed
- `pro browser login` gave up after one silent attempt at opening the missing ChatGPT tab. Seen on a real machine: the wait sat for a minute reporting "no chatgpt.com tab is open" and ended not-ready, with no way to tell whether prodex had even tried - it opened once, ignored the result, and said nothing. It now retries while the tab is still missing and says so when an attempt fails.

## 0.35.0

### Added
- A wedged browser now heals itself. Reporting it was not enough: nobody ran a check for four days, and the point of an unattended path is that nobody is watching. When a send finds the browser silent and a prodex-launched Chrome still running, it confirms the silence across several probes, ends that browser, waits for the profile lock to clear, launches a fresh one and retries. Verified by freezing the local browser: the send recovered on its own and answered. `PRODEX_NO_AUTO_CLEAR=1` keeps the old report-only behaviour.

### Fixed
- Recovery no longer stacks a second browser on a wedged one. When a consult found the port unreachable, the unattended path - the one agents use - launched another Chrome onto the same profile, which joins the wedged instance rather than replacing it and leaves it burning CPU. Both that path and `pro browser login` now stop and name `pro browser reset` instead.
- A port was matched as a substring, so a check on port 9 claimed the browser listening on 9333 and refused to launch.
- Ending a wedged browser now wakes it first. A process held in a stopped state cannot act on SIGTERM, so it kept the profile lock and the replacement launch failed with "no reachable DevTools endpoint" - measured, on exactly that. It is continued, asked to quit, and only forced if it will not go.

### Added
- prodex now notices a browser it launched that is running but no longer answering. Found on a real machine: a Chrome prodex started sat for four days with two renderers pinned near 100% and the window server burning 75% CPU on its zombie window, while `check` reported it as simply not running - prodex only ever asked whether the debug port replied, and a dead browser answers exactly like an absent one. `check` now reports `browser_wedged` with the pids, and `pro browser reset` ends it: a preview by default, `--confirm` to act, and it refuses while the browser still answers, since that would take an in-flight consult with it.

## 0.33.0

### Added
- `pro browser project-delete` removes a project from the account. It previews by default - naming exactly what would go and deleting nothing - and only acts with `--confirm-delete`. Names must match exactly, and a name shared by two projects is refused with both ids rather than resolved by guessing, because the deletion cannot be undone from here. `--id` picks one in that case.
- `pro browser projects` now prints each project's id alongside its name, which is what `project-delete --id` needs.

### Fixed
- `pro browser projects` read the rendered sidebar, which lags the account: it still listed a project that had just been deleted. It now prints the account's own listing when that is readable and falls back to the sidebar otherwise.

## 0.31.1

### Fixed
- A send that created a project could fail with "power slider not found". The model menu paints a moment after it opens, and on a page built seconds earlier - a project just created - that moment is longer than the single look prodex gave it. It now waits a few beats for the slider before giving up; measured on the failing path, the same send goes through.
- The picker's step numbers follow the path actually walked. A normal chat asks four questions and a tool kind three, but every screen claimed "of 3", and the reasoning question had no number at all. The first screen no longer states a total, because how many remain depends on the answer being given.

## 0.30.0

### Added
- The picker asks how much reasoning an ordinary chat should get: keep the pinned model, or Instant / Medium / High / Extra high. prodex is named for Pro, but the same signed-in browser runs the standard reasoning levels, and a one-line question does not want minutes of Pro reasoning. Verified end to end: the receipt records `gpt-5-6` for an Instant send where the previous sends recorded `gpt-5-6-pro`.

### Fixed
- `--effort` now overrides a pinned Pro model instead of being applied after it. ChatGPT deselects Pro the moment an effort is set, so a repo with `model: Pro` pinned was selecting Pro only to undo it. `--pro-mode` still keeps the pinned Pro, since it refines that selection rather than replacing it.
- Two tests wrote their fixture config to `.bridge/config.json`, which prodex does not read, so they passed without ever loading the defaults they claimed to test. They now write `.bridge/config.local.json` and first assert the pinned value is really in effect.

## 0.28.1

### Added
- `--json` on `pro latest` and `pro show`. Every other read path was already machine-readable, so an agent that wanted the thread, the recorded warnings, or the model that actually answered had to scrape a human-facing rendering. The JSON carries `task_id`, `status`, `thread`, `created_at`, `answer`, `warnings`, `model_used` when the receipt recorded one, and the blocker when there is one.

## 0.27.3

### Changed
- The waiting line no longer prints the clock twice. A deep research run read `[###---] 2m 58s / 30m  waiting 2m 57s (deep research researching (1m 48s))` - the same elapsed time in two places, with the part worth reading pushed to the end. The label now carries only the detail.

## 0.27.1

### Changed
- The interactive picker reads the way the terminal tools it sits beside do. It runs on the alternate screen so the shell's scrollback comes back untouched, opens with a framed panel naming the repo, model, pinned project and browser state (choosing a project without knowing the browser is down wasted every question that followed), numbers each row so a choice can be typed instead of arrowed to, marks the cursor with a left bar that survives coloring, labels each question with its step, truncates to the terminal instead of wrapping, and dims hints and key help rather than competing with the choices. The wait line gained a spinner, so a still frame no longer reads as a hang, and says how to stop.

## 0.26.1

### Fixed
- `pro browser login` could block forever on a Chrome it was reusing. When the dedicated Chrome was already running but had no chatgpt.com tab, login reported "reusing it (no new window opened)", told the user to finish logging in "in the opened window", and then waited on `chatgpt_page_missing` - a tab nobody was going to create. It now opens the ChatGPT tab in that browser (once, not once per poll) and the wait proceeds; reproduced and verified locally, READY in 2 seconds where the old build waited out the whole budget.
- The wait no longer refers to "the opened window" when it reused a running browser.

## 0.25.1

### Fixed
- The page reader could invent an answer. With no assistant message it returned the last 4000 characters of the page - sidebar and navigation text - as the answer, and a fallback added in 0.21.3 counted any conversation turn without a user message as an assistant reply, which is how a tool's progress panel became a 28-character result. Deep research, the case that fallback existed for, is read from the transcript now, so both are gone: no assistant message means no answer.
- Thread identity was rejected for every prompt containing markdown. The composer stores what was typed with markdown escaped (`## File` as `\## File`, fences as escaped backticks), so a `--file` consult never matched and silently fell back to reading the page. Comparison now unescapes first; verified live, a `--file` send returns through the transcript.
- The navigation guard pinned whatever page the send started on. A `--new-chat` send into a project pinned the project page, then read its own conversation as a stray tab and navigated back - away from the answer it was waiting for. It now only guards a real conversation url, and only while the transcript cannot answer.
- The release-pack test asserted an exact file mode, which depends on the installing user's umask: green under CI's 022, red under a local 002. It now asserts the actual contract - no execute bit on non-bin files, execute kept on the bin entry - and the suite is green under both.

## 0.24.0

### Fixed
- Citation resolution ate every space in a cited answer. A `sources_footnote` reference carries `matched_text: " "` - a single space - and 0.23.0 substituted on it blindly, so a 47k-character report came back with its words fused together. Substitution now requires text that actually contains a citation delimiter. Anyone on 0.23.0 or 0.23.1 should upgrade.

### Added
- `pro_recover` MCP tool. A consult that outlives its budget already handed back the thread it landed in, but acting on that meant running a shell command - which an agent reaching prodex over MCP may not be able to do. Recovery is now reachable the same way the consult was, and it is how a deep research report gets collected when the run outlasts the send.

### Changed
- The `tools` parameter description caught up with what deep research actually does now: prodex presses start, waits out the roughly ten-minute run, and returns the full report; if the budget still runs out, the blocker carries the thread for `pro_recover`.

## 0.23.0

### Changed
- Answers are now read from the conversation transcript, with the rendered page as fallback. The transcript is the same data the UI draws, minus the drawing: markdown tables and fenced code survive instead of being flattened by innerText, citations come back as real links (the DOM drops their urls entirely), completion is an explicit `finished_successfully`/`end_turn` rather than a caret heuristic, and `model_used` comes from ChatGPT's own tag on the message.
- The wait now pins the conversation id instead of the tab. Measured live: a send whose tab drifted back to the project page left the DOM reader reporting zero assistant messages for over ten minutes while the finished answer had been sitting in the transcript since 52 seconds in. Reading by conversation id is immune to where the tab wandered.
- Deep research reports and `pro browser recover` resolve their citation markers the same way, so a saved report carries source links instead of private-use characters.

## 0.21.3

### Changed
- `--tool deep-research` now returns the thread URL immediately instead of waiting out a 30-minute budget for a report it cannot read. A run the user finished themselves was measured from prodex's browser: the same thread, same account, after a real navigation and a cache-ignoring reload, renders only the prompt turn and an empty result turn - while their own browser shows the finished report. prodex starts the run and tells you where to read it (`deep_research_not_readable`).
- README no longer claims deep research reports come back through prodex.
- Blocked sends now report the thread the prompt actually landed in (`thread`, also on the blocker), instead of `null` whenever the send used `--new-chat`.

### Fixed
- The answer reader falls back to `conversation-turn` sections when a thread renders no `data-message-author-role` nodes, so answers in that shape are no longer read as empty.
- Tests no longer write the real `~/.local/share/prodex/last-login.json`; the login registry is isolated per run.

## [0.21.2] - 2026-08-09

### Fixed
- A consult can no longer answer with a DIFFERENT conversation. The browser is
  shared - other agents, the user, tooling - and while prodex waited for an
  answer, something navigated the tab to another thread; prodex read that
  thread and saved it as this consult's answer, silently, with a receipt
  (caught live: a research prompt came back with an unrelated email draft).
  The wait now pins the conversation the prompt landed in, navigates back if
  the tab moves, and fails with `thread_navigated_away` (carrying the thread
  URL for `pro browser recover`) rather than returning someone else's text.

## [0.21.1] - 2026-08-07

### Fixed
- A composer tool is found by its title OR its description. ChatGPT stopped
  rendering the visible "Deep research" title and left only "Get a detailed
  report", so a title-only lookup started failing with `Selected "Deep
  research" but the composer never showed it as active` (measured live, twice).
  Each known tool now carries every string its menu row is known to render, and
  the activation check accepts any of them.
- The deep research start control is pressed without ever hitting the
  microphone. "Start dictation" and "Start Voice" sit in the same composer and
  matched the old start-button pattern, so the click could land on dictation
  instead of the run.

### Known limitation
- `--tool deep-research` still cannot be called working. The tool enables, the
  prompt posts, and prodex presses the start control, but no run has yet
  produced an assistant message in these tests. Everything else in `--tool`
  (web search) and the model/effort slider is verified live. If you need a deep
  research report today, let prodex post the prompt and press start in the
  browser yourself - the thread is a normal one.

## [0.21.0] - 2026-08-07

### Fixed
- Model and effort selection works against ChatGPT's new picker. The radio list
  is gone: the picker is now a single power slider whose five positions render,
  on GPT-5.6 Sol, as Instant / Medium / High / Extra High / Pro - so "Pro" is
  the top EFFORT, not a model, and every `--model Pro` send had been failing
  with "Pro option not found in the model menu". prodex focuses the slider and
  steps it until the readout matches the requested label (Korean and English
  names both resolve), and falls back to the old radio path when a browser
  still renders one. Verified live: `--effort 높음` moved the picker to High,
  `--model Pro` moved it back to Pro.
  (The picker header's "Pro, 5 of 5." is the slider POSITION, not a remaining
  -runs quota - it reads "Instant, 1 of 5." at the other end. An earlier draft
  of this release mistook it for a quota; nothing ships that reads it that way.)

### Added
- `--tool <name>` (and `tools: [...]` on `pro_consult`) turns on a ChatGPT
  composer tool for a send: `web-search`, `deep-research`, `create-image`, or
  any label the tools menu shows - an unknown name is passed through, so a tool
  ChatGPT adds later needs no prodex release, and a name the menu does not have
  fails with the actual menu contents listed. Aliases (`deep`, `research`,
  `search`, `image`) resolve to the rendered labels.
  `web-search` is verified live end to end (a current-rate question came back
  with the figure, the date and a source).
  `deep-research` raises the default timeout to 30 minutes automatically. It is
  NOT verified end to end: on this account the tool enables, the prompt posts,
  and ChatGPT then produced no assistant message at all for 30+ minutes, with
  no activity indicator. Treat it as available but unproven until that is
  understood.
- Enabling a tool had to be sequenced around a discovery: a tool is not a chip
  beside the composer, it is a token INSIDE the ProseMirror editor. It is
  therefore enabled after the composer is cleared (clearing removes it), the
  prompt/composer match check ignores the token, and because the toggle
  survives a page reload, prodex clearing the composer on every send is what
  keeps a tool from leaking into the next one.

## [0.20.0] - 2026-08-06

### Added
- `--attach <path>` (and `attach: [...]` on the `pro_consult` MCP tool) uploads
  a real file to ChatGPT instead of inlining its text. This is the only way to
  hand ChatGPT a pdf, pptx, xlsx or image and let it parse the original;
  `--file` still inlines a text file's contents into the prompt, which cannot
  carry a binary and bloats the prompt. The upload goes through the composer's
  file input over CDP (no file dialog, no OS automation), runs BEFORE the
  prompt is submitted, and waits until ChatGPT has finished accepting every
  file - a send that fires mid-upload posts a prompt ChatGPT cannot see the
  file for. `--attach` carries the same escape guard as `--file`: a path
  outside the repo root is refused, so an agent cannot upload `~/.ssh` by
  asking nicely. The browser process reads the path, so the file must live on
  the machine running the browser; when it does not, the attachment never
  appears and prodex says exactly that.
  Verified live end to end: an image attachment came back with the product name
  read off the banner, and a document attachment came back with the marker
  string from inside the file.

### Fixed
- `--model Pro` works again. ChatGPT moved the models behind a "Model" submenu
  (the picker's top level is now Advanced / Model / Effort), so the flat radio
  lookup failed every send with "Pro option not found in the model menu" -
  while the picker button itself already read "Pro, 5 of 5". prodex now skips
  the menu entirely when the button already shows the requested model, which
  is both the same end state and immune to the menu being reshuffled again.
- A send carrying an attachment waits up to 2 minutes for the composer to
  become submit-ready instead of 3 seconds. ChatGPT keeps the send control
  disabled while it ingests an uploaded document, and the old budget expired
  mid-ingest: the prompt sat in the composer and the send timed out with
  "ChatGPT never registered the prompt".
- Attachments left by a previous failed send are cleared by reloading the tab,
  not by clicking their remove buttons. Measured live: after a removal the file
  input still accepts files (input.files becomes 1) while the composer never
  renders the chip again, and every later attach in that tab silently does
  nothing - a wedge that outlives the command that caused it.

## [0.19.2] - 2026-08-05

### Fixed
- Long prompts and `--file` attachments send again. 0.17.0 split a large prompt
  into 4,000-character `Input.insertText` chunks to dodge the CDP command
  timeout, but the chunks corrupt the text at their boundaries: measured live
  on a 95 KB prompt, the composer ended up the right LENGTH with content
  shifted from the first boundary on (first divergence at 3,938 characters),
  which surfaced as "Composer text did not match after insertion" and blocked
  every long consult - including any `--file` attachment, whose contents make
  the prompt long. A prompt above the chunk size now goes in as ONE in-page
  `execCommand("insertText")`, where nothing can interleave, on a connection
  whose budget scales with the text (a 67 KB insert takes ~20s in the page).
  Verified live end to end: the same 95 KB prompt and a large `--file`
  attachment both send and answer.

## [0.19.1] - 2026-07-28

### Fixed
- A bridge root that is not a usable repo directory now fails with a diagnosis
  instead of a raw ENOENT. Field report (macOS): an agent harness started
  `prodex mcp` with a working directory of `/dev/fd/<n>` - a file-descriptor
  path - so every call died on `<root>/tasks`, `/sessions`, `/receipts` with a
  different number each time, and the operator had no way to see what prodex
  had resolved. The error now names the resolved path, says it is a
  descriptor/device path, and gives both ways out.
- `PRODEX_CWD` (absolute paths only) pins the repo prodex operates on. The MCP
  server takes no flags, so when a harness spawns it from a pipe path or a
  deleted directory this is the only way to fix it without changing the
  harness; `--cwd` still wins where a command accepts it.

### Security
- The local MCP token is stored ONCE. It used to be persisted twice in
  `.bridge/config.local.json` - as `token` and again inside `server_url` - so
  an operator's redaction that masked the `token` key still leaked the same
  secret from the URL (field report). `server_url` now holds the token-free
  endpoint, the token-bearing URL is composed only where it is actually needed
  (`prodex status --show-token --url-only`), and a config written before this
  change is repaired in place the first time any command reads it: the
  duplicate leaves the file, not just the output. Verified on a real config
  (token occurrences 2 -> 1, saved browser defaults preserved).
- Unchanged, for the record: the file is mode 0600 and gitignored, prodex masks
  the token on every surface it prints, and `prodex setup --token-ttl-hours
  <hours>` rotates it while preserving saved browser defaults (verified).

## [0.19.0] - 2026-07-28

### Added
- Every consult now records the model that ACTUALLY answered. ChatGPT tags each
  message with `data-message-model-slug`; prodex reads it, prints
  `model_used: gpt-5-6-pro` on stderr and stores it on the consult receipt.
  Until now prodex recorded only what it ASKED for, so a model click that
  silently did not take - or a repo with no default at all - was invisible, and
  you could believe you were getting Pro reasoning when you were not. Verified
  live end to end.
- `model_mismatch` warning when Pro was requested but a non-Pro model answered,
  and the existing `model_selection_warning` (nothing pinned) now names the
  model that answered instead of leaving it to guesswork.
- A timed-out consult records the thread URL it landed in, and its next step
  spells out `pro browser recover --target-url <thread>`. recover was built for
  exactly this case but the blocked record kept no URL, so the thread had to be
  hunted down by hand (hit live).

## [0.18.1] - 2026-07-28

### Fixed
- Onboarding taught superseded behavior. It still told users to pass
  `--busy-wait-ms 600000` to queue behind a busy browser (automatic since
  0.16.33), still called the Pro default a 15-minute timeout (it is 20), and
  said nothing about the no-window modes that landed in 0.18.0 - the login
  step is exactly where that choice belongs. It now offers
  `--virtual-display` and `--minimized` right after the first headed login,
  and says plainly that `--headless` is not an option for ChatGPT.
- The README's "just don't minimize it" rule is gone: minimizing is now a
  supported mode, and the Pro default timeout there said 15 minutes too.

## [0.18.0] - 2026-07-27

### Added
- `pro browser login --virtual-display` (or `PRODEX_VIRTUAL_DISPLAY=1`, which
  also covers the MCP server and its auto-recovery) runs the dedicated browser
  on an X virtual framebuffer: log in headed once, and after that no window
  appears anywhere - not on the desktop, not in the taskbar. It stays a REAL
  headed Chrome, which is the whole point, because Cloudflare rejects headless
  browsers and accepts headed ones. Verified end to end: the signed-in profile
  loaded chatgpt.com with no challenge and a real Pro send returned in 31s with
  no window. Needs Xvfb and xauth (prodex names the package when they are
  missing); Linux and WSL only. The display is served over loopback TCP
  (WSLg mounts /tmp/.X11-unix read-only) and protected by a per-display xauth
  cookie under ~/.local/share/prodex/xvfb - never -ac, so no other local
  process can watch the signed-in window. A browser already running on your
  desktop cannot be moved onto a virtual display by reuse, so prodex refuses
  the switch instead of silently leaving the window where it was.
- `pro browser login --minimized` (or `PRODEX_MINIMIZE_WINDOW=1`) launches the
  dedicated browser and minimizes it, so nothing sits on your desktop while it
  stays a REAL headed Chrome - which is the point, because Cloudflare admits
  headed browsers and rejects headless ones. Verified live under WSLg: a
  minimized Chrome still reports visibilityState "visible" and a real Pro send
  completed in 26 seconds with no window on screen. On a desktop that marks
  minimized windows hidden, prodex restores the window and says so instead of
  leaving a browser it cannot send into. MCP auto-recovery re-applies the mode.

### Fixed
- The dedicated browser launches with renderer backgrounding disabled
  (`--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding`,
  `--disable-background-timer-throttling`). Chrome throttles the renderer of an
  occluded window, and prodex's own advice is to keep that window behind your
  editor - a throttled renderer makes ChatGPT stream slowly or stall, which
  reaches the user as an unexplained send timeout.
- A headless login that Cloudflare blocks now says so. It reported "the
  profile is not signed in", sending users to re-login over and over, when
  the real cause is that Cloudflare rejects headless browsers by design. The
  message now names the challenge and points at the alternatives (run headed,
  or run a real headed Chrome on a virtual display).
- Cloudflare interstitial detection matches what the page actually renders:
  the body says "Verifying you are human." and "<site> needs to review the
  security of your connection", while only the title says "Just a moment...".
  The old pattern only matched "verify you are human", so the live page went
  undetected.
- `pro browser login --headless` honors `--wait-timeout-ms` for its
  signed-in verification instead of a fixed 30 seconds.

## [0.17.0] - 2026-07-27

### Added
- Headless mode: `pro browser login --headless`, or `PRODEX_HEADLESS=1` for
  every entry point including the MCP server. The dedicated browser runs with
  no visible window, pinned to a 1440x900 window because headless Chrome's
  800x600 default collapses the ChatGPT sidebar - and the sidebar carries the
  logged-in signals, so a narrow headless session would read as logged out.
  Headless requires a profile that is already signed in (the login verifies
  the session and says so if it is missing), and refuses to switch modes while
  an instance of the other mode is running on the same profile.
  Measured caveat, documented in the README: against ChatGPT today, headless
  draws a Cloudflare "Just a moment..." challenge that does not clear (>60s)
  even with a real signed-in profile, so the flag ships as available but
  unproven for ChatGPT rather than as the recommended mode.
- MCP consults recover a closed browser by themselves. The auto-recovery gate
  only fired for interactive terminals, and an MCP caller has none - so a
  closed browser made every `pro_consult` fail with a step the agent had to
  shell out for (tied for the most common field failure). Recovery reuses the
  saved profile AND the saved window mode; `PRODEX_NO_AUTO_LOGIN=1` disables it.

### Fixed
- Long prompts no longer freeze the send. The whole prompt went to ChatGPT in
  one `Input.insertText`, whose single huge ProseMirror transaction stalls a
  heavy thread past the 20s CDP command timeout - the send then died with
  "Chrome DevTools command timed out: Input.insertText" (observed twice in one
  field session on long inputs). Text is inserted in 4,000-character chunks,
  split on code points so an emoji or other astral character is never cut in
  half.
- A CDP command timeout reports as `browser_cdp_timeout` with a usable next
  step (retry with `--new-chat`, or reload the tab) instead of the generic
  "resolve the visible browser issue manually".
- `pro browser check` no longer takes a minute on a repo with real consult
  history. Reporting the single newest consult verified EVERY recorded one,
  and each verification is a full receipt scan: measured live, latest_pro
  alone took 42 of the check's 46 seconds. It now verifies newest-first and
  stops at the first trusted record (65s -> 9s on the same repo). `pro list`
  still verifies everything, because it displays everything.
- The browser status read honors the caller's `--timeout-ms` instead of the
  20s default CDP command budget.

## [0.16.33] - 2026-07-23

### Fixed
Agent-misuse batch, derived from auditing 177 real prodex invocations across
other repos' sessions (41 failed). Each item is a failure an AI caller could
not recover from on its own:
- `pro browser check` reports an in-flight response as `chatgpt: busy` with
  "no action needed" instead of `chatgpt: blocked`, and stops counting it as a
  browser fault. Agents read "blocked" as "the browser is broken" and went off
  relaunching or re-logging in when ChatGPT was simply mid-answer.
- A held machine-global send lock now queues by default (budget = the send
  timeout) instead of failing instantly. `pro_consult` cannot pass
  `--busy-wait-ms`, so the old advice to "pass --busy-wait-ms" was
  un-followable from MCP; `--busy-wait-ms 0` opts back into failing fast.
- `pro_consult` no longer advertises `pro_mode` (ChatGPT removed Pro
  sub-modes). Agents that saw the field passed `pro_mode: "true"` and got a
  hard "must be one of 기본, 확장" error instead of an answer; a stale caller
  that still sends it is now ignored rather than rejected.
- Retired subcommands point at a command that exists: `pro status` said "use
  `pro browser status`", which itself errored with "use `pro browser check`" -
  a two-hop dead end.
- The default send timeout with NO model selection is 5 minutes instead of 90
  seconds. Repos with no saved defaults chronically hit "Timed out after
  90000ms" because the UI's current model is unknown and may be Pro.
- `browser_unreachable` guidance states that `pro browser login` reopens the
  window with the saved session and returns immediately for non-interactive
  callers, so agents stop treating it as a blocking human login step.
- `config: missing` is labelled optional (only the HTTP MCP surface needs it),
  since it appeared in nearly every healthy browser-only check and sent agents
  chasing `prodex setup`.

## [0.16.32] - 2026-07-23

### Fixed
- A thread still generating a previous answer is now diagnosed as
  `response_in_progress` instead of "missing a visible prompt composer".
  Field bug: consults continue the current thread by default, so a follow-up
  landing while the previous (often timed-out Pro) answer was still streaming
  hit the composer-readiness assert BEFORE the busy check - the composer locks
  during generation, so the send failed with a misleading not-ready error and
  agents had to diagnose the busy thread themselves.
- Busy threads now queue by default: the send waits for the in-flight response
  to finish (up to the send timeout budget, with "tab busy" progress) and then
  proceeds. `--busy-wait-ms` tunes the budget and now accepts `0` to fail fast
  with the `response_in_progress` blocker, whose guidance now points at
  `--busy-wait-ms`, `pro browser recover`, and starting a new chat.
- Browser auto-detection no longer opens blank Windows Edge/Chrome windows.
  Root cause (trap-logged live): Windows chrome.exe/msedge.exe do not implement
  a console `--version` - they open a blank window - and the candidate walk
  probed the /mnt/c install paths by exec whenever the earlier PATH probes
  failed (e.g. `google-chrome --version` stalling past its old 3s timeout on a
  loaded machine, or a test PATH without a real chrome). Windows-host browsers
  are no longer auto-candidates under WSL at all (opt-in via PRODEX_CHROME
  only), `.exe` paths are validated by file existence instead of exec
  everywhere (also fixes the same blank-window probe for native Windows), and
  the version probe timeout is 10s.

## [0.16.31] - 2026-07-22

### Added
- `pro browser recover --target-url <thread-url>` recovers a FINISHED answer from
  a ChatGPT thread whose send timed out. Field bug: when a consult's send times
  out (send_timeout) but ChatGPT completes the answer afterwards, the task is
  stuck "blocked", a re-send is refused as "still generating", and the completed
  answer sits unreachable in the thread the operator can see. recover navigates
  the visible tab to the thread, waits for a stable finished assistant answer (a
  real message, not answerExpression's page-chrome fallback), prints it, and
  records it as a done consult so `prodex pro latest` re-prints it. Verified live
  by recovering a real 9.9 KB answer from a timed-out consult thread.

## [0.16.30] - 2026-07-22

### Fixed
Agent-ergonomics batch: four separate points where a reasonable consult
invocation bounced (each observed live as an agent retried different flags).
prodex is now liberal in what it accepts:
- `--file` accepts an absolute path that points inside the repo (converted to the
  repo-relative path the reader needs); an absolute path OUTSIDE the repo now
  gives a clear "outside the repo root" error instead of the generic
  "must be repo-relative, not absolute". Agents naturally pass absolute paths.
- `--stdin` no longer requires a positional prompt: `git diff | prodex ask
  --stdin` uses the piped text as the whole prompt (a positional instruction, if
  given, still goes above the piped data).
- `--project` acceptance when already inside the project is now case-insensitive,
  matching the case-insensitive sidebar-row lookup - `--project codex` while
  sitting on "Codex" no longer fails with "did not navigate the visible tab".
- `--pro-mode` on a ChatGPT UI that does not expose Pro sub-modes yet (staged
  rollout) now degrades to a plain Pro send with a `pro_mode_unavailable` warning
  instead of hard-failing the whole consult (Pro itself is already selected).

## [0.16.29] - 2026-07-16

### Documentation
- onboard and README now document the `PRODEX_DEFAULT_PROJECT` /
  `PRODEX_DEFAULT_MODEL` / `PRODEX_DEFAULT_PRO_MODE` / `PRODEX_DEFAULT_EFFORT`
  global env defaults (added in 0.16.28): why an agent's `prodex mcp` (no --cwd)
  misses a per-repo default, how to set a directory-independent default to your
  own project, and that with no project set consults just go to the general chat.

## [0.16.28] - 2026-07-16

### Added
- Global browser-selection defaults via `PRODEX_DEFAULT_PROJECT`,
  `PRODEX_DEFAULT_MODEL`, `PRODEX_DEFAULT_PRO_MODE`, `PRODEX_DEFAULT_EFFORT` env
  vars. The MCP server (pro_consult) usually runs as `prodex mcp` with no
  `--cwd`, so it reads whatever directory the agent launched in - a per-repo
  default project set elsewhere was missed and consults landed in the general
  chat. These env vars are a global fallback applied from any cwd; a per-repo
  config still wins field-by-field.

### Changed
- pro_consult now documents that it CONTINUES the currently-open thread by
  default and that `new_chat:true` should be passed only to start a fresh thread
  for a genuinely new topic. Consecutive follow-ups on one topic stay in a single
  conversation instead of spawning a new thread each time (less sidebar clutter,
  kept context). `project`/`model` should be left to saved/global defaults rather
  than passed per-call.

## [0.16.27] - 2026-07-16

### Changed
- Timeout guidance is now human-readable. Timeout messages and progress lines
  render durations as "20 min" / "1m 30s" instead of raw milliseconds (the raw
  ms is kept in parentheses so the send_timeout blocker can still parse a budget
  to double). A send announces its budget ("prompt sent, waiting for answer
  (budget 20 min)"), long waits show elapsed as "waiting 3m 20s (generating)",
  and a send_timeout suggests "Rerun with a bigger budget (40 min): `prodex pro
  browser ask --timeout-ms 2400000 ...`".

## [0.16.26] - 2026-07-16

### Changed
- A Pro selection now defaults `--timeout-ms` to 20 minutes (was 15). Pro
  reasoning routinely runs 6-20 minutes, and 15 minutes was still cutting long
  answers off with a `send_timeout` (field report), forcing a manual
  `--timeout-ms 1200000` on every consult. An explicit `--timeout-ms` still wins.

### Fixed
- A ChatGPT session that expires mid-send used to surface as a cryptic
  acceptance timeout ("raise --timeout-ms"), hiding that a re-login was needed.
  On an acceptance timeout, prodex now re-checks the login state and, if the
  session is gone, fails with `session_expired` and "Run `prodex pro browser
  login`, log in, then retry." instead.

## [0.16.25] - 2026-07-15

### Fixed
- Switching from one project to another could send into the WRONG project. The
  sidebar SPA navigation moved the URL to the requested project, but ChatGPT's
  composer stayed bound to the previous project's conversation target, so the
  prompt silently created its thread in the project the tab came from
  (reproduced live via PRODEX_DEBUG_SEND: baseline URL on the requested project,
  yet the prompt posted into the old one). After actually switching projects,
  `selectProject` now hard-reloads the project home so the composer rebinds to
  the target project before sending. Verified live: a codex -> prodex-smoke
  cross-project send now lands in prodex-smoke.

## [0.16.24] - 2026-07-15

### Fixed
- An acceptance timeout on a slow or undetected answer was misreported as
  "ChatGPT web UI may have changed... update prodex" (send_ui_changed), even
  though the send button was fine. Root cause: `submitButtonFound` was only set
  true inside the fallback click loop, which is skipped whenever the Enter-key
  submit succeeds - so a normal send followed by a slow answer left it false and
  tripped the UI-changed diagnosis. prodex now polls `submitExpression` right
  after typing to record whether the send control actually exists (verified live:
  the current button is still `data-testid="send-button"` / `aria-label="Send
  prompt"`), so a slow answer now correctly says "Raise --timeout-ms". The poll
  also waits for the composer to be submit-ready before pressing Enter, reducing
  the new-chat/project-home submit race.

## [0.16.23] - 2026-07-15

### Added
- `pro list --json` emits the consult list as structured JSON (task_id, status,
  summary; empty is a valid `[]`), matching the human tab output and the existing
  `tasks/receipts/sessions list --json`. An agent enumerating past consults no
  longer gets "Unknown option for pro list: --json".

## [0.16.22] - 2026-07-15

### Fixed
- `pro browser projects` and `pro browser models` rejected `--cwd` with "Unknown
  option", while their sibling `pro browser` subcommands (ask/check/smoke) accept
  it. An agent that passes `--cwd` uniformly on every prodex call broke on these
  two repo-independent sidebar/picker reads. Both now accept (and ignore) `--cwd`.

## [0.16.21] - 2026-07-14

Firefighting-code review batch (findings from a parallel review of v0.16.3..HEAD,
each verified in the code before fixing).

### Fixed
- Concurrency: the machine-global browser send lock could let two clients send at
  once. It created the lock file and wrote the pid in two separate steps, and a
  concurrent waiter reaped the momentarily-empty file as a dead lock - so both
  clients proceeded. The lock now publishes atomically (write a temp file, then
  hard-link it into place) so it is never observed empty; reaping re-verifies the
  same holder still owns the file before removing it; release removes only our own
  lock; and EPERM (a live process owned by another user) is treated as alive, not
  dead.
- A live-but-wedged holder is now reaped after a generous stale timeout (default
  60 min, override PRODEX_SEND_LOCK_STALE_MS) so a hung browser cannot block every
  send on the machine forever.
- Project selection matched sidebar projects by substring: `--project "Codex"`
  could select "Codex Review" and silently send into the wrong project. Both the
  sidebar-row match and the already-in-project (navigation-stall) acceptance now
  match by name equality, with a unique case-insensitive fallback and a loud error
  on ambiguity.
- A "project not found" (or other) blocked send recorded the requested/default
  project name into the persisted task summary and blocker, which cross the MCP
  boundary unredacted. The persisted records now redact the project name; local
  stdout/stderr still show it.
- `pro ask --busy-wait-ms` reported "Unknown option" instead of the intended
  "only applies when sending" guidance.
- Help text still described the pre-July 300000 ms pro-mode timeout; corrected to
  900000 ms (a Pro selection raises the default timeout).

### Internal
- Send-lock tests restore the isolated PRODEX_SEND_LOCK_FILE instead of deleting
  it; a bare delete leaked later tests onto the real machine lock.

## [0.16.20] - 2026-07-14

### Fixed
- README no longer tells new users to pass `--pro-mode 확장` in the quickstart
  (that errors under the GPT-5.6 picker) and no longer claims the old 90s/300s
  timeout defaults. The flags reference now explains that Pro sub-modes belong
  to the GPT-5.5 generation picker, and that any Pro selection defaults to a
  15-minute timeout. Quickstart teaches defaults-first
  (`setup --model Pro --project`), project-name discovery, and
  `--busy-wait-ms` for shared browsers.

## [0.16.19] - 2026-07-14

### Changed
- Onboarding now teaches the three lessons a week of real usage surfaced:
  pin per-repo defaults first (`prodex setup --model Pro --project "..."` -
  otherwise sends silently use whatever the ChatGPT UI last had selected),
  discover exact project names with `pro browser projects`, and use
  `--busy-wait-ms` when multiple agents share the browser. Also notes that
  saved defaults apply to agent consults.

## [0.16.18] - 2026-07-14

### Changed
- `--pro-mode` is forward-compatible with OpenAI's staged rollout of the new
  picker: per the July release notes Pro Standard/Extended still exist, but
  some browsers (including the dedicated one here) receive a picker that
  renders Pro as a single row. Selection now first tries the keyboard path
  (focus the Pro row, ArrowRight - how Radix submenus open) with the
  documented labels (Pro Standard/Extended, 기본/확장), then the legacy hover
  chevron, and only then fails - with a message that correctly describes the
  staged rollout instead of claiming the feature was removed.

## [0.16.17] - 2026-07-14

### Fixed
- Transiently-covered clicks now retry with fresh coordinates everywhere in
  the selection flow (menu items, the Pro radio, the sub-mode expander,
  project rows) - not just the model-selector button. A hover-verified click
  refused during a menu/modal animation or right after project navigation
  aborted the whole send (field failure: the Pro menu item refused once
  mid-animation). Persistent covers still fail with the refusal message.

## [0.16.16] - 2026-07-14

### Fixed
- `--model Pro` sends now default to a 15-minute timeout. The elevated default
  (previously 5 minutes) was keyed to the removed `--pro-mode`, so Pro sends
  fell back to the 90-second default and chronically timed out mid-reasoning
  (field failure; a real Pro consult measured ~13 minutes). An explicit
  `--timeout-ms` still wins; non-Pro sends keep the fast default.

## [0.16.15] - 2026-07-14

### Changed
- A persisted default project (prodex setup --project "X") now APPLIES under
  --new-chat, producing a fresh thread INSIDE the project. It used to be
  suppressed (old semantics: new-chat = root chat), which sent every
  default-projected consult to the general chat list - the opposite of why a
  default project is pinned. --target-url and --project-new still suppress it;
  an explicit --project still wins.

## [0.16.14] - 2026-07-14

### Fixed
- Concurrent prodex clients no longer corrupt each other's sends. Two sessions
  sharing the one dedicated browser tab interleaved composer input and
  navigation - measured live: one client's test prompt landed inside the other
  client's consult thread, and a 15-minute consult never actually posted (its
  acceptance signal came from the other client's activity). Visible-browser
  sends now hold a machine-global lock (~/.local/share/prodex/browser-send.lock,
  pid-liveness stale reaping): a second send queues behind the holder within
  its --busy-wait-ms budget, or fails fast naming the holder pid. Applies to
  ask and smoke.

## [0.16.13] - 2026-07-14

Shared-tab contention and post-creation transients, from a live sweep of the
remaining real-usage flows.

### Added
- `--busy-wait-ms <ms>` on visible-browser asks: when the tab is busy with
  another response (another agent or the user mid-generation), wait up to the
  given bound for it to finish instead of failing immediately. Progress shows
  the wait; a mid-wait page blocker (usage limit etc.) still fails fast.
  Verified against a genuine in-flight generation.

### Fixed
- `--project-new` aborted right after creating the project: the create-modal's
  closing overlay transiently covered the model selector, and a single
  hover-verify refusal failed the whole send. The selector click now retries
  briefly with fresh coordinates on a transient refusal (persistent covers
  still fail). Verified live end to end: create, select, send, and the thread
  URL carries the new project's slug.

### Tests
- In-page menu match predicate pinned in parity with menuItemLabelMatches
  across the full label matrix (badges, cross-match refusals, Korean labels).
- True key rotation pinned: receipts written after rotate verify under the new
  key alone; pre-rotation receipts do not.

## [0.16.12] - 2026-07-13

Project management usability: stop guessing names, notice wrong landings.

### Added
- `prodex pro browser projects` - read-only list of the sidebar project names
  exactly as ChatGPT renders them, so `--project` / `setup --project` never
  have to guess spelling or case. Polls briefly for sidebar hydration; failures
  carry port-aware guidance like `models`.
- `project_landing_warning`: when a project was requested but the answered
  thread's URL is a root `/c/` thread (in-project threads carry
  `/g/g-p-<project>/c/`), the send now warns on stderr and in the recorded
  result instead of leaving the mis-landing to a manual sidebar audit.

### Changed
- The `--project` not-found error now points at `prodex pro browser projects`.

## [0.16.11] - 2026-07-13

### Fixed
- `--new-chat --project` silently created the thread at ROOT instead of inside
  the project: the root new-chat navigation left the SPA composer bound to the
  root conversation target even after entering the project. When a project is
  requested, the root navigation is now skipped - the project home the
  selection step opens IS the fresh composer for "a new chat in this project".
  Verified live: the thread URL now carries the project slug
  (`/g/g-p-<project>/c/<thread>`), where broken runs produced a bare
  `/c/<thread>` root URL. Plain `--new-chat` (no project) is unchanged.

## [0.16.10] - 2026-07-13

### Fixed
- `--new-chat --project` failed with "project not found in sidebar (0 projects
  visible)": right after the new-chat navigation the sidebar's Projects section
  has not hydrated yet, and project selection checked it exactly once. The
  project row is now polled (up to 6s) - the same race class as the
  model-selector button after new-chat (0.15.7). Reproduced and verified live
  with the failing combination.

## [0.16.9] - 2026-07-13

### Fixed
- `--project` matching now falls back to a case-insensitive match when the
  exact name is not in the sidebar (an agent asking for "codex" resolves the
  sidebar's "Codex" when unambiguous; multiple case-insensitive matches fail
  loudly instead of guessing). The not-found error also says how matching
  works and how many projects were visible, without listing their names
  (sidebar project names are personal context and error text is persisted).

## [0.16.8] - 2026-07-13

Field report: a harness consult meant for GPT Pro silently ran on the
medium-effort thinking model, because the 2026-07 ChatGPT update reset the
UI's selected model and nothing pinned one.

### Fixed
- A send with NO model selection at all (no per-ask flag, no saved default)
  now emits and records `model_selection_warning`, naming the fix
  (`prodex setup --model Pro` or --model/--effort) - it previously used
  whatever the ChatGPT UI last had selected without any indication.
- Re-running `prodex setup` only to change browser-send defaults (e.g.
  `setup --model Pro`) no longer rotates the MCP token - rotation would
  silently 401 every client holding the old URL. The token now rotates only
  when explicitly requested via `--token` or `--token-ttl-hours`.

## [0.16.7] - 2026-07-13

Fixes from an xhigh multi-agent review of the 0.16.4-0.16.6 firefight range
(15 verified findings).

### Fixed
- `--project`: a stalled cross-project navigation could be silently accepted
  while the tab was still inside the OLD project (any `/g/g-p-` URL passed the
  already-inside check), sending the prompt into the wrong project. The
  unchanged-URL acceptance now also requires the REQUESTED project's name in
  the page title or heading (both carry it, measured live).
- Dialog auto-dismiss safety: Escape is no longer sent when the open dialog is
  itself the evidence of a real blocker (usage limit, verification, captcha) -
  the precise blocker is reported instead; a websocket failure during the
  dismiss no longer aborts the flow (connect is inside the best-effort guard);
  only a VISIBLE dialog is sampled; and when Escape cannot close the dialog,
  the not-ready error now names the dialog instead of suggesting a re-login.
- `--pro-mode` guidance: no longer swallows the real reason (a Plus plan with
  no Pro entry now says "Pro option not found" instead of claiming the UI
  removed sub-modes), and names `prodex setup --clear-pro-mode` for users whose
  saved default injects pro_mode into every plain ask. The submenu-model
  rejection text also stopped recommending the removed --pro-mode.
- `pro browser models`: a flag-validation error (e.g. `--timeout-ms abc`) is a
  plain usage error again instead of being dressed as a browser blocker, and
  port-aware guidance now reflects the resolved port (PRODEX_CDP_PORT
  included), not just the raw --port flag.
- `pro browser check`: an invalid PRODEX_CDP_PORT/--port/--timeout-ms is
  reported as the config/usage error it is (not "check failed"); a probe
  failure no longer skips the independent latest_pro section; and the
  check-failed next step is rewritten port/source-cli-aware like every other
  next step.

## [0.16.6] - 2026-07-10

### Fixed
- A retried `repo_write_file_apply` after a successful apply now says the write
  "was already applied" instead of the generic "File preimage changed" - a
  client retry after a lost response can tell "already done" from a real
  concurrent-modification conflict.
- `pro browser models --port <custom>` failures now suggest the login command
  with that port instead of the default-port command that would not fix the
  setup.
- `pro browser check` reports a failing in-page probe as a check failure with a
  next step (like doctor) instead of crashing with an internal
  "Runtime.evaluate failed".

### Tests
- The in-page answer extractor (`answerExpression`) is now behaviorally tested
  against a fake DOM (message counts, last-assistant answer, thinking
  placeholder, empty-message and no-message fallbacks) - previously the send
  loop's only data producer had no test.
- Added the fresh-preimage bypass test: an apply whose preimage matches the
  concurrently-changed file but not the reviewed receipt is rejected.

## [0.16.5] - 2026-07-10

More 2026-07 ChatGPT update compatibility, found by live-sweeping the
remaining selection paths.

### Fixed
- `--project` selection: the update made the sidebar project row a plain list
  item (no longer a link), so clicking it never navigated. Navigation now uses
  the row's "Open project home" button (verified live from both outside and
  inside the project), with the old row click kept as a fallback. An unchanged
  URL is also accepted when the tab is already on the project's home instead
  of failing with "did not navigate".
- `--pro-mode`: the update removed the Pro sub-mode submenu from the model
  picker entirely (verified live, including on hover) - Pro is a single mode
  now. The flag now fails with guidance to use `--model Pro` instead of a bare
  "expander not found".

## [0.16.4] - 2026-07-10

Compatibility with the 2026-07 ChatGPT web update (measured live).

### Fixed
- Model/effort menu matching survives label badges: the update renders a
  version chip next to a label (e.g. "Instant" + a "5.5" chip), which
  concatenates in textContent ("Instant5.5") and broke both exact and
  first-line matching. Menu predicates (and the Pro radio finder, the
  "available" error listing, and `pro browser models` output) now read
  innerText - where the badge stays on its own line - so the existing
  first-line tolerant match handles it. Verified live: `--effort 즉시`
  selects Instant and answers on the new UI.
- The update ships a "ChatGPT for Work" onboarding modal that puts the app
  behind aria-hidden, hiding the composer and the logged-in signals, so every
  send/models run reported "not ready". The page-settle path now detects an
  open dialog blocking the composer and dismisses it with Escape (bounded,
  only when the composer is actually blocked). Verified live.

### Fixed (release tooling)
- npm 12 changed `npm pack --json` from an array to an object keyed by package
  name, which broke `release pack`/`release status` (and the publish
  workflow's verification, which installs npm@latest). All pack-output parsing
  now accepts both shapes. Release verification failures also print a tail of
  the captured output instead of hiding the real error behind npm warnings.

### Changed
- Refreshed stale model-name examples in help text (GPT-5.5 -> GPT-5.6 Sol).

## [0.16.3] - 2026-07-08

Fixes from a second multi-angle audit (docs, dependencies/packaging, error-UX,
test coverage, MCP protocol, browser/CDP lifecycle).

### Fixed
- `prodex pro browser login` no longer opens a second Chrome window when the
  dedicated browser is already running: it detects the reachable instance and
  reuses it (Chrome's singleton otherwise honored `--new-window` and spawned a
  duplicate, which then blocked sends as `ambiguous_chatgpt_tabs`). This is the
  recurring "extra windows" problem.
- The MCP stdio transport no longer tears down the whole session on a single
  malformed frame - it reports the parse error and keeps processing the rest of
  the buffer (matching the SDK), so a valid pipelined message after a bad one is
  still delivered. Oversize frames remain fatal.
- `ask` with no prompt now shows an example (and the `--stdin` pipe form)
  instead of a bare "requires a prompt".
- The HTTP MCP `401` now returns a `hint` explaining how to authorize (no
  token-specific detail leaked).

### Changed
- The published package no longer ships source maps or `.d.ts` declarations
  (the package is bin-only, so they were dead weight) - roughly halves the
  unpacked install size.
- Documented `sessions cancel` in the top-level `--help`.

### Tests
- Added the previously-missing security reject-path tests: a wrong HTTP token
  (URL and bearer) returns 401, and a receipt whose signed body is tampered
  while the key is intact is rejected as untrusted.

## [0.16.2] - 2026-07-08

### Changed
- `bridge_list_results` / `listFinalizedResultsReadOnly` now reads the receipts
  directory once and indexes completion receipts by task id, instead of
  re-reading and re-parsing every receipt for each result (was O(results x
  receipts) on the list/completion path). Trust behavior is unchanged.
- Documented existing but previously unlisted flags: `tasks create --repo-id`
  / `--file` and `tasks block --command`.

## [0.16.1] - 2026-07-08

Second pass of the multi-angle audit backlog.

### Fixed
- An assistant message that posted with empty text (image-only reply, tool
  card, or a render-lag frame) no longer causes the send to return page chrome
  (sidebar + echoed prompt) as the "answer" - the page-tail fallback now applies
  only when there is no assistant message at all.
- Receipt integrity-key initialization is now exclusive-create: if two processes
  race to create it, the loser adopts the winner's key instead of clobbering it
  (a clobber would silently untrust every receipt already signed with the
  overwritten key).
- The CDP client now keeps a persistent websocket "error" listener, so a second
  post-open socket error can no longer surface as an unhandled event and crash
  the process.
- `prodex pro ask` (a dry-run preview) now rejects send-only flags (`--model`,
  `--effort`, `--port`, `--target-url`, `--project`, `--new-chat`, ...) with
  guidance to `pro browser ask`, instead of silently accepting and ignoring
  them (their values were not even validated).
- `prodex pro debate-prompt` no longer accepts a meaningless `--cwd` (it prints
  a prompt and never touches the ledger).

## [0.16.0] - 2026-07-08

Fixes from a multi-angle audit (concurrency, resource/error paths, security,
answer-extraction, CLI).

### Fixed
- The in-page "still generating" placeholder test over-matched any answer
  starting with "Thinking"/"Thought for"/"Thought about" (the twin of the
  0.15.7 `isUsableChatGptAnswer` fix, left behind in the page expressions). A
  real answer beginning with those words could cause a false "response in
  progress" send refusal or a false timeout with a bogus truncation warning.
  Both expressions now share one snippet kept in sync with the TS check.
- A crashed claim holder left a `.<task>.claim.lock` that nothing cleaned up,
  permanently wedging all future claims of that task. A lock older than the
  claim window (60s) is now reaped and the claim retried.
- The MCP stdio `send()` could hang forever (and leak a `drain` listener) if the
  reader died while the ~100KB write was backpressured; it now also settles on
  the stream's `error`/`close`.
- The answer acceptance/stability poll loops aborted the whole send on a
  transient CDP evaluate failure, discarding an already-streamed partial answer
  and skipping the salvage path; transient failures now retry.
- `--pro-mode` combined with a non-Pro `--model` was silently dropped; it now
  fails with a clear message.

### Security
- The ChatGPT conversation URL and project name no longer cross the MCP boundary
  via receipts (`metadata.thread`) or tasks (`provenance.thread`/`project`) -
  they are now redacted the same way sessions already were.

## [0.15.8] - 2026-07-08

### Added
- `prodex sessions cancel <session-id|latest>` marks a session blocked - clears a
  session left stuck in "running"/"preview" by an interrupted send (UX audit F15).
- `--json` on `tasks list`, `receipts list`, and `sessions list` emits the full
  records as JSON (empty list is a valid `[]`) for scripting (UX audit F6/F7).

## [0.15.7] - 2026-07-08

### Fixed
- Model/reasoning selection right after `--new-chat` intermittently failed with
  "model selector button not found": the selector lives in the composer form,
  which has not finished rendering immediately after the new-chat navigation.
  The selector button is now polled (up to 4s) instead of checked once
  (verified live: `--new-chat --effort High` now selects and answers). Found
  during live verification of this release.

### Changed
- Model/reasoning menu items are matched tolerantly - exact text OR first line -
  so a description or badge rendered on a second line (e.g. "High\nBalanced
  speed") no longer breaks selection. First-line (not prefix) matching still
  refuses to cross-match "High" with "Extra High" or "Pro" with "Pro Standard".
- `isUsableChatGptAnswer` no longer misclassifies a real answer that merely
  starts with "Thinking" (e.g. "Thinking about it, yes.") as a reasoning
  placeholder; only a single line that IS the reasoning header is treated as a
  placeholder.
- `init` reports ".bridge receipt ledger already initialized (no changes)." when
  re-run against an existing ledger instead of always claiming it initialized.

## [0.15.6] - 2026-07-08

### Changed
- Empty list commands now print a clear message instead of blank output:
  `tasks list`, `receipts list`, `sessions list`, and `pro list` say "No tasks
  yet." / "No receipts yet." / "No sessions yet." / "No GPT Pro consults yet."
  (with the status qualifier when `--status` is given), so a fresh or
  wrong-directory ledger is no longer indistinguishable from a crash.

## [0.15.5] - 2026-07-08

### Added
- `PRODEX_DEBUG_SEND=1` prints send diagnostics to stderr (baseline message
  counts, whether the prompt posted, and per-poll acceptance counts) for
  field-debugging send/acceptance issues. Off by default, no user-facing
  effect.

### Notes
- Follow-up on the 0.15.4 send fix: with the Enter-first submit, visible-browser
  sends are reliable under normal human-paced use (verified 6/6 at the default
  ~10s pacing). The residual failures seen during 0.15.4 debugging were
  reproduced only with pacing disabled (machine-speed back-to-back sends),
  which degrades the ChatGPT session - exactly what the built-in send pacing
  (`PRODEX_MIN_SEND_INTERVAL_MS`, default 10s) exists to prevent. Not a code
  defect.

## [0.15.4] - 2026-07-08

### Fixed
- Intermittent "ChatGPT never registered the prompt" failures, root-caused with
  live instrumentation to two issues in the send path:
  - The composer clear used an in-page Selection API select-all +
    `execCommand("delete")`, which desyncs ProseMirror's internal state so the
    prompt shows and the send button enables but a click never submits
    (confirmed with an A/B repro). prepare now only focuses; leftover text is
    cleared submit-safely via native CDP keyboard events (Ctrl+A, Backspace).
  - Submit is now sent with the Enter key (which targets the focused composer
    and is coordinate-free) instead of a click at captured coordinates. After
    the prompt lands the composer grows and the send button moves ~100px, so a
    click at the captured position missed the button entirely (measured live:
    captured y=583 while the button had moved to y=693). Clicking the send
    button, re-reading fresh coordinates and verifying the post each attempt,
    remains as a fallback for configs where Enter inserts a newline.

## [0.15.3] - 2026-07-08

### Fixed
- `--new-chat` no longer risks a false "ChatGPT never registered the prompt"
  timeout on a slow navigation. It previously navigated to a fresh chat then
  waited a fixed 1.5s; if the old thread was still rendered when the answer-
  count baseline was captured, acceptance (which needs the fresh thread's
  lower counts to exceed the old counts) could never trigger. It now waits for
  the tab to actually reach the fresh empty chat (root URL, zero messages)
  before baselining (`isFreshChatGptPage` / condition-based wait).
- Submit is now polled for up to 2s instead of a single check after a fixed
  300ms sleep. The send button reliably appears within ~200ms of the prompt
  landing (measured live), but a slow render moment could leave it briefly
  absent, and a single miss fell back to Enter and risked the prompt never
  posting.

## [0.15.2] - 2026-07-07

### Fixed
- Streaming detection no longer relies only on the stop-button's label text.
  During generation ChatGPT's send control becomes an icon-only stop button
  (`data-testid="stop-button"`) and the active assistant message carries
  `aria-busy="true"` (both measured live); the previous label regex could miss
  an icon-only/relabeled control and accept a mid-stream pause as the final
  answer, silently truncating it. `generating` now also checks these
  structural signals. Live-verified: a 40-line answer streams as `generating`
  and is captured complete.

## [0.15.1] - 2026-07-07

### Fixed
- Regression from 0.15.0: excluding the sidebar `nav` from the blocker-text
  scan also stripped it from the login/status text and button signals, so a
  logged-in Pro session was misdetected as "missing a clear logged-in ChatGPT
  session" and every send was falsely blocked (the logged-in signals - "New
  chat", "Projects", the profile button, the plan hint - live in the sidebar).
  Blocker detection and login detection now use separate text samples: blocker
  scanning stays nav-excluded (a sidebar chat title still cannot fake a
  blocker), while login/status detection keeps the sidebar. Live-verified: a
  real send that failed under 0.15.0 succeeds again.

## [0.15.0] - 2026-07-07

### Security
- Secret-file blocklist: the service-account guard was anchored
  (`^service-account.json$`) and trivially bypassed by any prefix - Firebase's
  `serviceAccountKey.json`, `<name>-service-account.json`, and
  `firebase-adminsdk-*.json` were readable/searchable through the ChatGPT HTTP
  MCP tools. It now blocks any filename containing service-account / adminsdk
  with a data extension, plus `secrets.{json,yaml,...}`, `.p8`, `.ovpn`, and
  `.tfvars`. Source modules (`secrets.ts`, `service-account.ts`,
  `credentials.ts`) stay readable. Found by a security audit with live PoCs.
- The `bridge_get_session` / `bridge_list_sessions` MCP tools no longer return
  the ChatGPT project name or thread URL - the same personal context receipts
  already redact - so a client on the semi-trusted HTTP MCP surface cannot
  enumerate them. The raw session file keeps them for local CLI inspection.

### Fixed
- Blocker detection no longer scans the ChatGPT sidebar: a past-chat title like
  "usage limit reset" or "verify human" in the history list used to match the
  blocker patterns and abort an otherwise valid send on every poll. The runtime
  blocker-text scan now excludes `nav`/`aside`/navigation (verified live: chat
  titles live inside the sidebar `<nav>`).
- Composer insertion now verifies the composer holds exactly the prompt
  (whitespace-normalized), not merely that it is non-empty. A failed clear that
  left stale text would otherwise silently submit a contaminated prompt.
- Concurrent `claimTask` calls can no longer both succeed: the claim is
  serialized behind an O_EXCL lock file, so a multi-agent bridge gets exactly
  one winner instead of a silent double-claim.
- `connectCdp` guards the message-listener `JSON.parse` (a malformed/binary
  frame is dropped instead of throwing uncaught) and fails fast if the socket
  closes during connect instead of waiting the full timeout.

### Changed
- UX polish from a breadth audit: `prodex ask` typos now suggest `ask` (it was
  missing from the suggestion table); `pro --help` lists `debate-prompt`;
  `--effort`/`--pro-mode` errors include the English aliases; and `pro ask`
  validation errors say `pro ask`, not the internal `ask-pro`.

## [0.14.0] - 2026-07-07

### Fixed
- Auto-recovery now relaunches the profile you last logged in with, not the
  fixed default. `pro browser login` records its profile dir + port
  (`~/.local/share/prodex/last-login.json`, `PRODEX_LAST_LOGIN_FILE` override),
  and `ask` recovery reads it back - a custom-profile user could otherwise be
  silently sent to a different account (or wait 2 minutes on a logged-out
  default profile). Found by an adversarial audit.
- `--json` now stays valid JSON on the blocked path: a login/captcha/limit/
  timeout blocker prints `{status:"blocked", blocker:{...}}` to stdout (the
  human error still goes to stderr), so a script can branch on the case it
  most needs to. Previously only the `done` path was JSON.
- `--new-chat` no longer silently enters a persisted default project; a fresh
  root chat is used (an explicit `--project` still wins). The pointless
  double navigation (root, then into the project) is gone.

### Changed
- Bridge registry hardening (on top of the 0.11.1 concurrency fix):
  roots are canonicalized with `realpath` so one bridge has one entry even
  via symlinked/relative spellings; roots whose directory no longer exists
  are pruned when a new root is registered; total entries are capped at 2000
  (newest kept). Registry work remains fully best-effort.

## [0.13.0] - 2026-07-07

### Added
- One-command recovery: when `prodex ask` / `pro browser ask` fails because no
  browser is running (`browser_unreachable`), an interactive terminal now
  launches the dedicated browser, waits until the saved session is READY, and
  retries the send once - no separate `pro browser login` step. `--auto-login`
  forces it for scripts, `--no-auto-login` disables it, and non-interactive
  runs stay off by default so a window never pops up unattended. Only
  `browser_unreachable` triggers recovery; every other blocker (login, captcha,
  usage limit, ...) reports as before. Live-verified: with the browser killed,
  a single `ask --auto-login` relaunched it, reached READY in 7s on the saved
  session, and returned the answer.

### Changed
- Terminal interactivity is now threaded through `CliIO.isInteractive`
  (defaults to `process.stdout.isTTY`) instead of read directly, so guided
  login and auto-recovery gate deterministically.

## [0.12.0] - 2026-07-07

### Added
- Pipe input into asks: `git diff | prodex ask --stdin "Review this diff"`
  appends piped stdin to the prompt (guarded: errors when nothing was piped
  or input exceeds 200k chars). Live-verified with a real diff summarized
  correctly through the browser.
- `--json` on visible-browser asks prints one structured object (task_id,
  status, thread, answer, warnings) to stdout instead of the tab header
  format, for script consumers; progress and the saved-artifact footer stay
  on stderr. Rejected on the dry-run preview path.
- `onboard` now opens with the standalone terminal flow (guided login,
  `ask --new-chat`, re-print), then the agent MCP section (including
  pro_consult and `pro debate-prompt`), then bridge health, then the
  ChatGPT Project HTTP MCP - matching the README narrative instead of the
  old bridge-first ordering.

### Fixed
- `pro browser ask` validation errors now name `pro browser ask` instead of
  the internal `ask-pro`; the `prodex ask` alias maps both spellings to
  `ask` (including the dry-run guidance sentence).

## [0.11.1] - 2026-07-07

### Fixed
- Bridge registry: concurrent registrations can no longer lose a root. Writes
  from one process are serialized, and a bounded verify-retry re-merges after
  a cross-process rename race (the registry also still self-heals on every
  later `ensure()`). Found by an adversarial audit (30 concurrent first
  registrations used to record 1).

## [0.11.0] - 2026-07-07

### Added
- Machine-wide bridge registry: every `BridgeStore.ensure()` records its
  bridge root in `~/.local/share/prodex/bridges.json` (absolute paths only -
  no task contents, no secrets), so local indexers can find scattered
  per-repo `.bridge` directories from one well-known file. The first
  consumer is sessionwiki's prodex adapter, which turns every bridge task
  (prompt + answer) into a searchable session. Best-effort by design: a
  registry failure never breaks a bridge operation; a corrupt registry is
  rebuilt; writes are atomic. `PRODEX_BRIDGES_REGISTRY` overrides the
  location (used by the hermetic test setup).

## [0.10.0] - 2026-07-07

### Added
- `--new-chat` for `prodex ask` / `pro browser ask` and `new_chat` for the
  `pro_consult` MCP tool: navigate to a fresh chat before sending. Long
  accumulated threads eventually break prompt-acceptance detection (measured
  live during a debate run), so agent loops and repeated consults should send
  each ask into a fresh chat. Incompatible with `--target-url`. Live-verified:
  a send parked on a polluted 11-message thread escaped to a new thread.
- `prodex pro debate-prompt [--topic "..."] [--rounds N]`: prints a
  paste-into-agent orchestration prompt for a structured debate between the
  agent (Claude/Codex) and the user's ChatGPT Pro via `pro_consult` - one
  self-contained consult per round, `new_chat: true` + `timeout_ms: 240000`
  reliability guidance baked in, blocked-consult retry loops forbidden, and a
  final synthesis that cites each round's receipt task_id. Rounds are capped
  at 5 to keep Pro usage low-volume. Validated live with a two-round debate.

## [0.9.1] - 2026-07-06

### Fixed
- Truncated Pro answers are no longer silent at runtime: `answer_incomplete`
  (and any other send warnings) now print to stderr and reach the MCP
  `pro_consult` notes, instead of living only inside the persisted receipt.
  An adversarial review found an agent calling `pro_consult` with a short
  `timeout_ms` would receive a cut-off answer marked `status:"done"` with no
  truncation signal.
- The Windows-host browser fallback under WSL keyed only on
  `WSL_DISTRO_NAME`, which real WSL non-login shells do not export (measured
  live), so it never activated where it mattered. Detection now also accepts
  `WSL_INTEROP` and a `/proc/version` kernel probe.
- The `prodex ask` alias no longer leaks the internal `ask-pro` command name
  in validation errors ("ask requires a prompt", not "ask-pro requires a
  prompt").
- The answer-stability caret guard now trims trailing whitespace before the
  suspect-tail check, so a streaming caret followed by a newline cannot slip
  through with only two confirmations.
- Millisecond flags (`--timeout-ms`, `--launch-timeout-ms`,
  `--wait-timeout-ms`) reject fractional values instead of silently treating
  `1.5` as 1.5ms; `--token-ttl-hours` keeps accepting fractions.

### Added
- `pro_consult` bridges send progress to MCP progress notifications when the
  client requests them (progressToken), so SDK-default clients that reset
  their request timeout on progress survive multi-minute consults. Verified
  end to end against a live browser through a real stdio MCP client.
- `pro browser check` echoes saved `browser_defaults` (model / pro-mode /
  effort / project) next to the live model hints.
- docs/clients.md: Codex needs `tool_timeout_sec` (its default tool timeout
  races prodex's Pro extended budget and it ignores progress notifications);
  Claude Code stdio needs no change (~28h default).

## [0.9.0] - 2026-07-06

### Added
- `prodex ask "..."` top-level shortcut for `prodex pro browser ask` with
  identical flags, and a restructured `--help` that opens with the flagship
  ask examples and groups commands into ask/consult, bridge ledger, agent/MCP
  integration, and maintenance sections.
- Live progress for visible-browser sends: connecting / tab ready / applying
  selection / prompt sent phases plus a throttled waiting heartbeat (elapsed
  seconds, generating|stabilizing) on stderr, so multi-minute Pro consults no
  longer look frozen. Applies to `pro browser ask` and `pro browser smoke`.
- Guided login: `pro browser login` in an interactive terminal now waits
  (default 5 minutes) until a logged-in ChatGPT tab with a visible composer is
  detected, narrating which manual step is still missing, and exits nonzero if
  readiness never arrives. `--wait` forces it for scripts, `--no-wait` skips,
  `--wait-timeout-ms` tunes the budget; non-TTY runs keep the old immediate
  return.
- `pro_consult` tool on the local stdio MCP server so Claude/Codex can ask
  ChatGPT directly through the same explicit visible-browser flow (pacing,
  receipts, artifacts identical to the CLI). The HTTP MCP surface never
  registers it, so nothing reachable through a tunnel or ChatGPT itself can
  drive the browser.
- `PRODEX_CDP_PORT` environment override for the DevTools port (explicit
  --port still wins), replacing ten scattered hardcoded 9333 fallbacks.
- Browser discovery now also probes macOS app bundles, Windows Program
  Files/LOCALAPPDATA installs, and Windows-host browsers under WSL; on Linux
  shells without DISPLAY/WAYLAND_DISPLAY, a present WSLg X socket injects
  DISPLAY=:0 so the browser launch does not die instantly in WSL.
- `doctor` reports an informational `chatgpt:` line (ok / not connected /
  partial with blocker code), so an all-green doctor no longer hides a missing
  browser setup; the line never fails doctor.

### Fixed
- Short answers no longer capture ChatGPT's streaming caret: the current UI
  renders the caret as a literal trailing underscore in the message text, and
  it can outlive the stop button, so a fast answer could be recorded as
  "TOKEN_" instead of "TOKEN" (measured live). Caret-suspect tails now require
  extra stable polls, converging on the finalized text; answers that genuinely
  end with an underscore are still accepted after the extra wait.

### Changed
- After a successful ask, a stderr footer names the saved artifact path and
  the `pro latest` re-print command. `send_timeout` blockers now suggest a
  paste-ready rerun command with a concrete doubled `--timeout-ms` value.
- README: the terminal quickstart uses `prodex ask` and documents the guided
  login and progress output; the MCP section is reframed as the optional
  "Agent Bridge Quick Start" instead of a second competing onboarding path.

## [0.8.3] - 2026-07-06

### Fixed
- Package `bin` path is now `dist/cli.js` (was `./dist/cli.js`). npm 11 rejects
  the `./` prefix and silently drops the bin entry on publish, which would ship
  a package with no `prodex` command. Older releases published under npm 10
  (which kept the `./` form) were unaffected, but the CI auto-publish uses the
  latest npm, so this is required for the tokenless release path. (0.8.2 was
  never published to npm — its CI publish surfaced this before it completed.)

## [0.8.2] - 2026-07-04

### Changed
- Releases now publish to npm from CI via npm trusted publishing (OIDC) with
  provenance, instead of a manually pasted token. A `v*.*.*` tag triggers
  `.github/workflows/publish.yml`, which verifies the tag matches
  `package.json`, runs `release:verify`, and runs
  `npm publish --provenance --access public`. No `NPM_TOKEN` is stored or
  exposed anywhere. One-time owner setup: add a GitHub Actions trusted
  publisher for this repo + `publish.yml` in the npmjs.com package settings,
  then revoke any old automation tokens.

## [0.8.1] - 2026-07-04

### Added
- Selector-rot diagnostic: when a send times out before the prompt ever posts
  (the composer still holds the text, or no send button was found), prodex now
  reports a `send_ui_changed` blocker — "the ChatGPT web UI may have changed" —
  with an update/report next step, instead of the misleading "raise
  --timeout-ms" latency message. The acceptance phase waits for the prompt to
  post, so a timeout there signals a broken submit (a UI change), not a slow
  model. A genuinely clean-but-slow submit still gets the timeout hint.

## [0.8.0] - 2026-07-03

### Fixed
- Restore visible-browser sends after a ChatGPT composer/editor change that
  had silently broken them. Three compounding causes, each fixed and
  live-verified end-to-end in a fresh chat:
  - Composer detection now requires real on-screen size (getBoundingClientRect
    width/height), so the hidden 0x0 fallback `<textarea>` that precedes the
    real ProseMirror editor is no longer picked (it had accepted a `.value`
    write as a false success while the real editor stayed empty).
  - The prompt is now typed with native CDP `Input.insertText` into the focused
    editor instead of in-page `execCommand`/value writes, which ProseMirror
    ignores for its internal model (so the send posted an empty message).
  - Submit performs a real CDP mouse click on the send button (from a fresh
    `getBoundingClientRect`) instead of a synthetic `button.click()`, which
    ChatGPT's React handler ignores; prepare no longer writes a marker
    attribute onto the composer form (that re-rendered/reset the editor).
- `connectCdp` now bounds every connect and command with a default 20s timeout
  even when the caller passes none, so a frozen/half-open browser socket makes
  the poll loop error out instead of hanging indefinitely.

## [0.7.4] - 2026-07-03

### Fixed
- Tighten the 0.7.3 secret-file blocklist to remove false positives found in an
  adversarial regression review: a directory or module named `credentials`/
  `service-account` (e.g. `credentials.ts`, `src/credentials/oauth.ts`,
  `service_account.py`) is no longer blocked — those names now require a
  data/config extension (`credentials.json`, `service-account.json` stay
  blocked). Secret extensions match only as the final extension, so
  `foo.key.ts` / `using.gpg.md` are allowed while `server.pem` / `tls.key`
  stay blocked; `.asc` (public GPG signatures / AsciiDoc) is no longer treated
  as secret; `*.tfstate.backup` remains blocked explicitly.

## [0.7.3] - 2026-07-03

### Fixed
- CI/release: `npm run build` now marks the packaged bin `dist/cli.js`
  executable (new `postbuild` step), so `release:check` and `npm publish` no
  longer need a manual `chmod +x`. This fixes the GitHub Actions
  release-verify job, which failed on every push with "package bin entries
  must be executable: dist/cli.js".
- Visible-browser sends that time out while the answer is still streaming now
  salvage the partial text and return it with an `answer_incomplete` warning
  instead of discarding minutes of Pro reasoning; the answer is saved as a
  normal done consult with the warning recorded on the receipt.

### Changed
- Timeouts now surface as a dedicated `send_timeout` blocker with a
  "raise --timeout-ms" next step instead of the generic `browser_send_failed`
  bucket, and the timeout error messages include the elapsed budget.

## [0.7.2] - 2026-07-03

### Security
- Broaden the repo tool sensitive-path blocklist beyond `.env`/`.git`/
  `.bridge`/`node_modules`/`dist` to cover common in-repo credential and key
  material — `.npmrc`, `.netrc`, `.pgpass`, `.git-credentials`, `id_rsa`/
  `id_ed25519` and friends, `*.pem`/`*.key`/`*.p12`/`*.pfx`/`*.jks`/`*.ppk`/
  `*.kdbx`, `*.tfstate`, `*.gpg`/`*.asc`, `credentials.*`, `service-account.*`,
  and the `.ssh`/`.aws`/`.gnupg`/`.gcloud`/`.azure`/`.kube`/`.docker`
  directories. Applies to `repo_read_file`, `repo_search` (path filter + rg
  excludes), and the `repo_write_file_*` flow, so a remote MCP caller can no
  longer read or overwrite these in-repo secret files. Traversal/symlink
  escape outside the repo was already blocked. Matching is conservative so
  ordinary files (e.g. `keyboard.ts`, `notes/secretsanta.md`) are unaffected;
  it is defense in depth, not an exhaustive secret scanner. README wording
  corrected accordingly.

## [0.7.1] - 2026-07-03

### Changed
- Tab activation is now opt-in (`PRODEX_ACTIVATE_TAB=1`) instead of on by
  default. Bringing the window to the front steals OS focus, which disrupts
  background/agent-loop use; since a non-minimized window (even behind other
  windows) already counts as visible, the default now sends without touching
  window focus and reports the tab_not_visible blocker only when the window is
  minimized or on another tab. This matches how comparable bridges
  (browser-use, OpenCLI) avoid moving the user's visible window.

## [0.7.0] - 2026-07-03

### Added
- Visible-browser sends now bring the ChatGPT tab to the front automatically
  (DevTools activate) before enforcing the visible-tab requirement, so a tab
  merely covered by another recovers instead of failing; a fully minimized
  window still stops with `tab_not_visible`.
- Human-pacing for visible-browser sends: consecutive sends are auto-throttled
  to one per `PRODEX_MIN_SEND_INTERVAL_MS` (default 10000 ms; `0` disables),
  tracked per repo in `.bridge/last-browser-send`, to keep an agent loop from
  hammering ChatGPT at machine speed.
- README: standalone "Pro second opinion" quickstart and an FAQ covering
  visibility, pacing, UI language, and account considerations.

### Changed
- Page status is now read with a short settle-and-retry so a transient SPA
  re-render right after a project hop is not misreported as "no composer".
- Answer completion now requires two consecutive stable, non-generating polls
  (was one), so a mid-stream pause is not mistaken for the final answer.

## [0.6.1] - 2026-07-03

### Changed
- Internal: second pass of the cli.ts decomposition. Command handlers move
  into cli-ledger.ts (tasks/results/receipts/sessions), cli-server.ts
  (init/setup/start/status/tunnel), and cli-pro.ts (pro/ask-pro/legacy
  chatgpt), with shared source-aware messaging in cli-shared.ts; cli.ts
  shrinks from ~4,100 to ~1,700 lines. No behavior change: help output
  verified byte-identical, full test suite and package smoke green.

## [0.6.0] - 2026-07-03

### Added
- English (US) ChatGPT UI support for the selection flags: efforts, Pro
  sub-modes, project rows, and the new-project button match both locales'
  labels (Instant/Medium/High/Extra High, Pro Standard/Extended, "Open
  project options for", "New project"), captured and verified live.
  `parseReasoningEffort` also accepts the English menu labels as input.

### Changed
- Internal: cli.ts split into cli-args.ts (argument parsing) and
  cli-help.ts (help text, CLI version); no behavior change, help output
  verified byte-identical.
- Model-prefixed English thinking placeholders are treated as still
  generating, matching the Korean behavior.

## [0.5.0] - 2026-07-03

### Added
- `--project-new "name"` creates a ChatGPT project from the sidebar popover
  (name typed, committed with Enter, navigation verified) and sends inside it.
  It cannot be combined with `--target-url` and never comes from saved
  defaults.
- `setup --interactive`: a short wizard that collects the browser-send
  defaults (model, Pro sub-mode or effort, project) instead of flags.
- `receipts rotate-key`: rotates the local receipt-integrity HMAC key. The key
  file now holds one key per line — the first signs new receipts, the rest are
  kept so receipts signed before a rotation still verify.

### Changed
- Non-Korean ChatGPT UIs get a documented escape hatch: `--model "<exact
  label>"` clicks any radio entry in the picker, and the composer-button
  detection now also excludes common English control labels.

## [0.4.0] - 2026-07-02

### Added
- `pro browser models`: read-only listing of the model menu options the visible
  ChatGPT tab currently shows (opens the menu, reads labels, presses Escape).
- `setup --clear-model / --clear-pro-mode / --clear-effort / --clear-project`
  to remove individual saved browser-send defaults.
- `status` output now includes `browser_defaults`.

### Changed
- `--pro-mode 확장` raises the default send timeout from 90000 ms to 300000 ms
  (an explicit `--timeout-ms` still wins).
- Selection clicks are now guarded: targets are scrolled into view and refused
  when covered by another element, menu open/close is polled instead of fixed
  sleeps, and a menu that stays open after a pick is treated as a failed
  selection. On any selection error the menu is closed with Escape before the
  blocker is reported.
- Selecting a model whose menu entry opens a submenu of variants (for example
  GPT-5.5) now fails fast with a clear error instead of silently keeping the
  previous model.
- `--project` now verifies that the sidebar click actually navigated and that
  the composer is ready before sending.
- Receipt display output (`receipts list/show`, MCP receipt tools) redacts the
  ChatGPT project name from `metadata.selection`; the raw receipt file keeps it
  for local inspection.

### Fixed
- `--target-url --confirm-target` can no longer be combined with `--project`,
  which could navigate away from the confirmed tab after the check; a saved
  default project is likewise ignored when `--target-url` is used.
- The Pro radio is matched by prefix: its visible label carries the active
  sub-mode (for example "Pro 확장"), which broke exact-text matching for
  `--pro-mode` and `--model Pro` whenever a sub-mode was already selected.
- Model-prefixed thinking placeholders (for example "Pro 생각 중") are no
  longer accepted as the final answer; the poll keeps waiting for the real
  response.

## [0.3.0] - 2026-07-02

### Added
- Model, reasoning-effort, and project selection for visible-browser sends:
  `pro browser ask --model / --pro-mode 기본|확장 / --effort 즉시|중간|높음|"매우 높음" /
  --project "name"` (English effort aliases instant/medium/high/max).
- `setup --model/--pro-mode/--effort/--project` persists browser-send defaults
  in `.bridge/config.local.json` (`browser_defaults`); per-ask flags override
  them.
- Applied selections are recorded on the consult receipt
  (`metadata.selection`).
- `--project-new` is reserved and fails fast until new-project automation is
  verified live.

### Fixed
- Pro sub-mode selection uses the chevron expander next to the Pro radio
  (clicking the Pro radio itself commits Pro and closes the menu).
- `repo_search` resolves ripgrep via absolute-path fallbacks when the MCP
  server is spawned with a narrowed PATH.

## [0.2.0] - 2026-07-01

### Added
- Initial public release as `@youdie006/prodex`: local CLI + MCP bridge
  (stdio and loopback HTTP) that coordinates coding agents with a logged-in
  ChatGPT Pro browser session over raw CDP, with HMAC-signed durable receipts
  under `.bridge/`.
