import { describe, expect, it } from "vitest";

import { readPowerSliderSelection } from "../src/picker-interaction.js";

// ChatGPT's power slider stopped being an effort control. Measured live, one
// slider now walks a ladder of model-and-effort pairs together:
//
//   0  GPT-5.6 Terra  Light        3  GPT-6 Astra  Light
//   1  GPT-5.6 Sol    Light        4  GPT-6 Astra  Medium
//   2  GPT-5.6 Sol    Medium       5  GPT-6 Astra  Extra High
//
// The menu item that owns the slider reads "<model>\n<effort>", and the row
// that is aria-checked is "Default" - the recommended set - rather than the
// model a send actually uses. Reading the owner's first line as the effort is
// what made `pro browser models` announce "Extra High" as a model and miss
// GPT-6 Astra entirely.
describe("reading the current pick out of the power slider", () => {
  // Measured shape: the labels and the slider track are sibling rows, so the row
  // that literally contains the slider carries no text at all.
  const ladderPicker = {
    sliderValueText: null,
    items: [
      { role: "menuitem", text: "GPT-6 Astra\nExtra High", checked: false, containsSlider: false },
      { role: "menuitem", text: "", checked: false, containsSlider: true },
      { role: "menuitemradio", text: "Default\nRecommended set of models", checked: true, containsSlider: false },
      { role: "menuitemradio", text: "GPT-6 Astra", checked: false, containsSlider: false },
      { role: "menuitemradio", text: "GPT-5.6 Sol", checked: false, containsSlider: false }
    ]
  };

  it("takes the model from the slider's own row, not from the checked one", () => {
    expect(readPowerSliderSelection(ladderPicker)).toEqual({ model: "GPT-6 Astra", effort: "Extra High" });
  });

  it("still reads the older labeled-row picker", () => {
    expect(
      readPowerSliderSelection({
        sliderValueText: null,
        items: [
          { role: "menuitem", text: "Model\nGPT-5.5", checked: false, containsSlider: false },
          { role: "menuitem", text: "Effort\n높음", checked: false, containsSlider: false }
        ]
      })
    ).toEqual({ model: "GPT-5.5", effort: "높음" });
  });

  it("falls back to the checked row when no row owns the slider", () => {
    expect(
      readPowerSliderSelection({
        sliderValueText: "매우 높음",
        items: [{ role: "menuitemradio", text: "GPT-5.5", checked: true, containsSlider: false }]
      })
    ).toEqual({ model: "GPT-5.5", effort: "매우 높음" });
  });
});
