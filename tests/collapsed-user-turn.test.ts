import { describe, expect, it } from "vitest";

import { CHATGPT_EXPAND_USER_TURN_JS, chatGptRequestMatchesUserTurn, chatGptUserTurnStillExpanding, USER_TURN_EXPAND_MAX_POLLS } from "../src/chatgpt-browser.js";

// Measured 2026-10-13: ChatGPT collapses a long user turn behind "Show more"
// and leaves the rest out of the DOM - 10,250 of 12,095 characters, the
// request marker among the missing - so a posted 500-line --file send was
// refused as request_mismatch. The text appears only after the button is
// clicked, and only on a later read (React renders after the click returns).
function bubble(collapsed: boolean | undefined) {
  let clicks = 0;
  const button = collapsed === undefined ? null : {
    getAttribute: (name: string) => (name === "aria-expanded" ? String(!collapsed) : null),
    click: () => { clicks += 1; }
  };
  const node = {
    querySelector: (selector: string) => (selector === 'button[aria-expanded="false"]' && collapsed ? button : null)
  };
  return { node, clicks: () => clicks };
}

const expand = (node: unknown): boolean =>
  new Function("node", `${CHATGPT_EXPAND_USER_TURN_JS}\n return expandCollapsedUserTurn(node);`)(node) as boolean;

describe("a collapsed user turn", () => {
  it("is expanded, and reported so the caller reads it again", () => {
    const collapsed = bubble(true);
    expect(expand(collapsed.node)).toBe(true);
    expect(collapsed.clicks()).toBe(1);
  });

  it("is left alone once expanded, or when it never collapsed", () => {
    const expanded = bubble(false);
    expect(expand(expanded.node)).toBe(false);
    expect(expanded.clicks()).toBe(0);
    expect(expand(bubble(undefined).node)).toBe(false);
    expect(expand(undefined)).toBe(false);
    expect(expand({})).toBe(false);
  });

  it("keeps a send waiting instead of judging the cut text", () => {
    const id = "a".repeat(32);
    const sent = `${"line\n".repeat(600)}\n[prodex-request:${id}]`;
    const cut = `${"line\n".repeat(420)}…\nShow more`;
    expect(chatGptRequestMatchesUserTurn(cut, sent, id)).toBe(false);
    expect(chatGptUserTurnStillExpanding({ lastUserText: cut, lastUserCollapsed: true })).toBe(true);
    expect(chatGptUserTurnStillExpanding({ lastUserText: sent, lastUserCollapsed: false })).toBe(false);
    expect(chatGptUserTurnStillExpanding({ lastUserText: sent })).toBe(false);
  });

  it("is judged after a bounded wait if it keeps collapsing", () => {
    const state = { lastUserText: "cut", lastUserCollapsed: true };
    expect(chatGptUserTurnStillExpanding(state, USER_TURN_EXPAND_MAX_POLLS - 1)).toBe(true);
    expect(chatGptUserTurnStillExpanding(state, USER_TURN_EXPAND_MAX_POLLS)).toBe(false);
  });
});
