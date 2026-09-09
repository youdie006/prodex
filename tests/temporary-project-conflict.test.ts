import { describe, expect, it } from "vitest";

import { projectIdentity } from "../src/chatgpt-browser.js";
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

// The rebind check confirms the reload landed back on the requested project.
// It compared the whole URL, which also carries mode in a query string - the
// very thing that differs across the reload this failure showed up in.
describe("recognising the project a URL belongs to", () => {
  it("reads the project out of a project home", () => {
    expect(projectIdentity("https://chatgpt.com/g/g-p-abc123/project")).toBe("g-p-abc123");
  });

  it("reads it out of a thread inside that project", () => {
    expect(projectIdentity("https://chatgpt.com/g/g-p-abc123/c/6aa002cb-56c0")).toBe("g-p-abc123");
  });

  it("ignores a query string, which carries mode rather than identity", () => {
    expect(projectIdentity("https://chatgpt.com/g/g-p-abc123/project?temporary-chat=true")).toBe("g-p-abc123");
  });

  it("tells two projects apart", () => {
    expect(projectIdentity("https://chatgpt.com/g/g-p-abc123/project")).not.toBe(
      projectIdentity("https://chatgpt.com/g/g-p-def456/project")
    );
  });

  it("has no answer for a page outside any project", () => {
    expect(projectIdentity("https://chatgpt.com/")).toBeUndefined();
    expect(projectIdentity("https://chatgpt.com/c/6aa002cb-56c0")).toBeUndefined();
    expect(projectIdentity("not a url")).toBeUndefined();
  });
});
