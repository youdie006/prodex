import { describe, expect, it } from "vitest";

import { cdpCommandTimedOut } from "../src/chatgpt-browser.js";
import { browserSendBlockerFromError } from "../src/cli-pro.js";

// A CDP command timeout was explained as a heavy thread, and the advice was to
// retry on a fresh one. Measured against the live browser, the other cause is a
// JavaScript dialog: it halts the page's main thread, so every command waits
// forever, and a client that had not armed the Page domain first cannot dismiss
// it - the browser answers "no dialog is showing". Retrying, with or without
// --new-chat, cannot get past that. Somebody has to close the dialog, or the
// window has to be reopened.
describe("what a stalled DevTools command tells the caller to do", () => {
  const blocker = browserSendBlockerFromError(new Error("Chrome DevTools command timed out: Runtime.enable"));

  it("keeps naming the heavy-thread case", () => {
    expect(blocker.code).toBe("browser_cdp_timeout");
    expect(blocker.next_step).toMatch(/long thread|new-chat/i);
  });

  it("also names the dialog, and a cure that works for it", () => {
    expect(blocker.next_step).toMatch(/dialog/i);
    expect(blocker.next_step).toMatch(/reopen|`prodex pro browser login`/i);
  });
});

// The first command of most sends is the surface probe, and it swallowed its
// own timeout. The next command then found a closed socket and reported that,
// which named neither the stalled tab nor the dialog cure. The socket now
// remembers the timeout that closed it, and the guard's rejection carries it.
describe("a command refused because a timeout already closed the socket", () => {
  const blocker = browserSendBlockerFromError(
    new Error("Chrome DevTools command timed out: Runtime.evaluate (the connection was closed by that timeout before Runtime.evaluate)")
  );

  it("is still the stalled-tab case, with its guidance", () => {
    expect(blocker.code).toBe("browser_cdp_timeout");
    expect(blocker.next_step).toMatch(/dialog/i);
  });

  it("is recognised as a timeout by the probes that decide whether to swallow an error", () => {
    expect(cdpCommandTimedOut(new Error("Chrome DevTools command timed out: Runtime.evaluate"))).toBe(true);
    expect(cdpCommandTimedOut(new Error("Chrome DevTools websocket closed"))).toBe(false);
    expect(cdpCommandTimedOut("Chrome DevTools command timed out: Runtime.evaluate")).toBe(false);
  });
});

// A connection that closed with no timeout behind it is a different event: the
// tab went away under prodex. It used to fall into the generic "resolve the
// visible browser issue manually".
describe("a connection the tab closed under prodex", () => {
  it("names the tab going away, and how to get it back", () => {
    for (const message of ["Chrome DevTools websocket closed", "Chrome DevTools websocket is not open (Runtime.evaluate)"]) {
      const blocker = browserSendBlockerFromError(new Error(message));
      expect(blocker.code).toBe("browser_connection_lost");
      expect(blocker.retryable).toBe(true);
      expect(blocker.next_step).toMatch(/`prodex pro browser login`/);
    }
  });
});
