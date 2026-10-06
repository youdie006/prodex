import { describe, expect, it, vi } from "vitest";

import {
  activeComposerToolsExpression,
  composerToolEntryRectExpression,
  composerToolMenuTexts,
  composerToolsButtonRectExpression,
  enableComposerTools
} from "../src/chatgpt-browser.js";

// Measured 2026-10-06: a create-image send reached the tools step while the
// page still showed only its server-rendered editor, and failed at once with
// "composer tools button not found: the composer has not rendered".
describe("opening the composer tools on a page that is still hydrating", () => {
  it("waits for the tools button instead of failing on the first look", async () => {
    vi.useFakeTimers();
    try {
      const label = "Create image";
      let buttonLooks = 0;
      let entryClicked = false;
      let clicks = 0;
      const cdp = {
        send: async (method: string) => {
          if (method === "Input.dispatchMouseEvent") clicks += 1;
          return { result: {} };
        },
        evaluate: async (expression: string) => {
          // This branch hover-verifies a click point before pressing.
          if (expression.includes("elementFromPoint")) return true;
          if (expression === composerToolsButtonRectExpression()) {
            buttonLooks += 1;
            return buttonLooks < 3 ? { ok: false, reason: "composer tools button not found: the composer has not rendered" } : { ok: true, x: 10, y: 10 };
          }
          if (expression === composerToolEntryRectExpression(label)) {
            entryClicked = true;
            return { ok: true, x: 20, y: 20 };
          }
          if (expression === activeComposerToolsExpression(composerToolMenuTexts(label))) {
            return { active: entryClicked && clicks >= 4 ? [label] : [] };
          }
          return undefined;
        }
      };
      const enabling = enableComposerTools(cdp as never, [label]);
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(enabling).resolves.toEqual([label]);
      expect(buttonLooks).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clicks the tools button again when the first click came before it worked", async () => {
    // Measured: the button was found, clicked and no menu opened, and the
    // send was refused as "the composer tools menu has no Create image".
    vi.useFakeTimers();
    try {
      const label = "Create image";
      let buttonClicks = 0;
      let entryClicked = false;
      let lastPoint = "";
      const cdp = {
        send: async (method: string, params: { type?: string; x?: number; y?: number } = {}) => {
          if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed") {
            lastPoint = `${params.x},${params.y}`;
            if (lastPoint === "10,10") buttonClicks += 1;
            if (lastPoint === "20,20") entryClicked = true;
          }
          return { result: {} };
        },
        evaluate: async (expression: string) => {
          // This branch hover-verifies a click point before pressing.
          if (expression.includes("elementFromPoint")) return true;
          if (expression === composerToolsButtonRectExpression()) return { ok: true, x: 10, y: 10 };
          if (expression === composerToolEntryRectExpression(label)) {
            return buttonClicks >= 2 ? { ok: true, x: 20, y: 20 } : { ok: false, available: ["Chat", "Work"] };
          }
          if (expression === activeComposerToolsExpression(composerToolMenuTexts(label))) {
            return { active: entryClicked ? [label] : [] };
          }
          return undefined;
        }
      };
      const enabling = enableComposerTools(cdp as never, [label]);
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(enabling).resolves.toEqual([label]);
      expect(buttonClicks).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
