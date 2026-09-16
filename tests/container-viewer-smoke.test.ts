import { describe, expect, it } from "vitest";

import {
  assertSafePageTargets,
  buildMarkerExpression,
  parseContainerViewerSmokeOptions
} from "../scripts/container-viewer-smoke.mjs";

describe("container viewer smoke options", () => {
  it.each([
    [["--seed"], { mode: "seed" }],
    [["--verify"], { mode: "verify" }]
  ] as const)("parses %j", (args, expected) => {
    expect(parseContainerViewerSmokeOptions([...args])).toEqual(expected);
  });

  it.each([
    [],
    ["--seed", "--verify"],
    ["--seed", "--unknown"],
    ["seed"]
  ].map(args => ({ args })))("rejects unsupported arguments: $args", ({ args }) => {
    expect(() => parseContainerViewerSmokeOptions(args)).toThrow(/exactly one|unknown option|unexpected argument/i);
  });
});

describe("container viewer smoke page safety", () => {
  it("allows only blank, owned fixture, and sandbox page targets", () => {
    expect(() => assertSafePageTargets([
      { id: "blank", type: "page", url: "about:blank" },
      { id: "fixture", type: "page", url: "http://127.0.0.1:39455/" },
      { id: "sandbox", type: "page", url: "chrome://sandbox/" },
      { id: "worker", type: "service_worker", url: "https://example.invalid/worker.js" }
    ])).not.toThrow();
  });

  it.each([
    "https://chatgpt.com/",
    "http://127.0.0.1:39455/not-owned",
    "chrome://settings/"
  ])("refuses an unsafe existing page before mutation: %s", (url) => {
    expect(() => assertSafePageTargets([{ id: "unsafe", type: "page", url }])).toThrow(/refus.*existing page/i);
  });
});

describe("container viewer smoke persistence expressions", () => {
  it("writes the synthetic marker only in seed mode", () => {
    const expression = buildMarkerExpression("seed");

    expect(expression).toMatch(/localStorage\.setItem/);
    expect(expression).toMatch(/localStorage\.clear/);
  });

  it("only reads the expected marker in verify mode", () => {
    const expression = buildMarkerExpression("verify");

    expect(expression).toMatch(/localStorage\.getItem/);
    expect(expression).not.toMatch(/localStorage\.(?:setItem|clear|removeItem)/);
  });
});
