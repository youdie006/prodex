import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { withBrowserSendLock } from "../src/browser-send-lock.js";

// Measured 2026-10-20 on M3: `prodex pro browser login --background` waited
// 5 s for the send lock while an MCP agent sent consults back to back, gave
// up, and told the user to "raise --timeout-ms" - an option login does not
// accept ("Unknown option for pro browser login: --timeout-ms").
describe("a send lock that stays busy", () => {
  const prior = process.env.PRODEX_SEND_LOCK_FILE;
  beforeEach(async () => {
    process.env.PRODEX_SEND_LOCK_FILE = path.join(await mkdtemp(path.join(tmpdir(), "prodex-lock-")), "browser-send.lock");
  });
  afterEach(() => {
    if (prior === undefined) delete process.env.PRODEX_SEND_LOCK_FILE;
    else process.env.PRODEX_SEND_LOCK_FILE = prior;
  });

  const busy = (flag?: string) =>
    withBrowserSendLock(60_000, () => {}, () =>
      flag === undefined
        ? withBrowserSendLock(50, () => {}, async () => "inner")
        : withBrowserSendLock(50, () => {}, async () => "inner", flag)
    );

  it("names --timeout-ms for a send, as before", async () => {
    await expect(busy()).rejects.toThrow(/raise --timeout-ms \(which is also the queue budget\)/);
  });

  it("names the flag of the command that waited", async () => {
    await expect(busy("--wait-timeout-ms")).rejects.toThrow(/raise --wait-timeout-ms/);
    await expect(busy("--wait-timeout-ms")).rejects.not.toThrow(/--timeout-ms \(/);
  });
});
