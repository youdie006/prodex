import { describe, expect, it } from "vitest";

import { looksLikeBinaryFileContent } from "../src/bundle.js";

// `--file` inlines a file's text into the prompt and `--attach` uploads the
// file itself. Pointing --file at a binary used to inline the bytes: measured,
// `--file` on an executable produced a preview carrying an ELF header and NUL
// bytes inside a text fence - 535 control bytes out of 798 - which costs
// tokens, answers nothing, and pushes control characters through the composer
// and the prompt-identity check that guards against reading another
// conversation's answer.
describe("telling a file worth inlining from one worth uploading", () => {
  it("catches a binary by the NUL bytes no source file has", () => {
    expect(looksLikeBinaryFileContent("\u007fELF\u0002\u0001\u0001\u0000\u0000")).toBe(true);
  });

  it("catches a binary whose bytes decoded as replacement characters", () => {
    expect(looksLikeBinaryFileContent("\ufffd\ufffd\ufffd\ufffd\ufffdabc")).toBe(true);
  });

  it("leaves ordinary source alone, tabs and newlines included", () => {
    const source = "function main() {\n\tconst x = 1;\r\n\treturn `a ${x}`;\n}\n";
    expect(looksLikeBinaryFileContent(source)).toBe(false);
  });

  it("leaves text in any language alone", () => {
    expect(looksLikeBinaryFileContent("\ud55c\uae00 \ubb38\uc11c\uc785\ub2c8\ub2e4.\n\uc22b\uc790 12345.\n")).toBe(false);
  });

  it("does not call an empty file binary", () => {
    expect(looksLikeBinaryFileContent("")).toBe(false);
  });
});
