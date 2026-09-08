import { describe, expect, it } from "vitest";

import { effortNeedsWorkSurface } from "../src/picker-interaction.js";

// Max and Ultra are rungs of the Work surface's slider; Chat's tops out at Pro.
// Since sends put the browser back on Chat, asking for one of them would have
// been advertised in the help and then made impossible by the very next step -
// the switch would move to Chat and the step would come back "not applied".
describe("efforts that only exist on the Work surface", () => {
  it("names the two that do", () => {
    expect(effortNeedsWorkSurface("Max")).toBe(true);
    expect(effortNeedsWorkSurface("Ultra")).toBe(true);
  });

  it("leaves Chat's own steps alone", () => {
    for (const effort of ["즉시", "중간", "높음", "매우 높음", "Pro"]) {
      expect(effortNeedsWorkSurface(effort)).toBe(false);
    }
  });

  it("treats an absent effort as no opinion", () => {
    expect(effortNeedsWorkSurface(undefined)).toBe(false);
  });
});
