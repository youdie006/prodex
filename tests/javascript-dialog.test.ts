import { describe, expect, it } from "vitest";

import { javascriptDialogResponse } from "../src/picker-interaction.js";

// A JavaScript dialog stops the page's main thread, and every Runtime.evaluate
// then waits forever. Measured against the live browser: with a dialog open an
// evaluate never returns, Page.enable itself never returns, and a client that
// did not enable the Page domain BEFORE the dialog appeared is told "no dialog
// is showing" when it tries to dismiss one - so there is no recovery after the
// fact, only prevention. prodex surfaced this as "Chrome DevTools command timed
// out: Runtime.enable", which names neither the cause nor the cure.
describe("answering a JavaScript dialog", () => {
  it("accepts the one prodex's own navigation raises", () => {
    // beforeunload is the page asking whether to leave. prodex asked to leave,
    // so dismissing it would block the navigation it just requested.
    expect(javascriptDialogResponse("beforeunload")).toEqual({ accept: true });
  });

  it("declines anything the page asked for on its own", () => {
    // Accepting an arbitrary confirm() presses a button in someone's real
    // session; getting out of the way is enough to unblock the thread.
    for (const type of ["alert", "confirm", "prompt"]) {
      expect(javascriptDialogResponse(type)).toEqual({ accept: false });
    }
  });

  it("declines a type it has never heard of", () => {
    expect(javascriptDialogResponse("something-new")).toEqual({ accept: false });
    expect(javascriptDialogResponse(undefined)).toEqual({ accept: false });
  });
});
