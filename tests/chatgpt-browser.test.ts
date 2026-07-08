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
  inferChatGptPageLoggedInLikely,
  inferLoggedInLikely,
  isLikelyChatGptGeneratingControl,
  isLikelyChatGptSubmitButton,
  normalizeChatGptTargetUrl,
  selectChatGptPage,
  prepareComposerExpression,
  composerTextStateExpression,
  sendChatGptPrompt,
  submitExpression,
  isUsableChatGptAnswer
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

  it("recognizes a logged-in Korean ChatGPT UI snapshot", () => {
    const text = "채팅 기록\nChatGPT\n새 채팅\n프로젝트\n홍길동\nPro\n무엇이든 편하게 시작해 보세요.";
    const buttons = ["프로필 메뉴 열기", "새 채팅", "프로젝트 홈 열기"];

    expect(inferLoggedInLikely(text, buttons)).toBe(true);
  });

  it("does not treat Korean thinking placeholders as final answers", () => {
    expect(isUsableChatGptAnswer("생각 중...")).toBe(false);
    expect(isUsableChatGptAnswer("9s 동안 생각함\n\n실제 답변입니다.")).toBe(true);
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
    expect(blocker?.next_step).toContain("visible");
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

  constructor(
    private readonly editors: FakeTextArea[],
    private readonly roots: FakeElement[]
  ) {}

  createTreeWalker(): { nextNode: () => boolean; currentNode?: { parentElement?: FakeElement; nodeValue?: string } } {
    return { nextNode: () => false };
  }

  querySelectorAll(selector: string): FakeElement[] {
    if (selector === "button,a,[role=\"button\"]") return this.roots.flatMap((root) => root.buttons);
    if (selector === "[data-message-author-role]") return [];
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
