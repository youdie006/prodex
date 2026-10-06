import { describe, expect, it, vi } from "vitest";

import { attachFilesToComposer, markComposerFileInputExpression, PRODEX_ATTACH_INPUT_ATTRIBUTE } from "../src/chatgpt-browser.js";

// A project home keeps a hidden copy of an earlier page mounted, with its own
// complete composer form ahead of the visible one (measured 2026-10-06). A
// file set on the hidden form's input never reaches the composer, so the
// attachment waited out its whole upload budget.
function composerWithForm(size: { width: number; height: number }) {
  const input = { attributes: new Map<string, string>(), setAttribute(name: string, value: string) { this.attributes.set(name, value); } };
  const form = { tagName: "FORM", querySelectorAll: () => [], querySelector: () => input };
  const composer = {
    getBoundingClientRect: () => size,
    parentElement: { closest: () => null },
    closest: (selector: string) => (selector === "form" ? form : null)
  };
  return { composer, input };
}

function mark(composers: unknown[]): boolean {
  const document = {
    readyState: "complete",
    querySelector: () => null,
    querySelectorAll: (selector: string) => (selector.includes(PRODEX_ATTACH_INPUT_ATTRIBUTE) ? [] : composers)
  };
  return new Function("document", `return ${markComposerFileInputExpression()};`)(document) as boolean;
}

describe("marking the attachment input", () => {
  it("tags the file input of the visible composer's form, not the hidden copy before it", () => {
    const hidden = composerWithForm({ width: 0, height: 0 });
    const visible = composerWithForm({ width: 420, height: 48 });
    expect(mark([hidden.composer, visible.composer])).toBe(true);
    expect(visible.input.attributes.get(PRODEX_ATTACH_INPUT_ATTRIBUTE)).toBe("1");
    expect(hidden.input.attributes.size).toBe(0);
  });

  it("reports false when no visible composer is on the page", () => {
    const hidden = composerWithForm({ width: 0, height: 0 });
    expect(mark([hidden.composer])).toBe(false);
  });
});

describe("attaching while the composer is still hydrating", () => {
  it("waits for the visible composer's file input instead of failing at once", async () => {
    vi.useFakeTimers();
    try {
      // Measured: a loaded page showed its editor 2 s before the file inputs.
      let markPolls = 0;
      const queried: string[] = [];
      const cdp = {
        send: async (method: string, params: { selector?: string } = {}) => {
          if (method === "DOM.getDocument") return { result: { root: { nodeId: 1 } } };
          if (method === "DOM.querySelector") {
            queried.push(params.selector ?? "");
            return { result: { nodeId: params.selector?.includes(PRODEX_ATTACH_INPUT_ATTRIBUTE) ? 7 : 0 } };
          }
          return { result: {} };
        },
        evaluate: async (expression: string) => {
          if (expression.includes(PRODEX_ATTACH_INPUT_ATTRIBUTE) && expression.includes("setAttribute")) {
            markPolls += 1;
            return markPolls >= 3;
          }
          if (expression.includes("removed:")) return { ok: true, removed: 0 };
          return { ok: true, present: ["probe.txt"], uploading: false };
        }
      };
      const attaching = attachFilesToComposer(cdp as never, ["/tmp/probe.txt"], { timeoutMs: 5_000 });
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(attaching).resolves.toEqual({ attached: ["probe.txt"] });
      expect(markPolls).toBe(3);
      expect(queried[0]).toBe(`[${PRODEX_ATTACH_INPUT_ATTRIBUTE}]`);
    } finally {
      vi.useRealTimers();
    }
  });
});
