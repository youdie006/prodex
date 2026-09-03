import { describe, expect, it } from "vitest";

import { buildIssueReport } from "../src/issue-report.js";

const environment = { version: "0.36.5", platform: "linux", nodeVersion: "v22.22.0" };

// Bug reports from this project have been arriving as chat messages - a sibling
// session hit a broken picker three different ways and nothing was recorded
// anywhere. A blocked receipt already holds what a report needs (code, message,
// next_step), so the report is built from that rather than retyped.
describe("a bug report built from a blocked consult", () => {
  const blocked = {
    task_id: "task_20260903_024913_gpt-pro-consult",
    status: "blocked" as const,
    blocker: {
      code: "browser_send_failed",
      message: "model selector button not found",
      retryable: true,
      next_step: "Resolve the visible browser issue manually, then rerun the consult if needed."
    }
  };

  it("carries what someone would need to reproduce it", () => {
    const report = buildIssueReport(blocked, environment);
    expect(report.title).toContain("browser_send_failed");
    expect(report.title).toContain("model selector button not found");
    expect(report.body).toContain("0.36.5");
    expect(report.body).toContain("linux");
    expect(report.body).toContain("v22.22.0");
    expect(report.body).toContain("Resolve the visible browser issue manually");
    expect(report.labels).toContain("bug");
  });

  it("never carries the prompt or the answer", () => {
    // The failure is the report; the conversation is the user's. A public issue
    // must not become the place a private consult leaks.
    const report = buildIssueReport(
      {
        ...blocked,
        summary: "the assistant said something confidential",
        prompt: "our unreleased pricing model is ...",
        answer: "here is the analysis of your unreleased pricing"
      } as never,
      environment
    );
    expect(report.body).not.toMatch(/unreleased|confidential|pricing/i);
  });

  it("refuses a consult that did not fail, so nothing files a report about a success", () => {
    expect(() => buildIssueReport({ ...blocked, status: "done", blocker: undefined } as never, environment)).toThrow(/not a failure/i);
  });

  it("labels by area so triage does not start from scratch", () => {
    expect(buildIssueReport(blocked, environment).labels).toContain("area:browser");
    expect(
      buildIssueReport({ ...blocked, blocker: { ...blocked.blocker, code: "response_choice_pending" } }, environment).labels
    ).toContain("area:browser");
    expect(
      buildIssueReport({ ...blocked, blocker: { ...blocked.blocker, code: "bridge_store_corrupt" } }, environment).labels
    ).toContain("area:bridge");
  });
});
