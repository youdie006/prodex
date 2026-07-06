import { describe, expect, it } from "vitest";

import { readPositiveIntegerFlag, readPositiveNumberFlag } from "../src/cli-args.js";

describe("readPositiveIntegerFlag", () => {
  it("accepts positive integers", () => {
    expect(readPositiveIntegerFlag(["--timeout-ms", "300000"], "--timeout-ms")).toBe(300_000);
  });

  it("returns undefined when the flag is absent", () => {
    expect(readPositiveIntegerFlag([], "--timeout-ms")).toBeUndefined();
  });

  it("rejects zero and negatives", () => {
    expect(() => readPositiveIntegerFlag(["--timeout-ms", "0"], "--timeout-ms")).toThrow(/--timeout-ms/);
    expect(() => readPositiveIntegerFlag(["--timeout-ms", "-5"], "--timeout-ms")).toThrow(/--timeout-ms/);
  });

  it("rejects non-integer values instead of silently using fractional milliseconds", () => {
    // --wait-timeout-ms 1.5 previously meant a 1.5ms budget and an instant
    // "not ready" - a footgun, not a feature.
    expect(() => readPositiveIntegerFlag(["--wait-timeout-ms", "1.5"], "--wait-timeout-ms")).toThrow(
      /--wait-timeout-ms must be a positive integer/
    );
  });
});

describe("readPositiveNumberFlag", () => {
  it("still accepts fractional values for non-millisecond flags like --token-ttl-hours", () => {
    expect(readPositiveNumberFlag(["--token-ttl-hours", "0.5"], "--token-ttl-hours")).toBe(0.5);
  });
});
