import { describe, it, expect } from "vitest";

import { parseReasoningEffort, parseProMode } from "../src/chatgpt-browser.js";

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
