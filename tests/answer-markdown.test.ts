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

  it("reads a code block kept in its source element, with a fence longer than any backtick run inside", () => {
    // Measured 2026-10-19 on build bfc3a09a: a markdown block has no <pre>;
    // its text sits in [data-code-block-source] <code>. The whole block's text
    // was used instead, so the toolbar's "Markdown" leaked into the code, and
    // the three-backtick fence was closed early by the ``` inside it.
    const root = el("div", {}, [
      el("div", { "data-markdown-copy": "code-block", "data-code-block": "true" }, [
        el("div", { "data-markdown-copy": "exclude" }, [el("div", {}, ["Markdown"]), el("button", { "aria-label": "Copy code" }, [])]),
        el("div", { "data-code-block-source": "true" }, [el("code", {}, [el("span", {}, ['```js\nconst s = "nested";\n```'])])])
      ])
    ]);
    expect(render(root)).toBe('````markdown\n```js\nconst s = "nested";\n```\n````');
  });

  it("keeps a mermaid diagram as its source, or says it was there", () => {
    // Measured 2026-10-21 on build 9e0e8636: a mermaid block is drawn as an
    // SVG preview ([data-chatgpt-mermaid-preview]) whose only text is the
    // toolbar and the node labels, so the saved answer lost it entirely. The
    // source lives in the React props of the preview's fiber ancestors.
    const preview = el("div", { "data-chatgpt-mermaid-preview": "" }, [
      el("div", { "data-markdown-copy": "exclude" }, []),
      el("div", { "data-code-block-preview-pane": "mermaid" }, ["A B C"])
    ]) as FakeNode & Record<string, unknown>;
    preview.__reactFiber$x = { memoizedProps: {}, return: { memoizedProps: { content: "flowchart TD\n    A --> B --> C" }, return: null } };
    expect(render(el("div", {}, [el("p", {}, ["Before."]), preview, el("p", {}, ["After."])]))).toBe(
      "Before.\n\n```mermaid\nflowchart TD\n    A --> B --> C\n```\n\nAfter."
    );

    const unreadable = el("div", { "data-chatgpt-mermaid-preview": "" }, [
      el("div", { "data-code-block-preview-pane": "mermaid" }, ["A B C"])
    ]);
    expect(render(el("div", {}, [unreadable]))).toBe("[mermaid diagram - open the thread to see its source]");
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

// Measured 2026-10-28: ChatGPT's newer answer renderer puts a paragraph's text
// in word spans under white-space: pre-line, so a single newline inside a
// paragraph shows on screen as a line break. Collapsing it like ordinary HTML
// whitespace returned "alpha beta" for an answer showing alpha and beta on two
// lines, and a whole multi-line answer as one line.
describe("line breaks the page shows", () => {
  const preLine = { style: "white-space: pre-line" };

  it("keeps a newline inside a pre-line paragraph", () => {
    const root = el("div", {}, [el("p", preLine, [el("span", {}, ["alpha\n"]), el("span", {}, ["beta"])])]);
    expect(render(root)).toBe("alpha\nbeta");
  });

  it("keeps them when the pre-line style is set on an ancestor", () => {
    const root = el("div", preLine, [
      el("p", {}, [el("span", {}, ["Pros:  \n"]), el("span", {}, ["fast\n"]), el("span", {}, ["cheap"])]),
      el("ul", {}, [el("li", {}, ["one\ntwo"])])
    ]);
    expect(render(root)).toBe("Pros:\nfast\ncheap\n\n- one\ntwo");
  });

  it("keeps a blank line between paragraphs held in one pre-line block", () => {
    // The shape measured live: "Heading\n\n" and the next words in spans.
    const root = el("div", preLine, [el("p", {}, [el("span", {}, ["Heading\n\n"]), el("span", {}, ["Inline "]), el("span", {}, ["text"])])]);
    expect(render(root)).toBe("Heading\n\nInline text");
  });

  it("still collapses source whitespace where the page does", () => {
    const root = el("div", {}, [el("p", {}, ["word\n   wrapped  in\tsource"])]);
    expect(render(root)).toBe("word wrapped in source");
  });
});

// Measured 2026-10-28: ChatGPT's link component appends utm_source=chatgpt.com
// to every link it renders. An answer whose source linked
// "https://example.com/page" came back as "https://example.com/page?utm_source=chatgpt.com",
// a url the model never wrote; "?id=3&q=x" became "?id=3&q=x&utm_source=chatgpt.com"
// and "/b#sec" became "/b?utm_source=chatgpt.com#sec".
describe("links ChatGPT tagged for tracking", () => {
  const linked = (href: string, label: string) => el("div", {}, [el("p", {}, [el("a", { href }, [label])])]);

  it("drops the parameter ChatGPT appended", () => {
    expect(render(linked("https://example.com/page?utm_source=chatgpt.com", "example"))).toBe("[example](https://example.com/page)");
    expect(render(linked("https://example.com/?utm_source=chatgpt.com", "four"))).toBe("[four](https://example.com/)");
  });

  it("keeps the rest of the query and the fragment", () => {
    expect(render(linked("https://example.com/a?id=3&q=x+y&utm_source=chatgpt.com", "one"))).toBe("[one](https://example.com/a?id=3&q=x+y)");
    expect(render(linked("https://example.com/b?utm_source=chatgpt.com#sec", "two"))).toBe("[two](https://example.com/b#sec)");
  });

  it("leaves a link alone when its utm_source is anything else", () => {
    expect(render(linked("https://example.com/c?utm_source=newsletter", "three"))).toBe("[three](https://example.com/c?utm_source=newsletter)");
    expect(render(linked("https://example.com/c?x=utm_source=chatgpt.com", "five"))).toBe("[five](https://example.com/c?x=utm_source=chatgpt.com)");
  });

  it("drops it from a source pill's link as well", () => {
    const web = el("span", { "data-chatgpt-copy-reference": "0" }, [el("a", { href: "https://blog.rust-lang.org/x/?utm_source=chatgpt.com" }, ["blog.rust-lang.org"])]);
    expect(render(el("div", {}, [el("p", {}, ["Rust is current.", web])]))).toBe("Rust is current. [blog.rust-lang.org](https://blog.rust-lang.org/x/)");
  });
});
