import { describe, expect, it } from "vitest";

import { browserSendBlockerFromError, reclassifyRecordedBlocker } from "../src/cli-pro.js";

// Every string below is a real blocker message taken from the ledger on this
// machine - 296 recorded blockers across 77 bridge roots, of which 178 were the
// catch-all `browser_send_failed`. Replaying them through the classifier showed
// 109 still landing there, each one answered with "resolve the visible browser
// issue manually": advice for a problem nobody has, on failures that recur.
//
// They all fail BEFORE the prompt is submitted - the selection steps and the
// post-insertion check run ahead of the send - so "nothing was sent" is a fact
// in these next steps and not a hope.
const FROM_THE_LEDGER: { seen: number; message: string; code: string; retryable: boolean }[] = [
  {
    seen: 14,
    message:
      'Refusing to click "project Notes": another element covers its click point (overlay, scroll, or layout change). Retry, or interact manually in the visible browser.',
    code: "click_blocked",
    retryable: true
  },
  {
    seen: 12,
    message: "Composer text did not match the prompt after insertion (possible leftover text in the composer)",
    code: "composer_text_mismatch",
    retryable: true
  },
  { seen: 8, message: "model selector button not found", code: "composer_not_ready", retryable: true },
  { seen: 8, message: "Pro option not found in the model menu", code: "selection_not_applied", retryable: false },
  {
    seen: 5,
    message: 'Selected "Create image" but the composer never showed it as active.',
    code: "tool_not_applied",
    retryable: true
  },
  {
    seen: 4,
    message: 'Clicking project "Notes" did not navigate the visible tab. If the tab is already inside this project, omit --project and retry.',
    code: "project_navigation_failed",
    retryable: true
  },
  {
    seen: 4,
    message:
      "ChatGPT project not found in sidebar: <project> (project not found in sidebar (9 projects visible; names are matched exactly first, then case-insensitively - check the exact sidebar spelling)) List the visible names with `prodex pro browser projects`.",
    code: "project_not_found",
    retryable: false
  },
  {
    seen: 3,
    message: "ChatGPT's model picker did not expose its power slider, so the requested model/effort could not be selected.",
    code: "composer_not_ready",
    retryable: true
  },
  {
    seen: 2,
    message: "ChatGPT did not finish accepting notes.md within the upload budget.",
    code: "attachment_upload_timeout",
    retryable: true
  },
  { seen: 2, message: 'ChatGPT\'s composer tools menu has no "Create image".', code: "tool_not_offered", retryable: false }
];

describe("classifying the failures that actually recur", () => {
  for (const entry of FROM_THE_LEDGER) {
    it(`gives ${entry.code} to the one seen ${entry.seen} times`, () => {
      const blocker = browserSendBlockerFromError(new Error(entry.message));
      expect(blocker.code).toBe(entry.code);
      expect(blocker.retryable).toBe(entry.retryable);
      expect(blocker.next_step).toBeDefined();
      // The catch-all's advice is the thing being replaced; none of these may
      // fall back to it.
      expect(blocker.next_step).not.toMatch(/resolve the visible browser issue/i);
    });
  }

  it("tells the caller nothing was sent, because nothing was", () => {
    for (const entry of FROM_THE_LEDGER) {
      expect(browserSendBlockerFromError(new Error(entry.message)).next_step).toMatch(/nothing was sent|Nothing was sent/);
    }
  });

  // A message nobody has classified is still a send failure, and must not be
  // dressed up as one of the above.
  it("leaves an unknown failure in the catch-all rather than guessing", () => {
    const blocker = browserSendBlockerFromError(new Error("something nobody has seen before"));
    expect(blocker.code).toBe("browser_send_failed");
  });
});

// Records keep the code they were written with, and most of the recurring
// failures were recorded as the catch-all before they had names. A report
// grouped by the recorded code kept showing "browser_send_failed: ..." rows
// for causes the classifier now knows.
describe("reading old records with what the classifier knows now", () => {
  it("names a catch-all record whose cause has a code today", () => {
    const record = { code: "browser_send_failed", message: FROM_THE_LEDGER[0].message };
    expect(reclassifyRecordedBlocker(record).code).toBe(FROM_THE_LEDGER[0].code);
  });

  it("keeps a catch-all record it still cannot place", () => {
    const record = { code: "browser_send_failed", message: "something nobody has seen before" };
    expect(reclassifyRecordedBlocker(record)).toEqual(record);
  });

  // A record that already had a code is history; rewriting it would let a
  // later classifier change what an old failure was.
  it("leaves a record that was never the catch-all exactly as written", () => {
    const record = { code: "send_timeout", message: 'Refusing to click "x": another element covers its click point' };
    expect(reclassifyRecordedBlocker(record)).toEqual(record);
  });
});
