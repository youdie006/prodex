import { describe, expect, it } from "vitest";

import { createChatGptAnswerStabilityTracker } from "../src/chatgpt-browser.js";

describe("createChatGptAnswerStabilityTracker", () => {
  it("accepts a normal answer after two consecutive stable non-generating polls", () => {
    const observe = createChatGptAnswerStabilityTracker();
    expect(observe("answer", true)).toBe(false);
    expect(observe("answer", false)).toBe(false);
    expect(observe("answer", false)).toBe(false);
    expect(observe("answer", false)).toBe(true);
  });

  it("resets stability when the text changes", () => {
    const observe = createChatGptAnswerStabilityTracker();
    observe("partial", false);
    observe("partial", false);
    expect(observe("longer partial", false)).toBe(false);
    expect(observe("longer partial", false)).toBe(false);
    expect(observe("longer partial", false)).toBe(true);
  });

  it("does not count generating polls as confirmations and resets the baseline", () => {
    const observe = createChatGptAnswerStabilityTracker();
    observe("answer", false);
    expect(observe("answer", true)).toBe(false);
    expect(observe("answer", false)).toBe(false);
    expect(observe("answer", false)).toBe(false);
    expect(observe("answer", false)).toBe(true);
  });

  it("holds a trailing-caret-suspect answer for extra confirmations", () => {
    const observe = createChatGptAnswerStabilityTracker();
    // The streaming caret renders as a literal trailing underscore that can
    // outlive the stop button; two stable polls must NOT accept it.
    observe("PRODEX_UX_090_OK_", false);
    expect(observe("PRODEX_UX_090_OK_", false)).toBe(false);
    expect(observe("PRODEX_UX_090_OK_", false)).toBe(false);
    expect(observe("PRODEX_UX_090_OK_", false)).toBe(false);
    // Caret disappears at finalization: converge on the clean text quickly.
    expect(observe("PRODEX_UX_090_OK", false)).toBe(false);
    expect(observe("PRODEX_UX_090_OK", false)).toBe(false);
    expect(observe("PRODEX_UX_090_OK", false)).toBe(true);
  });

  it("eventually accepts an answer that genuinely ends with an underscore", () => {
    const observe = createChatGptAnswerStabilityTracker();
    let accepted = false;
    observe("const trailing_", false);
    for (let poll = 0; poll < 8 && !accepted; poll += 1) {
      accepted = observe("const trailing_", false);
    }
    expect(accepted).toBe(true);
  });

  it("treats a caret followed by trailing whitespace as suspect too", () => {
    const observe = createChatGptAnswerStabilityTracker();
    observe("PRODEX_UX_090_OK_\n", false);
    expect(observe("PRODEX_UX_090_OK_\n", false)).toBe(false);
    expect(observe("PRODEX_UX_090_OK_\n", false)).toBe(false);
    expect(observe("PRODEX_UX_090_OK_\n", false)).toBe(false);
  });

  it("treats the legacy block caret the same way", () => {
    const observe = createChatGptAnswerStabilityTracker();
    observe("streaming tail▍", false);
    expect(observe("streaming tail▍", false)).toBe(false);
    expect(observe("streaming tail▍", false)).toBe(false);
    expect(observe("streaming tail", false)).toBe(false);
    expect(observe("streaming tail", false)).toBe(false);
    expect(observe("streaming tail", false)).toBe(true);
  });
});
