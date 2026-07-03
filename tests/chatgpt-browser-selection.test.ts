import { describe, it, expect } from "vitest";

import {
  hasPartialChatGptAnswer,
  isTabActivationEnabled,
  isUsableChatGptAnswer,
  parseReasoningEffort,
  parseProMode,
  resolveCdpTimeoutMs
} from "../src/chatgpt-browser.js";

describe("resolveCdpTimeoutMs", () => {
  it("falls back to a bounded default so a frozen browser cannot hang the poll forever", () => {
    expect(resolveCdpTimeoutMs(undefined)).toBe(20_000);
    expect(resolveCdpTimeoutMs(0)).toBe(20_000);
    expect(resolveCdpTimeoutMs(-5)).toBe(20_000);
  });

  it("honors an explicit positive timeout", () => {
    expect(resolveCdpTimeoutMs(5_000)).toBe(5_000);
    expect(resolveCdpTimeoutMs(1)).toBe(1);
  });
});

describe("hasPartialChatGptAnswer", () => {
  it("recognizes a new assistant message with usable text even while still generating", () => {
    expect(hasPartialChatGptAnswer(0, { answer: "Here is a partial thought", assistantMessageCount: 1, generating: true })).toBe(true);
  });

  it("is false when no new assistant message appeared", () => {
    expect(hasPartialChatGptAnswer(1, { answer: "text", assistantMessageCount: 1, generating: true })).toBe(false);
  });

  it("is false for a bare thinking placeholder", () => {
    expect(hasPartialChatGptAnswer(0, { answer: "Pro 생각 중", assistantMessageCount: 1, generating: true })).toBe(false);
    expect(hasPartialChatGptAnswer(0, { answer: "", assistantMessageCount: 1, generating: true })).toBe(false);
  });
});

describe("isTabActivationEnabled", () => {
  it("is off by default so sends never steal focus", () => {
    expect(isTabActivationEnabled({})).toBe(false);
    expect(isTabActivationEnabled({ PRODEX_ACTIVATE_TAB: "0" })).toBe(false);
    expect(isTabActivationEnabled({ PRODEX_ACTIVATE_TAB: "" })).toBe(false);
  });

  it("opts in on the documented truthy values", () => {
    expect(isTabActivationEnabled({ PRODEX_ACTIVATE_TAB: "1" })).toBe(true);
    expect(isTabActivationEnabled({ PRODEX_ACTIVATE_TAB: "true" })).toBe(true);
    expect(isTabActivationEnabled({ PRODEX_ACTIVATE_TAB: "YES" })).toBe(true);
  });
});

describe("isUsableChatGptAnswer thinking placeholders", () => {
  it("rejects the bare Korean thinking status", () => {
    expect(isUsableChatGptAnswer("생각 중")).toBe(false);
  });

  it("rejects the model-prefixed Korean thinking status", () => {
    expect(isUsableChatGptAnswer("Pro 생각 중")).toBe(false);
    expect(isUsableChatGptAnswer("GPT-5.5 생각 중...")).toBe(false);
  });

  it("accepts a real answer that merely mentions thinking", () => {
    expect(isUsableChatGptAnswer("생각 중이라는 표현은 다음과 같이 씁니다.\n예시입니다.")).toBe(true);
    expect(isUsableChatGptAnswer("OK")).toBe(true);
  });
});

describe("parseReasoningEffort", () => {
  it("accepts the canonical Korean labels unchanged", () => {
    expect(parseReasoningEffort("즉시")).toBe("즉시");
    expect(parseReasoningEffort("중간")).toBe("중간");
    expect(parseReasoningEffort("높음")).toBe("높음");
    expect(parseReasoningEffort("매우 높음")).toBe("매우 높음");
  });

  it("normalizes the spaceless '매우높음' to the exact menu label", () => {
    expect(parseReasoningEffort("매우높음")).toBe("매우 높음");
  });

  it("trims surrounding whitespace", () => {
    expect(parseReasoningEffort("  높음  ")).toBe("높음");
  });

  it("accepts lowercase English aliases", () => {
    expect(parseReasoningEffort("instant")).toBe("즉시");
    expect(parseReasoningEffort("Medium")).toBe("중간");
    expect(parseReasoningEffort("HIGH")).toBe("높음");
    expect(parseReasoningEffort("max")).toBe("매우 높음");
  });

  it("accepts the English menu labels as verified in the English UI", () => {
    expect(parseReasoningEffort("Extra High")).toBe("매우 높음");
    expect(parseReasoningEffort("Instant")).toBe("즉시");
  });

  it("throws with the valid choices on an unknown value", () => {
    expect(() => parseReasoningEffort("turbo")).toThrow(/매우 높음/);
  });
});

describe("parseProMode", () => {
  it("accepts the canonical Korean labels unchanged", () => {
    expect(parseProMode("기본")).toBe("기본");
    expect(parseProMode("확장")).toBe("확장");
  });

  it("accepts English aliases", () => {
    expect(parseProMode("standard")).toBe("기본");
    expect(parseProMode("Extended")).toBe("확장");
  });

  it("throws with the valid choices on an unknown value", () => {
    expect(() => parseProMode("ultra")).toThrow(/기본/);
  });
});
