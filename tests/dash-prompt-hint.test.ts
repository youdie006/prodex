import { describe, expect, it } from "vitest";

import { unknownOptionError } from "../src/cli-args.js";

// Measured 2026-10-20: `prodex pro browser ask "-5 + 3, what is it?"` failed
// with only "Unknown option: -5 + 3, what is it?". A prompt that starts with a
// dash is read as an option; `--` before it is the way to send it.
describe("an unknown option that is really a prompt", () => {
  it("says to put -- before it when it holds spaces", () => {
    expect(unknownOptionError("-5 + 3, what is it?", undefined, ["--file"]).message).toBe(
      'Unknown option: -5 + 3, what is it?. If this is the prompt, put `--` before it: prodex ask -- "-5 + 3, what is it?"'
    );
  });

  it("says so for a dash word that cannot be a flag", () => {
    expect(unknownOptionError("-5", undefined, ["--file"]).message).toContain("put `--` before it");
  });

  it("keeps the plain suggestion for a mistyped flag", () => {
    expect(unknownOptionError("--fil", undefined, ["--file"]).message).toBe("Unknown option: --fil. Did you mean `--file`?");
  });
});
