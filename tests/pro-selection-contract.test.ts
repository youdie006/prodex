import { describe, expect, it } from "vitest";

import { selectionMismatchWarning } from "../src/chatgpt-browser.js";
import { browserSendBlockerFromError, isProSelection, proSelectionVerified } from "../src/cli-pro.js";

// Asking for Pro is a contract: the answer has to come from Pro or it is not
// the thing that was asked for. Three ways that contract was breaking, all
// measured against the on-disk ledger.

// 1. A Pro request made through --effort was budgeted like an ordinary send.
// The raised budget keyed off --model and --pro-mode only, so `--effort Pro`
// got five minutes for reasoning the code's own comment calls "6-20 minutes".
// send_timeout is 55 of the 267 blockers on this machine.
describe("recognising that a send asked for Pro", () => {
  it("counts an effort-shaped Pro request", () => {
    expect(isProSelection({ effort: "Pro" })).toBe(true);
    expect(isProSelection({ effort: "프로" })).toBe(true);
  });

  it("still counts the model- and sub-mode-shaped ones", () => {
    expect(isProSelection({ model: "Pro" })).toBe(true);
    expect(isProSelection({ model: "GPT-6 Pro" })).toBe(true);
    expect(isProSelection({ proMode: "확장" })).toBe(true);
  });

  it("does not count a request for any other rung", () => {
    expect(isProSelection({ effort: "높음" })).toBe(false);
    expect(isProSelection({ effort: "매우 높음" })).toBe(false);
    expect(isProSelection({ model: "GPT-5.6 Sol" })).toBe(false);
    expect(isProSelection({})).toBe(false);
  });
});

// 2. After the answer arrives ChatGPT tags it with the model that wrote it.
// That tag was only ever checked against --model, so an --effort Pro request
// answered by a lesser model passed without a word.
describe("checking the answer against what was asked for", () => {
  it("catches an effort-shaped Pro request answered by something else", () => {
    const warning = selectionMismatchWarning({ effort: "Pro", modelSlug: "gpt-5-6-thinking" });
    expect(warning).toMatch(/^model_mismatch:/);
    expect(warning).toContain("gpt-5-6-thinking");
  });

  it("still catches the model-shaped one", () => {
    expect(selectionMismatchWarning({ model: "Pro", modelSlug: "gpt-5-6-thinking" })).toMatch(/^model_mismatch:/);
  });

  it("says nothing when Pro did answer", () => {
    expect(selectionMismatchWarning({ effort: "Pro", modelSlug: "gpt-6-pro" })).toBeUndefined();
    expect(selectionMismatchWarning({ model: "Pro", modelSlug: "gpt-6-pro" })).toBeUndefined();
  });

  it("says nothing when Pro was never asked for, or nothing came back", () => {
    expect(selectionMismatchWarning({ effort: "높음", modelSlug: "gpt-5-6-thinking" })).toBeUndefined();
    expect(selectionMismatchWarning({ effort: "Pro" })).toBeUndefined();
    expect(selectionMismatchWarning({})).toBeUndefined();
  });
});

// 3. A picker that could not provide the requested step used to warn and send
// anyway at whatever step it was on. That is how a Pro request came back as
// gpt-5-6-thinking, unusable, after minutes of waiting.
describe("what a picker that cannot provide the requested step tells the caller", () => {
  const blocker = browserSendBlockerFromError(
    new Error('ChatGPT\'s model picker has no "Pro" step. It showed: Instant / Instant, 1 of 5. / Latest / GPT-5.5')
  );

  it("is its own blocker, not a generic send failure", () => {
    expect(blocker.code).toBe("selection_not_applied");
  });

  it("does not invite a retry that would fail the same way", () => {
    expect(blocker.retryable).toBe(false);
  });

  it("says nothing was sent, and names the way to send anyway", () => {
    expect(blocker.next_step).toMatch(/nothing was sent/i);
    expect(blocker.next_step).toMatch(/--allow-model-fallback/);
  });
});

// 4. The receipt recorded what was asked for and what answered, but left the
// comparison to whoever read it later. "Can I count this as a Pro review?" is
// the question the caller actually has, so the receipt answers it.
describe("recording whether the send met the contract", () => {
  it("says nothing when Pro was never asked for", () => {
    expect(proSelectionVerified({ effort: "높음", modelSlug: "gpt-5-6-thinking" })).toBeUndefined();
    expect(proSelectionVerified({ modelSlug: "gpt-6-pro" })).toBeUndefined();
  });

  it("says nothing when no model tag came back to check against", () => {
    expect(proSelectionVerified({ effort: "Pro" })).toBeUndefined();
  });

  it("confirms a Pro request that Pro answered", () => {
    expect(proSelectionVerified({ effort: "Pro", modelSlug: "gpt-6-pro" })).toBe(true);
    expect(proSelectionVerified({ model: "Pro", modelSlug: "gpt-6-pro" })).toBe(true);
  });

  it("denies a Pro request that something else answered", () => {
    expect(proSelectionVerified({ effort: "Pro", modelSlug: "gpt-5-6-thinking" })).toBe(false);
    expect(proSelectionVerified({ model: "Pro", modelSlug: "gpt-5-6-thinking" })).toBe(false);
  });
});
