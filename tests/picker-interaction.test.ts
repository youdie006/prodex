import { describe, expect, it } from "vitest";

import { menuItemRectExpression, powerSliderStateExpression } from "../src/chatgpt-browser.js";
import { readPowerSliderSelection } from "../src/picker-interaction.js";

describe("composer picker interaction decisions", () => {
  it("reads the current slider label and checked model radio", () => {
    expect(
      readPowerSliderSelection({
        items: [
          { role: "menuitem", text: "Instant", checked: false, containsSlider: false },
          { role: "menuitemradio", text: "GPT-5.6 Sol", checked: true, containsSlider: false },
          { role: "menuitemradio", text: "GPT-5.5", checked: false, containsSlider: false }
        ]
      })
    ).toEqual({ model: "GPT-5.6 Sol", effort: "Instant" });
  });

  it("uses the menu item that owns the slider even for an unfamiliar localized label", () => {
    expect(
      readPowerSliderSelection({
        items: [
          { role: "menuitem", text: "Localized step", checked: false, containsSlider: true },
          { role: "menuitemradio", text: "GPT-5.6 Sol", checked: true, containsSlider: false }
        ]
      })
    ).toEqual({ model: "GPT-5.6 Sol", effort: "Localized step" });
  });

  it("keeps reading the prior Model and Effort rows", () => {
    expect(
      readPowerSliderSelection({
        items: [
          { role: "menuitem", text: "Model\nGPT-5.6 Sol", checked: false, containsSlider: false },
          { role: "menuitem", text: "Effort\nPro", checked: false, containsSlider: true }
        ]
      })
    ).toEqual({ model: "GPT-5.6 Sol", effort: "Pro" });
  });

  it("prefers the slider's accessible value text when it is present", () => {
    expect(
      readPowerSliderSelection({
        sliderValueText: "Extra High",
        items: [
          { role: "menuitem", text: "High", checked: false, containsSlider: true },
          { role: "menuitemradio", text: "GPT-5.6 Sol", checked: true, containsSlider: false }
        ]
      })
    ).toEqual({ model: "GPT-5.6 Sol", effort: "Extra High" });
  });

  it("does not mistake an accessibility position sentence for the effort label", () => {
    expect(
      readPowerSliderSelection({
        sliderValueText: "Instant, 1 of 5.",
        items: [
          { role: "menuitem", text: "Instant", checked: false, containsSlider: false },
          { role: "menuitemradio", text: "GPT-5.6 Sol", checked: true, containsSlider: false }
        ]
      })
    ).toEqual({ model: "GPT-5.6 Sol", effort: "Instant" });
  });

  it("executes the state reader against the measured mixed-control DOM", () => {
    const slider = {
      getAttribute(name: string) {
        return (
          {
            "aria-valuenow": "0",
            "aria-valuemin": "0",
            "aria-valuemax": "4",
            "aria-valuetext": null
          } as Record<string, string | null>
        )[name];
      }
    };
    const items = [
      { role: "menuitem", text: "Instant", checked: false },
      { role: "menuitemradio", text: "GPT-5.6 Sol", checked: true },
      { role: "menuitemradio", text: "GPT-5.5", checked: false }
    ].map((item) => ({
      innerText: item.text,
      textContent: item.text,
      getAttribute(name: string) {
        if (name === "role") return item.role;
        if (name === "aria-checked") return String(item.checked);
        return null;
      },
      contains() {
        return false;
      }
    }));
    const menu = {
      innerText: "Instant\nGPT-5.6 Sol\nGPT-5.5",
      querySelectorAll() {
        return items;
      }
    };
    const document = {
      querySelector(selector: string) {
        return selector === '[role="slider"]' ? slider : menu;
      }
    };

    const state = new Function("document", `return ${powerSliderStateExpression()}`)(document);

    expect(state).toMatchObject({ ok: true, position: 0, min: 0, max: 4, model: "GPT-5.6 Sol", effort: "Instant" });
  });

});
