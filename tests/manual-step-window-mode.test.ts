import { describe, expect, it } from "vitest";

import { manualBrowserStepForWindowMode } from "../src/cli-pro.js";

// Measured with a signed-out profile started on a virtual display - the state
// an expired session leaves behind: `pro browser check` and every send, with
// and without --auto-login, reported login_required and told the caller to
// "Log in manually in the visible browser." prodex had started that browser
// itself with no window at all. The login command already knew the way out;
// the blocker a send or a check prints did not.
const commands = {
  headedLogin: "prodex pro browser login --port 9444 --headed",
  visibleRecovery: "prodex pro browser login --port 9444 --headed --recover-visible"
};
const loginRequired = { code: "login_required", message: "ChatGPT is asking you to log in.", next_step: "Log in manually in the visible browser." };

describe("a manual browser step when the browser has no window", () => {
  it("sends a virtual-display browser to a headed login instead of a window that does not exist", () => {
    const out = manualBrowserStepForWindowMode(loginRequired, { port: 9444, virtual_display: 99 }, 9444, commands);
    expect(out.next_step).toMatch(/virtual display/);
    expect(out.next_step).toContain(commands.headedLogin);
    expect(out.next_step).not.toMatch(/visible browser\.$/);
  });

  it("sends a headless browser through the guarded visible switch", () => {
    const out = manualBrowserStepForWindowMode(loginRequired, { port: 9444, headless: true }, 9444, commands);
    expect(out.next_step).toMatch(/headless/);
    expect(out.next_step).toContain(commands.visibleRecovery);
  });

  it("covers captcha and the Cloudflare check, which need the same hands", () => {
    for (const code of ["captcha_required", "cloudflare_check"]) {
      const out = manualBrowserStepForWindowMode({ ...loginRequired, code }, { port: 9444, virtual_display: 99 }, 9444, commands);
      expect(out.next_step).toContain(commands.headedLogin);
    }
  });

  it("leaves a headed browser's advice alone - there the window is real", () => {
    expect(manualBrowserStepForWindowMode(loginRequired, { port: 9444 }, 9444, commands)).toBe(loginRequired);
  });

  // A record for a different browser says nothing about this one.
  it("ignores a saved launch that belongs to another port", () => {
    expect(manualBrowserStepForWindowMode(loginRequired, { port: 9333, virtual_display: 99 }, 9444, commands)).toBe(loginRequired);
    expect(manualBrowserStepForWindowMode(loginRequired, undefined, 9444, commands)).toBe(loginRequired);
  });

  it("does not touch blockers a person cannot fix in the window", () => {
    const busy = { code: "response_in_progress", message: "busy", next_step: "Wait." };
    expect(manualBrowserStepForWindowMode(busy, { port: 9444, virtual_display: 99 }, 9444, commands)).toBe(busy);
  });
});

// Guidance embeds commands, and the CLI rewrites them to carry the caller's
// cwd and source build. The rewrite rebuilt only --port and dropped every other
// flag - measured: "`prodex pro browser login --background`" came out as a
// plain `login`, and "--headed" vanished from the step whose whole point is a
// window. Following that advice relaunched the browser in the mode it was
// telling the caller to leave.
describe("rewriting a command inside guidance", () => {
  it("keeps the flags it does not rebuild itself", async () => {
    const { sourceAwareBrowserNextStep } = await import("../src/cli-shared.js");
    expect(sourceAwareBrowserNextStep("Run `prodex pro browser login --background` to reopen it.", undefined, { cwd: "/repo" })).toBe(
      "Run `cd /repo && prodex pro browser login --background` to reopen it."
    );
    expect(sourceAwareBrowserNextStep("Run `prodex pro browser login --port 9444 --headed` now.", undefined, { cwd: "/repo" })).toBe(
      "Run `cd /repo && prodex pro browser login --port 9444 --headed` now."
    );
  });

  it("does not repeat --port, which it already rebuilds", async () => {
    const { flagsBesidesPort } = await import("../src/cli-shared.js");
    expect(flagsBesidesPort(" --port 9444 --headed --recover-visible")).toBe(" --headed --recover-visible");
    expect(flagsBesidesPort(" --port 9444")).toBe("");
    expect(flagsBesidesPort(undefined)).toBe("");
  });
});
