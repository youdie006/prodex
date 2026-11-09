import { describe, expect, it } from "vitest";

import { CHATGPT_MODEL_HINTS_JS } from "../src/chatgpt-browser.js";
import { formatProConsultArtifact } from "../src/cli-pro.js";

// Measured 2026-10-07: model hints were every line of the whole page matching
// /GPT|Pro|.../i, so the saved answer of every consult listed sidebar project
// names ("prodex-smoke-project", "Projects"), conversation titles and the
// request marker - 179 saved answers in one test repo carried a project name.
//
// Measured 2026-11-03 in the browser container: a new chat leaves the home
// page's composer mounted but hidden ahead of the conversation's, and an
// "Edit message" editor is a visible form inside the user turn. Both are on
// the page next to the real composer.
type Fake = Record<string, unknown>;

const TRIGGER = 'button[aria-label="Select ChatGPT model"]';

function node(opts: { text?: string; visible?: boolean; inMessage?: boolean; form?: Fake | null }): Fake {
  return {
    innerText: opts.visible === false ? (opts.text ?? "").replace(/\n/g, "") : opts.text ?? "",
    getClientRects: () => (opts.visible === false ? [] : [{}]),
    parentElement: { closest: () => (opts.inMessage ? {} : null) },
    closest: (selector: string) => (selector === "form" ? opts.form ?? null : null)
  };
}

function composer(opts: { trigger: string; typed?: string; formLines?: string[]; visible?: boolean; inMessage?: boolean }) {
  const form: Fake = {};
  const lines = [opts.typed, ...(opts.formLines ?? []), opts.trigger].filter((line) => line !== undefined && line !== "");
  Object.assign(form, node({ text: lines.join("\n"), visible: opts.visible, inMessage: opts.inMessage }));
  const editor = node({ text: opts.typed ?? "", visible: opts.visible, inMessage: opts.inMessage, form });
  const trigger = opts.trigger ? node({ text: opts.trigger, visible: opts.visible, inMessage: opts.inMessage, form }) : undefined;
  return { form, editor, trigger };
}

function hints(composers: ReturnType<typeof composer>[]): string[] {
  const document = {
    querySelector: (selector: string) => (selector.includes(TRIGGER) ? composers.find((c) => c.trigger)?.trigger ?? null : null),
    querySelectorAll: (selector: string) =>
      selector.includes(TRIGGER)
        ? composers.flatMap((c) => (c.trigger ? [c.trigger] : []))
        : selector === "form"
          ? composers.map((c) => c.form)
          : selector.includes("contenteditable")
            ? composers.map((c) => c.editor)
            : []
  };
  return new Function("document", `${CHATGPT_MODEL_HINTS_JS}\n return modelHintLines();`)(document) as string[];
}

describe("model hints", () => {
  it("come from the model selector and the composer, not the sidebar", () => {
    const result = hints([composer({ trigger: "Pro", formLines: ["Ask anything", "Extended Pro", "Add files and more"] })]);
    expect(result).toContain("Pro");
    expect(result).toContain("Extended Pro");
    expect(result.join("\n")).not.toMatch(/prodex-smoke-project|Projects|Select ChatGPT model/);
  });

  it("read the composer's model trigger", () => {
    expect(hints([composer({ trigger: "Thinking effort\nPro" })])).toEqual(["Thinking effort", "Pro"]);
  });

  it("leave out the prompt of a message open for editing", () => {
    const editing = composer({ trigger: "", typed: "Use the latest Pro plan\nKeep it high level", inMessage: true });
    expect(hints([editing, composer({ trigger: "Thinking effort\nPro" })])).toEqual(["Thinking effort", "Pro"]);
  });

  it("read the visible composer, not a hidden one ahead of it", () => {
    const hidden = composer({ trigger: "Instant", visible: false });
    expect(hints([hidden, composer({ trigger: "Thinking effort\nPro" })])).toEqual(["Thinking effort", "Pro"]);
  });

  it("leave out text typed into the composer", () => {
    expect(hints([composer({ trigger: "Pro", typed: "Pick Auto if unsure" })])).toEqual(["Pro"]);
  });

  it("are filtered again when an answer is saved", () => {
    const artifact = formatProConsultArtifact({
      url: "https://chatgpt.com/c/x",
      title: "A title",
      answer: "answer",
      modelHints: ["ChatGPT", "Projects", "prodex-smoke-project", "[prodex-request:" + "a".repeat(32) + "]", "Pro"],
      warnings: []
    } as never);
    expect(artifact).toContain("- Pro");
    expect(artifact).not.toMatch(/prodex-smoke-project|Projects|prodex-request/);
  });
});
