import { describe, expect, it } from "vitest";

import { parseReasoningEffort, pickerSelectionPlan } from "../src/chatgpt-browser.js";

// The picker's slider has five steps and prodex knew four names for them.
// Measured at both ends on the live UI:
//   {position: 0, max: 4, effort: "Instant", lines: ["Instant", "Instant, 1 of 5.", ...]}
//   {position: 4, max: 4, effort: "Pro",     lines: ["Pro, 5 of 5.", ...]}
// So Pro is the fifth step, and --effort could not name it: the vocabulary
// stopped at 매우 높음. The only way to reach it was --model Pro, which then
// warned "Say --effort Pro to be explicit" - a command that failed on the
// spot. Reaching the top of the slider went in a circle.
describe("Pro as a step of the effort slider", () => {
  it("is accepted by --effort, in both the label and the English spelling", () => {
    expect(parseReasoningEffort("Pro")).toBe("Pro");
    expect(parseReasoningEffort("pro")).toBe("Pro");
    expect(parseReasoningEffort("프로")).toBe("Pro");
  });

  it("still accepts the four it always did", () => {
    expect(parseReasoningEffort("즉시")).toBe("즉시");
    expect(parseReasoningEffort("매우 높음")).toBe("매우 높음");
    expect(parseReasoningEffort("max")).toBe("매우 높음");
    expect(parseReasoningEffort("extrahigh")).toBe("매우 높음");
  });

  it("still refuses something the slider does not have", () => {
    expect(() => parseReasoningEffort("Ultra")).toThrow(/must be one of/i);
  });

  it("names Pro among the accepted values when it refuses", () => {
    // The message is where someone learns what they may pass; leaving Pro out
    // of it is what made the advice in the warning unfollowable.
    expect(() => parseReasoningEffort("Ultra")).toThrow(/Pro/);
  });

  it("sends an explicit --effort Pro straight to the slider, with nothing to warn about", () => {
    expect(pickerSelectionPlan({ effort: "Pro" })).toEqual({ sliderLabel: "Pro" });
  });
});
