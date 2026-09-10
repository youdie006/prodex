import { describe, expect, it } from "vitest";

import { inferChatGptPageLoggedInLikely } from "../src/chatgpt-browser.js";

// Measured live on a project home, on a logged-in Pro account, while the page
// showed a working composer:
//
//   document.body.innerText                 1900 chars, sidebar and all
//   the sample the login check read          111 chars: a promo banner
//
// The sample keeps only text whose own parent element has a box, and the
// sidebar's did not - so every logged-in signal was filtered out and a working
// browser was told "missing a clear logged-in ChatGPT session. Log in
// manually". Reproduced twice in a row; four of the last thirty days' blockers
// carry that message.
describe("deciding whether the session is live", () => {
  const sidebar = "Chat history\nChatGPT\nNew chat\nLibrary\nProjects\nSora\nGPTs\nPro";
  const promoOnly = "Image creation got a major upgrade\nHigher-quality results, faster generation\nTry it";

  it("reads the sidebar even when the filtered sample kept only a banner", () => {
    expect(
      inferChatGptPageLoggedInLikely({
        textSample: `${promoOnly}\n${sidebar}`,
        blockerTextSample: promoOnly,
        visibleButtonLabels: ["Open profile menu", "Search"]
      })
    ).toBe(true);
  });

  // The other direction of the same rule: a blocker scan that excludes the nav
  // must not take the signals with it, which is why the filtered sample is read
  // too rather than replaced.
  it("reads the sidebar when it is the filtered sample that carries it", () => {
    expect(
      inferChatGptPageLoggedInLikely({
        textSample: "full body text",
        blockerTextSample: sidebar,
        visibleButtonLabels: ["Profile menu"]
      })
    ).toBe(true);
  });

  it("still calls a real login screen logged out", () => {
    expect(
      inferChatGptPageLoggedInLikely({
        textSample: "Welcome back\nLog in\nSign up for free",
        blockerTextSample: "Welcome back\nLog in\nSign up for free",
        visibleButtonLabels: ["Log in", "Sign up"]
      })
    ).toBe(false);
  });

  // The reason the logged-OUT half keeps the message-excluded sample: an old
  // conversation that quotes a signup page must not report the session as dead.
  it("does not let a chat message quoting a signup page fake a logout", () => {
    expect(
      inferChatGptPageLoggedInLikely({
        textSample: `Old conversation says Log in and Sign up for free\n${sidebar}`,
        blockerTextSample: sidebar,
        visibleButtonLabels: ["Open profile menu"]
      })
    ).toBe(true);
  });

  // A page with none of the furniture is not a session prodex can vouch for -
  // the error page reaches here, and it has its own blocker upstream.
  it("does not invent a session for a page with nothing on it", () => {
    expect(inferChatGptPageLoggedInLikely({ textSample: "Try again", blockerTextSample: "Try again", visibleButtonLabels: [] })).toBe(
      false
    );
  });
});
