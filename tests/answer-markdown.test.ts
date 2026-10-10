import { describe, expect, it } from "vitest";

import { CHATGPT_RENDERED_MESSAGE_TEXT_JS } from "../src/chatgpt-browser.js";

// A page-read answer used innerText, which drops markdown: measured
// 2026-10-07, headings lost their #, numbered lists their numbers, bullets
// their markers, links their urls, code blocks their fences (gaining the
// toolbar's "Python"/"Run"), tables their structure, and KaTeX math came back
// as one glyph per line, twice. These tests build the measured shapes.
type FakeNode = {
  nodeType: number;
  tagName?: string;
  textContent: string;
  innerText?: string;
  childNodes: FakeNode[];
  getAttribute: (name: string) => string | null;
};

function text(value: string): FakeNode {
  return { nodeType: 3, textContent: value, childNodes: [], getAttribute: () => null };
}

function el(tag: string, attrs: Record<string, string> = {}, children: Array<FakeNode | string> = []): FakeNode {
  const childNodes = children.map((child) => (typeof child === "string" ? text(child) : child));
  const node: FakeNode = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    childNodes,
    get textContent() {
      return childNodes.map((child) => child.textContent).join("");
    },
    getAttribute: (name) => (name in attrs ? attrs[name] : null)
  };
  return node;
}

function render(root: FakeNode, innerText = "fallback text"): string {
  root.innerText = innerText;
  return new Function("root", `${CHATGPT_RENDERED_MESSAGE_TEXT_JS}\n return renderedMessageText(root);`)(root) as string;
}

describe("page-read answers as markdown", () => {
  it("keeps headings, numbered and bulleted lists, bold and links", () => {
    const root = el("div", {}, [
      el("h2", {}, ["Plan"]),
      el("ol", {}, [el("li", {}, ["Define the goal."]), el("li", {}, ["Do it."])]),
      el("ul", {}, [el("li", {}, ["Keep it ", el("strong", {}, ["clear"]), "."]), el("li", {}, ["Stay focused."])]),
      el("p", {}, ["Visit ", el("a", { href: "https://example.com" }, ["Example"]), " to begin."])
    ]);
    expect(render(root)).toBe(
      "## Plan\n\n1. Define the goal.\n2. Do it.\n\n- Keep it **clear**.\n- Stay focused.\n\nVisit [Example](https://example.com) to begin."
    );
  });

  it("keeps a task list's checkboxes", () => {
    // Measured 2026-10-07: a checkbox is a button[role=checkbox] with
    // aria-checked, and leaving buttons out dropped every [x] and [ ].
    const box = (checked: boolean) =>
      el("div", { "data-markdown-copy": "contents" }, [el("button", { role: "checkbox", "aria-checked": String(checked) }, [])]);
    const root = el("div", {}, [
      el("ul", {}, [el("li", {}, [box(true), el("span", {}, ["Completed task"])]), el("li", {}, [box(false), el("span", {}, ["Pending task"])])])
    ]);
    expect(render(root)).toBe("- [x] Completed task\n- [ ] Pending task");
  });

  it("indents a nested list and honours an ordered list's start", () => {
    const root = el("div", {}, [
      el("ol", { start: "3" }, [el("li", {}, ["Third", el("ul", {}, [el("li", {}, ["detail"])])]), el("li", {}, ["Fourth"])])
    ]);
    expect(render(root)).toBe("3. Third\n   - detail\n4. Fourth");
  });

  it("writes math from its TeX source instead of the rendered glyphs", () => {
    const root = el("div", {}, [
      el("span", { "data-math-display": "true", "data-math-source": "x = \\frac{-b}{2a}" }, [el("span", { class: "katex-display" }, ["x", "=", "-b"])]),
      el("p", {}, ["This solves ", el("span", { "data-math-display": "false", "data-math-source": "ax^2 = 0" }, [el("span", { class: "katex" }, ["a", "x"])]), "."])
    ]);
    expect(render(root)).toBe("$$\nx = \\frac{-b}{2a}\n$$\n\nThis solves $ax^2 = 0$.");
  });

  it("fences a code block with its language and leaves the toolbar out", () => {
    const root = el("div", {}, [
      el("p", {}, ["Here it is."]),
      el("div", { "data-markdown-copy": "code-block" }, [
        el("div", { "data-markdown-copy": "exclude" }, [el("div", {}, ["Python"]), el("button", { "aria-label": "Run code" }, ["Run"])]),
        el("div", { class: "cm-content", "data-language": "python" }, [
          el("div", { class: "cm-line" }, ["def add(a, b):"]),
          el("div", { class: "cm-line" }, ["    return a + b"])
        ])
      ]),
      el("p", {}, ["Calling ", el("span", { "data-markdown-copy": "inline-code" }, ["add(2, 3)"]), " returns 5."])
    ]);
    expect(render(root)).toBe("Here it is.\n\n```python\ndef add(a, b):\n    return a + b\n```\n\nCalling `add(2, 3)` returns 5.");
  });

  it("reads a long code block from its editor, not just the lines on screen", () => {
    // Measured 2026-10-07: a 150-line code block came back with 36 lines -
    // CodeMirror renders only the lines in view - and nothing said so.
    const full = Array.from({ length: 150 }, (_, i) => `print(${i + 1})`).join("\n");
    const content = el("div", { class: "cm-content", "data-language": "python" }, [
      el("div", { class: "cm-line" }, ["print(1)"]),
      el("div", { class: "cm-line" }, ["print(2)"])
    ]) as FakeNode & { cmTile?: unknown };
    content.cmTile = { view: { state: { doc: { toString: () => full } } } };
    const root = el("div", {}, [el("div", { "data-markdown-copy": "code-block" }, [content])]);
    expect(render(root)).toBe("```python\n" + full + "\n```");
  });

  it("writes a table as markdown with pipes escaped", () => {
    const row = (tag: string, cells: string[]) => el("tr", {}, cells.map((cell) => el(tag, {}, [cell])));
    const root = el("div", {}, [el("table", {}, [el("thead", {}, [row("th", ["fruit", "color"])]), el("tbody", {}, [row("td", ["apple", "red"]), row("td", ["a|b", "green"])])])]);
    expect(render(root)).toBe("| fruit | color |\n| --- | --- |\n| apple | red |\n| a\\|b | green |");
  });

  it("spells out source pills: a web source as a link, a file source as a label", () => {
    const web = el("span", { "data-chatgpt-copy-reference": "0" }, [el("a", { href: "https://blog.rust-lang.org/x/" }, ["blog.rust-lang.org"])]);
    const file = el("span", { "data-chatgpt-copy-reference": "1" }, [el("button", { "aria-label": "cont-att" }, ["cont-att"])]);
    const root = el("div", {}, [el("p", {}, ["Rust 1.99.0 is current.", web]), el("p", {}, ["walnut-9 ", file, ", done"])]);
    expect(render(root)).toBe("Rust 1.99.0 is current. [blog.rust-lang.org](https://blog.rust-lang.org/x/)\n\nwalnut-9 [cont-att], done");
  });

  it("reads the renderer ChatGPT uses for web-search answers since 2026-10-10", () => {
    // Bold is a span[data-d-default-strong], and a source is a badge inside a
    // popover trigger whose urls only exist once it is opened. Both came back
    // as plain words: "Latest LTS: Node.js v24 ... Node.js downloads+1".
    const strong = (text: string) => el("span", { "data-d-component": "text", "data-d-default-strong": "", "data-d-inline": "" }, [text]);
    const badge = (label: string) =>
      el("span", { "data-d-component": "popover-trigger", role: "button" }, [
        el("span", { "data-d-component": "box" }, [el("div", { "data-pill": "", "data-d-component": "badge" }, [el("div", {}, [label])])])
      ]);
    const root = el("div", {}, [
      el("ol", { "data-d-component": "list" }, [
        el("li", { "data-d-component": "list-item" }, [
          el("div", {}, [el("p", { "data-d-component": "text" }, [strong("Latest LTS:"), " Node.js v24 is current.", badge("Node.js downloads+1")])])
        ])
      ])
    ]);
    expect(render(root)).toBe("1. **Latest LTS:** Node.js v24 is current. [Node.js downloads+1]");
  });

  it("falls back to the page text when nothing could be read", () => {
    expect(render(el("div", {}, []), "only what the page shows")).toBe("only what the page shows");
  });
});
