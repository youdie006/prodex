import { describe, it, expect } from "vitest";

import { findRipgrep } from "../src/repo.js";

describe("findRipgrep", () => {
  it("returns the rg path from a PATH directory", () => {
    expect(findRipgrep({ PATH: "/x/bin:/y/bin" }, (p) => p === "/y/bin/rg")).toBe("/y/bin/rg");
  });

  it("falls back to common install locations when PATH has no rg", () => {
    expect(findRipgrep({ PATH: "/x/bin" }, (p) => p === "/usr/local/bin/rg")).toBe("/usr/local/bin/rg");
  });

  it("prefers PATH over the fallback locations", () => {
    // rg exists both in a PATH dir and in /usr/bin; PATH wins
    expect(findRipgrep({ PATH: "/y/bin" }, (p) => p === "/y/bin/rg" || p === "/usr/bin/rg")).toBe("/y/bin/rg");
  });

  it("returns bare 'rg' as a last resort when nothing is found", () => {
    expect(findRipgrep({ PATH: "/x/bin" }, () => false)).toBe("rg");
  });
});
