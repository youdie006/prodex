import { describe, expect, it } from "vitest";

import {
  assertChatGptIdleAndReadyForPrompt,
  ChatGptBrowserBlockerError,
  looksLikeChatGptErrorPage
} from "../src/chatgpt-browser.js";

// Measured live on two different projects: every hard load of a project home -
// Page.reload and location.assign alike - comes back as ChatGPT's error page,
// the whole body "Try again" and one button, while the same route reached by
// clicking the sidebar renders in under two seconds and the rest of ChatGPT
// loads fine. The project step no longer reloads because of it, but any send
// can still land on that page, and prodex used to report it as a login it
// could not find.
describe("recognising ChatGPT's error page", () => {
  it("knows the page that is nothing but a retry", () => {
    expect(looksLikeChatGptErrorPage({ bodyText: "Try again", hasComposer: false })).toBe(true);
    expect(looksLikeChatGptErrorPage({ bodyText: "다시 시도", hasComposer: false })).toBe(true);
  });

  it("is not fooled by a page that works", () => {
    expect(looksLikeChatGptErrorPage({ bodyText: "Try again", hasComposer: true })).toBe(false);
  });

  it("is not fooled by a real page that merely mentions retrying", () => {
    const realPage = `Skip to content Chat history New chat Projects ${"conversation ".repeat(20)} Try again`;
    expect(looksLikeChatGptErrorPage({ bodyText: realPage, hasComposer: false })).toBe(false);
  });

  it("does not call a page that is still loading an error", () => {
    expect(looksLikeChatGptErrorPage({ bodyText: "", hasComposer: false })).toBe(false);
    expect(looksLikeChatGptErrorPage({ bodyText: "   ", hasComposer: false })).toBe(false);
  });
});

// A project page that fails to load leaves the tab parked on that error page,
// and measured live the very next send then reported "missing a clear
// logged-in ChatGPT session" and told the caller to log in - on a browser
// whose session was fine. That is also exactly the retry the blocker above
// asks for, so the wrong diagnosis landed on the recovery path.
describe("a send that finds the tab on ChatGPT's error page", () => {
  const errorPage = {
    textSample: "Try again",
    visibleButtonLabels: ["Try again"],
    hasComposer: false,
    generating: false
  };

  const blockerFrom = (state: Parameters<typeof assertChatGptIdleAndReadyForPrompt>[0]) => {
    try {
      assertChatGptIdleAndReadyForPrompt(state, undefined, true);
    } catch (error) {
      if (error instanceof ChatGptBrowserBlockerError) return error.blocker;
      throw error;
    }
    return undefined;
  };

  it("names the page instead of blaming the login", () => {
    const blocker = blockerFrom(errorPage);
    expect(blocker?.code).toBe("chatgpt_error_page");
    expect(blocker?.message).not.toMatch(/logged-in/i);
    expect(blocker?.next_step).not.toMatch(/log in/i);
  });

  it("is worth retrying, because the page may come back", () => {
    expect(blockerFrom(errorPage)?.retryable).toBe(true);
  });

  it("still tells a genuinely logged-out tab to log in", () => {
    const blocker = blockerFrom({
      textSample: "Log in Sign up Welcome back",
      visibleButtonLabels: ["Log in", "Sign up"],
      hasComposer: false,
      generating: false
    });
    expect(blocker?.code).toBe("chatgpt_not_ready");
    expect(blocker?.next_step).toMatch(/log in/i);
  });

  it("says nothing about the error page when the composer is there", () => {
    expect(
      blockerFrom({
        textSample: "New chat Projects Try again",
        visibleButtonLabels: ["New chat"],
        hasComposer: true,
        generating: false
      })
    ).toBeUndefined();
  });
});
