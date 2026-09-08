import { describe, expect, it } from "vitest";

import { browserSendBlockerFromError } from "../src/cli-pro.js";

// A slider that ignored every press was reported as the picker having no such
// step, with "resolve the visible browser issue manually" as the cure - and a
// person who opened the browser found the step right there. The condition is
// the picker still hydrating, and the cure is a retry.
describe("a picker whose slider ignored every arrow press", () => {
  const blocker = browserSendBlockerFromError(
    new Error(
      'ChatGPT\'s power slider did not respond to arrow keys: it stayed at "Instant" (1 of 5) while the picker was still hydrating, so the "Pro" step could not be reached.'
    )
  );

  it("is its own retryable blocker, not a browser issue to fix by hand", () => {
    expect(blocker.code).toBe("picker_not_responding");
    expect(blocker.retryable).toBe(true);
    expect(blocker.next_step).toMatch(/retry/i);
    expect(blocker.next_step).not.toMatch(/resolve the visible browser issue/i);
  });

  it("says nothing was sent", () => {
    expect(blocker.next_step).toMatch(/nothing was sent/i);
  });
});
