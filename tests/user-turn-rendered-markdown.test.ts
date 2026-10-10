import { describe, expect, it } from "vitest";

import { chatGptRequestMatchesUserTurn } from "../src/chatgpt-browser.js";

// Measured 2026-10-10: the browser container's ChatGPT renders a sent user
// turn as markdown (the host still shows it raw), so a --file prompt's
// "```text" fence line disappeared and the inner fences moved. Every such send
// posted and was then refused as unverified. Fence lines carry no request text;
// everything else must still match in order.
const id = "e".repeat(32);
const sent = [
  "What is the keyword in the file? Reply with only it.",
  "",
  "## File: md-input.md",
  "",
  "```text",
  "## Notes",
  "",
  "- item one with `code` and **bold**",
  "- item two with a [link](https://example.com)",
  "",
  "```js",
  "const answer = 42; // the answer",
  "```",
  "",
  "The keyword is opal-5.",
  "```",
  "",
  `[prodex-request:${id}]`
].join("\n");

describe("a sent turn drawn as markdown", () => {
  it("is recognized when the fences were rendered away", () => {
    const rendered = [
      "What is the keyword in the file? Reply with only it.",
      "",
      "## File: md-input.md",
      "",
      "",
      "## Notes",
      "",
      "- item one with `code` and **bold**",
      "- item two with a [link](https://example.com)",
      "",
      "```js",
      "const answer = 42; // the answer",
      "",
      "",
      "The keyword is opal-5.",
      "```",
      "",
      `[prodex-request:${id}]`,
      "…",
      "Show more"
    ].join("\n");
    expect(chatGptRequestMatchesUserTurn(rendered, sent, id)).toBe(true);
  });

  it("still refuses different words, a missing marker, or another request's marker", () => {
    const changed = sent.replace("opal-5", "opal-6");
    expect(chatGptRequestMatchesUserTurn(changed, sent, id)).toBe(false);
    expect(chatGptRequestMatchesUserTurn(sent.replace(`[prodex-request:${id}]`, ""), sent, id)).toBe(false);
    expect(chatGptRequestMatchesUserTurn(sent.replace(id, "f".repeat(32)), sent, id)).toBe(false);
  });
});
