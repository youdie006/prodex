import { describe, it, expect } from "vitest";

import { renderBanner, shouldColorize } from "../src/banner.js";

describe("renderBanner", () => {
  it("renders a multi-line PROdex banner with the tagline and no ANSI by default", () => {
    const banner = renderBanner({ color: false });
    const lines = banner.split("\n");
    // ASCII art is at least 6 rows tall plus a tagline line
    expect(lines.length).toBeGreaterThanOrEqual(6);
    expect(banner.toLowerCase()).toContain("chatgpt pro");
    expect(banner).not.toContain("[");
  });

  it("colors the PRO block red (#BE1C1C) and resets when color is enabled", () => {
    const banner = renderBanner({ color: true });
    expect(banner).toContain("[38;2;190;28;28m");
    expect(banner).toContain("[0m");
  });

  it("renders the same ASCII rows regardless of color", () => {
    const stripAnsi = (s: string) => s.replace(/\[[0-9;]*m/g, "");
    expect(stripAnsi(renderBanner({ color: true }))).toBe(renderBanner({ color: false }));
  });
});

describe("shouldColorize", () => {
  it("disables color for NO_COLOR with any non-empty value", () => {
    expect(shouldColorize({ NO_COLOR: "1" }, true)).toBe(false);
    expect(shouldColorize({ NO_COLOR: "0" }, true)).toBe(false);
  });

  it("disables color when FORCE_COLOR is 0 even on a TTY", () => {
    expect(shouldColorize({ FORCE_COLOR: "0" }, true)).toBe(false);
  });

  it("forces color when FORCE_COLOR is set truthy on a non-TTY", () => {
    expect(shouldColorize({ FORCE_COLOR: "1" }, false)).toBe(true);
  });

  it("falls back to TTY when neither NO_COLOR nor FORCE_COLOR is set", () => {
    expect(shouldColorize({}, true)).toBe(true);
    expect(shouldColorize({}, false)).toBe(false);
  });
});
