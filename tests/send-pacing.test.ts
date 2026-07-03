import { describe, it, expect } from "vitest";

import { computeSendPacingWaitMs, resolveMinSendIntervalMs, DEFAULT_MIN_SEND_INTERVAL_MS } from "../src/cli-shared.js";

describe("computeSendPacingWaitMs", () => {
  it("does not wait for the first send (no previous timestamp)", () => {
    expect(computeSendPacingWaitMs(undefined, 1_000_000, 10_000)).toBe(0);
  });

  it("waits the remaining interval when the previous send was recent", () => {
    expect(computeSendPacingWaitMs(1_000_000, 1_003_000, 10_000)).toBe(7_000);
  });

  it("does not wait once the interval has fully elapsed", () => {
    expect(computeSendPacingWaitMs(1_000_000, 1_015_000, 10_000)).toBe(0);
  });

  it("does not wait when pacing is disabled (interval 0)", () => {
    expect(computeSendPacingWaitMs(1_000_000, 1_000_100, 0)).toBe(0);
  });

  it("does not wait on backwards clock skew or a corrupt marker", () => {
    expect(computeSendPacingWaitMs(2_000_000, 1_000_000, 10_000)).toBe(0);
    expect(computeSendPacingWaitMs(Number.NaN, 1_000_000, 10_000)).toBe(0);
  });
});

describe("resolveMinSendIntervalMs", () => {
  it("defaults when the env var is unset or blank", () => {
    expect(resolveMinSendIntervalMs({})).toBe(DEFAULT_MIN_SEND_INTERVAL_MS);
    expect(resolveMinSendIntervalMs({ PRODEX_MIN_SEND_INTERVAL_MS: "  " })).toBe(DEFAULT_MIN_SEND_INTERVAL_MS);
  });

  it("honors an explicit override, including 0 to disable", () => {
    expect(resolveMinSendIntervalMs({ PRODEX_MIN_SEND_INTERVAL_MS: "0" })).toBe(0);
    expect(resolveMinSendIntervalMs({ PRODEX_MIN_SEND_INTERVAL_MS: "25000" })).toBe(25_000);
  });

  it("falls back to the default on a nonsense value", () => {
    expect(resolveMinSendIntervalMs({ PRODEX_MIN_SEND_INTERVAL_MS: "-5" })).toBe(DEFAULT_MIN_SEND_INTERVAL_MS);
    expect(resolveMinSendIntervalMs({ PRODEX_MIN_SEND_INTERVAL_MS: "abc" })).toBe(DEFAULT_MIN_SEND_INTERVAL_MS);
  });
});
