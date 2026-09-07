import { describe, expect, it } from "vitest";

import { sliderRestoreStep } from "../src/picker-interaction.js";

// Reading the ladder means walking someone's slider, and the walk used to be
// put back by replaying a precomputed number of presses. Any interruption
// mid-walk skipped that, and the setting stayed where the walk abandoned it:
// measured after one `pro browser models`, a slider left at High when it had
// been on Pro. Restoring against the position actually read cannot be skipped
// the same way, because it keeps correcting until the two agree.
describe("putting the power slider back where it was", () => {
  it("moves down when the walk left it above where it started", () => {
    expect(sliderRestoreStep({ current: 4, target: 2 })).toBe("left");
  });

  it("moves up when the walk left it below", () => {
    expect(sliderRestoreStep({ current: 0, target: 3 })).toBe("right");
  });

  it("stops once it is back", () => {
    expect(sliderRestoreStep({ current: 3, target: 3 })).toBe("done");
  });

  it("stops rather than guessing when the position cannot be read", () => {
    expect(sliderRestoreStep({ current: undefined, target: 3 })).toBe("done");
    expect(sliderRestoreStep({ current: 2, target: undefined })).toBe("done");
    expect(sliderRestoreStep({ current: Number.NaN, target: 1 })).toBe("done");
  });
});
