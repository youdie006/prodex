import path from "node:path";
import { describe, it, expect } from "vitest";

import { findRipgrep } from "../src/repo.js";

describe("findRipgrep", () => {
  it("returns the rg path from a PATH directory", () => {
    const executable = process.platform === "win32" ? "rg.exe" : "rg";
    const firstDir = path.join(path.parse(process.cwd()).root, "x", "bin");
    const secondDir = path.join(path.parse(process.cwd()).root, "y", "bin");
    const expected = path.join(secondDir, executable);

    expect(
      findRipgrep({ PATH: [firstDir, secondDir].join(path.delimiter) }, (candidate) => candidate === expected)
    ).toBe(expected);
  });

  it("falls back to a user install location when PATH has no rg", () => {
    const executable = process.platform === "win32" ? "rg.exe" : "rg";
    const root = path.parse(process.cwd()).root;
    const pathDir = path.join(root, "x", "bin");
    const home = path.join(root, "users", "tester");
    const expected = path.join(home, ".cargo", "bin", executable);

    expect(findRipgrep({ PATH: pathDir, HOME: home }, (candidate) => candidate === expected)).toBe(expected);
  });

  it("prefers PATH over the fallback locations", () => {
    const executable = process.platform === "win32" ? "rg.exe" : "rg";
    const root = path.parse(process.cwd()).root;
    const pathDir = path.join(root, "y", "bin");
    const home = path.join(root, "users", "tester");
    const expected = path.join(pathDir, executable);
    const fallback = path.join(home, ".cargo", "bin", executable);

    expect(
      findRipgrep({ PATH: pathDir, HOME: home }, (candidate) => candidate === expected || candidate === fallback)
    ).toBe(expected);
  });

  it("returns bare 'rg' as a last resort when nothing is found", () => {
    expect(findRipgrep({ PATH: "/x/bin" }, () => false)).toBe("rg");
  });
});
