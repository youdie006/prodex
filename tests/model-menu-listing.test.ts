import { describe, expect, it } from "vitest";

import { formatModelMenuOption, modelMenuOptionsExpression } from "../src/chatgpt-browser.js";

// Read off the live composer: the picker no longer lists models. It has three
// rows - Advanced, "Model" showing GPT-5.6 Sol, and "Effort" showing Pro - and
// the two that matter open a submenu. The listing read only each row's first
// line, so it printed the word "Model" with no hint of what the model IS, and
// then called both rows "not selectable via --model yet". Measured against that
// same UI: --model Pro, --effort 즉시 and --pro-mode 확장 all selected fine,
// because selection walks into the submenu. The listing was telling the user
// the opposite of what the tool does.
describe("what `pro browser models` reports", () => {
  it("names what a submenu row is currently set to", () => {
    expect(formatModelMenuOption({ label: "Model", kind: "submenu", checked: false, value: "GPT-5.6 Sol" })).toBe(
      "  Model  ->  GPT-5.6 Sol"
    );
    expect(formatModelMenuOption({ label: "Effort", kind: "submenu", checked: false, value: "Pro" })).toBe("  Effort  ->  Pro");
  });

  it("no longer calls a submenu row unselectable", () => {
    const line = formatModelMenuOption({ label: "Effort", kind: "submenu", checked: false, value: "Pro" });
    expect(line).not.toMatch(/not selectable/i);
  });

  it("leaves a plain row alone, and marks the checked one", () => {
    expect(formatModelMenuOption({ label: "Advanced", kind: "radio", checked: false })).toBe("  Advanced");
    expect(formatModelMenuOption({ label: "Pro", kind: "radio", checked: true })).toBe("* Pro");
  });

  it("says nothing extra when a submenu row does not show a value", () => {
    expect(formatModelMenuOption({ label: "Model", kind: "submenu", checked: false })).toBe("  Model");
  });

  it("asks the page for that second line", () => {
    expect(modelMenuOptionsExpression()).toContain("value");
  });
});
