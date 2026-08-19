import { describe, expect, it } from "vitest";

import {
  CHATGPT_RESPONSE_CHOICE_SELECTOR,
  busyBlockerAfterTranscriptCheck,
  chatGptBusyBlocker,
  chatGptResponseChoiceBlocker,
  responseChoiceBlocksThisSend,
  statusExpression
} from "../src/chatgpt-browser.js";

// Measured on the real browser, and it is how a shared tab jams: an ordinary
// send finished, and ChatGPT replaced the thread with "You're giving feedback
// on a new version of ChatGPT. Which response do you prefer?" - two finished
// candidates, two "I prefer this response" buttons, and a composer whose submit
// control stays `data-testid="stop-button"` forever. prodex read that control as
// "still generating", so every later send waited out its whole budget and then
// failed with "wait for it to finish and retry". Nothing was generating: the
// page had not changed in twenty seconds and would not change without a click.
describe("the thread ChatGPT stops to ask which response you prefer", () => {
  it("is not reported as a response still being generated", () => {
    expect(chatGptBusyBlocker({ generating: true, awaitingResponseChoice: true })).toBeUndefined();
    expect(chatGptBusyBlocker({ generating: true, awaitingResponseChoice: false })?.code).toBe("response_in_progress");
  });

  it("says what to click, since waiting will never clear it", () => {
    const blocker = chatGptResponseChoiceBlocker(true);
    expect(blocker?.code).toBe("response_choice_pending");
    // The old advice was "wait for it to finish", which never happens.
    expect(blocker?.message).not.toMatch(/generating/i);
    expect(blocker?.next_step).toMatch(/prefer/i);
    expect(chatGptResponseChoiceBlocker(false)).toBeUndefined();
  });

  it("only blocks the sends that would stay on that thread", () => {
    // A send that is leaving anyway does not care what the old thread is
    // asking: --new-chat navigates to a fresh chat, and picking a project
    // navigates to the project home.
    expect(responseChoiceBlocksThisSend({ awaitingResponseChoice: true, newChat: true })).toBe(false);
    expect(responseChoiceBlocksThisSend({ awaitingResponseChoice: true, project: "some project" })).toBe(false);
    expect(responseChoiceBlocksThisSend({ awaitingResponseChoice: true, projectNew: "brand new" })).toBe(false);
    expect(responseChoiceBlocksThisSend({ awaitingResponseChoice: true })).toBe(true);
    expect(responseChoiceBlocksThisSend({ awaitingResponseChoice: false })).toBe(false);
  });

  it("is recognized by the testids ChatGPT puts on that panel, not by its English", () => {
    // Read off the live page: the title and both buttons carry testids, so the
    // detection survives a UI in any language.
    expect(CHATGPT_RESPONSE_CHOICE_SELECTOR).toContain("paragen-prefer-response-button");
    expect(statusExpression()).toContain("awaitingResponseChoice");
  });
});

describe("a stop control that outlives the answer it belonged to", () => {
  const busy = chatGptBusyBlocker({ generating: true });

  it("loses to the transcript, which knows the turn finished", () => {
    // Measured on the real page: an ordinary conversation whose answer was
    // complete kept `data-testid="stop-button"` with aria-label "Stop
    // answering", unchanged over thirty seconds, while the transcript for that
    // same conversation reported status finished_successfully, end_turn true.
    // prodex believed the button, so a send that only wanted to navigate away
    // to a project first waited out five minutes of "tab busy".
    expect(busyBlockerAfterTranscriptCheck(busy, { ok: true, isComplete: true })).toBeUndefined();
  });

  it("stands while the transcript agrees the answer is still coming", () => {
    expect(busyBlockerAfterTranscriptCheck(busy, { ok: true, isComplete: false })?.code).toBe("response_in_progress");
  });

  it("stands when the transcript cannot be read at all", () => {
    // Silence is not permission: an unreadable transcript is no evidence that
    // the page is idle, and typing into a live generation corrupts a thread.
    expect(busyBlockerAfterTranscriptCheck(busy, { ok: false })?.code).toBe("response_in_progress");
    expect(busyBlockerAfterTranscriptCheck(busy, undefined)?.code).toBe("response_in_progress");
  });
});
