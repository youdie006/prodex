import { describe, expect, it } from "vitest";

import { pickLandedConversation, transcriptContainsWholeSentPrompt } from "../src/chatgpt-browser.js";

// When the page never reports the prompt posting, prodex finds the conversation
// it landed in by matching the prompt against the recent ones. Identity is a
// PREFIX test - the first 120 normalized characters - because a composer tool
// prefixes the prompt and attachments append to it, so neither end is reliable
// alone. Two consults that open the same way are therefore indistinguishable
// to it, which is not hypothetical: an agent working from a template, or a
// debate loop, repeats its opening every round.
//
// Measured with a 125-character shared preamble, the prompts differing at
// character 142: sending the NEWER prompt picked the OLDER conversation, whose
// answer would have come back as this send's.
const PREAMBLE =
  "You are reviewing a diff for the prodex repository. Follow the house rules: no emojis, English in git content, and answer in ";
const older = `${PREAMBLE}Korean. Question 1: is the lock correct?`;
const newer = `${PREAMBLE}Korean. Question 2: is the parser correct?`;

describe("finding the conversation a prompt landed in", () => {
  it("tells apart two conversations that open with the same text", () => {
    const candidates = [
      { id: "conv-OLD", userText: older },
      { id: "conv-NEW", userText: newer }
    ];
    expect(pickLandedConversation(candidates, newer)).toBe("conv-NEW");
    expect(pickLandedConversation(candidates, older)).toBe("conv-OLD");
  });

  // The prefix test is what survives a tool prefix and an appended attachment,
  // so it stays in charge whenever it is not ambiguous.
  it("still matches through a composer tool's prefix", () => {
    expect(pickLandedConversation([{ id: "solo", userText: `Deep research ${newer}` }], newer)).toBe("solo");
  });

  it("picks nothing when two conversations are genuinely the same prompt", () => {
    const twice = [
      { id: "a", userText: older },
      { id: "b", userText: older }
    ];
    expect(pickLandedConversation(twice, older)).toBeUndefined();
  });

  it("picks nothing when no conversation matches", () => {
    expect(pickLandedConversation([{ id: "a", userText: older }], "something else entirely")).toBeUndefined();
    expect(pickLandedConversation([], newer)).toBeUndefined();
  });

  // A prompt longer than the recorded sample cannot be matched whole, which
  // leaves the ambiguity unresolved - and nothing is the safe answer.
  it("refuses rather than guessing when the prompt outruns the sample", () => {
    const long = `${PREAMBLE}${"detail ".repeat(900)}`;
    const sample = long.slice(0, 4000);
    expect(
      pickLandedConversation(
        [
          { id: "a", userText: sample },
          { id: "b", userText: sample }
        ],
        long
      )
    ).toBeUndefined();
  });
});

describe("comparing a whole prompt against a transcript", () => {
  it("accepts a transcript that wraps the prompt", () => {
    expect(transcriptContainsWholeSentPrompt(`Deep research ${newer} (attached: notes.md)`, newer)).toBe(true);
  });

  it("refuses one that only shares the opening", () => {
    expect(transcriptContainsWholeSentPrompt(older, newer)).toBe(false);
  });

  it("has no opinion about empty text", () => {
    expect(transcriptContainsWholeSentPrompt("", newer)).toBe(false);
    expect(transcriptContainsWholeSentPrompt(newer, "  ")).toBe(false);
  });
});
