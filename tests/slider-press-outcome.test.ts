import { describe, expect, it } from "vitest";

import { sliderPressOutcome } from "../src/picker-interaction.js";

// Two consults were blocked with "ChatGPT's model picker has no Pro step. It
// showed: Instant, 1 of 5" - after a walk that pressed ArrowRight ten times.
// The slider had taken focus on a page built seconds earlier, before its key
// handler was attached, so every press was swallowed and the walk never left
// rung 1. Telling a swallowed press from a press at the end of the track is
// what lets the walk wait for the handler instead of reporting a step that
// exists as missing.
describe("what one arrow press on the power slider tells the walk", () => {
  it("moved when the position changed", () => {
    expect(sliderPressOutcome({ before: 0, after: 1, key: "ArrowRight", min: 0, max: 4 })).toBe("moved");
    expect(sliderPressOutcome({ before: 3, after: 2, key: "ArrowLeft", min: 0, max: 4 })).toBe("moved");
  });

  it("is at the edge when pressing past the end of the track", () => {
    expect(sliderPressOutcome({ before: 4, after: 4, key: "ArrowRight", min: 0, max: 4 })).toBe("at-edge");
    expect(sliderPressOutcome({ before: 0, after: 0, key: "ArrowLeft", min: 0, max: 4 })).toBe("at-edge");
  });

  it("was swallowed when there was room to move and nothing happened", () => {
    expect(sliderPressOutcome({ before: 0, after: 0, key: "ArrowRight", min: 0, max: 4 })).toBe("swallowed");
    expect(sliderPressOutcome({ before: 2, after: 2, key: "ArrowLeft", min: 0, max: 4 })).toBe("swallowed");
  });

  it("treats missing bounds as the five-step ladder", () => {
    expect(sliderPressOutcome({ before: 0, after: 0, key: "ArrowRight" })).toBe("swallowed");
    expect(sliderPressOutcome({ before: 4, after: 4, key: "ArrowRight" })).toBe("at-edge");
  });
});
