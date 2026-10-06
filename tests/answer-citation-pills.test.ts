import { describe, expect, it } from "vitest";

import { CHATGPT_RENDERED_MESSAGE_TEXT_JS } from "../src/chatgpt-browser.js";

// Measured 2026-10-06: ChatGPT renders a source as an inline pill, and the
// page's innerText put the pill's label on its own line, so answers came back
// as "walnut-9 \ncont-att" (a file source) or ended with a bare
// "blog.rust-lang.org" (a web source) that read as part of the answer.
function pill(label: string, href?: string) {
  return {
    innerText: label,
    matches: () => false,
    contains: () => false,
    querySelector: (selector: string) => (href && selector.includes("href") ? { getAttribute: () => href } : null)
  };
}

function render(innerText: string, pills: ReturnType<typeof pill>[]): string {
  const root = { innerText, querySelectorAll: () => pills };
  return new Function("root", `${CHATGPT_RENDERED_MESSAGE_TEXT_JS}\n return renderedMessageText(root);`)(root) as string;
}

describe("source pills in a page-read answer", () => {
  it("marks a file source instead of appending its name as a new line", () => {
    expect(render("walnut-9 \ncont-att", [pill("cont-att")])).toBe("walnut-9 [cont-att]");
  });

  it("turns a web source into a markdown link like the transcript reader does", () => {
    const url = "https://blog.rust-lang.org/2026/10/01/Rust-1.99.0/";
    expect(render("The current version is 1.99.0. \nblog.rust-lang.org", [pill("blog.rust-lang.org", url)])).toBe(
      `The current version is 1.99.0. [blog.rust-lang.org](${url})`
    );
  });

  it("does not rewrite the same words when they appear in the prose before the pill", () => {
    const url = "https://example.org/a";
    expect(render("See example.org for details. \nexample.org", [pill("example.org", url)])).toBe(
      `See example.org for details. [example.org](${url})`
    );
  });

  it("keeps punctuation that follows a pill on the pill's line", () => {
    // Measured: "plum-stale [stale-chip]\n, walnut-9 [cont-att]".
    expect(render("plum-stale \nstale-chip\n, walnut-9 \ncont-att", [pill("stale-chip"), pill("cont-att")])).toBe(
      "plum-stale [stale-chip], walnut-9 [cont-att]"
    );
    expect(render("First point. \nsite.org\n\nNext paragraph.", [pill("site.org", "https://site.org/")])).toBe(
      "First point. [site.org](https://site.org/)\n\nNext paragraph."
    );
  });

  it("leaves text without pills untouched", () => {
    expect(render("plain answer\n\nsecond paragraph", [])).toBe("plain answer\n\nsecond paragraph");
  });
});
