import { describe, expect, it } from "vitest";

import { chatSurfaceRecoveryPlan } from "../src/chatgpt-browser.js";
import { chatSurfaceChoice, chatSurfaceState, surfaceFromProbe } from "../src/picker-interaction.js";

// ChatGPT grew a Chat/Work toggle, and the two surfaces have different model
// pickers. Measured on one account within minutes of each other:
//
//   Chat: Latest / GPT-5.6 Sol / GPT-5.5, slider Instant..Pro, Pro at 5 of 5
//   Work: Default / GPT-6 Astra / Sol / Terra / Luna / GPT-5.5,
//         slider Light..Ultra, no Pro anywhere in the picker
//
// The dedicated browser had drifted onto Work, so prodex was driving a picker
// that has no Pro at all while the person asking for Pro was looking at Chat.
// Nothing announced the difference: both surfaces have a composer and a slider.
describe("choosing which ChatGPT surface to drive", () => {
  it("stays put when Chat is already the active one", () => {
    expect(
      chatSurfaceChoice([
        { label: "Chat", checked: true },
        { label: "Work", checked: false }
      ])
    ).toBe("already-chat");
  });

  it("switches back when the browser has drifted onto Work", () => {
    expect(
      chatSurfaceChoice([
        { label: "Chat", checked: false },
        { label: "Work", checked: true }
      ])
    ).toBe("switch-to-chat");
  });

  it("switches when nothing claims to be selected rather than guessing", () => {
    expect(
      chatSurfaceChoice([
        { label: "Chat", checked: false },
        { label: "Work", checked: false }
      ])
    ).toBe("switch-to-chat");
  });

  it("does nothing where the toggle does not exist", () => {
    // Older builds, and every page that predates the split.
    expect(chatSurfaceChoice([])).toBe("no-toggle");
    expect(chatSurfaceChoice([{ label: "Work", checked: true }])).toBe("no-toggle");
  });
});

// The toggle only exists on the home screen. Threads and project pages carry no
// trace of it, yet they keep whichever surface was chosen - which is how a send
// into a project ended up on Work's picker with the toggle nowhere in sight.
// The choice is persisted where any page can read it:
//   localStorage["oai/apps/tpp/chat-surface-mode"] = "work"
//   cookie oai-chat-surface-mode=work
describe("knowing the surface where the toggle is not rendered", () => {
  it("believes the visible toggle over the stored value", () => {
    expect(chatSurfaceState({ storedMode: "work", surfaces: [{ label: "Chat", checked: true }] })).toBe("already-chat");
    expect(chatSurfaceState({ storedMode: "chat", surfaces: [{ label: "Chat", checked: false }] })).toBe("switch-to-chat");
  });

  it("falls back to the stored value on pages without a toggle", () => {
    expect(chatSurfaceState({ storedMode: "work", surfaces: [] })).toBe("switch-to-chat");
    expect(chatSurfaceState({ storedMode: "chat", surfaces: [] })).toBe("already-chat");
  });

  it("reads the value however it was quoted", () => {
    // localStorage holds it JSON-encoded; the cookie holds it bare.
    expect(chatSurfaceState({ storedMode: '"work"', surfaces: [] })).toBe("switch-to-chat");
    expect(chatSurfaceState({ storedMode: "WORK", surfaces: [] })).toBe("switch-to-chat");
  });

  it("says nothing when there is neither a toggle nor a stored value", () => {
    expect(chatSurfaceState({ surfaces: [] })).toBe("unknown");
    expect(chatSurfaceState({ storedMode: "", surfaces: [] })).toBe("unknown");
  });

  it("does not treat a value it does not recognise as Work", () => {
    // "null", or a mode that does not exist yet, is not a reason to rewrite the
    // preference and reload the page on every send.
    expect(chatSurfaceState({ storedMode: "null", surfaces: [] })).toBe("unknown");
    expect(chatSurfaceState({ storedMode: '"focus"', surfaces: [] })).toBe("unknown");
  });
});

// A listing taken on a thread or project page found no toggle and said nothing
// about the surface, though the persisted choice - what the app itself reads
// on those pages - was in the same probe.
describe("naming the surface a listing was read from", () => {
  it("prefers the drawn toggle", () => {
    expect(surfaceFromProbe({ surfaces: [{ label: "Chat", checked: false }, { label: "Work", checked: true }], storedMode: '"chat"' })).toBe("Work");
  });

  it("falls back to the persisted choice where no toggle is drawn", () => {
    expect(surfaceFromProbe({ surfaces: [], storedMode: '"chat"' })).toBe("Chat");
    expect(surfaceFromProbe({ storedMode: "work" })).toBe("Work");
  });

  it("says nothing for a value it does not recognise", () => {
    expect(surfaceFromProbe({ surfaces: [], storedMode: "null" })).toBeUndefined();
    expect(surfaceFromProbe(undefined)).toBeUndefined();
  });
});

// Threads and project pages render no surface toggle, so the switch is made by
// writing the app's stored preference and loading a document that reads it.
// Reloading in place is the obvious way and the wrong one on a project home:
// measured on two different projects, every hard load of one comes back as
// ChatGPT's error page. The tab is then on a document with no sidebar, and the
// project step that follows reports the project missing from a sidebar that was
// never drawn - a broken reload wearing the costume of a missing project.
describe("applying the stored surface where no toggle exists", () => {
  it("opens the root instead of reloading a project home, when the send is leaving anyway", () => {
    expect(
      chatSurfaceRecoveryPlan({ href: "https://chatgpt.com/g/g-p-000000/project", mayLeaveCurrentPage: true })
    ).toBe("fresh-root");
  });

  // A continuation or a pinned tab has no destination other than the page it is
  // already on, so leaving it loses the send. The reload may fail there; going
  // somewhere else fails for certain.
  it("reloads in place when that page is the destination", () => {
    expect(
      chatSurfaceRecoveryPlan({ href: "https://chatgpt.com/g/g-p-000000/project", mayLeaveCurrentPage: false })
    ).toBe("reload");
  });

  it("reloads a thread, which is not the page that fails to load", () => {
    expect(chatSurfaceRecoveryPlan({ href: "https://chatgpt.com/c/abc-123", mayLeaveCurrentPage: true })).toBe("reload");
    expect(chatSurfaceRecoveryPlan({ href: "https://chatgpt.com/", mayLeaveCurrentPage: true })).toBe("reload");
  });
});
