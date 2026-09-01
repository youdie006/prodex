import { describe, expect, it } from "vitest";

import { proModeNotAppliedWarning } from "../src/chatgpt-browser.js";

// Measured on the current ChatGPT picker: selection is a five-step power slider
// (`{ok:true, position:4, max:4, model:"GPT-5.6 Sol", effort:"Pro"}`) and the
// send takes that branch and returns. It reads `effort ?? model`, so a request
// for a Pro sub-mode never reaches the code that would apply it - and nothing
// said so. A run with `--model Pro --pro-mode 확장` finished clean, recorded
// model_used gpt-5-6-pro and zero warnings, having never applied 확장.
//
// The older picker, still live on another machine, fails the same request LOUDLY
// ("Pro option not found in the model menu"). Getting silence on one box and an
// error on the other, for the same command, is the part worth fixing here:
// silence is the worse half.
describe("a Pro sub-mode asked for on a power-slider picker", () => {
  it("is reported as not applied, naming the step that was used instead", () => {
    const warning = proModeNotAppliedWarning("확장", "Pro");
    expect(warning).toBeDefined();
    expect(warning).toContain("pro_mode_not_applied");
    expect(warning).toContain("확장");
    expect(warning).toContain("Pro");
  });

  it("does not claim the send failed, because it did not", () => {
    const warning = proModeNotAppliedWarning("기본", "Pro") ?? "";
    expect(warning).not.toMatch(/\bfailed\b|\berror\b/i);
  });

  it("says nothing when no sub-mode was asked for", () => {
    expect(proModeNotAppliedWarning(undefined, "Pro")).toBeUndefined();
    expect(proModeNotAppliedWarning(undefined, undefined)).toBeUndefined();
  });

  it("still names the request when the slider will not say what it is set to", () => {
    expect(proModeNotAppliedWarning("확장", undefined)).toContain("확장");
  });
});
