import { describe, expect, it } from "vitest";

import { browserSendBlockerFromError } from "../src/cli-pro.js";

// Measured 2026-10-07: a send that posted and then ran out of time was
// recorded as send_timeout with retryable: true, while its own next_step said
// "Do not resend automatically". A caller that trusts the flag resends the
// question into a second conversation.
describe("a timeout after the prompt was posted", () => {
  const timeout = (extra: Record<string, unknown>) =>
    Object.assign(
      new Error("Timed out after 25s (25000ms) waiting for ChatGPT to respond. Pro reasoning can run many minutes. Do not resend the question; recover the original answer once it finishes."),
      extra
    );

  it("is not retryable when the request landed in a thread", () => {
    const blocker = browserSendBlockerFromError(timeout({ requestId: "a".repeat(32), thread: "https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }));
    expect(blocker.code).toBe("send_timeout");
    expect(blocker.retryable).toBe(false);
    expect(blocker.next_step).toMatch(/Do not resend/);
  });

  it("stays retryable when nothing says the prompt was posted", () => {
    expect(browserSendBlockerFromError(timeout({})).retryable).toBe(true);
  });
});
