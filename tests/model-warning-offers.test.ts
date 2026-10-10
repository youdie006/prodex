import { describe, expect, it } from "vitest";

import { offeredModelLabels } from "../src/chatgpt-browser.js";

// Measured 2026-10-07: --model GPT-99 warned "It offers: Medium, Latest,
// GPT-5.6 Sol, GPT-5.5" - Medium is the effort slider's row, not a model.
// `pro browser models` lists only the models; the warning now uses the same
// reading.
describe("the models a model_not_applied warning offers", () => {
  it("come from the model rows, not every menu item", () => {
    const options = [
      { label: "Latest", kind: "radio" as const, checked: true },
      { label: "GPT-5.6 Sol", kind: "radio" as const, checked: false },
      // A radio row's second line is a note, not its name (measured: "Leaving on October 14").
      { label: "GPT-5.5", kind: "radio" as const, checked: false, value: "Leaving on October 14" },
      { label: "Model", kind: "submenu" as const, checked: false, value: "GPT-5.5" }
    ];
    expect(offeredModelLabels(options, ["Medium", "Latest", "GPT-5.6 Sol", "GPT-5.5"])).toEqual(["Latest", "GPT-5.6 Sol", "GPT-5.5"]);
  });

  it("fall back to the menu items when the model rows could not be read", () => {
    expect(offeredModelLabels(undefined, ["Latest"])).toEqual(["Latest"]);
    expect(offeredModelLabels([], ["Latest"])).toEqual(["Latest"]);
  });
});
