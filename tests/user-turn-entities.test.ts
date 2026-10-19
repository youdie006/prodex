import { describe, expect, it } from "vitest";

import { chatGptRequestMatchesUserTurn } from "../src/chatgpt-browser.js";

// Measured 2026-10-19 on ChatGPT build bfc3a09a: a prompt containing
// "&amp; &lt;b&gt;" was displayed in the sent turn as "& <b>", so a send that
// had posted was refused as request_mismatch.
const id = "c".repeat(32);
const sent = [
  "Reply with exactly: SPECIAL_OK",
  "2. HTML <div class=\"x\">tag</div> & entity &amp; &lt;b&gt; &quot;q&quot; &#39;s&#39; &#x41;",
  "3. a [link](https://example.com/a_b)",
  "",
  `[prodex-request:${id}]`
].join("\n");

describe("a sent turn whose HTML entities were displayed decoded", () => {
  it("is recognized", () => {
    const seen = [
      "Reply with exactly: SPECIAL_OK",
      "2. HTML <div class=\"x\">tag</div> & entity & <b> \"q\" 's' A",
      "3. a [link]\\([https://example.com/a_b](https://example.com/a_b))",
      "",
      `[prodex-request:${id}]`
    ].join("\n");
    expect(chatGptRequestMatchesUserTurn(seen, sent, id)).toBe(true);
  });

  it("leaves an out-of-range character reference as written instead of throwing", () => {
    const odd = `Value &#99999999; here\n\n[prodex-request:${id}]`;
    expect(chatGptRequestMatchesUserTurn(odd, odd, id)).toBe(true);
  });

  it("still refuses a turn whose words differ", () => {
    const seen = sent.replace("&lt;b&gt;", "<i>");
    expect(chatGptRequestMatchesUserTurn(seen, sent, id)).toBe(false);
  });
});
