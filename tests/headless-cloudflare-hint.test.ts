import { describe, expect, it } from "vitest";

import { headlessCloudflareHint } from "../src/cli-pro.js";

// Measured 2026-10-20 on M3: after a visible sign-in, `login --background`
// handed the profile to headless Chrome, which reported
// "HeadlessChrome/155.0.0.0" and an 800x600 screen and sat on Cloudflare's
// "Just a moment" page. The failure said only to inspect the headless
// failure; the way out (a virtual display, or the container on macOS) went
// unsaid.
describe("a headless handoff stopped by Cloudflare", () => {
  it("points Linux at the virtual display", () => {
    const hint = headlessCloudflareHint("cloudflare_check", "linux");
    expect(hint).toMatch(/HeadlessChrome/);
    expect(hint).toMatch(/--virtual-display/);
  });

  it("points macOS at the browser container", () => {
    const hint = headlessCloudflareHint("cloudflare_check", "darwin");
    expect(hint).toMatch(/container/);
    expect(hint).not.toMatch(/--virtual-display/);
  });

  it("says nothing for other blockers", () => {
    expect(headlessCloudflareHint("login_required", "darwin")).toBeUndefined();
    expect(headlessCloudflareHint(undefined, "linux")).toBeUndefined();
  });
});
