import { describe, expect, it } from "vitest";

import { chatSurfaceChoice } from "../src/picker-interaction.js";

// ChatGPT grew a Chat/Work toggle, and the two surfaces have different model
// pickers. Measured on one account within minutes of each other:
//
//   Chat: Latest / GPT-5.6 Sol / GPT-5.5, slider Instant..Pro, Pro at 5 of 5
//   Work: Default / GPT-6 Astra / Sol / Terra / Luna / GPT-5.5,
//         slider Light..Ultra, no Pro anywhere in the picker
//
// The dedicated browser had drifted onto Work, so prodex was driving a picker
// that has no Pro at all while the person asking for Pro was looking at Chat.
// Nothing announced the difference: both surfaces have a composer and a slider.
describe("choosing which ChatGPT surface to drive", () => {
  it("stays put when Chat is already the active one", () => {
    expect(
      chatSurfaceChoice([
        { label: "Chat", checked: true },
        { label: "Work", checked: false }
      ])
    ).toBe("already-chat");
  });

  it("switches back when the browser has drifted onto Work", () => {
    expect(
      chatSurfaceChoice([
        { label: "Chat", checked: false },
        { label: "Work", checked: true }
      ])
    ).toBe("switch-to-chat");
  });

  it("switches when nothing claims to be selected rather than guessing", () => {
    expect(
      chatSurfaceChoice([
        { label: "Chat", checked: false },
        { label: "Work", checked: false }
      ])
    ).toBe("switch-to-chat");
  });

  it("does nothing where the toggle does not exist", () => {
    // Older builds, and every page that predates the split.
    expect(chatSurfaceChoice([])).toBe("no-toggle");
    expect(chatSurfaceChoice([{ label: "Work", checked: true }])).toBe("no-toggle");
  });
});
