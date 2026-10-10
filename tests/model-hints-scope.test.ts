import { describe, expect, it } from "vitest";

import { CHATGPT_MODEL_HINTS_JS } from "../src/chatgpt-browser.js";
import { formatProConsultArtifact } from "../src/cli-pro.js";

// Measured 2026-10-07: model hints were every line of the whole page matching
// /GPT|Pro|.../i, so the saved answer of every consult listed sidebar project
// names ("prodex-smoke-project", "Projects"), conversation titles and the
// request marker - 179 saved answers in one test repo carried a project name.
function hints(options: { trigger?: string; forms?: string[] }): string[] {
  const document = {
    querySelector: () => (options.trigger === undefined ? null : { getAttribute: () => "Select ChatGPT model", innerText: options.trigger }),
    querySelectorAll: (selector: string) =>
      selector === "form" ? (options.forms ?? []).map((text) => ({ innerText: text, getClientRects: () => [{}] })) : []
  };
  return new Function("document", `${CHATGPT_MODEL_HINTS_JS}\n return modelHintLines();`)(document) as string[];
}

describe("model hints", () => {
  it("come from the model selector and the composer, not the sidebar", () => {
    const result = hints({ trigger: "Pro", forms: ["Ask anything\nExtended Pro\nAdd files and more"] });
    expect(result).toContain("Pro");
    expect(result).toContain("Extended Pro");
    expect(result.join("\n")).not.toMatch(/prodex-smoke-project|Projects|Select ChatGPT model/);
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
