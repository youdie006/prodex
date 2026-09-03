import { describe, expect, it } from "vitest";

import { pinnedSelectionWarning } from "../src/chatgpt-browser.js";

// Pinning a default the account's picker does not offer is how this project
// broke for someone else: model=Pro was set when Pro was a model, ChatGPT made
// Pro an effort step and dropped it from some accounts entirely, and every plain
// send there failed afterwards. The picker knows what it offers; asking it once,
// when the default is set, beats finding out on every send.
describe("pinning a default the picker does not offer", () => {
  const offered = ["Instant", "GPT-5.6 Sol", "GPT-5.5"];

  it("stays quiet about a value prodex knows the slider has", () => {
    // Pro IS a slider step - measured "Pro, 5 of 5" - and the slider reveals
    // only its current one, so a listing that happens to show "Extra High"
    // proves nothing about Pro. Warning there was a false alarm on a value the
    // very next send used successfully, and an alarm that cries about known-good
    // settings is one people learn to skip.
    expect(pinnedSelectionWarning({ effort: "Pro" }, ["Extra High", "GPT-5.6 Sol", "GPT-5.5"])).toBeUndefined();
    expect(pinnedSelectionWarning({ model: "Pro" }, ["Extra High", "GPT-5.6 Sol", "GPT-5.5"])).toBeUndefined();
    expect(pinnedSelectionWarning({ effort: "매우 높음" }, ["Instant", "GPT-5.6 Sol"])).toBeUndefined();
  });

  it("says so for something it has no reason to expect, and names what is there", () => {
    const warning = pinnedSelectionWarning({ model: "GPT-4 Turbo" }, offered);
    expect(warning).toBeDefined();
    expect(warning).toContain("GPT-4 Turbo");
    expect(warning).toContain("Instant, GPT-5.6 Sol, GPT-5.5");
    // The slider shows one step at a time, and reading the others means moving
    // it - which would change the user's setting just to look. So this may not
    // claim the account cannot provide it.
    expect(warning).not.toMatch(/does not offer|unavailable:/);
    expect(warning).toMatch(/may still exist/);
  });

  it("stays quiet when the pin is something the picker has", () => {
    expect(pinnedSelectionWarning({ model: "GPT-5.6 Sol" }, offered)).toBeUndefined();
    expect(pinnedSelectionWarning({ effort: "Instant" }, offered)).toBeUndefined();
  });

  it("matches the way the rest of prodex matches a label, not by exact case", () => {
    expect(pinnedSelectionWarning({ model: "gpt-5.6 sol" }, offered)).toBeUndefined();
  });

  it("stays quiet when nothing was pinned, or nothing could be read", () => {
    expect(pinnedSelectionWarning({}, offered)).toBeUndefined();
    // An unreadable picker is not evidence the pin is wrong.
    expect(pinnedSelectionWarning({ model: "Pro" }, [])).toBeUndefined();
  });
});
