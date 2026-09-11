import { describe, expect, it } from "vitest";

import { CHATGPT_NON_TEXT_ANSWER_NOTE, classifyTranscriptRead, shouldRecoverThreadNavigation } from "../src/chatgpt-browser.js";

// Measured with `--tool create-image` on a live account: the image was
// generated and rendered, and the transcript's assistant message came back
//
//   content_type: "text", status: "finished_successfully",
//   end_turn: true, is_complete: true, parts: [""]
//
// with the image itself in a separate `tool` message. The transcript reports
// that as `answer_empty`, which was classified "pending" - so the send spent
// its whole budget "stabilizing" and then called a finished result a timeout.
// `recover` could not read it either. The transcript only reports answer_empty
// AFTER checking the turn ended, so it never means "still being written".
describe("a turn that finished without writing text", () => {
  const finished = (reason: string) => ({ ok: false, reason, status: "finished_successfully", userText: "draw a red circle" });

  it("is not treated as a turn still in progress", () => {
    expect(classifyTranscriptRead(finished("answer_empty"), "draw a red circle")).toBe("no_text");
  });

  it("still waits for a turn that has not ended", () => {
    expect(classifyTranscriptRead(finished("answer_not_finished"), "draw a red circle")).toBe("pending");
    expect(classifyTranscriptRead(finished("no_assistant_message"), "draw a red circle")).toBe("pending");
  });

  it("still falls back to the page when the transcript cannot be read", () => {
    expect(classifyTranscriptRead(finished("session_error"), "draw a red circle")).toBe("unavailable");
    expect(classifyTranscriptRead(undefined, "draw a red circle")).toBe("unavailable");
  });

  // A transcript that answered - with or without text - is not a reason to drag
  // someone else's tab back to the pinned thread.
  it("does not move the tab for a turn the transcript already settled", () => {
    expect(
      shouldRecoverThreadNavigation({
        pinnedThreadUrl: "https://chatgpt.com/c/6aa343da-f0c4-83ee",
        currentUrl: "https://chatgpt.com/",
        lastTranscriptClassification: "no_text"
      })
    ).toBe(false);
  });

  it("says what happened instead of returning nothing", () => {
    expect(CHATGPT_NON_TEXT_ANSWER_NOTE).toMatch(/no text answer/i);
    expect(CHATGPT_NON_TEXT_ANSWER_NOTE).toMatch(/image/i);
  });
});
