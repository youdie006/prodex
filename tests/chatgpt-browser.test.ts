import { describe, expect, it } from "vitest";
import {
  buildChromeLaunchArgs,
  assertVisibleChatGptTab,
  chatGptUrlsReferToSameTarget,
  chatGptBlockerErrorFromAnswerState,
  CHATGPT_RUNTIME_BLOCKER_TEXT_EXCLUDED_ANCESTORS,
  CHATGPT_COMPOSER_CANDIDATE_EXCLUDED_ANCESTORS,
  GPTPROUSE_ACTIVE_COMPOSER_ATTRIBUTE,
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
  inferChatGptPageLoggedInLikely,
  inferLoggedInLikely,
  isLikelyChatGptGeneratingControl,
  isLikelyChatGptSubmitButton,
  normalizeChatGptTargetUrl,
  selectChatGptPage,
  setComposerTextExpression,
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
      profileDir: "/tmp/gptprouse-profile",
      url: "https://chatgpt.com/"
    });

    expect(args).toContain("--remote-debugging-address=127.0.0.1");
    expect(args).toContain("--remote-debugging-port=9333");
    expect(args).toContain("--user-data-dir=/tmp/gptprouse-profile");
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
        answer: "GPTPROUSE_PRO_SMOKE_OK",
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

  it("detects ChatGPT browser blocker states before sending", () => {
    expect(detectChatGptBlocker("Just a moment... Checking if the site connection is secure", [])?.code).toBe("cloudflare_check");
    expect(detectChatGptBlocker("Please solve this captcha to continue", [])?.code).toBe("captcha_required");
    expect(detectChatGptBlocker("You've reached the GPT-5 message limit. Try again later.", [])?.code).toBe("usage_limit");
    expect(detectChatGptBlocker("Additional verification required", ["Continue"])?.code).toBe("permission_required");
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
    expect(selectChatGptPage(pages)?.url).toBe("https://chatgpt.com/c/first");
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
    expect(() => assertVisibleChatGptTab("visible", "https://chatgpt.com/c/current")).not.toThrow();
  });

  it("turns non-visible ChatGPT tabs into a browser status blocker", () => {
    expect(chatGptVisibilityBlocker("visible", "https://chatgpt.com/")).toBeUndefined();

    const blocker = chatGptVisibilityBlocker("hidden", "https://chatgpt.com/c/background");

    expect(blocker?.code).toBe("tab_not_visible");
    expect(blocker?.message).toContain("not the active visible tab");
    expect(blocker?.next_step).toContain("Select https://chatgpt.com/c/background");
  });

  it("scopes prompt insertion and submit to a ChatGPT composer root", () => {
    const insertExpression = setComposerTextExpression("hello");
    const submit = submitExpression();

    expect(CHATGPT_COMPOSER_CANDIDATE_EXCLUDED_ANCESTORS).not.toContain("textarea");
    expect(CHATGPT_COMPOSER_CANDIDATE_EXCLUDED_ANCESTORS).not.toContain("contenteditable");
    expect(CHATGPT_COMPOSER_CANDIDATE_EXCLUDED_ANCESTORS).not.toContain('div[role="textbox"]');
    expect(insertExpression).toContain("findChatGptComposerCandidate");
    expect(insertExpression).toContain("findChatGptComposerRoot");
    expect(insertExpression).toContain(GPTPROUSE_ACTIVE_COMPOSER_ATTRIBUTE);
    expect(insertExpression).toContain("markChatGptComposerRoot(root)");
    expect(insertExpression).not.toContain(".find((node) => !!(node.offsetWidth");
    expect(submit).toContain("findChatGptComposerCandidate");
    expect(submit).toContain("findMarkedChatGptComposerRoot()");
    expect(submit.indexOf("findMarkedChatGptComposerRoot()")).toBeLessThan(submit.indexOf("findChatGptComposerCandidate()"));
    expect(submit).toContain("root.querySelectorAll('button')");
    expect(submit).not.toContain("document.querySelectorAll('button')].find");
  });

  it("submits through the composer root marked during prompt insertion", () => {
    const wrongRoot = new FakeElement("form");
    const wrongEditor = new FakeTextArea();
    const wrongButton = new FakeButton("Save");
    const chatRoot = new FakeElement("form");
    const chatEditor = new FakeTextArea();
    const chatButton = new FakeButton("Send prompt", "send-button");
    chatButton.disabled = true;
    wrongEditor.formRoot = wrongRoot;
    chatEditor.formRoot = chatRoot;
    wrongRoot.buttons = [wrongButton];
    chatRoot.buttons = [chatButton];
    chatEditor.onDispatch = (event) => {
      if (event.type === "input") chatButton.disabled = false;
    };
    const document = new FakeDocument([wrongEditor, chatEditor], [wrongRoot, chatRoot]);
    const globals = [document, {}, FakeInputEvent, FakeEvent, FakeTextArea, FakeInput] as const;

    const inserted = evaluateBrowserExpression<{ ok: boolean }>(setComposerTextExpression("hello"), globals);
    const submitted = evaluateBrowserExpression<{ ok: boolean }>(submitExpression(), globals);

    expect(inserted.ok).toBe(true);
    expect(submitted.ok).toBe(true);
    expect(chatEditor.value).toBe("hello");
    expect(chatRoot.getAttribute(GPTPROUSE_ACTIVE_COMPOSER_ATTRIBUTE)).toBe("true");
    expect(chatButton.clicked).toBe(true);
    expect(wrongButton.clicked).toBe(false);
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
    return [this];
  }

  focus(): void {}

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
  constructor(
    private readonly editors: FakeTextArea[],
    private readonly roots: FakeElement[]
  ) {}

  querySelectorAll(selector: string): FakeElement[] {
    if (selector.includes("textarea") || selector.includes("[contenteditable")) return this.editors;
    if (selector.includes(GPTPROUSE_ACTIVE_COMPOSER_ATTRIBUTE)) {
      return this.roots.filter((root) => root.getAttribute(GPTPROUSE_ACTIVE_COMPOSER_ATTRIBUTE) === "true");
    }
    return [];
  }

  querySelector(selector: string): FakeElement | undefined {
    return this.querySelectorAll(selector)[0];
  }
}
