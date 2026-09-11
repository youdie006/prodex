import { describe, expect, it } from "vitest";

import { attachSendWarnings, sendWarningsFromError } from "../src/chatgpt-browser.js";

// A send's warnings ride out with the RESULT, so a send that throws loses
// them - and the ones that explain the failure are exactly the kind that get
// lost: "ChatGPT was on its Work surface... Switched back to Chat", or the
// notes from an auto-recovered browser, collected moments before the step that
// died. The blocked path then reported warnings: [] to every caller.
describe("warnings from a send that failed", () => {
  it("travels out with the error, the way the thread already does", () => {
    const error = new Error("the picker did not open");
    attachSendWarnings(error, ["ChatGPT was on its Work surface. Switched back to Chat."]);
    expect(sendWarningsFromError(error)).toEqual(["ChatGPT was on its Work surface. Switched back to Chat."]);
  });

  it("leaves an error alone when there was nothing to say", () => {
    const error = new Error("plain");
    attachSendWarnings(error, []);
    expect(sendWarningsFromError(error)).toEqual([]);
  });

  it("does not overwrite warnings an inner throw already attached", () => {
    const error = new Error("inner");
    attachSendWarnings(error, ["first"]);
    attachSendWarnings(error, ["second"]);
    expect(sendWarningsFromError(error)).toEqual(["first"]);
  });

  it("reads nothing off something that is not an error object", () => {
    expect(sendWarningsFromError("a string")).toEqual([]);
    expect(sendWarningsFromError(undefined)).toEqual([]);
    expect(sendWarningsFromError({ warnings: [1, "kept", null] })).toEqual(["kept"]);
  });

  // A frozen error still has to reach the caller; the warnings are a bonus.
  it("survives an error it cannot write to", () => {
    const frozen = Object.freeze(new Error("frozen"));
    expect(() => attachSendWarnings(frozen, ["note"])).not.toThrow();
  });
});
