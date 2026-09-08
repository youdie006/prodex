import { describe, expect, it } from "vitest";

import { shouldReloadForMissingComposer } from "../src/chatgpt-browser.js";

// A thread can be left rendered with no composer at all - measured after a send,
// zero contenteditables and zero textareas on the page - and every retry then
// hit the same dead page and reported the same "missing a visible prompt
// composer". One reload cures it. But a reload is only worth spending where it
// can help: a logged-out tab has no composer either, and a modal sitting over
// the composer has its own message telling the person to close it.
describe("deciding whether a missing composer is worth a reload", () => {
  const base = { hasComposer: false, loggedInLikely: true, hasBlocker: false };

  it("reloads a page that otherwise looks usable", () => {
    expect(shouldReloadForMissingComposer(base)).toBe(true);
  });

  it("does not reload when the composer is already there", () => {
    expect(shouldReloadForMissingComposer({ ...base, hasComposer: true })).toBe(false);
  });

  it("does not delay a logged-out page by the settle time", () => {
    expect(shouldReloadForMissingComposer({ ...base, loggedInLikely: false })).toBe(false);
  });

  it("leaves a page that already has a blocker to report it", () => {
    expect(shouldReloadForMissingComposer({ ...base, hasBlocker: true })).toBe(false);
  });

  it("never reloads a thread the busy check says is still writing its answer", () => {
    // Streaming hides the composer too. A reload there tears down the answer
    // being written - and with beforeunload now accepted, it really goes
    // through - which is why the decision waits for the busy check.
    expect(shouldReloadForMissingComposer({ ...base, busy: true })).toBe(false);
  });

  it("reloads a dead page once the transcript has cleared its stale busy signs", () => {
    // A finished thread kept its stop button for thirty seconds (measured), so
    // the raw generating flag would refuse the reload on exactly the page it
    // was written for. The caller passes the transcript-checked verdict.
    expect(shouldReloadForMissingComposer({ ...base, busy: false })).toBe(true);
  });

  it("never reloads a page waiting for a response choice", () => {
    expect(shouldReloadForMissingComposer({ ...base, awaitingResponseChoice: true })).toBe(false);
  });

  it("keeps the dialog message rather than reloading the dialog away", () => {
    expect(shouldReloadForMissingComposer({ ...base, openDialogText: "Upgrade to Pro" })).toBe(false);
    // Whitespace is not a dialog.
    expect(shouldReloadForMissingComposer({ ...base, openDialogText: "   " })).toBe(true);
  });
});
