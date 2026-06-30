import { describe, it, expect } from "vitest";

import { renderBanner } from "../src/banner.js";

describe("renderBanner", () => {
  it("renders a multi-line PROdex banner with the tagline and no ANSI by default", () => {
    const banner = renderBanner({ color: false });
    const lines = banner.split("\n");
    // ASCII art is at least 6 rows tall plus a tagline line
    expect(lines.length).toBeGreaterThanOrEqual(6);
    expect(banner.toLowerCase()).toContain("chatgpt pro");
    expect(banner).not.toContain("[");
  });

  it("colors the PRO block red (#BE1C1C) and resets when color is enabled", () => {
    const banner = renderBanner({ color: true });
    expect(banner).toContain("[38;2;190;28;28m");
    expect(banner).toContain("[0m");
  });

  it("renders the same ASCII rows regardless of color", () => {
    const stripAnsi = (s: string) => s.replace(/\[[0-9;]*m/g, "");
    expect(stripAnsi(renderBanner({ color: true }))).toBe(renderBanner({ color: false }));
  });
});
