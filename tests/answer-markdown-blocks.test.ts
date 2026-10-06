import { describe, expect, it } from "vitest";

import { CHATGPT_RENDERED_MESSAGE_TEXT_JS } from "../src/chatgpt-browser.js";

// Measured 2026-10-07: a page-read answer turned a fenced code block into
// "Python\nRun\ndef add(...)" - the block's toolbar text in place of the fence -
// and a markdown table into tab-separated lines.
type Node = {
  innerText?: string;
  textContent?: string;
  kind: "code" | "table" | "pill";
  matches: (selector: string) => boolean;
  contains: (other: unknown) => boolean;
  querySelector: (selector: string) => unknown;
  querySelectorAll: (selector: string) => unknown[];
};

function codeBlock(language: string, lines: string[]): Node {
  const label = { innerText: language[0].toUpperCase() + language.slice(1) + "\nRun" };
  const editor = { getAttribute: (name: string) => (name === "data-language" ? language : null) };
  return {
    kind: "code",
    innerText: `${label.innerText}\n${lines.join("\n")}`,
    matches: (selector) => selector.includes("code-block"),
    contains: () => false,
    querySelector: (selector) => (selector.includes("exclude") ? label : selector.includes("data-language") ? editor : null),
    querySelectorAll: (selector) => (selector.includes("cm-line") ? lines.map((line) => ({ textContent: line })) : [])
  };
}

function table(rows: string[][]): Node {
  return {
    kind: "table",
    innerText: rows.map((row) => row.join("\t")).join("\n"),
    matches: (selector) => selector === "table",
    contains: () => false,
    querySelector: () => null,
    querySelectorAll: (selector) =>
      selector === "tr" ? rows.map((row) => ({ children: row.map((cell) => ({ innerText: cell })) })) : []
  };
}

function render(innerText: string, nodes: Node[]): string {
  const root = { innerText, querySelectorAll: () => nodes };
  return new Function("root", `${CHATGPT_RENDERED_MESSAGE_TEXT_JS}\n return renderedMessageText(root);`)(root) as string;
}

describe("structure in a page-read answer", () => {
  it("restores a fenced code block without its toolbar text", () => {
    const block = codeBlock("python", ["def add(a, b):", "    return a + b"]);
    expect(render(`Here it is.\n${block.innerText}\nCalling it returns 5.`, [block])).toBe(
      "Here it is.\n```python\ndef add(a, b):\n    return a + b\n```\nCalling it returns 5."
    );
  });

  it("restores a markdown table, escaping pipes inside cells", () => {
    const grid = table([["fruit", "color"], ["apple", "red"], ["a|b", "green"]]);
    expect(render(grid.innerText as string, [grid])).toBe(
      "| fruit | color |\n| --- | --- |\n| apple | red |\n| a\\|b | green |"
    );
  });
});
