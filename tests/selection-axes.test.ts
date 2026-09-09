import { describe, expect, it } from "vitest";

import { resolveSelectionAxes } from "../src/cli-pro.js";

// Measured against the live picker: Pro is not a model row, it is the top step
// of the effort slider, and moving the slider anywhere else deselects it. So a
// saved `effort` default and an explicit `--model Pro` are the same control
// asked for two different things - and the saved one won. The send ran at the
// saved effort, the answer came back from a lesser model, and the warning that
// noticed told the caller to clear a saved MODEL default, which had never been
// involved.
describe("what a send actually selects", () => {
  it("lets an explicit Pro beat a saved effort, because they are one control", () => {
    expect(resolveSelectionAxes({ explicit: { model: "Pro" }, defaults: { effort: "중간" } })).toEqual({ model: "Pro" });
  });

  it("keeps a saved pro_mode under an explicit Pro, which it only refines", () => {
    expect(resolveSelectionAxes({ explicit: { model: "Pro" }, defaults: { pro_mode: "확장", effort: "중간" } })).toEqual({
      model: "Pro",
      proMode: "확장"
    });
  });

  // A model row and the slider are different controls, so naming a model does
  // not answer the effort question. Only Pro does, by being a step.
  it("leaves a saved effort alone under a model that is not Pro", () => {
    expect(resolveSelectionAxes({ explicit: { model: "GPT-5.6 Sol" }, defaults: { effort: "중간" } })).toEqual({
      model: "GPT-5.6 Sol",
      effort: "중간"
    });
  });

  it("still lets an explicit effort suppress a saved model", () => {
    expect(resolveSelectionAxes({ explicit: { effort: "즉시" }, defaults: { model: "Pro", pro_mode: "확장" } })).toEqual({
      effort: "즉시"
    });
  });

  it("takes both when the caller says both out loud", () => {
    expect(resolveSelectionAxes({ explicit: { model: "Pro", effort: "중간" }, defaults: {} })).toEqual({
      model: "Pro",
      effort: "중간"
    });
  });

  it("applies the saved selection when the caller pins nothing", () => {
    expect(resolveSelectionAxes({ explicit: {}, defaults: { model: "Pro", pro_mode: "확장" } })).toEqual({
      model: "Pro",
      proMode: "확장"
    });
    expect(resolveSelectionAxes({ explicit: {} })).toEqual({});
  });

  // "프로" is how the same step reads on a Korean account, and the model axis
  // is free text, so the check cannot be an equality against "Pro".
  it("reads the Korean name of the same step", () => {
    expect(resolveSelectionAxes({ explicit: { model: "프로" }, defaults: { effort: "중간" } })).toEqual({ model: "프로" });
  });
});
