import { describe, expect, it } from "vitest";

import { ProvenanceSchema } from "../src/schema.js";
import { formatAskedFor, redactSelectionForRecord } from "../src/cli-pro.js";

// Mined from the ledger on this machine: all 57 recorded send_timeout blockers
// carry no selection at all, because it was only ever written into the ANSWER
// receipt and a timeout never writes one. So the ledger cannot answer the first
// question anyone asks of a timeout - was this a Pro run, and was the budget
// right for it - which is the question the budgets themselves depend on.
describe("what a record says was asked for", () => {
  it("has somewhere to keep the selection", () => {
    const parsed = ProvenanceSchema.parse({
      adapter: "chatgpt-control",
      selection: { model: "Pro", effort: "높음" }
    });
    expect(parsed.selection).toEqual({ model: "Pro", effort: "높음" });
  });

  it("still accepts a record from before it had one", () => {
    expect(ProvenanceSchema.parse({ adapter: "cli" }).selection).toBeUndefined();
  });

  // Records cross the MCP boundary, so the project name is scrubbed there the
  // same way it is scrubbed out of a blocker's text - and nothing else is,
  // because the model and the effort are what makes the record worth keeping.
  it("scrubs the project and keeps the rest", () => {
    const recorded = redactSelectionForRecord(
      { project: "Ledger", model: "Pro", effort: "높음" },
      (text) => text.split("Ledger").join("<project>")
    );
    expect(recorded).toEqual({ project: "<project>", model: "Pro", effort: "높음" });
  });

  it("scrubs a created project's name too", () => {
    const recorded = redactSelectionForRecord({ project_new: "Ledger" }, (text) => text.split("Ledger").join("<project>"));
    expect(recorded).toEqual({ project_new: "<project>" });
  });
});

// The selection is recorded so a person reading a timeout can see what it was
// for on the same screen as the budget it used up. `pro show` printed the
// budget and not the request until this line existed.
describe("showing what was asked for", () => {
  it("names each axis that was set, in a fixed order", () => {
    expect(formatAskedFor({ effort: "\ub192\uc74c", project: "<project>", model: "Pro" })).toBe(
      "asked_for: model=Pro effort=\ub192\uc74c project=<project>"
    );
  });

  it("prints nothing for a send that pinned nothing", () => {
    expect(formatAskedFor(undefined)).toBeUndefined();
    expect(formatAskedFor({})).toBeUndefined();
  });
});
