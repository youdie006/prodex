import { describe, expect, it } from "vitest";

import { modelMenuOptionsExpression } from "../src/chatgpt-browser.js";

// The listing was narrowed to radios because the current picker puts the power
// slider's own rows in as plain menuitems - its track, and the pair naming the
// live model and effort - which showed up as a model called "Extra High" and a
// duplicate GPT-6 Astra. But an earlier picker put the models behind submenu
// rows that are menuitems too, and dropping every menuitem empties the listing
// there. Both have to survive.
describe("listing the models in the picker", () => {
  const run = (rows: { role: string; text: string; haspopup?: string; checked?: boolean }[]) => {
    const items = rows.map((row) => ({
      innerText: row.text,
      textContent: row.text,
      getAttribute(name: string) {
        if (name === "role") return row.role;
        if (name === "aria-haspopup") return row.haspopup ?? null;
        if (name === "aria-checked") return row.checked ? "true" : "false";
        return null;
      }
    }));
    // Honour the selector, or the double cannot show what the query leaves out.
    const doc = {
      querySelector: () => ({
        querySelectorAll: (selector: string) => {
          const roles = selector.match(/role="([a-z]+)"/g)?.map((part) => part.slice(6, -1)) ?? [];
          return items.filter((item) => roles.includes(item.getAttribute("role") as string));
        }
      })
    };
    return new Function("document", `return ${modelMenuOptionsExpression()}`)(doc) as { label: string }[];
  };

  it("leaves out the slider's own rows", () => {
    const labels = run([
      { role: "menuitem", text: "GPT-6 Astra\nUltra" },
      { role: "menuitem", text: "" },
      { role: "menuitemradio", text: "Latest", checked: true },
      { role: "menuitemradio", text: "GPT-5.5" }
    ]).map((option) => option.label);
    expect(labels).toEqual(["Latest", "GPT-5.5"]);
  });

  it("still lists models that a picker keeps behind submenu rows", () => {
    const labels = run([
      { role: "menuitem", text: "Model\nGPT-5.6 Sol", haspopup: "menu" },
      { role: "menuitem", text: "Effort\nPro", haspopup: "menu" }
    ]).map((option) => option.label);
    expect(labels).toEqual(["Model", "Effort"]);
  });
});
