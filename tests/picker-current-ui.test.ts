import { describe, expect, it } from "vitest";
import {
  menuOpenExpression, menuClosedExpression, powerSliderPresentExpression,
  focusPowerSliderExpression, powerSliderStateExpression, modelMenuOptionsExpression
} from "../src/chatgpt-browser.js";

function fixture() {
  let active: unknown;
  const triggerAttrs: Record<string, string> = { "aria-expanded": "true", "aria-controls": "current-menu" };
  const menuAttrs: Record<string, string> = { role: "menu", "aria-labelledby": "current-trigger" };
  const owner = { getAttribute: (key: string) => key === "role" ? "menuitem" : null, closest: () => null, focus: () => { active = owner; } };
  const slider = {
    getAttribute: (key: string) => ({ "aria-hidden": "true", "aria-valuenow": "3", "aria-valuemin": "0", "aria-valuemax": "4" }[key] ?? null),
    closest: () => owner,
    focus: () => { /* Hidden thumb cannot receive browser focus. */ }
  };
  const item = (role: string, text: string, checked = false) => ({
    innerText: text, textContent: text, contains: () => false,
    getAttribute: (key: string) => ({ role, "aria-checked": String(checked) }[key] ?? null)
  });
  const menu = {
    id: "current-menu", innerText: "Extra High\nLatest\nGPT-5.6 Sol",
    getAttribute: (key: string) => menuAttrs[key] ?? null,
    contains: (node: unknown) => node === slider || node === owner,
    querySelector: (selector: string) => selector.includes('role="slider"') ? slider : null,
    querySelectorAll: () => [item("menuitem", "Extra High"), item("menuitemradio", "Latest", true), item("menuitemradio", "GPT-5.6 Sol")]
  };
  const trigger = {
    id: "current-trigger", offsetWidth: 120, offsetHeight: 40,
    getAttribute: (key: string) => triggerAttrs[key] ?? null,
    getClientRects: () => [{}]
  };
  const stray = { focus: () => { active = stray; }, getAttribute: () => "9" };
  const triggers = [trigger];
  const document = {
    querySelector: (selector: string) => selector === '[role="slider"]' ? stray : null,
    querySelectorAll: (selector: string) => selector.includes('role="menu"') ? [menu] : triggers,
    getElementById: (id: string) => id === menu.id ? menu : null,
    get activeElement() { return active; }
  };
  return { document, triggerAttrs, menuAttrs, triggers, owner };
}

function evaluate(expression: string, document: unknown): unknown {
  return new Function("document", `return ${expression}`)(document);
}

describe("current picker without the retired test id", () => {
  it("recognizes only the menu linked to the actual model trigger", () => {
    const f = fixture();
    expect(evaluate(menuOpenExpression(), f.document)).toBe(true);
    expect(evaluate(menuClosedExpression(), f.document)).toBe(false);
    expect(evaluate(powerSliderPresentExpression(), f.document)).toBe(true);
    expect(evaluate(modelMenuOptionsExpression(), f.document)).toEqual([
      { label: "Latest", kind: "radio", checked: true },
      { label: "GPT-5.6 Sol", kind: "radio", checked: false }
    ]);
  });

  it("focuses the keyboard owner instead of the hidden slider thumb", () => {
    const f = fixture();
    expect(evaluate(focusPowerSliderExpression(), f.document)).toEqual({ ok: true });
    expect(f.document.activeElement).toBe(f.owner);
    expect(evaluate(powerSliderStateExpression(), f.document)).toMatchObject({ ok: true, position: 3, model: "Latest", effort: "Extra High" });
  });

  it("refuses unrelated menus, closed triggers and ambiguous triggers", () => {
    const f = fixture();
    f.menuAttrs["aria-labelledby"] = "other-trigger";
    expect(evaluate(menuOpenExpression(), f.document)).toBe(false);
    expect(evaluate(focusPowerSliderExpression(), f.document)).toMatchObject({ ok: false });
    f.menuAttrs["aria-labelledby"] = "current-trigger";
    f.triggerAttrs["aria-expanded"] = "false";
    expect(evaluate(menuOpenExpression(), f.document)).toBe(false);
    f.triggerAttrs["aria-expanded"] = "true";
    f.triggers.push(f.triggers[0]!);
    expect(evaluate(menuOpenExpression(), f.document)).toBe(false);
  });

  it("never reads or focuses a document-wide stray slider when the picker is absent", () => {
    const f = fixture();
    f.triggers.length = 0;
    expect(evaluate(powerSliderStateExpression(), f.document)).toMatchObject({ ok: false });
    expect(evaluate(focusPowerSliderExpression(), f.document)).toMatchObject({ ok: false });
  });
});
