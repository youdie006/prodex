import { describe, expect, it } from "vitest";

import { modelSelectionUnavailableWarning } from "../src/chatgpt-browser.js";

// The picker lists its models and then refuses every one of them: measured on
// both surfaces, the model rows carry pointer-events: none and no coordinate
// reaches them. Saying the picker "does not offer" a model and then listing
// that same model two clauses later reads like a bug in prodex rather than a
// picker that cannot be driven.
describe("what a send says when the model could not be applied", () => {
  it("separates a model that is listed but inert from one that is absent", () => {
    const listed = modelSelectionUnavailableWarning("GPT-5.5", "target element is not clickable (pointer-events: none)", [
      "Latest",
      "GPT-5.6 Sol",
      "GPT-5.5"
    ]);
    expect(listed).toMatch(/GPT-5\.5/);
    expect(listed).not.toMatch(/does not offer/i);
    expect(listed).toMatch(/cannot be clicked|inert|not selectable/i);

    const absent = modelSelectionUnavailableWarning("o3", "menu item not found", ["Latest", "GPT-5.5"]);
    expect(absent).toMatch(/does not offer/i);
  });

  it("still says nothing about failures that are not about the model row", () => {
    expect(modelSelectionUnavailableWarning("Pro", "menu did not open", [])).toBeUndefined();
  });
});
