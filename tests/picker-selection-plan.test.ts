import { describe, expect, it } from "vitest";

import { pickerSelectionPlan } from "../src/chatgpt-browser.js";

// Measured on the live picker: the model and the effort are two different
// controls sitting in one menu.
//
//   role="slider"        aria-valuenow=0 aria-valuemax=4   <- effort, Instant..Pro
//   menuitemradio        "GPT-5.6 Sol"  aria-checked=true  <- model
//   menuitemradio        "GPT-5.5"                         <- model
//
// Selection sent BOTH of them to the slider (`effort ?? model`), so a model name
// could never match a step. Reproduced exactly, including the message another
// machine reported: `--model "GPT-5.6 Sol"` failed with `has no "GPT-5.6 Sol"
// step. It showed: Instant / Instant, 1 of 5. / ... / GPT-5.6 Sol / GPT-5.5` -
// the name is right there in the text, which is why the report said "목록엔
// 보이는데". It was in the slider's TEXT, not among its steps.
//
// `--model Pro` looked fine here this morning only because the slider happened
// to sit on its top step; once it moved to Instant, the same command failed.
describe("what a picker selection should drive", () => {
  it("sends an effort to the slider and a model to its radio", () => {
    expect(pickerSelectionPlan({ effort: "즉시" })).toEqual({ sliderLabel: "즉시" });
    expect(pickerSelectionPlan({ model: "GPT-5.6 Sol" })).toEqual({ modelLabel: "GPT-5.6 Sol" });
  });

  it("drives both when both are asked for, because they are separate controls", () => {
    // The warning added when they were believed to share one control does not
    // apply here: nothing is discarded.
    expect(pickerSelectionPlan({ model: "GPT-5.6 Sol", effort: "중간" })).toEqual({
      modelLabel: "GPT-5.6 Sol",
      sliderLabel: "중간"
    });
  });

  it("reads --model Pro as the effort it now is, and says so", () => {
    // Pro stopped being a model and became the slider's top step, but it is the
    // pinned default in every repo set up before that. Failing them all is worse
    // than honouring the request where it now lives.
    const plan = pickerSelectionPlan({ model: "Pro" });
    expect(plan.sliderLabel).toBe("Pro");
    expect(plan.modelLabel).toBeUndefined();
    expect(plan.warning).toMatch(/pro/i);
    expect(plan.warning).toMatch(/effort/i);
  });

  it("lets an explicit effort win over that reinterpretation", () => {
    const plan = pickerSelectionPlan({ model: "Pro", effort: "즉시" });
    expect(plan.sliderLabel).toBe("즉시");
    expect(plan.warning).toMatch(/pro/i);
  });

  it("reads any other Chat step named as a model the same way", () => {
    // Measured 2026-10-22: the menu offered only GPT-6 and GPT-5.6 Sol, with
    // Instant..Pro on the slider. `--model Instant` warned "does not offer" and
    // went out on the saved Pro step, so a request for a fast answer waited on
    // Pro reasoning.
    for (const [model, step] of [["Instant", "즉시"], ["instant", "즉시"], ["Medium", "중간"], ["High", "높음"], ["Extra High", "매우 높음"], ["즉시", "즉시"]]) {
      const plan = pickerSelectionPlan({ model });
      expect(plan.sliderLabel).toBe(step);
      expect(plan.modelLabel).toBeUndefined();
      expect(plan.warning).toContain(`--model ${model}`);
      expect(plan.warning).toMatch(/effort/i);
    }
  });

  it("keeps real model names and the Work-only rungs off that path", () => {
    expect(pickerSelectionPlan({ model: "GPT-6" })).toEqual({ modelLabel: "GPT-6" });
    // Max and Ultra only exist on the Work surface, which a model name does not reach.
    expect(pickerSelectionPlan({ model: "Ultra" })).toEqual({ modelLabel: "Ultra" });
  });

  it("asks for nothing when nothing was requested", () => {
    expect(pickerSelectionPlan({})).toEqual({});
  });
});
