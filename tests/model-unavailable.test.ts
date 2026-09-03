import { describe, expect, it } from "vitest";

import { modelSelectionUnavailableWarning, stepSelectionUnavailableWarning } from "../src/chatgpt-browser.js";

// A model this picker does not offer must not kill an otherwise valid send.
// Measured on the live picker: the model rows carry pointer-events:none and sit
// outside the menu's own box, so no coordinate reaches them - and "Pro", which
// every repo configured before the change has pinned as its default model,
// stopped being a model at all. The result was that a plain `prodex ask` failed
// in those repos, every time, for a selection the UI no longer supports.
//
// prodex already answers this shape elsewhere: a Pro sub-mode it cannot apply
// warns and the send goes. A model it cannot apply is the same situation.
describe("a model the picker cannot offer", () => {
  it("warns instead of failing when the row is inert", () => {
    const warning = modelSelectionUnavailableWarning("GPT-5.6 Sol", "target element is not clickable (pointer-events: none)");
    expect(warning).toBeDefined();
    expect(warning).toContain("model_not_applied");
    expect(warning).toContain("GPT-5.6 Sol");
  });

  it("warns when the picker does not list it, and says what it does list", () => {
    const warning = modelSelectionUnavailableWarning("Pro", "menu item not found", ["Instant", "GPT-5.6 Sol", "GPT-5.5"]);
    expect(warning).toContain("model_not_applied");
    expect(warning).toContain("Instant, GPT-5.6 Sol, GPT-5.5");
  });

  it("stays an error for anything else, so a real click failure is not buried", () => {
    // A row that IS offered and clickable but would not take the click is a
    // failure worth stopping for; only "this picker has no such thing" is not.
    expect(
      modelSelectionUnavailableWarning("GPT-5.5", 'Refusing to click "GPT-5.5": another element covers its click point')
    ).toBeUndefined();
    expect(modelSelectionUnavailableWarning("GPT-5.5", "reasoning/model menu did not open")).toBeUndefined();
  });
});

// The same rule has to hold for the slider. Reported from another machine: that
// account's picker has no "Pro" step at all - five attempts, the same list every
// time - so a pinned default of model=Pro turned into a step request the slider
// could not satisfy, and every plain send failed. A selection the picker cannot
// provide is the UI declining, not prodex breaking.
describe("an effort step the slider does not have", () => {
  it("warns and lets the send go, naming what the slider does offer", () => {
    const warning = stepSelectionUnavailableWarning("Pro", ["Instant", "Medium", "High"]);
    expect(warning).toBeDefined();
    expect(warning).toContain("step_not_applied");
    expect(warning).toContain("Pro");
    expect(warning).toContain("Instant, Medium, High");
  });

  it("works the same when the labels are localized", () => {
    // The browser reporting this runs in Korean, so the steps come back
    // translated. The warning has to quote what the page said, not an English
    // label prodex expected to see.
    const warning = stepSelectionUnavailableWarning("Pro", ["즉시", "중간", "높음", "매우 높음"]);
    expect(warning).toContain("매우 높음");
  });

  it("says nothing when no step was requested", () => {
    expect(stepSelectionUnavailableWarning(undefined, ["Instant"])).toBeUndefined();
  });
});
