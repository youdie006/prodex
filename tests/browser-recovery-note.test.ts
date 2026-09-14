import { describe, expect, it } from "vitest";

import { browserRecoveredNote } from "../src/cli-pro.js";

// Killing the dedicated browser and sending with --auto-login recovers it in
// about three seconds and answers normally - and recorded nothing. The note
// existed only on the branch that ENDS a wedged browser, so the commoner case,
// where the browser is simply gone and prodex starts one, left warnings: [] on
// the receipt, the result and the task. A reader of `pro latest` could not tell
// the answer came from a browser prodex had to start, and an audit could not
// count how often the environment dies under a send.
describe("what recovery writes down", () => {
  it("says a browser that was gone was started, and what survived", () => {
    const note = browserRecoveredNote([]);
    expect(note).toMatch(/^browser_recovered: /);
    expect(note).toMatch(/was not running/);
    expect(note).toMatch(/login was kept/i);
  });

  it("names the pids when it ended a browser that had stopped answering", () => {
    const note = browserRecoveredNote([4321, 4322]);
    expect(note).toMatch(/^browser_recovered: /);
    expect(note).toContain("pid 4321, 4322");
    expect(note).toMatch(/stopped answering/);
    expect(note).toMatch(/login were kept/i);
  });

  // Both go into a record that crosses the MCP boundary. Everything the note
  // says is built from the pids and nothing else - no prompt, no answer, no
  // project name - and those all arrive quoted in this codebase's messages.
  it("carries nothing from the consult itself", () => {
    for (const note of [browserRecoveredNote([]), browserRecoveredNote([1])]) {
      expect(note).not.toContain('"');
      expect(note.replace(/pid [\d, ]+/, "")).not.toMatch(/\d/);
    }
  });
});
