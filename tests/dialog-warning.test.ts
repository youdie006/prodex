import { describe, expect, it } from "vitest";

import { answeredDialogWarning } from "../src/picker-interaction.js";

// prodex answers a JavaScript dialog so the page keeps responding, and that is
// a button pressed in someone's real session on their behalf. Doing it quietly
// would hide both the fact that something popped up mid-send and the reason the
// send behaved oddly around it.
describe("saying that a dialog was answered", () => {
  it("says nothing when none appeared", () => {
    expect(answeredDialogWarning([])).toBeUndefined();
  });

  it("names what appeared and what prodex did with it", () => {
    const warning = answeredDialogWarning(["alert"]);
    expect(warning).toMatch(/^dialog_answered:/);
    expect(warning).toMatch(/alert/);
    expect(warning).toMatch(/dismiss/i);
  });

  it("says accepted for the one it accepts", () => {
    expect(answeredDialogWarning(["beforeunload"])).toMatch(/accept/i);
  });

  it("collapses repeats rather than listing the same thing five times", () => {
    const warning = answeredDialogWarning(["alert", "alert", "confirm"]);
    expect(warning).toMatch(/alert x2/);
    expect(warning).toMatch(/confirm/);
  });
});
