import { describe, expect, it } from "vitest";

import { sliderWalkPlan } from "../src/chatgpt-browser.js";

// The slider shows one step at a time, and that single visible label is all
// `pro browser models` ever reported. It is why a machine on this same account
// concluded "Pro does not exist here" from five listings that all read
// Instant / GPT-5.6 Sol / GPT-5.5 - the slider was parked on Instant every
// time - and why prodex's own pinned-default check cried about a Pro that the
// very next send used successfully. Reading every step means walking it, and
// walking someone's setting is only acceptable if it is put back.
describe("walking the slider to see every step", () => {
  it("goes to the bottom, climbs to the top, then returns to where it started", () => {
    const plan = sliderWalkPlan({ position: 2, min: 0, max: 4 });
    expect(plan.toBottom).toBe(2);
    expect(plan.climb).toBe(4);
    expect(plan.back).toBe(2);
  });

  it("costs nothing to return when it started at the bottom", () => {
    const plan = sliderWalkPlan({ position: 0, min: 0, max: 4 });
    expect(plan.toBottom).toBe(0);
    expect(plan.climb).toBe(4);
    expect(plan.back).toBe(0);
  });

  it("still puts the top back at the top", () => {
    const plan = sliderWalkPlan({ position: 4, min: 0, max: 4 });
    expect(plan.toBottom).toBe(4);
    expect(plan.climb).toBe(4);
    expect(plan.back).toBe(4);
  });

  it("refuses to walk a slider whose bounds make no sense", () => {
    // A misread control must not turn into thousands of keystrokes in someone's
    // browser.
    expect(sliderWalkPlan({ position: 0, min: 0, max: 0 })).toBeUndefined();
    expect(sliderWalkPlan({ position: 0, min: 0, max: 99 })).toBeUndefined();
    expect(sliderWalkPlan({ position: 9, min: 0, max: 4 })).toBeUndefined();
    expect(sliderWalkPlan({ position: Number.NaN, min: 0, max: 4 })).toBeUndefined();
  });
});
