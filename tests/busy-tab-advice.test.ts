import { describe, expect, it } from "vitest";

import { chatGptBusyBlocker } from "../src/chatgpt-browser.js";

// Measured 2026-10-27: a send with --new-chat waited five minutes behind
// another session's Pro answer and then advised "A new topic can go to a new
// chat instead" - the very thing it had been asked to do. Every send waits
// for the shared tab, and leaving a thread mid-answer could lose that answer,
// so a new chat is not a way around it. The recover command it suggested also
// said `<thread-url>` while the thread that was generating was on screen.
describe("advice for a tab still generating", () => {
  it("does not offer a new chat as the way around the wait", () => {
    const blocker = chatGptBusyBlocker({ generating: true, url: "https://chatgpt.com/c/abc123" });
    expect(blocker?.next_step).not.toMatch(/new chat instead/);
    expect(blocker?.next_step).toMatch(/new chat waits as well/i);
  });

  it("names the generating thread in the recover command", () => {
    const blocker = chatGptBusyBlocker({ generating: true, url: "https://chatgpt.com/g/g-p-1a2b-notes/c/abc123" });
    expect(blocker?.next_step).toContain("`prodex pro browser recover --target-url https://chatgpt.com/g/g-p-1a2b-notes/c/abc123`");
    // The prompt of the send that is waiting landed nowhere, so the blocker
    // must not claim a thread for it.
    expect(blocker?.thread).toBeUndefined();
  });

  it("keeps the placeholder when the page is not a conversation", () => {
    expect(chatGptBusyBlocker({ generating: true, url: "https://chatgpt.com/" })?.next_step).toContain("--target-url <thread-url>");
    expect(chatGptBusyBlocker({ generating: true })?.next_step).toContain("--target-url <thread-url>");
  });
});
