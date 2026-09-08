import { describe, expect, it } from "vitest";

import { browserSendBlockerFromError } from "../src/cli-pro.js";

// A send refused by the browser lock was reported under the generic browser
// blocker, whose guidance is to resolve the visible browser issue by hand.
// There is no browser issue: another prodex send owns the window. The caller
// needs to know to wait, not to go looking for something to fix.
describe("what a refused browser lock tells the caller to do", () => {
  const blocker = browserSendBlockerFromError(
    new Error(
      "Another prodex browser send is in progress (pid 4242) and did not finish within the wait budget. Retry once it finishes, or raise --timeout-ms (which is also the queue budget)."
    )
  );

  it("names the lock, not the browser", () => {
    expect(blocker.code).toBe("browser_busy");
    expect(blocker.retryable).toBe(true);
    expect(blocker.next_step).toMatch(/another prodex send/i);
    expect(blocker.next_step).not.toMatch(/browser issue/i);
  });

  it("points at the wait budget as the lever", () => {
    expect(blocker.next_step).toMatch(/--timeout-ms/);
  });
});
