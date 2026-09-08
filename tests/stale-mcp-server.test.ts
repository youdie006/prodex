import { describe, expect, it } from "vitest";

import { staleServerWarning, withServerVersionNotice } from "../src/mcp-tools.js";

// A consult was served by an MCP server that had been running since the middle
// of the previous month. Node reads a module once, at startup, so installing a
// newer prodex does not change what an already-running server executes - and
// nothing said so. Three servers on one machine were serving code that predated
// two releases of fixes, and the fixes looked like they had not worked.
describe("telling a caller its MCP server is older than what is installed", () => {
  it("says nothing when the running server is the installed one", () => {
    expect(staleServerWarning({ running: "0.39.4", installed: "0.39.4" })).toBeUndefined();
  });

  it("says nothing when either version cannot be read", () => {
    expect(staleServerWarning({ running: "0.39.4" })).toBeUndefined();
    expect(staleServerWarning({ installed: "0.39.4" })).toBeUndefined();
    expect(staleServerWarning({})).toBeUndefined();
  });

  it("names both versions and says a restart is what picks the new one up", () => {
    const warning = staleServerWarning({ running: "0.39.1", installed: "0.39.4" });
    expect(warning).toMatch(/^server_outdated:/);
    expect(warning).toContain("0.39.1");
    expect(warning).toContain("0.39.4");
    expect(warning).toMatch(/restart/i);
  });
});

describe("carrying that warning back on a consult result", () => {
  it("puts it in front of the warnings the consult already had", () => {
    const result = withServerVersionNotice({ status: "done", warnings: ["dialog_answered: ..."] }, "server_outdated: x");
    expect(result).toMatchObject({
      status: "done",
      warnings: ["server_outdated: x", "dialog_answered: ..."]
    });
  });

  it("adds a warnings list to a result that had none", () => {
    expect(withServerVersionNotice({ status: "done" }, "server_outdated: x")).toMatchObject({
      status: "done",
      warnings: ["server_outdated: x"]
    });
  });

  it("leaves the result alone when there is nothing to say", () => {
    const result = { status: "done" as const };
    expect(withServerVersionNotice(result, undefined)).toBe(result);
  });

  it("never turns a result it cannot extend into one", () => {
    expect(withServerVersionNotice("plain text", "server_outdated: x")).toBe("plain text");
    expect(withServerVersionNotice(null, "server_outdated: x")).toBeNull();
  });
});
