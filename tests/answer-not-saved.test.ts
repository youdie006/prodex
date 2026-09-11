import { describe, expect, it } from "vitest";

import { answerRescuedFromFailedPersistence } from "../src/cli-pro.js";

// A send whose answer arrived and whose recording then failed prints
// "consult_answer_received_but_not_saved: <task> <thread>", a blank line and
// the answer, then throws - so a person at a terminal still has the text. The
// MCP path only saw the throw and discarded the collected output, which loses
// exactly the answer that cost the most to get: a Pro run someone waited
// minutes for, thrown away because a receipt could not be written.
describe("an answer that outlived its record", () => {
  const lines = [
    "consult_answer_received_but_not_saved: task_20260911_000000_gpt-pro-consult https://chatgpt.com/c/abc-123",
    "",
    "The answer, first line.",
    "",
    "And a second paragraph."
  ];

  it("hands back the answer rather than only the failure", () => {
    const rescued = answerRescuedFromFailedPersistence(lines);
    expect(rescued?.taskId).toBe("task_20260911_000000_gpt-pro-consult");
    expect(rescued?.thread).toBe("https://chatgpt.com/c/abc-123");
    expect(rescued?.answer).toBe("The answer, first line.\n\nAnd a second paragraph.");
  });

  it("stays out of the way of an ordinary send", () => {
    expect(
      answerRescuedFromFailedPersistence(["task_1\tdone\thttps://chatgpt.com/c/abc", "", "the answer"])
    ).toBeUndefined();
  });

  // The marker with nothing under it is a failure with no answer to save, and
  // reporting an empty answer as a success would be worse than the error.
  it("does not manufacture an answer that is not there", () => {
    expect(answerRescuedFromFailedPersistence(["consult_answer_received_but_not_saved: task_1 thread", "", "   "])).toBeUndefined();
    expect(answerRescuedFromFailedPersistence([])).toBeUndefined();
  });
});
