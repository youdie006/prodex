import { beforeEach, describe, expect, it } from "vitest";

const keys = ["PRODEX_BRIDGES_REGISTRY", "PRODEX_SEND_LOCK_FILE", "PRODEX_LAST_LOGIN_FILE"] as const;
const isolated = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

describe.sequential("persistent-state test isolation", () => {
  it("can exercise callers that remove an environment override", () => {
    for (const key of keys) {
      expect(isolated[key]).toBeTruthy();
      delete process.env[key];
    }
  });

  it("restores every state override before the next test", () => {
    for (const key of keys) expect(process.env[key]).toBe(isolated[key]);
  });

  describe("an explicit per-test fixture", () => {
    beforeEach(() => { process.env.PRODEX_LAST_LOGIN_FILE = "/tmp/explicit-isolation-fixture.json"; });
    it("can still select its own isolated launch record", () => {
      expect(process.env.PRODEX_LAST_LOGIN_FILE).toBe("/tmp/explicit-isolation-fixture.json");
    });
  });
});
