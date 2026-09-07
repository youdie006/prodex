import { describe, expect, it } from "vitest";

import * as browser from "../src/chatgpt-browser.js";

// These functions build JavaScript that is sent to the page and evaluated
// there. A comment written with "\n" in it does not stay a comment: the
// template literal turns the escape into a real newline, so the rest of the
// sentence becomes code. That shipped once and every `pro browser models` run
// died with a bare "Runtime.evaluate failed", which names neither the
// expression nor the syntax error.
describe("expressions sent to the page", () => {
  const builders = Object.entries(browser).filter(
    ([name, value]) => /Expression$/.test(name) && typeof value === "function"
  ) as [string, (...args: never[]) => string][];

  it("finds the builders to check", () => {
    expect(builders.length).toBeGreaterThan(5);
  });

  it.each(builders)("%s parses as JavaScript", (name, build) => {
    // Builders that take arguments get a plausible label; the point is the
    // surrounding syntax, not the value.
    const source = build.length === 0 ? build() : (build as (arg: string) => string)("Extra High");
    expect(() => new Function(`return ${source}`)).not.toThrow();
  });
});
