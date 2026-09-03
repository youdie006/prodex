import { describe, expect, it } from "vitest";

import { pinnedSelectionWarning } from "../src/chatgpt-browser.js";

// Pinning a default the account's picker does not offer is how this project
// broke for someone else: model=Pro was set when Pro was a model, ChatGPT made
// Pro an effort step and dropped it from some accounts entirely, and every plain
// send there failed afterwards. The picker knows what it offers; asking it once,
// when the default is set, beats finding out on every send.
describe("pinning a default the picker does not offer", () => {
  const offered = ["Instant", "GPT-5.6 Sol", "GPT-5.5"];

  it("says so, and names what is actually there", () => {
    const warning = pinnedSelectionWarning({ model: "Pro" }, offered);
    expect(warning).toBeDefined();
    expect(warning).toContain("Pro");
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
