import { describe, expect, it } from "vitest";

import { CHATGPT_STREAMING_SELECTOR, composerToolsButtonRectExpression } from "../src/chatgpt-browser.js";

// Second pass over the 2026-09-29 ChatGPT redesign, each measured on the live
// page against the published 0.40.20.
describe("the composer controls after the redesign", () => {
  // The stop control lost its test id and is a composer button labelled "Stop".
  // Sampled through a streamed answer, prodex read generating=false on all 23
  // samples while it was on screen, so a pause mid-answer could end the wait
  // and return a truncated answer as complete.
  it("treats the composer's Stop button as a response in progress", () => {
    expect(CHATGPT_STREAMING_SELECTOR).toContain('form button[aria-label="Stop"]');
    expect(CHATGPT_STREAMING_SELECTOR).toContain('[data-testid="stop-button"]');
  });

  // The "+" control lost data-testid="composer-plus-btn" and every --tool send
  // failed with "composer tools button not found".
  it("finds the tools control by its new attribute, inside the composer form only", () => {
    const button = {
      getBoundingClientRect: () => ({ x: 520, y: 360, width: 24, height: 24 }),
      scrollIntoView: () => undefined,
      setAttribute: () => undefined,
      removeAttribute: () => undefined
    };
    const form = { querySelector: (s: string) => (s.includes('data-composer-navigation-target="add-context"') ? button : null) };
    const composer = { getBoundingClientRect: () => ({ width: 540, height: 40 }), closest: (s: string) => (s === "form" ? form : null) };
    const document = {
      querySelector: () => null,
      querySelectorAll: (s: string) => (s.includes("prompt-textarea") ? [composer] : [])
    };
    const run = (doc: unknown) =>
      new Function("document", "getComputedStyle", `return ${composerToolsButtonRectExpression()};`)(doc, () => ({ pointerEvents: "auto" })) as {
        ok: boolean;
        reason?: string;
      };
    expect(run(document).ok).toBe(true);
    const unrendered = { querySelector: () => null, querySelectorAll: () => [] };
    expect(run(unrendered).reason).toMatch(/composer has not rendered/);
  });
});
