import { describe, expect, it } from "vitest";

import { CHATGPT_RENDERED_MESSAGE_TEXT_JS, chatGptRequestMatchesUserTurn } from "../src/chatgpt-browser.js";

// Measured 2026-10-07: ChatGPT renders inline code in the sent user turn as
// <code>x</code>, so the page shows "$HOME x" for a prompt that said
// "$HOME `x`". The send posted, then was refused as request_mismatch and its
// answer thrown away, on every prompt carrying inline code. The comparison
// stays strict; the turn is read back with its backticks.
function userText(innerText: string, codes: Array<{ text: string; inPre?: boolean }>): string {
  const root = {
    innerText,
    querySelectorAll: (selector: string) =>
      selector === "code" ? codes.map((code) => ({ textContent: code.text, closest: (s: string) => (s === "pre" && code.inPre ? {} : null) })) : []
  };
  return new Function("root", `${CHATGPT_RENDERED_MESSAGE_TEXT_JS}\n return userMessageText(root);`)(root) as string;
}

describe("reading a user turn whose inline code was rendered", () => {
  const id = "c".repeat(32);
  const sent = `Reply with only this exact string: <tag a="1">&amp; $HOME \`x\` end\n\n[prodex-request:${id}]`;

  it("puts the backticks back, so the strict match still recognizes the request", () => {
    const seen = userText(`Reply with only this exact string: <tag a="1">&amp; $HOME x end\n\n[prodex-request:${id}]`, [{ text: "x" }]);
    expect(seen).toBe(sent);
    expect(chatGptRequestMatchesUserTurn(seen, sent, id)).toBe(true);
  });

  it("leaves a multi-line code block alone even when it is not inside a pre", () => {
    // Measured: a --file prompt's fenced block renders in the user turn as one
    // <code> outside any <pre>; backticking it broke every such request.
    const block = "## Notes\n\n- item one with `code`\nconst answer = 42;";
    expect(userText(`ask\n${block}\nend`, [{ text: block }])).toBe(`ask\n${block}\nend`);
  });

  it("leaves code inside a rendered block alone and text without code untouched", () => {
    expect(userText("text\nline one", [{ text: "line one", inPre: true }])).toBe("text\nline one");
    expect(userText("plain prompt", [])).toBe("plain prompt");
  });
});

describe("matching a user turn whose url the composer autolinked", () => {
  // Measured 2026-10-07 under load: the composer autolinked a url before the
  // send, so the stored turn read "[link]\\([https://example.com](https://example.com))"
  // for a prompt that said "[link](https://example.com)"; the answer was refused.
  const id = "d".repeat(32);
  const sent = `- item two with a [link](https://example.com)\n\n[prodex-request:${id}]`;

  it("still recognizes the request", () => {
    const seen = `- item two with a [link]\\([https://example.com](https://example.com))\n\n[prodex-request:${id}]`;
    expect(chatGptRequestMatchesUserTurn(seen, sent, id)).toBe(true);
  });

  it("still refuses a different url", () => {
    const seen = `- item two with a [link]\\([https://other.example](https://other.example))\n\n[prodex-request:${id}]`;
    expect(chatGptRequestMatchesUserTurn(seen, sent, id)).toBe(false);
  });
});
