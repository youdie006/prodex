import { describe, expect, it } from "vitest";

import { CHATGPT_RENDERED_MESSAGE_TEXT_JS, chatGptRequestMatchesUserTurn, transcriptMatchesSentPrompt } from "../src/chatgpt-browser.js";

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

// A minimal DOM: text nodes and inline <code> elements under one root, with
// innerText computed from the children as they are at read time.
function domTurn(parts: Array<string | { code: string }>) {
  type Node = { nodeType: number; textContent: string; parentNode: typeof root | null; closest?: (s: string) => null };
  const root = {
    childNodes: [] as Node[],
    ownerDocument: {
      createTextNode: (text: string): Node => ({ nodeType: 3, textContent: text, parentNode: null })
    },
    get innerText(): string {
      return root.childNodes.map((node) => node.textContent).join("");
    },
    querySelectorAll: (selector: string) => (selector === "code" ? root.childNodes.filter((node) => node.nodeType === 1) : []),
    insertBefore(node: Node, before: Node | null) {
      const index = before ? root.childNodes.indexOf(before) : root.childNodes.length;
      root.childNodes.splice(index, 0, node);
      node.parentNode = root;
      return node;
    },
    removeChild(node: Node) {
      root.childNodes.splice(root.childNodes.indexOf(node), 1);
      node.parentNode = null;
      return node;
    }
  };
  for (const part of parts) {
    const node: Node =
      typeof part === "string"
        ? { nodeType: 3, textContent: part, parentNode: root }
        : { nodeType: 1, textContent: part.code, parentNode: root, closest: () => null };
    root.childNodes.push(node);
  }
  for (const node of root.childNodes) {
    Object.defineProperty(node, "nextSibling", { get: () => root.childNodes[root.childNodes.indexOf(node) + 1] ?? null });
  }
  return root;
}

describe("reading a user turn whose code span text also occurs as plain text", () => {
  // Measured 2026-10-24 on a 28k-character consult: "sessionwiki list" occurred
  // three times as plain text and once in backticks. The backticks were put back
  // by searching the text, so they landed on the first plain occurrence, the
  // turn no longer matched the prompt, and two sends were refused as
  // request_mismatch although both had posted.
  const id = "e".repeat(32);
  const sent = `run sessionwiki list first, then \`sessionwiki list\` again\n\n[prodex-request:${id}]`;

  it("puts the backticks around the code span itself, not an earlier plain occurrence", () => {
    const root = domTurn(["run sessionwiki list first, then ", { code: "sessionwiki list" }, ` again\n\n[prodex-request:${id}]`]);
    const seen = new Function("root", `${CHATGPT_RENDERED_MESSAGE_TEXT_JS}\n return userMessageText(root);`)(root) as string;
    expect(seen).toBe(sent);
    expect(chatGptRequestMatchesUserTurn(seen, sent, id)).toBe(true);
    // The page is left as it was found.
    expect(root.childNodes).toHaveLength(3);
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

  it("recognizes an autolinked url that the composer escaped differently in its text and its href", () => {
    // Measured 2026-10-21: a url with "_" and parentheses was stored with "\\_"
    // in the link text but "_\\(...\\)" in the href, so the two halves were not
    // identical until unescaped and the request was refused.
    const url = "https://en.wikipedia.org/wiki/Function_(mathematics)";
    const sentWithParens = `See [the docs](${url}) for more.\n\n[prodex-request:${id}]`;
    const seen =
      "See [the docs]\\([https://en.wikipedia.org/wiki/Function\\_(mathematics)](https://en.wikipedia.org/wiki/Function_\\(mathematics\\))) for more." +
      `\n\n[prodex-request:${id}]`;
    expect(chatGptRequestMatchesUserTurn(seen, sentWithParens, id)).toBe(true);
    expect(transcriptMatchesSentPrompt(seen, sentWithParens)).toBe(true);
  });
});
