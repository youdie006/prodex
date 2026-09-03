import { describe, expect, it } from "vitest";

import { modelSelectionUnavailableWarning } from "../src/chatgpt-browser.js";

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
