import { describe, expect, it } from "vitest";

import { CHATGPT_STREAMING_SIGNAL_JS } from "../src/chatgpt-browser.js";

// Measured 2026-10-20 on ChatGPT build bfc3a09a: after a Pro answer finished,
// the composer form kept a zero-size, undisplayed button labelled "Stop".
// Its mere presence matched `form button[aria-label="Stop"]`, so prodex read
// the finished answer as still generating for its whole five-minute budget,
// returned it as answer_incomplete, and a second send queued behind it gave up.
type Fake = { rects: number; children?: Fake[] };
const node = (rects: number, children: Fake[] = []) => ({
  getClientRects: () => Array.from({ length: rects }, () => ({})),
  children
});

const visible = (matches: unknown[]) =>
  new Function("document", `${CHATGPT_STREAMING_SIGNAL_JS}\n return streamingSignalVisible();`)({
    querySelectorAll: () => matches
  }) as boolean;

describe("the streaming signal", () => {
  it("ignores a stop button that is not displayed", () => {
    expect(visible([node(0)])).toBe(false);
  });

  it("counts a displayed stop button", () => {
    expect(visible([node(1)])).toBe(true);
  });

  it("counts a busy message drawn through its children (display: contents)", () => {
    expect(visible([node(0, [node(1)])])).toBe(true);
  });

  it("is off when nothing matches", () => {
    expect(visible([])).toBe(false);
  });
});
