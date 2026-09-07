import { describe, expect, it } from "vitest";

import { menuKeyboardStep } from "../src/picker-interaction.js";

// The picker's model rows carry pointer-events: none and sit outside the menu's
// box, so no coordinate reaches them - and they refuse .focus() too. Measured
// live, the only way in is the menu's own roving focus: the menu opens with a
// row already active, ArrowDown walks to the next, and Enter commits.
//
// This matters beyond tidiness. With the recommended set active the slider walks
// a short mixed ladder that tops out at Extra High; choosing the model row first
// swaps in that model's own ladder, which has two more rungs above it (Max, then
// Ultra). The top of the machine is only reachable through this walk.
describe("walking the picker's menu by keyboard", () => {
  const requested = ["GPT-6 Astra"] as const;

  it("commits as soon as the requested row is the active one", () => {
    expect(
      menuKeyboardStep({ active: { role: "menuitemradio", label: "GPT-6 Astra" }, requested, pressed: 3, limit: 12 })
    ).toBe("select");
  });

  it("keeps walking while another row is active", () => {
    expect(menuKeyboardStep({ active: { role: "menuitemradio", label: "Default" }, requested, pressed: 0, limit: 12 })).toBe(
      "down"
    );
  });

  it("does not commit on the label row that merely repeats the model name", () => {
    // The row above the slider reads "<model>" then "<effort>", so its first
    // line matches the model being looked for while being the wrong element.
    expect(menuKeyboardStep({ active: { role: "menuitem", label: "GPT-6 Astra" }, requested, pressed: 1, limit: 12 })).toBe(
      "down"
    );
  });

  it("gives up rather than pressing forever once it has been all the way round", () => {
    expect(menuKeyboardStep({ active: { role: "menuitemradio", label: "GPT-5.5" }, requested, pressed: 12, limit: 12 })).toBe(
      "exhausted"
    );
  });

  it("gives up when focus has fallen out of the menu", () => {
    expect(menuKeyboardStep({ active: null, requested, pressed: 0, limit: 12 })).toBe("exhausted");
  });
});
