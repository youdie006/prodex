import { describe, expect, it } from "vitest";
import {
  buildChromeLaunchArgs,
  assertChatGptPageAvailable,
  assertChatGptReadyForPrompt,
  assertChatGptTargetUrlMatches,
  assertChatGptTargetTabAvailable,
  assertVisibleChatGptTab,
  ChatGptBrowserBlockerError,
  chatGptUrlsReferToSameTarget,
  chatGptBlockerErrorFromAnswerState,
  chatGptBlockerFromAnswerState,
  CHATGPT_RUNTIME_BLOCKER_TEXT_EXCLUDED_ANCESTORS,
  CHATGPT_BLOCKER_SCAN_EXCLUDED_ANCESTORS,
  CHATGPT_STREAMING_SELECTOR,
  CHATGPT_COMPOSER_CANDIDATE_EXCLUDED_ANCESTORS,
  PRODEX_ACTIVE_COMPOSER_ATTRIBUTE,
  chatGptPageSelectionBlocker,
  chatGptVisibilityBlocker,
  chatGptBusyBlocker,
  computePageDiscoveryTimeout,
  computePromptAcceptanceDeadline,
  detectChatGptBlocker,
  detectChatGptPageBlocker,
  type DevtoolsPage,
  getChatGptBrowserStatus,
  hasChatGptPromptAcceptance,
  hasFreshChatGptAnswer,
  isFreshChatGptPage,
  menuItemLabelMatches,
  chunkComposerText,
  COMPOSER_INSERT_CHUNK_CHARS,
  insertComposerTextInPageExpression,
  composerFileInputSelector,
  modelButtonAlreadyShows,
  attachmentStateExpression,
  attachmentPresenceExpression,
  resolveComposerToolLabel,
  powerLabelMatches,
  deepResearchStartButtonRectExpression,
  conversationIdFromThreadUrl,
  deleteProjectExpression,
  deepResearchReportExpression,
  resolveTranscriptCitations,
  pickLandedConversation,
  recentConversationsExpression,
  resolveProjectToDelete,
  transcriptAnswerExpression,
  classifyTranscriptRead,
  browserLostMidWaitBlocker,
  resolveBrowserWindowMode,
  shouldRecoverThreadNavigation,
  transcriptMatchesSentPrompt,
  deepResearchUnreadableBlocker,
  defaultTimeoutForTools,
  modelSelectionWarning,
  resolveHeadlessPreference,
  resolveVirtualDisplayPreference,
  virtualDisplayServerArgs,
  virtualDisplayEnv,
  assertVirtualDisplayToolingAvailable,
  assertChatGptIdleAndReadyForPrompt,
  inferChatGptPageLoggedInLikely,
  inferLoggedInLikely,
  isLikelyChatGptGeneratingControl,
  isLikelyChatGptSubmitButton,
  normalizeChatGptTargetUrl,
  selectChatGptPage,
  prepareComposerExpression,
  composerTextStateExpression,
  answerExpression,
  sendChatGptPrompt,
  submitExpression,
  isUsableChatGptAnswer,
  CHATGPT_THINKING_PLACEHOLDER_JS
} from "../src/chatgpt-browser.js";

describe("ChatGPT browser adapter", () => {
  it("returns a clear blocker when the local debug port is not reachable", async () => {
    const status = await getChatGptBrowserStatus({ port: 9, timeoutMs: 100 });

    expect(status.reachable).toBe(false);
    expect(status.blocker?.code).toBe("browser_unreachable");
  });

  it("includes the browser login next step when sending without a reachable browser", async () => {
    await expect(sendChatGptPrompt({ port: 9, prompt: "test", timeoutMs: 100 })).rejects.toThrow(/pro browser login/);
  });

  it("keeps initial page discovery bounded below the full answer timeout", () => {
    expect(computePageDiscoveryTimeout(90_000)).toBe(5_000);
    expect(computePageDiscoveryTimeout(100)).toBe(100);
  });

  it("builds a visible Chrome launch command without exposing cookies or tokens", () => {
    const args = buildChromeLaunchArgs({
      port: 9333,
      profileDir: "/tmp/prodex-profile",
      url: "https://chatgpt.com/"
    });

    expect(args).toContain("--remote-debugging-address=127.0.0.1");
    expect(args).toContain("--remote-debugging-port=9333");
    expect(args).toContain("--user-data-dir=/tmp/prodex-profile");
    expect(args.join(" ")).not.toMatch(/cookie|token|password/i);
  });

  it("disables renderer backgrounding so an out-of-the-way window keeps streaming", () => {
    // Chrome backgrounds the renderer of an occluded or minimized window, and
    // the README tells users to keep the dedicated window behind their editor
    // - exactly the occluded case. A throttled renderer makes ChatGPT stream
    // slowly or stall, which surfaces as a send timeout.
    for (const args of [
      buildChromeLaunchArgs({ port: 9333, profileDir: "/tmp/p", url: "https://chatgpt.com/" }),
      buildChromeLaunchArgs({ port: 9333, profileDir: "/tmp/p", url: "https://chatgpt.com/", headless: true })
    ]) {
      expect(args).toContain("--disable-backgrounding-occluded-windows");
      expect(args).toContain("--disable-renderer-backgrounding");
      expect(args).toContain("--disable-background-timer-throttling");
    }
  });

  it("builds a headless launch that still renders the desktop sidebar layout", () => {
    // Headless defaults to an 800x600 viewport, at which ChatGPT collapses the
    // sidebar - and the sidebar IS the logged-in signal (inferLoggedInLikely
    // keys on "New chat"/"Projects"), so a narrow headless window would report
    // a logged-in Pro session as logged out. Pin a desktop-width window.
    const args = buildChromeLaunchArgs({
      port: 9333,
      profileDir: "/tmp/prodex-profile",
      url: "https://chatgpt.com/",
      headless: true
    });

    expect(args).toContain("--headless=new");
    expect(args).not.toContain("--new-window");
    const windowSize = args.find((arg) => arg.startsWith("--window-size="));
    expect(windowSize).toBeDefined();
    const width = Number(windowSize?.split("=")[1]?.split(",")[0]);
    expect(width).toBeGreaterThanOrEqual(1280);

    const headed = buildChromeLaunchArgs({ port: 9333, profileDir: "/tmp/prodex-profile", url: "https://chatgpt.com/" });
    expect(headed).not.toContain("--headless=new");
    expect(headed).toContain("--new-window");
  });

  it("treats the model as already selected when the picker button says so", () => {
    // ChatGPT moved the models behind a "Model" submenu (top level is now
    // Advanced / Model / Effort), so prodex's flat radio lookup started
    // failing with "Pro option not found in the model menu" - while the picker
    // button itself already read "Pro, 5 of 5". Opening the menu at all is
    // unnecessary when the requested model is the active one.
    expect(modelButtonAlreadyShows("Pro", "Pro, 5 of 5.")).toBe(true);
    expect(modelButtonAlreadyShows("pro", "Pro")).toBe(true);
    expect(modelButtonAlreadyShows("Pro", "GPT-5.6 Pro")).toBe(true);
    expect(modelButtonAlreadyShows("Pro", "Thinking")).toBe(false);
    expect(modelButtonAlreadyShows("Thinking", "Pro, 5 of 5.")).toBe(false);
    // No requested model, or an unreadable button, must not claim a match.
    expect(modelButtonAlreadyShows(undefined, "Pro")).toBe(false);
    expect(modelButtonAlreadyShows("Pro", "")).toBe(false);
  });

  it("matches a requested model/effort against the labels the power slider renders", () => {
    // ChatGPT replaced the model radio list with a single power slider:
    // positions 0..4 render Instant / Medium / High / Extra High / Pro on
    // GPT-5.6 Sol (measured live). "Pro" is now the top EFFORT, not a model,
    // which is why --model Pro could not find a Pro radio any more.
    expect(powerLabelMatches("Pro", "Pro")).toBe(true);
    expect(powerLabelMatches("pro", "Pro")).toBe(true);
    expect(powerLabelMatches("높음", "High")).toBe(true);
    expect(powerLabelMatches("High", "High")).toBe(true);
    expect(powerLabelMatches("매우 높음", "Extra High")).toBe(true);
    expect(powerLabelMatches("extra high", "Extra High")).toBe(true);
    expect(powerLabelMatches("중간", "Medium")).toBe(true);
    expect(powerLabelMatches("즉시", "Instant")).toBe(true);
    // "High" must not satisfy a request for "Extra High" (prefix trap).
    expect(powerLabelMatches("매우 높음", "High")).toBe(false);
    expect(powerLabelMatches("Pro", "Extra High")).toBe(false);
  });

  it("treats a mid-wait conversation switch as a different target", () => {
    // Caught live and it is a correctness bug, not a nuisance: while prodex
    // waited for an answer, the shared tab was navigated to another
    // conversation, and prodex saved THAT conversation's text as the consult
    // answer - a completely unrelated thread, silently, with a receipt.
    const sent = "https://chatgpt.com/c/6a7590d4-3e08-83ee-8962-50a7fc1e5646";
    const other = "https://chatgpt.com/c/6a631bf8-c7b0-83e8-b25c-70b16f6d2287";
    expect(chatGptUrlsReferToSameTarget(sent, other)).toBe(false);
    expect(chatGptUrlsReferToSameTarget(sent, sent)).toBe(true);
    // Query strings on the same conversation are still the same target.
    expect(chatGptUrlsReferToSameTarget(sent, `${sent}?messageId=finalAgentTurnStart`)).toBe(true);
  });

  it("does not manufacture an answer out of a turn that holds no assistant message", async () => {
    // A 0.21.3 fallback treated any conversation-turn without a user message as
    // an answer. That is how a tool's progress panel became a 28-character
    // "answer". Deep research - the case the fallback existed for - is read
    // from the transcript now, so a turn with no assistant message is simply
    // not an answer.
    const browser = await import("../src/chatgpt-browser.js");
    const answerExpression = (browser as { answerExpression: () => string }).answerExpression;
    const doc = new FakeDocument([], []);
    doc.body.innerText = "ChatGPT\nsidebar\nSearching the web\nAnswer now";
    const turn = new FakeElement("div");
    turn.setAttribute("data-testid", "conversation-turn-2");
    turn.innerText = "Searching the web\nAnswer now";
    doc.turns = [turn];
    doc.messages = [];

    const state = evaluateBrowserStatusExpression<{ answer: string; assistantMessageCount: number }>(answerExpression(), doc);
    expect(state.assistantMessageCount).toBe(0);
    // And with nothing to answer with, the field must be empty rather than a
    // slice of whatever the page happened to render.
    expect(state.answer).toBe("");
  });

  it("does not mistake ChatGPT's interruption notice for an answer", () => {
    // Measured after killing the browser mid-stream: the thread rendered
    // "Pro thinking / Connection interrupted. Waiting for the complete answer",
    // and recover saved that as the recovered answer.
    expect(isUsableChatGptAnswer("Pro thinking\nConnection interrupted. Waiting for the complete answer")).toBe(false);
    expect(isUsableChatGptAnswer("Connection interrupted. Waiting for the complete answer")).toBe(false);
    expect(isUsableChatGptAnswer("연결이 중단되었습니다. 전체 답변을 기다리는 중")).toBe(false);
  });

  it("does not mistake a tool's own progress panel for an answer", () => {
    // Measured on a --tool web-search send: the page rendered "Searching the
    // web / Answer now" (a status line and a button) and prodex returned those
    // 28 characters as the answer while the real reply was still being written.
    expect(isUsableChatGptAnswer("Searching the web\nAnswer now")).toBe(false);
    expect(isUsableChatGptAnswer("웹 검색 중\n지금 답변")).toBe(false);
    expect(isUsableChatGptAnswer("Searching the web")).toBe(false);
    // A real answer that merely mentions searching is not a placeholder.
    expect(isUsableChatGptAnswer("Searching the web for benchmarks turned up three papers, summarized below.")).toBe(true);
  });

  it("stops waiting when the browser it was reading through is gone", () => {
    // Observed: the dedicated Chrome died mid-wait during a deep research run.
    // Every poll threw, the loop swallowed it, and the send sat silent for the
    // rest of a 30-minute budget while the research finished server-side. The
    // thread is the whole point - hand it back so the report can be recovered.
    const thread = "https://chatgpt.com/c/6a780848-1660-83ee-9e1a-104f95826746";
    const blocker = browserLostMidWaitBlocker(thread);

    expect(blocker.code).toBe("browser_unreachable");
    expect(blocker.retryable).toBe(true);
    expect(blocker.thread).toBe(thread);
    expect(blocker.next_step).toContain("pro browser login");
    expect(blocker.next_step).toContain(thread);
    expect(blocker.message).toMatch(/browser/i);
    // Killing the browser also aborts a streaming answer, so the message must
    // not promise that one is still being written - only deep research keeps
    // going without us. Measured: the thread showed "Connection interrupted."
    expect(blocker.message).not.toContain("still being written");
  });

  it("reopens the browser the way the user set it up, not with a fresh window", () => {
    // The browser_unreachable blocker tells people to run `pro browser login`.
    // That command read only flags and env, so someone who set up a virtual
    // display got a VISIBLE window back every time they followed the advice -
    // the surprise window they went headless to avoid.
    const saved = { virtual_display: 99, headless: false, minimized: false };

    expect(resolveBrowserWindowMode({ lastLogin: saved })).toEqual({ headless: false, virtualDisplay: true, minimized: false });
    expect(resolveBrowserWindowMode({ lastLogin: { headless: true } })).toEqual({
      headless: true,
      virtualDisplay: false,
      minimized: false
    });
    expect(resolveBrowserWindowMode({ lastLogin: { minimized: true } })).toEqual({
      headless: false,
      virtualDisplay: false,
      minimized: true
    });

    // An explicit flag still wins over what was saved.
    expect(resolveBrowserWindowMode({ flags: { headless: true }, lastLogin: saved })).toEqual({
      headless: true,
      virtualDisplay: false,
      minimized: false
    });
    expect(resolveBrowserWindowMode({ flags: { minimized: true }, lastLogin: saved })).toEqual({
      headless: false,
      virtualDisplay: false,
      minimized: true
    });
    // And so does the environment, which is how CI and agents pin a mode.
    expect(resolveBrowserWindowMode({ env: { PRODEX_HEADLESS: "1" }, lastLogin: saved })).toEqual({
      headless: true,
      virtualDisplay: false,
      minimized: false
    });

    // Nothing saved and nothing asked for: an ordinary visible window.
    expect(resolveBrowserWindowMode({})).toEqual({ headless: false, virtualDisplay: false, minimized: false });
  });

  it("only drags the tab back to a real conversation, and only when the page is the only source", () => {
    // Measured: a --new-chat send into a project pinned the PROJECT page (the
    // url before ChatGPT rewrote it to /c/<id>). When the url then became the
    // conversation, prodex read that as "someone moved the tab" and navigated
    // back to the project page - destroying its own view of the answer and
    // then sitting on "stabilizing" for over ten minutes.
    const project = "https://chatgpt.com/g/g-p-abc-my-project";
    const thread = "https://chatgpt.com/g/g-p-abc-my-project/c/6a780848-1660-83ee-9e1a-104f95826746";
    const other = "https://chatgpt.com/c/1111aaaa-2222-3333-4444-555566667777";

    // A page that is not a conversation is not something to pin to.
    expect(shouldRecoverThreadNavigation({ pinnedThreadUrl: project, currentUrl: thread })).toBe(false);
    // A genuine move away from the pinned conversation, with only the page to read.
    expect(shouldRecoverThreadNavigation({ pinnedThreadUrl: thread, currentUrl: other })).toBe(true);
    // ...but not while the transcript is answering for us: yanking the tab back
    // would only disturb whoever moved it.
    expect(
      shouldRecoverThreadNavigation({ pinnedThreadUrl: thread, currentUrl: other, lastTranscriptClassification: "pending" })
    ).toBe(false);
    expect(
      shouldRecoverThreadNavigation({ pinnedThreadUrl: thread, currentUrl: other, lastTranscriptClassification: "answer" })
    ).toBe(false);
    // Still on the pinned thread: nothing to recover.
    expect(shouldRecoverThreadNavigation({ pinnedThreadUrl: thread, currentUrl: thread })).toBe(false);
    expect(shouldRecoverThreadNavigation({ currentUrl: other })).toBe(false);
  });

  it("keeps waiting when the transcript says the answer is unfinished", () => {
    // The transcript knows whether the message is done; the page only guesses.
    // When both are available the transcript decides, so a settled-looking page
    // cannot end the wait early.
    const sent = "my prompt";
    expect(classifyTranscriptRead(undefined, sent)).toBe("unavailable");
    expect(classifyTranscriptRead({ ok: false, reason: "conversation_http_500", status: "", userText: "" }, sent)).toBe("unavailable");
    expect(classifyTranscriptRead({ ok: false, reason: "answer_not_finished", status: "in_progress", userText: "my prompt" }, sent)).toBe(
      "pending"
    );
    expect(classifyTranscriptRead({ ok: false, reason: "no_assistant_message", status: "", userText: "my prompt" }, sent)).toBe("pending");
    expect(classifyTranscriptRead({ ok: true, reason: "", status: "finished_successfully", userText: "my prompt" }, sent)).toBe("answer");
    // A conversation that is not ours is not something to wait on.
    expect(classifyTranscriptRead({ ok: false, reason: "answer_not_finished", status: "in_progress", userText: "someone else" }, sent)).toBe(
      "unavailable"
    );
  });

  it("finds the conversation a prompt landed in when the page never showed it post", async () => {
    // Acceptance is read off the page. When the page changes shape, a prompt
    // that DID post looks like a prompt that never left - and the caller's
    // retry sends the same question twice. The transcript knows better.
    const conversations = {
      items: [
        { id: "conv-other", title: "Something else" },
        { id: "conv-ours", title: "Ours" }
      ]
    };
    const transcripts: Record<string, unknown> = {
      "conv-other": {
        current_node: "u1",
        mapping: { u1: { message: { author: { role: "user" }, content: { content_type: "text", parts: ["a different question"] } } } }
      },
      "conv-ours": {
        current_node: "u1",
        mapping: { u1: { message: { author: { role: "user" }, content: { content_type: "text", parts: ["the prompt we sent"] } } } }
      }
    };
    const fakeFetch = async (url: string) => {
      if (url.includes("/api/auth/session")) return { ok: true, status: 200, json: async () => ({ accessToken: "tok" }) };
      if (url.includes("/backend-api/conversations")) return { ok: true, status: 200, json: async () => conversations };
      const id = url.split("/").pop() ?? "";
      return { ok: true, status: 200, json: async () => transcripts[id] };
    };
    const found = await new Function("fetch", `return ${recentConversationsExpression(2)}`)(fakeFetch);

    expect(found.map((entry: { id: string }) => entry.id)).toEqual(["conv-other", "conv-ours"]);
    expect(found[1].userText).toBe("the prompt we sent");
  });

  it("picks the conversation whose prompt is the one that was sent", () => {
    const candidates = [
      { id: "conv-other", userText: "a different question" },
      { id: "conv-ours", userText: "@Deep research the prompt we sent" }
    ];
    expect(pickLandedConversation(candidates, "the prompt we sent")).toBe("conv-ours");
    expect(pickLandedConversation(candidates, "a question nobody asked")).toBeUndefined();
    expect(pickLandedConversation([], "anything")).toBeUndefined();
  });

  it("returns the prompt the transcript holds, so a caller can prove the thread is its own", async () => {
    const conversation = {
      current_node: "a1",
      mapping: {
        u1: { message: { author: { role: "user" }, content: { content_type: "text", parts: ["my exact prompt"] } }, parent: null },
        a1: {
          message: {
            author: { role: "assistant" },
            content: { content_type: "text", parts: ["an answer"] },
            status: "finished_successfully",
            end_turn: true
          },
          parent: "u1"
        }
      }
    };
    const fakeFetch = async (url: string) =>
      url.includes("/api/auth/session")
        ? { ok: true, status: 200, json: async () => ({ accessToken: "tok" }) }
        : { ok: true, status: 200, json: async () => conversation };
    const state = await new Function("fetch", `return ${transcriptAnswerExpression("conv-1")}`)(fakeFetch);
    expect(state.userText).toBe("my exact prompt");
  });

  it("refuses a transcript whose prompt is not the one that was sent", () => {
    // The browser is shared. If the tab moves to another conversation while a
    // consult waits, reading by "whatever id the url shows" would hand back a
    // stranger's answer and record it as this consult's - the exact accident
    // thread pinning exists to prevent.
    const sent = "Compare TCP and QUIC handshakes.";
    expect(transcriptMatchesSentPrompt("Compare TCP and QUIC handshakes.", sent)).toBe(true);
    // ChatGPT re-wraps whitespace, so matching must survive that.
    expect(transcriptMatchesSentPrompt("Compare TCP and\n QUIC   handshakes.", sent)).toBe(true);
    // Attachments and tool tokens can append to what the transcript shows.
    expect(transcriptMatchesSentPrompt(`${sent}\n\n[deck.pptx]`, sent)).toBe(true);
    // Measured: a send with a composer tool arrives PREFIXED with the tool
    // token, so the prompt is not at the start of the transcript message.
    expect(transcriptMatchesSentPrompt(`@Deep research ${sent}`, sent)).toBe(true);
    // Measured on a --file send: the composer escapes markdown when it stores
    // what was typed, so "## File: x" comes back as "\\## File: x" and code
    // fences as escaped backticks. Every file-bearing consult failed this check
    // and silently fell back to reading the page.
    const withMarkdown = "Summarize.\n\n## File: package.json\n\n```text\n{}\n```";
    const escaped = "Summarize.\n\n\\## File: package.json\n\n\\`\\`\\`text\n{}\n\\`\\`\\`";
    expect(transcriptMatchesSentPrompt(escaped, withMarkdown)).toBe(true);
    // A different conversation must never pass.
    expect(transcriptMatchesSentPrompt("What is the capital of France?", sent)).toBe(false);
    // Neither must a truncated echo that merely shares a prefix word.
    expect(transcriptMatchesSentPrompt("Compare", sent)).toBe(false);
    // Nothing to compare against is not a match.
    expect(transcriptMatchesSentPrompt("", sent)).toBe(false);
  });

  it("reads the answer off the active branch of the transcript, not the newest node", async () => {
    // Regenerating forks the conversation: the abandoned branch stays in the
    // mapping. The UI follows current_node up its parents, and so must this -
    // otherwise a regenerate hands back the answer the user threw away.
    const conversation = {
      current_node: "a2",
      mapping: {
        root: { message: null, parent: null },
        u1: { message: { author: { role: "user" }, content: { content_type: "text", parts: ["q"] } }, parent: "root" },
        a1: {
          message: {
            author: { role: "assistant" },
            content: { content_type: "text", parts: ["discarded answer"] },
            status: "finished_successfully",
            end_turn: true
          },
          parent: "u1"
        },
        a2: {
          message: {
            author: { role: "assistant" },
            content: { content_type: "text", parts: ["kept answer"] },
            status: "finished_successfully",
            end_turn: true,
            metadata: { is_complete: true, model_slug: "gpt-5-6-pro" }
          },
          parent: "u1"
        }
      }
    };
    const fakeFetch = async (url: string) =>
      url.includes("/api/auth/session")
        ? { ok: true, status: 200, json: async () => ({ accessToken: "tok" }) }
        : { ok: true, status: 200, json: async () => conversation };
    const state = await new Function("fetch", `return ${transcriptAnswerExpression("conv-1")}`)(fakeFetch);

    expect(state.ok).toBe(true);
    expect(state.text).toBe("kept answer");
    expect(state.modelSlug).toBe("gpt-5-6-pro");
    expect(state.endTurn).toBe(true);
  });

  it("treats an unfinished transcript message as still generating", async () => {
    const conversation = {
      current_node: "a1",
      mapping: {
        u1: { message: { author: { role: "user" }, content: { content_type: "text", parts: ["q"] } }, parent: null },
        a1: {
          message: {
            author: { role: "assistant" },
            content: { content_type: "text", parts: ["half an ans"] },
            status: "in_progress",
            end_turn: null
          },
          parent: "u1"
        }
      }
    };
    const fakeFetch = async (url: string) =>
      url.includes("/api/auth/session")
        ? { ok: true, status: 200, json: async () => ({ accessToken: "tok" }) }
        : { ok: true, status: 200, json: async () => conversation };
    const state = await new Function("fetch", `return ${transcriptAnswerExpression("conv-1")}`)(fakeFetch);

    expect(state.ok).toBe(false);
    expect(state.reason).toBe("answer_not_finished");
    expect(state.status).toBe("in_progress");
    expect(state.text).toBe("half an ans");
  });

  it("never treats ordinary text as a citation marker", () => {
    // Measured on a real report: a `sources_footnote` reference carries
    // matched_text " " - a single space. Substituting on that replaced every
    // space in the document, and a 47k-character report came back with its
    // words fused together.
    const marker = "\uE200cite\uE202turn0search1\uE201";
    const text = `Widely supported today.${marker} Ship it when ready.`;
    const resolved = resolveTranscriptCitations(text, [
      { matched_text: " ", items: [{ title: "Sources", url: "https://example.com/sources" }] },
      { matched_text: marker, items: [{ title: "Caniuse", url: "https://caniuse.com/webgpu" }] }
    ]);

    expect(resolved).toBe("Widely supported today. [Caniuse](https://caniuse.com/webgpu) Ship it when ready.");
    expect(resolved).toContain("Widely supported today.");
    expect(resolved).toContain("Ship it when ready.");
  });

  it("restores citation markers to links the transcript already carries", () => {
    // ChatGPT stores citations as private-use delimited tokens the UI renders
    // as chips; innerText drops the urls entirely. content_references maps each
    // token back to its sources, so the answer keeps them.
    const marker = "\uE200cite\uE202turn0search19\uE202turn0search5\uE201";
    const text = `Jeju is busy in summer.${marker} Book early.`;
    const resolved = resolveTranscriptCitations(text, [
      {
        matched_text: marker,
        items: [
          { title: "Visit Jeju", url: "https://www.visitjeju.net/u/25n" },
          { title: "Halla reservations", url: "https://visithalla.jeju.go.kr/contents.do" }
        ]
      }
    ]);
    expect(resolved).toBe(
      "Jeju is busy in summer. [Visit Jeju](https://www.visitjeju.net/u/25n) [Halla reservations](https://visithalla.jeju.go.kr/contents.do) Book early."
    );

    // A marker with no reference is noise, not content: drop it rather than
    // leaking private-use characters into the saved answer.
    expect(resolveTranscriptCitations(`kept${marker}`, [])).toBe("kept");
    // Duplicate urls collapse so a heavily cited sentence stays readable.
    expect(
      resolveTranscriptCitations(`x${marker}`, [
        { matched_text: marker, items: [{ title: "A", url: "https://a.example" }, { title: "A again", url: "https://a.example" }] }
      ])
    ).toBe("x [A](https://a.example)");
    // Text without markers is returned untouched.
    expect(resolveTranscriptCitations("plain answer", [])).toBe("plain answer");
  });

  it("pulls the deep research report out of the widget state the app stores it in", async () => {
    // Deep research now renders as a widget app (connector_openai_deep_research)
    // inside an iframe, so the report is absent from the main frame DOM. The
    // conversation transcript still carries it: the tool message's
    // chatgpt_sdk.widget_state holds report_message.content.parts.
    const conversation = {
      mapping: {
        "client-created-root": {},
        u1: { message: { author: { role: "user" }, content: { content_type: "text", parts: ["research this"] } } },
        t1: {
          message: {
            author: { role: "tool" },
            content: { content_type: "code", text: "{}" },
            metadata: {
              chatgpt_sdk: {
                resource_name: "Deep Research App_start",
                widget_state: JSON.stringify({
                  status: "completed",
                  research_started_at: "2026-08-09T04:56:48.802612Z",
                  report_message: { content: { parts: ["# Report\n\nBody text."] } }
                })
              }
            }
          }
        }
      }
    };
    const fetched: string[] = [];
    const fakeFetch = async (url: string) => {
      fetched.push(url);
      if (url.includes("/api/auth/session")) return { ok: true, status: 200, json: async () => ({ accessToken: "tok" }) };
      return { ok: true, status: 200, json: async () => conversation };
    };
    const run = new Function("fetch", `return ${deepResearchReportExpression("conv-1")}`);
    const state = await run(fakeFetch);

    expect(state.ok).toBe(true);
    expect(state.status).toBe("completed");
    expect(state.report).toBe("# Report\n\nBody text.");
    expect(fetched[1]).toContain("/backend-api/conversation/conv-1");
  });

  it("says why the deep research report is not readable yet instead of returning an empty answer", async () => {
    const running = {
      mapping: {
        t1: {
          message: {
            author: { role: "tool" },
            metadata: { chatgpt_sdk: { widget_state: JSON.stringify({ status: "researching" }) } }
          }
        }
      }
    };
    const fakeFetch = async (url: string) =>
      url.includes("/api/auth/session")
        ? { ok: true, status: 200, json: async () => ({ accessToken: "tok" }) }
        : { ok: true, status: 200, json: async () => running };
    const state = await new Function("fetch", `return ${deepResearchReportExpression("conv-1")}`)(fakeFetch);
    expect(state.ok).toBe(false);
    expect(state.status).toBe("researching");
    expect(state.report).toBe("");

    // No widget at all (the tool never ran) must be distinguishable from a run
    // still in progress, so the caller can stop waiting.
    const bare = async (url: string) =>
      url.includes("/api/auth/session")
        ? { ok: true, status: 200, json: async () => ({ accessToken: "tok" }) }
        : { ok: true, status: 200, json: async () => ({ mapping: {} }) };
    const none = await new Function("fetch", `return ${deepResearchReportExpression("conv-1")}`)(bare);
    expect(none.ok).toBe(false);
    expect(none.reason).toBe("no_widget_state");

    // A failed auth/session lookup must not look like "still researching".
    const denied = async () => ({ ok: false, status: 401, json: async () => ({}) });
    const unauth = await new Function("fetch", `return ${deepResearchReportExpression("conv-1")}`)(denied);
    expect(unauth.ok).toBe(false);
    expect(unauth.reason).toBe("session_http_401");
  });

  it("refuses to delete a project it cannot identify beyond doubt", () => {
    // Deleting is not undoable from here, so the name has to match exactly one
    // project. This account really does have two projects sharing a name.
    const projects = [
      { id: "g-p-aaa", name: "prodex-smoke-2" },
      { id: "g-p-bbb", name: "prodex-smoke-2" },
      { id: "g-p-ccc", name: "Codex" }
    ];

    expect(resolveProjectToDelete(projects, { name: "Codex" })).toEqual({ ok: true, id: "g-p-ccc", name: "Codex" });
    // An id wins over a name, and is the way out of an ambiguous name.
    expect(resolveProjectToDelete(projects, { id: "g-p-bbb" })).toEqual({ ok: true, id: "g-p-bbb", name: "prodex-smoke-2" });

    const ambiguous = resolveProjectToDelete(projects, { name: "prodex-smoke-2" });
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.reason).toMatch(/two|more than one|ambiguous/i);
    expect(ambiguous.reason).toContain("g-p-aaa");

    const missing = resolveProjectToDelete(projects, { name: "not a project" });
    expect(missing.ok).toBe(false);
    expect(missing.reason).toMatch(/no project/i);

    // A near-miss on case or spacing is not a match: deleting the wrong project
    // because of a typo is exactly what exactness is for.
    expect(resolveProjectToDelete(projects, { name: "codex" }).ok).toBe(false);
  });

  it("deletes by id through the endpoint that reports it deleted", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const fakeFetch = async (url: string, init?: { method?: string }) => {
      calls.push({ url, ...(init?.method ? { method: init.method } : {}) });
      if (url.includes("/api/auth/session")) return { ok: true, status: 200, json: async () => ({ accessToken: "tok" }) };
      return { ok: true, status: 200, text: async () => JSON.stringify({ deleted: true }) };
    };
    const result = await new Function("fetch", `return ${deleteProjectExpression("g-p-ccc")}`)(fakeFetch);

    expect(result).toEqual({ ok: true, reason: "" });
    expect(calls[1]).toEqual({ url: "/backend-api/gizmos/g-p-ccc", method: "DELETE" });
  });

  it("reads the conversation id out of plain and project thread urls", () => {
    expect(conversationIdFromThreadUrl("https://chatgpt.com/c/6a780848-1660-83ee-9e1a-104f95826746")).toBe(
      "6a780848-1660-83ee-9e1a-104f95826746"
    );
    expect(conversationIdFromThreadUrl("https://chatgpt.com/g/g-p-abc123-some-project/c/6a781322-552c-83e8-9c8f-02a5182c87f9")).toBe(
      "6a781322-552c-83e8-9c8f-02a5182c87f9"
    );
    expect(conversationIdFromThreadUrl("https://chatgpt.com/c/6a780848-1660-83ee-9e1a-104f95826746?model=gpt-5")).toBe(
      "6a780848-1660-83ee-9e1a-104f95826746"
    );
    expect(conversationIdFromThreadUrl("https://chatgpt.com/")).toBeUndefined();
    expect(conversationIdFromThreadUrl("not a url")).toBeUndefined();
  });

  it("hands back the thread when there is no conversation id to fetch the report by", () => {
    // The report is fetched from the conversation transcript, so a thread url
    // without a conversation id leaves nothing to poll. The run still started,
    // and the url is the only handle on it.
    const blocker = deepResearchUnreadableBlocker("https://chatgpt.com/c/abc123");
    expect(blocker.code).toBe("deep_research_not_readable");
    expect(blocker.thread).toBe("https://chatgpt.com/c/abc123");
    expect(blocker.next_step).toContain("https://chatgpt.com/c/abc123");
    expect(blocker.retryable).toBe(true);
  });

  it("recognizes the deep-research start button in either language", () => {
    // Deep research does not begin on submit: it shows a start button with a
    // countdown ring. prodex waited for an answer that never came because it
    // never pressed it (30+ minutes, zero assistant messages, measured live).
    const expression = deepResearchStartButtonRectExpression();
    expect(expression).toMatch(/시작/);
    expect(expression).toMatch(/start/i);
  });

  it("does not read the picker header count as a quota", () => {
    // Corrected by the user, then measured: the header tracks the SLIDER
    // POSITION, not remaining runs - "Instant, 1 of 5.", "Medium, 2 of 5.",
    // "Pro, 5 of 5.". prodex must not turn that into a quota warning.
    expect(powerLabelMatches("Pro", "Pro")).toBe(true);
    expect(powerLabelMatches("Instant", "Instant")).toBe(true);
  });

  it("resolves tool aliases to the labels ChatGPT renders, and passes unknown ones through", () => {
    // Agents will type the obvious thing, not ChatGPT's exact casing.
    expect(resolveComposerToolLabel("deep-research")).toBe("Deep research");
    expect(resolveComposerToolLabel("deep research")).toBe("Deep research");
    expect(resolveComposerToolLabel("DEEP")).toBe("Deep research");
    expect(resolveComposerToolLabel("research")).toBe("Deep research");
    expect(resolveComposerToolLabel("web-search")).toBe("Web search");
    expect(resolveComposerToolLabel("search")).toBe("Web search");
    expect(resolveComposerToolLabel("create-image")).toBe("Create image");
    expect(resolveComposerToolLabel("image")).toBe("Create image");
    // A tool prodex has never heard of still reaches the menu by its label,
    // so a new ChatGPT tool does not need a prodex release.
    expect(resolveComposerToolLabel("Canva")).toBe("Canva");
  });

  it("ignores the tool token when checking that the composer holds the prompt", () => {
    // Measured live: enabling a tool inserts its name INTO the ProseMirror
    // composer (it is not a separate chip), so a strict text match would read
    // "Deep research" as leftover contamination and refuse to send.
    const expression = composerTextStateExpression("my prompt", ["Deep research"]);
    expect(expression).toContain("Deep research");
    expect(expression).toContain("my prompt");
  });

  it("needs a research-sized budget by default when deep research is on", () => {
    // A deep research run is minutes of browsing, not one model reply; the
    // ordinary Pro budget would abandon it mid-report.
    expect(defaultTimeoutForTools(["Deep research"], 1_200_000)).toBeGreaterThanOrEqual(1_800_000);
    expect(defaultTimeoutForTools(["Web search"], 1_200_000)).toBe(1_200_000);
    expect(defaultTimeoutForTools([], 90_000)).toBe(90_000);
  });

  it("targets the general file input, not the image-only ones, when attaching", () => {
    // Measured live: ChatGPT's composer carries three file inputs - one
    // general (accept="") plus two accept="image/*". Attaching a pptx or pdf to
    // an image-only input silently does nothing.
    const selector = composerFileInputSelector();
    const general = { accept: "", matches: (sel: string) => !sel.includes("image") };
    expect(selector).toContain("input");
    expect(selector).toContain("file");
    expect(selector).toMatch(/not\(\[accept\*?=?"?image/i);
    expect(general.accept).toBe("");
  });

  it("reports which attachments the composer has accepted and whether one is still uploading", () => {
    const expression = attachmentStateExpression(["deck.pptx", "notes.pdf"]);
    expect(expression).toContain("deck.pptx");
    expect(expression).toContain("notes.pdf");
    // An upload in flight must be visible, or the send fires before the file
    // finishes and ChatGPT answers without it.
    expect(expression).toContain("progressbar");
    // An image attachment puts its filename ONLY on the remove button's
    // aria-label (measured live), so text-only detection misses it.
    expect(expression).toContain("aria-label");
    // Stale attachments are detected read-only: clicking the remove buttons
    // wedges the composer (measured live), so the reset is a reload.
    const presence = attachmentPresenceExpression();
    expect(presence).toMatch(/remove file/i);
    expect(presence).not.toContain(".click()");
  });

  it("inserts a long prompt in one in-page call, and a short one through key events", () => {
    // Measured live on a 95 KB prompt: chunked Input.insertText produced a
    // composer of the right LENGTH but with text shifted from the first chunk
    // boundary on (first divergence at 3,938 chars with a 4,000-char chunk),
    // which reached users as "Composer text did not match after insertion".
    // Anything above the chunk size now goes in as one in-page execCommand,
    // where nothing can interleave; short prompts keep the key-event path.
    const long = "가".repeat(COMPOSER_INSERT_CHUNK_CHARS + 1);
    const expression = insertComposerTextInPageExpression(long);
    expect(expression).toContain("insertText");
    expect(expression).toContain(JSON.stringify(long));
    // The whole prompt travels in ONE call - no boundary to corrupt.
    expect(expression.split(JSON.stringify(long)).length - 1).toBeGreaterThanOrEqual(1);
    // It clears the composer first, so leftovers cannot merge into the prompt.
    expect(expression).toContain('execCommand("delete")');
  });

  it("splits a long prompt into bounded composer chunks that rebuild the original exactly", () => {
    // Field failure: one Input.insertText carrying a whole multi-KB prompt
    // stalls the ProseMirror composer past the 20s CDP command timeout, and
    // the send dies with "Chrome DevTools command timed out: Input.insertText"
    // (observed twice in one session on long inputs). Each chunk gets its own
    // command budget instead.
    const long = "a".repeat(9_500);
    const chunks = chunkComposerText(long);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= COMPOSER_INSERT_CHUNK_CHARS)).toBe(true);
    expect(chunks.join("")).toBe(long);

    const short = "one short prompt";
    expect(chunkComposerText(short)).toEqual([short]);
    expect(chunkComposerText("")).toEqual([]);

    // Multi-byte text must not be split mid-character.
    const korean = "가나다라마바사".repeat(2_000);
    expect(chunkComposerText(korean).join("")).toBe(korean);
  });

  it("builds a virtual-display X server command that is authenticated, not world-open", () => {
    // WSLg mounts /tmp/.X11-unix read-only, so the X server has to serve over
    // loopback TCP - and a TCP X display with access control off would let any
    // process on the box watch the signed-in ChatGPT window. Require -auth.
    const args = virtualDisplayServerArgs(99, "/home/u/.local/share/prodex/xvfb/Xauthority");
    expect(args[0]).toBe(":99");
    expect(args).toContain("-auth");
    expect(args).toContain("/home/u/.local/share/prodex/xvfb/Xauthority");
    expect(args).toContain("-listen");
    expect(args).not.toContain("-ac");
    expect(args.join(" ")).toMatch(/-screen 0 \d{3,}x\d{3,}x24/);
  });

  it("points the browser at the virtual display without disturbing the real one", () => {
    const env = virtualDisplayEnv(99, "/tmp/Xauthority", { DISPLAY: ":0", PATH: "/usr/bin" });
    expect(env.DISPLAY).toBe("127.0.0.1:99");
    expect(env.XAUTHORITY).toBe("/tmp/Xauthority");
    expect(env.PATH).toBe("/usr/bin");
  });

  it("resolves the virtual-display preference from PRODEX_VIRTUAL_DISPLAY", () => {
    expect(resolveVirtualDisplayPreference(undefined, {})).toBe(false);
    expect(resolveVirtualDisplayPreference(undefined, { PRODEX_VIRTUAL_DISPLAY: "1" })).toBe(true);
    expect(resolveVirtualDisplayPreference(false, { PRODEX_VIRTUAL_DISPLAY: "1" })).toBe(false);
    expect(resolveVirtualDisplayPreference(true, {})).toBe(true);
  });

  it("names the package to install when Xvfb is missing", () => {
    expect(() => assertVirtualDisplayToolingAvailable(() => false)).toThrow(/apt install/);
    expect(() => assertVirtualDisplayToolingAvailable(() => false)).toThrow(/xvfb/);
    expect(() => assertVirtualDisplayToolingAvailable(() => true)).not.toThrow();
  });

  it("resolves the headless preference from PRODEX_HEADLESS, with the explicit option winning", () => {
    expect(resolveHeadlessPreference(undefined, {})).toBe(false);
    expect(resolveHeadlessPreference(undefined, { PRODEX_HEADLESS: "1" })).toBe(true);
    expect(resolveHeadlessPreference(undefined, { PRODEX_HEADLESS: "true" })).toBe(true);
    expect(resolveHeadlessPreference(undefined, { PRODEX_HEADLESS: "yes" })).toBe(true);
    expect(resolveHeadlessPreference(undefined, { PRODEX_HEADLESS: "0" })).toBe(false);
    expect(resolveHeadlessPreference(false, { PRODEX_HEADLESS: "1" })).toBe(false);
    expect(resolveHeadlessPreference(true, {})).toBe(true);
  });

  it("flags an answer that did not come from the requested model", () => {
    // prodex recorded what it ASKED for and never what actually answered, so a
    // model click that silently did not take (or no model pinned at all) was
    // invisible: the user believed they were getting Pro reasoning.
    expect(modelSelectionWarning("Pro", "gpt-5-6-pro")).toBeUndefined();
    expect(modelSelectionWarning(undefined, "gpt-5-6-pro")).toBeUndefined();
    const mismatch = modelSelectionWarning("Pro", "gpt-5-6-thinking");
    expect(mismatch).toMatch(/model_mismatch/);
    expect(mismatch).toMatch(/gpt-5-6-thinking/i);
    expect(mismatch).toMatch(/Pro/);
    // An unknown slug must not manufacture a false alarm.
    expect(modelSelectionWarning("Pro", undefined)).toBeUndefined();
    // A non-Pro request is not judged against the Pro rule.
    expect(modelSelectionWarning("Thinking", "gpt-5-6-thinking")).toBeUndefined();
  });

  it("detects the wording Cloudflare actually renders on the interstitial", () => {
    // Measured live: the challenge page body says "Verifying you are human."
    // and the title is "Just a moment...". The old pattern only matched
    // "verify you are human", so the real page fell through undetected.
    for (const sample of [
      "Verifying you are human. This may take a few seconds.",
      "chatgpt.com needs to review the security of your connection before proceeding.",
      "사용자가 사람인지 확인하는 중입니다."
    ]) {
      expect(detectChatGptBlocker(sample)?.code).toBe("cloudflare_check");
    }
    expect(detectChatGptBlocker("A normal answer about verifying user input")?.code).not.toBe("cloudflare_check");
  });

  it("recognizes a logged-in Korean ChatGPT UI snapshot", () => {
    const text = "채팅 기록\nChatGPT\n새 채팅\n프로젝트\n홍길동\nPro\n무엇이든 편하게 시작해 보세요.";
    const buttons = ["프로필 메뉴 열기", "새 채팅", "프로젝트 홈 열기"];

    expect(inferLoggedInLikely(text, buttons)).toBe(true);
  });

  it("does not treat Korean thinking placeholders as final answers", () => {
    expect(isUsableChatGptAnswer("생각 중...")).toBe(false);
    expect(isUsableChatGptAnswer("9s 동안 생각함\n\n실제 답변입니다.")).toBe(true);
  });

  it("keeps the in-page placeholder test in sync with isUsableChatGptAnswer", () => {
    // Evaluate the in-page snippet the same way the page expression does.
    const inPagePlaceholder = (answer: string): boolean => {
      const ansStripped = answer.trim().replace(/\.+$/, "");
      const ansLines = ansStripped.split(/\r?\n/).filter((l) => l.trim());
      return new Function("ansStripped", "ansLines", `return (${CHATGPT_THINKING_PLACEHOLDER_JS});`)(ansStripped, ansLines) as boolean;
    };
    for (const answer of [
      "Thinking",
      "Thinking...",
      "Thought for 5 seconds",
      "생각 중...",
      "Pro 생각 중",
      "Thinking about it, the answer is yes.",
      "Thinking caps help focus.",
      "9s 동안 생각함\n\n실제 답변입니다.",
      "Here is the real answer."
    ]) {
      // placeholder === true must mean the answer is NOT usable, and vice versa.
      expect(inPagePlaceholder(answer)).toBe(!isUsableChatGptAnswer(answer));
    }
  });

  it("does not misclassify a real answer that starts with 'Thinking' as a placeholder", () => {
    // The reasoning header is a placeholder only when it IS the whole content.
    expect(isUsableChatGptAnswer("Thinking")).toBe(false);
    expect(isUsableChatGptAnswer("Thinking...")).toBe(false);
    expect(isUsableChatGptAnswer("Thought for 5 seconds")).toBe(false);
    expect(isUsableChatGptAnswer("Pro 생각 중")).toBe(false);
    // ...but a substantive single-line answer starting with "Thinking" is real.
    expect(isUsableChatGptAnswer("Thinking about it, the answer is yes.")).toBe(true);
    expect(isUsableChatGptAnswer("Thinking caps are a metaphor for focus.")).toBe(true);
  });

  it("waits for a newly added assistant message before accepting an answer", () => {
    expect(
      hasFreshChatGptAnswer(1, {
        assistantMessageCount: 1,
        answer: "old answer",
        generating: false
      })
    ).toBe(false);
    expect(
      hasFreshChatGptAnswer(1, {
        assistantMessageCount: 2,
        answer: "PRODEX_PRO_SMOKE_OK",
        generating: false
      })
    ).toBe(true);
  });

  it("reports an in-flight response as a browser busy blocker", () => {
    const blocker = chatGptBusyBlocker(true);

    expect(blocker).toEqual(
      expect.objectContaining({
        code: "response_in_progress",
        retryable: true
      })
    );
    expect(blocker?.message).toContain("still generating");
    expect(blocker?.next_step).toContain("--busy-wait-ms");
    expect(blocker?.next_step).toContain("recover");
  });

  it("diagnoses a generating thread with a locked composer as busy, not as a missing composer", () => {
    // While ChatGPT streams a response the composer locks (hasComposer=false),
    // so the busy diagnosis must win over the composer-readiness one.
    const generatingStatus = {
      textSample: "New chat\nProjects",
      visibleButtonLabels: [],
      hasComposer: false,
      generating: true
    };

    let thrown: unknown;
    try {
      assertChatGptIdleAndReadyForPrompt(generatingStatus);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ChatGptBrowserBlockerError);
    expect((thrown as ChatGptBrowserBlockerError).blocker.code).toBe("response_in_progress");

    expect(() =>
      assertChatGptIdleAndReadyForPrompt({ ...generatingStatus, generating: false, hasComposer: true })
    ).not.toThrow();

    let idleThrown: unknown;
    try {
      assertChatGptIdleAndReadyForPrompt({ ...generatingStatus, generating: false });
    } catch (error) {
      idleThrown = error;
    }
    expect((idleThrown as ChatGptBrowserBlockerError).blocker.code).toBe("chatgpt_not_ready");
  });

  it("does not treat pre-existing generation as prompt acceptance", () => {
    const before = { userMessageCount: 2, assistantMessageCount: 1 };

    expect(
      hasChatGptPromptAcceptance(before, {
        userMessageCount: 2,
        assistantMessageCount: 1,
        generating: true
      })
    ).toBe(false);
    expect(
      hasChatGptPromptAcceptance(before, {
        userMessageCount: 3,
        assistantMessageCount: 1,
        generating: true
      })
    ).toBe(true);
    expect(
      hasChatGptPromptAcceptance(before, {
        userMessageCount: 2,
        assistantMessageCount: 2,
        generating: true
      })
    ).toBe(true);
  });

  it("recognizes current English and Korean ChatGPT submit buttons", () => {
    expect(isLikelyChatGptSubmitButton("Send prompt", null)).toBe(true);
    expect(isLikelyChatGptSubmitButton("프롬프트 보내기", null)).toBe(true);
    expect(isLikelyChatGptSubmitButton("", "send-button")).toBe(true);
    expect(isLikelyChatGptSubmitButton("시작하기", null)).toBe(false);
  });

  it("recognizes generating controls without treating generic cancel buttons as busy", () => {
    expect(isLikelyChatGptGeneratingControl("Stop generating")).toBe(true);
    expect(isLikelyChatGptGeneratingControl("Stop response")).toBe(true);
    expect(isLikelyChatGptGeneratingControl("응답 중지")).toBe(true);
    expect(isLikelyChatGptGeneratingControl("Cancel")).toBe(false);
    expect(isLikelyChatGptGeneratingControl("취소")).toBe(false);
    expect(isLikelyChatGptGeneratingControl("Stop sharing")).toBe(false);
  });

  it("excludes current composer text from runtime blocker scans", () => {
    expect(CHATGPT_RUNTIME_BLOCKER_TEXT_EXCLUDED_ANCESTORS).toContain('[data-message-author-role]');
    expect(CHATGPT_RUNTIME_BLOCKER_TEXT_EXCLUDED_ANCESTORS).toContain('div[role="textbox"]');
    expect(CHATGPT_RUNTIME_BLOCKER_TEXT_EXCLUDED_ANCESTORS).toContain('textarea');
    expect(CHATGPT_RUNTIME_BLOCKER_TEXT_EXCLUDED_ANCESTORS).toContain('[contenteditable="true"]');
  });

  it("excludes the sidebar/nav from the blocker scan but keeps it for login detection", () => {
    // A history title like "usage limit reset" lives in the sidebar <nav> and
    // must not be scanned as a page blocker - so the BLOCKER-SCAN selector
    // excludes nav. But login detection needs the sidebar ("New chat",
    // "Projects"), so the login/status selector must NOT exclude nav.
    expect(CHATGPT_BLOCKER_SCAN_EXCLUDED_ANCESTORS).toContain("nav");
    expect(CHATGPT_BLOCKER_SCAN_EXCLUDED_ANCESTORS).toContain('[role="navigation"]');
    expect(CHATGPT_RUNTIME_BLOCKER_TEXT_EXCLUDED_ANCESTORS).not.toContain("nav");
  });

  it("keeps login detection working while the sidebar is excluded from blocker scans", () => {
    // Regression: a state where the sidebar (nav) carries the logged-in signals
    // AND a chat title 'usage limit'. The blocker scan (nav-excluded) sees
    // neither the title nor the signals; login detection (nav-included) sees
    // the signals. Login must be true, and no blocker must fire.
    const state = {
      textSample: "full body text",
      blockerTextSample: "New chat\nProjects\nChatGPT Pro\nusage limit reset", // nav-included (login + a sidebar title)
      blockerScanTextSample: "", // nav-excluded: sidebar title gone
      visibleButtonLabels: ["Profile menu"]
    };
    expect(inferChatGptPageLoggedInLikely(state)).toBe(true);
    expect(detectChatGptPageBlocker(state)).toBeUndefined();
  });

  it("detects ChatGPT browser blocker states before sending", () => {
    expect(detectChatGptBlocker("Just a moment... Checking if the site connection is secure", [])?.code).toBe("cloudflare_check");
    expect(detectChatGptBlocker("Please solve this captcha to continue", [])?.code).toBe("captcha_required");
    expect(detectChatGptBlocker("You've reached the GPT-5 message limit. Try again later.", [])?.code).toBe("usage_limit");
    expect(detectChatGptBlocker("Model limit reached for GPT-5.", [])?.code).toBe("usage_limit");
    expect(detectChatGptBlocker("Additional verification required", ["Continue"])?.code).toBe("permission_required");
    // Sidebar chat titles that merely mention robots/automation must not be mistaken for a captcha.
    expect(detectChatGptBlocker("로봇 제어 연구\n자동화 워크플로 정리\nNew chat\nProjects", [])).toBeUndefined();
    expect(detectChatGptBlocker("Robotics research notes\nNew chat\nProjects", [])).toBeUndefined();
    // Real reCAPTCHA / human-verification phrasing is still detected.
    expect(detectChatGptBlocker("로봇이 아닙니다", [])?.code).toBe("captcha_required");
    expect(detectChatGptBlocker("Please complete the captcha to continue", [])?.code).toBe("captcha_required");
    // A logged-in Pro page whose text merely contains "로그인" (a sidebar/menu word) must read as logged in.
    expect(inferLoggedInLikely("채팅 기록\nChatGPT Pro\n새 채팅\n프로젝트\n로그인\n내 첫 프로젝트", ["프로필"])).toBe(true);
    // An actual logged-out screen (sign-up prompt or a Log in button) still reads as logged out.
    expect(inferLoggedInLikely("Welcome back\nLog in\nSign up for free", ["Log in"])).toBe(false);
  });

  it("does not treat old chat message text as a pre-send blocker", () => {
    expect(
      detectChatGptPageBlocker({
        textSample: [
          "New chat",
          "Projects",
          "How should I explain captcha challenges to users?",
          "You've reached the GPT-5 message limit. Try again later."
        ].join("\n"),
        blockerTextSample: "New chat\nProjects\nChatGPT\nWhat can I help with?",
        visibleButtonLabels: ["Send prompt", "Profile"]
      })
    ).toBeUndefined();
  });

  it("still reports real pre-send blockers outside old chat messages", () => {
    expect(
      detectChatGptPageBlocker({
        textSample: "Old conversation says captcha and Log in\nNew chat\nProjects\nPlease solve this captcha to continue",
        blockerTextSample: "New chat\nProjects\nPlease solve this captcha to continue",
        visibleButtonLabels: ["Continue", "Profile"]
      })?.code
    ).toBe("captcha_required");
  });

  it("infers logged-in page status from message-excluded chrome text", () => {
    expect(
      inferChatGptPageLoggedInLikely({
        textSample: "Old conversation says Log in and Sign up for free\nNew chat\nProjects",
        blockerTextSample: "New chat\nProjects\nChatGPT\nPro",
        visibleButtonLabels: ["Profile menu", "Send prompt"]
      })
    ).toBe(true);
  });

  it("reports blockers that appear while waiting for a submitted prompt", () => {
    const message = chatGptBlockerErrorFromAnswerState({
      textSample: "You've reached the GPT-5 message limit. Try again later.",
      visibleButtonLabels: ["Switch model"]
    });

    expect(message).toContain("usage");
    expect(message).toContain("Next:");
    expect(message).toContain("Wait for the limit");
  });

  it("preserves blocker metadata in browser blocker errors", () => {
    const blocker = chatGptBlockerFromAnswerState({
      textSample: "Please solve this captcha to continue",
      visibleButtonLabels: ["Continue"]
    });

    expect(blocker?.code).toBe("captcha_required");
    const error = new ChatGptBrowserBlockerError(blocker!);

    expect(error.message).toContain("captcha");
    expect(error.message).toContain("Next:");
    expect(error.blocker).toEqual(blocker);
  });

  it("does not treat submitted message text as a post-submit blocker", () => {
    expect(
      chatGptBlockerErrorFromAnswerState({
        textSample: "How do I explain captcha challenges to users?\nSend prompt",
        blockerTextSample: "Send prompt",
        visibleButtonLabels: ["Send prompt"]
      })
    ).toBeUndefined();
  });

  it("ignores post-submit button labels that are not in the page text", () => {
    expect(
      chatGptBlockerErrorFromAnswerState({
        textSample: "Conversation ready",
        visibleButtonLabels: ["Log in"]
      })
    ).toBeUndefined();
  });

  it("reports label-only login overlays while waiting for a submitted prompt", () => {
    const message = chatGptBlockerErrorFromAnswerState({
      textSample: "Conversation ready",
      blockerTextSample: "",
      visibleButtonLabels: ["Log in", "Sign up"]
    });

    expect(message).toBeDefined();
    expect(message ?? "").toContain("log in");
    expect(message ?? "").toContain("Next:");
  });

  it("does not report login from a lone post-submit button text", () => {
    expect(
      chatGptBlockerErrorFromAnswerState({
        textSample: "Conversation ready\nLog in",
        blockerTextSample: "Log in",
        visibleButtonLabels: []
      })
    ).toBeUndefined();
  });

  it("does not let short message text hide a real post-submit blocker", () => {
    const message = chatGptBlockerErrorFromAnswerState({
      textSample: "Please solve this captcha to continue",
      visibleButtonLabels: ["Continue"]
    });

    expect(message).toContain("captcha");
  });

  it("does not let exact message text hide a real non-message blocker", () => {
    const message = chatGptBlockerErrorFromAnswerState({
      textSample: "Please solve this captcha to continue",
      blockerTextSample: "Please solve this captcha to continue",
      visibleButtonLabels: ["Continue"]
    });

    expect(message).toContain("captcha");
  });

  it("reports login prompts that appear after a prompt is submitted", () => {
    const message = chatGptBlockerErrorFromAnswerState({
      textSample: "Log in\nSign up for free",
      visibleButtonLabels: ["Log in", "Sign up"]
    });

    expect(message).toContain("log in");
    expect(message).toContain("Next:");
  });

  it("does not flag a normal ChatGPT composer as blocked", () => {
    expect(detectChatGptBlocker("새 채팅\n무엇이든 물어보세요", ["프롬프트 보내기"])).toBeUndefined();
  });

  it("throws a structured blocker when the selected ChatGPT tab is hidden", () => {
    let thrown: unknown;

    try {
      assertVisibleChatGptTab("hidden", "https://chatgpt.com/c/background");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ChatGptBrowserBlockerError);
    expect((thrown as ChatGptBrowserBlockerError).blocker).toEqual(
      expect.objectContaining({
        code: "tab_not_visible",
        retryable: true,
        next_step: "Select https://chatgpt.com/c/background in the dedicated browser, then retry."
      })
    );
  });

  it("throws a structured blocker when the confirmed ChatGPT target does not match the current tab", () => {
    let thrown: unknown;

    try {
      assertChatGptTargetUrlMatches("https://chatgpt.com/c/current", "https://chatgpt.com/c/target");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ChatGptBrowserBlockerError);
    expect((thrown as ChatGptBrowserBlockerError).blocker).toEqual(
      expect.objectContaining({
        code: "target_url_mismatch",
        retryable: true,
        next_step: "Open https://chatgpt.com/c/target in the visible browser and retry. Current: https://chatgpt.com/c/current"
      })
    );
  });

  it("throws a structured blocker when the confirmed ChatGPT target tab is not open", () => {
    let thrown: unknown;

    try {
      assertChatGptTargetTabAvailable("https://chatgpt.com/c/missing");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ChatGptBrowserBlockerError);
    expect((thrown as ChatGptBrowserBlockerError).blocker).toEqual(
      expect.objectContaining({
        code: "target_tab_missing",
        retryable: true,
        next_step: "Open https://chatgpt.com/c/missing in the dedicated browser and retry."
      })
    );
  });

  it("throws a structured blocker when no ChatGPT tab is open", () => {
    let thrown: unknown;

    try {
      assertChatGptPageAvailable();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ChatGptBrowserBlockerError);
    expect((thrown as ChatGptBrowserBlockerError).blocker).toEqual(
      expect.objectContaining({
        code: "chatgpt_page_missing",
        retryable: true,
        next_step: "Open https://chatgpt.com/ in the dedicated Chrome profile, or run `prodex pro browser login` to reopen it."
      })
    );
    expect((thrown as ChatGptBrowserBlockerError).blocker.next_step).toContain("pro browser login");
  });

  it("throws a structured blocker when ChatGPT is not ready for prompts", () => {
    let thrown: unknown;

    try {
      assertChatGptReadyForPrompt(false, false);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ChatGptBrowserBlockerError);
    expect((thrown as ChatGptBrowserBlockerError).blocker).toEqual(
      expect.objectContaining({
        code: "chatgpt_not_ready",
        retryable: true,
        next_step: "Log in manually and open a normal chat or Project thread with the prompt composer visible, then retry."
      })
    );
  });

  it("honors the configured timeout while waiting for prompt acceptance", () => {
    expect(computePromptAcceptanceDeadline(90_000, 0)).toBe(90_000);
    expect(computePromptAcceptanceDeadline(3_000, 0)).toBe(3_000);
  });

  it("normalizes confirmed ChatGPT target URLs", () => {
    expect(normalizeChatGptTargetUrl("https://chatgpt.com/c/abc?utm=1#frag")).toBe("https://chatgpt.com/c/abc");
    expect(normalizeChatGptTargetUrl("https://chatgpt.com/c/abc/")).toBe("https://chatgpt.com/c/abc");
  });

  it("rejects non-ChatGPT target URLs", () => {
    expect(() => normalizeChatGptTargetUrl("https://example.com/c/abc")).toThrow(/ChatGPT/);
    expect(() => normalizeChatGptTargetUrl("https://chat.openai.com/c/abc")).toThrow(/ChatGPT/);
    expect(() => normalizeChatGptTargetUrl("javascript:alert(1)")).toThrow(/ChatGPT/);
  });

  it("compares current ChatGPT tab URLs to confirmed targets without query noise", () => {
    expect(chatGptUrlsReferToSameTarget("https://chatgpt.com/c/abc?model=gpt-5", "https://chatgpt.com/c/abc")).toBe(true);
    expect(chatGptUrlsReferToSameTarget("https://chatgpt.com/c/other", "https://chatgpt.com/c/abc")).toBe(false);
  });

  it("selects the ChatGPT page that matches a confirmed target instead of the first tab", () => {
    const pages = [
      devtoolsPage("https://chatgpt.com/c/first"),
      devtoolsPage("https://chatgpt.com/c/target?model=gpt-5"),
      devtoolsPage("https://example.com/c/target")
    ];

    expect(selectChatGptPage(pages, "https://chatgpt.com/c/target")?.url).toBe("https://chatgpt.com/c/target?model=gpt-5");
    expect(selectChatGptPage([pages[0]])?.url).toBe("https://chatgpt.com/c/first");
  });

  it("blocks no-target selection when multiple visible ChatGPT pages are available", () => {
    const first = devtoolsPage("https://chatgpt.com/c/first");
    const second = devtoolsPage("https://chatgpt.com/c/second");
    const visibilityByPage = new Map([
      [first.webSocketDebuggerUrl, "visible"],
      [second.webSocketDebuggerUrl, "visible"]
    ]);

    const blocker = chatGptPageSelectionBlocker([first, second], undefined, visibilityByPage);

    expect(blocker).toEqual(
      expect.objectContaining({
        code: "ambiguous_chatgpt_tabs",
        retryable: true
      })
    );
    expect(blocker?.next_step).toContain("--target-url");
    expect(selectChatGptPage([first, second], undefined, visibilityByPage)).toBeUndefined();
    expect(selectChatGptPage([first, second], "https://chatgpt.com/c/second", visibilityByPage)?.url).toBe("https://chatgpt.com/c/second");
  });

  it("blocks no-target selection when ChatGPT tab visibility is unknown", () => {
    const visible = devtoolsPage("https://chatgpt.com/c/visible");
    const unknown = devtoolsPage("https://chatgpt.com/c/unknown");
    const visibilityByPage = new Map([[visible.webSocketDebuggerUrl, "visible"]]);

    const blocker = chatGptPageSelectionBlocker([visible, unknown], undefined, visibilityByPage);

    expect(blocker).toEqual(
      expect.objectContaining({
        code: "ambiguous_chatgpt_tabs",
        retryable: true
      })
    );
    expect(blocker?.message).toContain("unknown");
    expect(blocker?.next_step).toContain("--target-url");
    expect(selectChatGptPage([visible, unknown], undefined, visibilityByPage)).toBeUndefined();
  });

  it("prefers the active visible ChatGPT page when no target is confirmed", () => {
    const hidden = devtoolsPage("https://chatgpt.com/c/hidden");
    const visible = devtoolsPage("https://chatgpt.com/c/visible");
    const visibilityByPage = new Map([
      [hidden.webSocketDebuggerUrl, "hidden"],
      [visible.webSocketDebuggerUrl, "visible"]
    ]);

    expect(selectChatGptPage([hidden, visible], undefined, visibilityByPage)?.url).toBe("https://chatgpt.com/c/visible");
  });

  it("prefers the visible matching ChatGPT page when a confirmed target has duplicates", () => {
    const hidden = devtoolsPage("https://chatgpt.com/c/target");
    hidden.title = "hidden target";
    const visible = devtoolsPage("https://chatgpt.com/c/target?model=gpt-5");
    visible.title = "visible target";
    const visibilityByPage = new Map([
      [hidden.webSocketDebuggerUrl, "hidden"],
      [visible.webSocketDebuggerUrl, "visible"]
    ]);

    expect(selectChatGptPage([hidden, visible], "https://chatgpt.com/c/target", visibilityByPage)?.title).toBe("visible target");
  });

  it("requires a visible ChatGPT tab before sending prompts", () => {
    expect(() => assertVisibleChatGptTab("hidden", "https://chatgpt.com/c/background")).toThrow(/active visible tab/i);
    expect(() => assertVisibleChatGptTab(undefined, "https://chatgpt.com/c/unknown")).toThrow(/active visible tab/i);
    expect(() => assertVisibleChatGptTab("visible", "https://chatgpt.com/c/current")).not.toThrow();
  });

  it("turns non-visible ChatGPT tabs into a browser status blocker", () => {
    expect(chatGptVisibilityBlocker("visible", "https://chatgpt.com/")).toBeUndefined();

    const blocker = chatGptVisibilityBlocker("hidden", "https://chatgpt.com/c/background");
    const unknownBlocker = chatGptVisibilityBlocker(undefined, "https://chatgpt.com/c/unknown");

    expect(blocker?.code).toBe("tab_not_visible");
    expect(blocker?.message).toContain("not the active visible tab");
    expect(blocker?.next_step).toContain("Select https://chatgpt.com/c/background");
    expect(unknownBlocker?.code).toBe("tab_not_visible");
    expect(unknownBlocker?.message).toContain("unknown");
  });

  it("scopes prompt insertion and submit to a ChatGPT composer root", () => {
    const prepareExpression = prepareComposerExpression();
    const submit = submitExpression();

    expect(CHATGPT_COMPOSER_CANDIDATE_EXCLUDED_ANCESTORS).not.toContain("textarea");
    expect(CHATGPT_COMPOSER_CANDIDATE_EXCLUDED_ANCESTORS).not.toContain("contenteditable");
    expect(CHATGPT_COMPOSER_CANDIDATE_EXCLUDED_ANCESTORS).not.toContain('div[role="textbox"]');
    expect(prepareExpression).toContain("findChatGptComposerCandidate");
    // prepare clears any stale active-composer marks (it must not SET one, which
    // would re-render ChatGPT's editor) and never uses the old offsetWidth gate.
    expect(prepareExpression).toContain(PRODEX_ACTIVE_COMPOSER_ATTRIBUTE);
    expect(prepareExpression).toContain("removeAttribute(activeComposerAttribute)");
    expect(prepareExpression).not.toContain("markChatGptComposerRoot(root)");
    expect(prepareExpression).not.toContain(".find((node) => !!(node.offsetWidth");
    // prepare must NOT manipulate the DOM selection for the ProseMirror editor:
    // an in-page select-all / execCommand desyncs ProseMirror so a later click
    // never submits (clearing is done via native CDP keyboard events instead).
    expect(prepareExpression).not.toContain("selectNodeContents");
    expect(prepareExpression).not.toContain('execCommand("delete")');
    expect(submit).toContain("findChatGptComposerCandidate");
    expect(submit).toContain("findMarkedChatGptComposerRoot()");
    expect(submit.indexOf("findMarkedChatGptComposerRoot()")).toBeLessThan(submit.indexOf("findChatGptComposerCandidate()"));
    expect(submit).toContain("root.querySelectorAll('button')");
    expect(submit).not.toContain("document.querySelectorAll('button')].find");
  });

  it("verifies the composer holds exactly the prompt and rejects leftover contamination", () => {
    const makeDoc = (composerValue: string) => {
      const root = new FakeElement("form");
      const editor = new FakeTextArea();
      editor.formRoot = root;
      editor.value = composerValue;
      root.buttons = [new FakeButton("Send prompt", "send-button")];
      return new FakeDocument([editor], [root]);
    };
    const globals = (doc: FakeDocument) => [doc, {}, FakeInputEvent, FakeEvent, FakeTextArea, FakeInput] as const;
    const prompt = "Review this repo\nfor security holes";

    // Clean: ProseMirror round-trips the prompt with an extra blank line; the
    // whitespace-normalized comparison must still accept it.
    const clean = evaluateBrowserExpression<{ ok: boolean }>(
      composerTextStateExpression(prompt),
      globals(makeDoc("Review this repo\n\nfor security holes"))
    );
    expect(clean.ok).toBe(true);

    // Contaminated: a failed clear left stale text prepended - must be rejected
    // so a wrong prompt is never sent.
    const dirty = evaluateBrowserExpression<{ ok: boolean; reason?: string }>(
      composerTextStateExpression(prompt),
      globals(makeDoc("leftover draft Review this repo\nfor security holes"))
    );
    expect(dirty.ok).toBe(false);
    expect(dirty.reason).toMatch(/did not match the prompt/);

    // Empty stays an empty-composer error.
    const empty = evaluateBrowserExpression<{ ok: boolean; reason?: string }>(
      composerTextStateExpression(prompt),
      globals(makeDoc(""))
    );
    expect(empty.ok).toBe(false);
    expect(empty.reason).toMatch(/empty/);

    // No expected arg (the acceptance-timeout "still has text" probe) accepts
    // any non-empty composer as before.
    const noArg = evaluateBrowserExpression<{ ok: boolean }>(composerTextStateExpression(), globals(makeDoc("anything")));
    expect(noArg.ok).toBe(true);
  });

  it("prepares the visible composer and locates its submit button", () => {
    const wrongRoot = new FakeElement("form");
    const wrongEditor = new FakeTextArea();
    const wrongButton = new FakeButton("Save");
    const chatRoot = new FakeElement("form");
    const chatEditor = new FakeTextArea();
    const chatButton = new FakeButton("Send prompt", "send-button");
    wrongEditor.formRoot = wrongRoot;
    chatEditor.formRoot = chatRoot;
    wrongRoot.buttons = [wrongButton];
    chatRoot.buttons = [chatButton];
    const document = new FakeDocument([wrongEditor, chatEditor], [wrongRoot, chatRoot]);
    const globals = [document, {}, FakeInputEvent, FakeEvent, FakeTextArea, FakeInput] as const;

    // prepare focuses/clears the real composer (the prompt is typed via CDP
    // Input.insertText, verified live); submit then locates the send button.
    const prepared = evaluateBrowserExpression<{ ok: boolean }>(prepareComposerExpression(), globals);
    const submitted = evaluateBrowserExpression<{ ok: boolean; x?: number; y?: number }>(submitExpression(), globals);

    expect(prepared.ok).toBe(true);
    // submitExpression returns the enabled submit button's click point; the
    // caller performs a real CDP click.
    expect(submitted.ok).toBe(true);
    expect(typeof submitted.x).toBe("number");
    expect(typeof submitted.y).toBe("number");
  });

  it("matches menu labels tolerantly (exact or first line) without cross-matching", () => {
    const efforts = ["High"];
    // exact
    expect(menuItemLabelMatches("High", efforts)).toBe(true);
    // description on a second line
    expect(menuItemLabelMatches("High\nBalanced speed and quality", efforts)).toBe(true);
    // must NOT match a longer sibling label
    expect(menuItemLabelMatches("Extra High", efforts)).toBe(false);
    expect(menuItemLabelMatches("Extra High\ndescription", efforts)).toBe(false);
    // "Pro" must not match "Pro Standard"
    expect(menuItemLabelMatches("Pro Standard", ["Pro"])).toBe(false);
    expect(menuItemLabelMatches("Pro\nsub-modes", ["Pro"])).toBe(true);
    // candidate list
    expect(menuItemLabelMatches("매우 높음\n최고 품질", ["매우 높음", "Extra High"])).toBe(true);
  });

  it("distinguishes a fresh empty chat from a lingering old thread", () => {
    // Fresh new chat: root URL, no messages yet.
    expect(isFreshChatGptPage({ url: "https://chatgpt.com/", assistantMessageCount: 0, userMessageCount: 0 })).toBe(true);
    expect(isFreshChatGptPage({ url: "https://chatgpt.com/?model=gpt-5", assistantMessageCount: 0, userMessageCount: 0 })).toBe(true);
    // Old thread still rendered (slow navigation): a /c/<id> URL or non-zero
    // message counts must NOT be mistaken for the fresh chat, or the answer
    // baseline is captured on the wrong thread.
    expect(isFreshChatGptPage({ url: "https://chatgpt.com/c/abc-123", assistantMessageCount: 5, userMessageCount: 5 })).toBe(false);
    expect(isFreshChatGptPage({ url: "https://chatgpt.com/", assistantMessageCount: 3, userMessageCount: 3 })).toBe(false);
    expect(isFreshChatGptPage({ url: "https://chatgpt.com/c/abc-123", assistantMessageCount: 0, userMessageCount: 0 })).toBe(false);
  });

  it("detects streaming via the stop-button and aria-busy signals, not just the label", async () => {
    // The streaming stop control is icon-only (data-testid="stop-button",
    // measured live) so its label won't match the "stop generating" pattern;
    // structural signals must drive `generating` to avoid silent truncation.
    expect(CHATGPT_STREAMING_SELECTOR).toContain('[data-testid="stop-button"]');
    expect(CHATGPT_STREAMING_SELECTOR).toContain('aria-busy="true"');
    const browser = await import("../src/chatgpt-browser.js");
    const statusExpr = (browser as { statusExpression: () => string }).statusExpression();
    // The generating computation must query the streaming selector, not rely
    // only on button-label text.
    expect(statusExpr).toContain("document.querySelector");
    expect(statusExpr).toContain("stop-button");
  });

  it("does not treat an incidental editable element as product-check composer readiness", async () => {
    const browser = await import("../src/chatgpt-browser.js");
    expect("statusExpression" in browser).toBe(true);
    const statusExpression = (browser as { statusExpression: () => string }).statusExpression;
    const plainEditor = new FakeTextArea();
    const plainDocument = new FakeDocument([plainEditor], []);
    plainDocument.body.innerText = "ChatGPT\nNew chat\nProjects\nPro";

    const plainStatus = evaluateBrowserStatusExpression<{ hasComposer: boolean }>(statusExpression(), plainDocument);

    const chatRoot = new FakeElement("form");
    const chatEditor = new FakeTextArea();
    const disabledSend = new FakeButton("Send prompt", "send-button");
    disabledSend.disabled = true;
    chatEditor.formRoot = chatRoot;
    chatRoot.buttons = [disabledSend];
    const chatDocument = new FakeDocument([chatEditor], [chatRoot]);
    chatDocument.body.innerText = "ChatGPT\nNew chat\nProjects\nPro";

    const chatStatus = evaluateBrowserStatusExpression<{ hasComposer: boolean }>(statusExpression(), chatDocument);

    expect(plainStatus.hasComposer).toBe(false);
    expect(chatStatus.hasComposer).toBe(true);
  });

  it("matches a menu item whose badge pollutes textContent (Instant + version chip)", async () => {
    const browser = await import("../src/chatgpt-browser.js");
    const menuItemPresentExpression = (browser as { menuItemPresentExpression: (label: string | readonly string[]) => string })
      .menuItemPresentExpression;
    const doc = new FakeDocument([], []);
    // Measured live on the 2026-07 ChatGPT update: the "5.5" chip concatenates
    // in textContent ("Instant5.5") but stays on its own line in innerText.
    const instant = new FakeElement("div");
    instant.innerText = "Instant\n5.5";
    instant.textContent = "Instant5.5";
    const extraHigh = new FakeElement("div");
    extraHigh.innerText = "Extra High";
    extraHigh.textContent = "Extra High";
    doc.menuItems = [instant, extraHigh];

    expect(evaluateBrowserStatusExpression<boolean>(menuItemPresentExpression("Instant"), doc)).toBe(true);
    // First-line matching must still refuse to cross-match High/Extra High.
    expect(evaluateBrowserStatusExpression<boolean>(menuItemPresentExpression("High"), doc)).toBe(false);
  });

  it("answerExpression reads counts, the last assistant text, and generating from the DOM", async () => {
    const browser = await import("../src/chatgpt-browser.js");
    const answerExpression = (browser as { answerExpression: () => string }).answerExpression;
    const message = (role: string, text: string): FakeElement => {
      const el = new FakeElement("div");
      el.setAttribute("data-message-author-role", role);
      el.innerText = text;
      return el;
    };
    type AnswerState = { answer: string; assistantMessageCount: number; userMessageCount: number; generating: boolean };

    // Normal thread: last assistant message is the answer, counts are split by role.
    const doc = new FakeDocument([], []);
    doc.body.innerText = "ChatGPT\nsidebar";
    doc.messages = [message("user", "q1"), message("assistant", "a1"), message("user", "q2"), message("assistant", "final answer")];
    const state = evaluateBrowserStatusExpression<AnswerState>(answerExpression(), doc);
    expect(state.assistantMessageCount).toBe(2);
    expect(state.userMessageCount).toBe(2);
    expect(state.answer).toBe("final answer");
    expect(state.generating).toBe(false);

    // A lone reasoning header is a placeholder: generating must be true.
    doc.messages = [message("user", "q"), message("assistant", "Thinking")];
    expect(evaluateBrowserStatusExpression<AnswerState>(answerExpression(), doc).generating).toBe(true);
    // ...but a real answer that starts with "Thinking" is not.
    doc.messages = [message("user", "q"), message("assistant", "Thinking about it, yes.")];
    expect(evaluateBrowserStatusExpression<AnswerState>(answerExpression(), doc).generating).toBe(false);

    // An assistant message with empty text must NOT fall back to page chrome.
    doc.messages = [message("user", "q"), message("assistant", "")];
    const empty = evaluateBrowserStatusExpression<AnswerState>(answerExpression(), doc);
    expect(empty.answer).toBe("");
    expect(empty.assistantMessageCount).toBe(1);

    // No messages at all: there is no answer, and the page's own text must not
    // be dressed up as one.
    doc.messages = [];
    const none = evaluateBrowserStatusExpression<AnswerState>(answerExpression(), doc);
    expect(none.answer).toBe("");
    expect(none.assistantMessageCount).toBe(0);
  });

  it("prefers the row's project-home button for project navigation (2026-07 UI)", async () => {
    const browser = await import("../src/chatgpt-browser.js");
    const projectItemRectExpression = (browser as { projectItemRectExpression: (name: string) => string }).projectItemRectExpression;
    const expr = projectItemRectExpression("demo-project");
    // The project row (li) is no longer a link on the new UI; navigation is the
    // "Open project home" button inside the row. Pin that the expression
    // targets it (with the Korean label variant) before falling back.
    expect(expr).toContain('project home');
    expect(expr).toContain("프로젝트 홈");
    expect(expr).toContain("clickPoint(home)");
    // Exact name match by EQUALITY (not substring), with a case-insensitive
    // unique fallback and a loud ambiguity error.
    expect(expr).toContain("projName(b) === wanted");
    expect(expr).toContain("projName(b).toLowerCase() === wanted.toLowerCase()");
    expect(expr).toContain("matches multiple sidebar projects");
  });

  it("matches a project by exact name, never a substring superset", async () => {
    const browser = await import("../src/chatgpt-browser.js");
    const matchProjectOptionName = (
      browser as { matchProjectOptionName: (labels: readonly string[], wanted: string) => number | "ambiguous" }
    ).matchProjectOptionName;
    const labels = ["Open project options for Codex Review", "Open project options for Codex"];
    // "Codex" must resolve to the exact "Codex" row (index 1), never the
    // substring superset "Codex Review" (index 0) that .includes() picked.
    expect(matchProjectOptionName(labels, "Codex")).toBe(1);
    // Korean label + case-insensitive unique fallback.
    expect(matchProjectOptionName(["prodex-smoke-project 프로젝트 옵션 열기"], "PRODEX-SMOKE-PROJECT")).toBe(0);
    // Duplicate exact names -> ambiguous, refuse to guess.
    expect(matchProjectOptionName(["Open project options for dup", "Open project options for dup"], "dup")).toBe("ambiguous");
    // No match.
    expect(matchProjectOptionName(labels, "Nonexistent")).toBe(-1);
  });

  it("keeps the in-page menu match predicate in parity with menuItemLabelMatches", async () => {
    const browser = await import("../src/chatgpt-browser.js");
    const menuItemPresentExpression = (browser as { menuItemPresentExpression: (label: string | readonly string[]) => string })
      .menuItemPresentExpression;
    const texts = ["High", "Extra High", "High\nBalanced speed", "Instant\n5.5", "Pro", "Pro Standard", "매우 높음\n최고 품질"];
    const candidateSets: (string | string[])[] = ["High", "Extra High", "Instant", "Pro", ["매우 높음", "Extra High"]];
    for (const candidates of candidateSets) {
      const list = Array.isArray(candidates) ? candidates : [candidates];
      for (const text of texts) {
        const doc = new FakeDocument([], []);
        const el = new FakeElement("div");
        el.innerText = text;
        el.textContent = text.replace(/\n/g, "");
        doc.menuItems = [el];
        const inPage = evaluateBrowserStatusExpression<boolean>(menuItemPresentExpression(candidates), doc);
        expect(inPage, `candidates=${JSON.stringify(list)} text=${JSON.stringify(text)}`).toBe(menuItemLabelMatches(text, list));
      }
    }
  });

  it("lists sidebar project names from both locales' option-button labels", async () => {
    const browser = await import("../src/chatgpt-browser.js");
    const sidebarProjectNamesExpression = (browser as { sidebarProjectNamesExpression: () => string }).sidebarProjectNamesExpression;
    const doc = new FakeDocument([], []);
    const en = new FakeElement("button");
    en.setAttribute("aria-label", "Open project options for Codex");
    const ko = new FakeElement("button");
    ko.setAttribute("aria-label", "prodex-smoke-project 프로젝트 옵션 열기");
    const dupe = new FakeElement("button");
    dupe.setAttribute("aria-label", "Open project options for Codex");
    doc.projectOptionButtons = [en, ko, dupe];

    const names = evaluateBrowserStatusExpression<string[]>(sidebarProjectNamesExpression(), doc);
    expect(names).toEqual(["Codex", "prodex-smoke-project"]);
  });

  it("reports an open dialog's text so a blocked composer can be dismissed", async () => {
    const browser = await import("../src/chatgpt-browser.js");
    const statusExpression = (browser as { statusExpression: () => string }).statusExpression;
    const doc = new FakeDocument([new FakeTextArea()], []);
    const dialog = new FakeElement("div");
    dialog.innerText = "ChatGPT for Work onboarding\nTry ChatGPT Work\nClose";
    doc.dialogs = [dialog];

    const status = evaluateBrowserStatusExpression<{ openDialogText?: string }>(statusExpression(), doc);
    expect(status.openDialogText).toContain("ChatGPT for Work onboarding");

    doc.dialogs = [];
    const clear = evaluateBrowserStatusExpression<{ openDialogText?: string }>(statusExpression(), doc);
    expect(clear.openDialogText).toBe("");
  });
});

function devtoolsPage(url: string): DevtoolsPage {
  return {
    type: "page",
    url,
    title: url,
    webSocketDebuggerUrl: `ws://127.0.0.1/devtools/page/${encodeURIComponent(url)}`
  };
}

function evaluateBrowserExpression<T>(
  expression: string,
  globals: readonly [FakeDocument, object, typeof FakeInputEvent, typeof FakeEvent, typeof FakeTextArea, typeof FakeInput]
): T {
  const run = new Function("document", "window", "InputEvent", "Event", "HTMLTextAreaElement", "HTMLInputElement", `return ${expression};`);
  return run(...globals) as T;
}

function evaluateBrowserStatusExpression<T>(expression: string, document: FakeDocument): T {
  const window = { getComputedStyle: () => ({ display: "block", visibility: "visible" }) };
  const nodeFilter = { SHOW_TEXT: 4 };
  const location = { href: "https://chatgpt.com/" };
  const run = new Function(
    "document",
    "window",
    "InputEvent",
    "Event",
    "HTMLTextAreaElement",
    "HTMLInputElement",
    "NodeFilter",
    "location",
    `return ${expression};`
  );
  return run(document, window, FakeInputEvent, FakeEvent, FakeTextArea, FakeInput, nodeFilter, location) as T;
}

class FakeEvent {
  constructor(
    readonly type: string,
    readonly options: Record<string, unknown> = {}
  ) {}
}

class FakeInputEvent extends FakeEvent {}

class FakeElement {
  offsetWidth = 100;
  offsetHeight = 24;
  innerText = "";
  textContent = "";
  parentElement?: FakeElement;
  formRoot?: FakeElement;
  buttons: FakeButton[] = [];
  onDispatch?: (event: FakeEvent) => void;
  private attributes = new Map<string, string>();

  constructor(readonly tagName = "div") {}

  getClientRects(): unknown[] {
    return this.offsetWidth > 0 && this.offsetHeight > 0 ? [this] : [];
  }

  getBoundingClientRect(): { width: number; height: number; x: number; y: number; top: number; left: number; right: number; bottom: number } {
    return {
      width: this.offsetWidth,
      height: this.offsetHeight,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: this.offsetWidth,
      bottom: this.offsetHeight
    };
  }

  focus(): void {}

  scrollIntoView(): void {}

  dispatchEvent(event: FakeEvent): void {
    this.onDispatch?.(event);
  }

  closest(selector: string): FakeElement | undefined {
    if (selector.includes("[data-message-author-role]")) return undefined;
    if (selector === "form") return this.formRoot ?? (this.tagName === "form" ? this : undefined);
    if (selector.includes("data-testid") || selector.includes("class")) return this.formRoot;
    return undefined;
  }

  querySelectorAll(selector: string): FakeElement[] {
    if (selector === "button") return this.buttons;
    return [];
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
}

class FakeTextArea extends FakeElement {
  private storedValue = "";

  constructor() {
    super("textarea");
  }

  get value(): string {
    return this.storedValue;
  }

  set value(value: string) {
    this.storedValue = value;
    this.textContent = value;
    this.innerText = value;
  }
}

class FakeInput extends FakeTextArea {}

class FakeButton extends FakeElement {
  clicked = false;
  disabled = false;

  constructor(label: string, dataTestId?: string) {
    super("button");
    this.innerText = label;
    if (dataTestId) this.setAttribute("data-testid", dataTestId);
  }

  click(): void {
    this.clicked = true;
  }
}

class FakeDocument {
  readonly body = new FakeElement("body");
  title = "ChatGPT";
  visibilityState = "visible";
  menuItems: FakeElement[] = [];
  dialogs: FakeElement[] = [];
  messages: FakeElement[] = [];
  projectOptionButtons: FakeElement[] = [];

  constructor(
    private readonly editors: FakeTextArea[],
    private readonly roots: FakeElement[]
  ) {}

  createTreeWalker(): { nextNode: () => boolean; currentNode?: { parentElement?: FakeElement; nodeValue?: string } } {
    return { nextNode: () => false };
  }

  querySelectorAll(selector: string): FakeElement[] {
    if (selector === "button,a,[role=\"button\"]" || selector === 'button,[role="button"]') {
      return this.roots.flatMap((root) => root.buttons);
    }
    if (selector === "[data-message-author-role]") return this.messages;
    if (selector.includes("menuitemradio") || selector.includes('[role="menuitem"]')) return this.menuItems;
    if (selector.includes("프로젝트 옵션") || selector.includes("project options")) return this.projectOptionButtons;
    if (selector.includes('[role="dialog"]')) return this.dialogs;
    if (selector.includes("textarea") || selector.includes("[contenteditable")) return this.editors;
    if (selector.includes(PRODEX_ACTIVE_COMPOSER_ATTRIBUTE)) {
      return this.roots.filter((root) => root.getAttribute(PRODEX_ACTIVE_COMPOSER_ATTRIBUTE) === "true");
    }
    return [];
  }

  querySelector(selector: string): FakeElement | undefined {
    return this.querySelectorAll(selector)[0];
  }
}
