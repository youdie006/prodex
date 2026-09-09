import { describe, expect, it } from "vitest";

import { temporaryProjectConflict } from "../src/cli-pro.js";

// A temporary chat is not saved; a project chat is. Entering a project leaves
// temporary mode, so asking for both is asking for two different things.
// prodex tried to do both and died deep inside the project step with "composer
// did not rebind after entering project", which names neither cause nor cure.
describe("asking for a temporary chat and a project at once", () => {
  it("refuses the combination when the project was asked for explicitly", () => {
    const error = temporaryProjectConflict({ temporary: true, explicitProject: "some-project" });
    expect(error).toMatch(/temporary/i);
    expect(error).toMatch(/project/i);
  });

  it("lets a temporary send through when no project was asked for", () => {
    expect(temporaryProjectConflict({ temporary: true })).toBeUndefined();
  });

  it("lets a project send through when it is not temporary", () => {
    expect(temporaryProjectConflict({ temporary: false, explicitProject: "some-project" })).toBeUndefined();
  });

  it("says nothing about a saved default, which is suppressed rather than refused", () => {
    // A pinned project must not turn every --temporary send into an error; the
    // per-call flag is the more specific instruction and simply wins.
    expect(temporaryProjectConflict({ temporary: true, explicitProject: undefined })).toBeUndefined();
  });
});
