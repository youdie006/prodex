import { describe, expect, it } from "vitest";

import { buildBlockerReport } from "../src/blocker-report.js";
import { formatBlockerReport, readSinceFlag } from "../src/cli-pro.js";

// Half of every consult on this machine ends in a blocker, and until now the
// only way to ask WHICH failure dominates was an ad-hoc script: `pro list`
// reads a single repo, and the registry that knows where the other 235 are had
// no reader. Counting raw codes is not enough either - browser_send_failed is
// a catch-all holding 165 of 267 blockers, so a report that stops at the code
// says "the catch-all is biggest" and names nothing to fix.

const consult = (
  code: string | undefined,
  message: string,
  createdAt: string,
  repo = "alpha"
) => ({
  repo,
  createdAt,
  ...(code ? { blocker: { code, message } } : {})
});

describe("ranking what actually blocks consults", () => {
  const consults = [
    consult("send_timeout", "The answer did not arrive in time.", "2026-09-08T01:00:00Z"),
    consult("send_timeout", "The answer did not arrive in time.", "2026-09-08T02:00:00Z"),
    consult("send_timeout", "The answer did not arrive in time.", "2026-09-08T03:00:00Z"),
    consult("response_in_progress", "The tab is busy.", "2026-09-08T04:00:00Z", "beta"),
    consult(undefined, "", "2026-09-08T05:00:00Z"),
    consult(undefined, "", "2026-09-08T06:00:00Z")
  ];

  it("counts the consults it read and how many of them were blocked", () => {
    const report = buildBlockerReport({ consults, roots: 2 });
    expect(report.totalConsults).toBe(6);
    expect(report.blocked).toBe(4);
    expect(report.roots).toBe(2);
  });

  it("ranks causes by how often they happen, with a share of the blocked", () => {
    const report = buildBlockerReport({ consults, roots: 2 });
    expect(report.groups[0]?.code).toBe("send_timeout");
    expect(report.groups[0]?.count).toBe(3);
    expect(report.groups[0]?.share).toBeCloseTo(0.75);
    expect(report.groups[1]?.code).toBe("response_in_progress");
  });

  it("remembers when a cause was last seen", () => {
    const report = buildBlockerReport({ consults, roots: 2 });
    expect(report.groups[0]?.lastSeen).toBe("2026-09-08T03:00:00Z");
  });

  it("has nothing to rank when nothing was blocked", () => {
    const report = buildBlockerReport({ consults: [consult(undefined, "", "2026-09-08T01:00:00Z")], roots: 1 });
    expect(report.blocked).toBe(0);
    expect(report.groups).toEqual([]);
  });
});

describe("splitting the catch-all code so the report names something fixable", () => {
  const consults = [
    consult("browser_send_failed", 'ChatGPT\'s model picker has no "Pro" step. It showed: Instant, 1 of 5.', "2026-09-08T01:00:00Z"),
    consult("browser_send_failed", 'ChatGPT\'s model picker has no "GPT-5.6 Sol" step. It showed: Instant, 1 of 5.', "2026-09-08T02:00:00Z"),
    consult("browser_send_failed", 'ChatGPT composer did not rebind after entering project "<project>"', "2026-09-08T03:00:00Z")
  ];

  it("groups the same failure written with different names together", () => {
    const report = buildBlockerReport({ consults, roots: 1 });
    const picker = report.groups.find((g) => /has no/.test(g.code));
    expect(picker?.count).toBe(2);
  });

  it("keeps a genuinely different failure apart, under the same code", () => {
    const report = buildBlockerReport({ consults, roots: 1 });
    expect(report.groups).toHaveLength(2);
    expect(report.groups.every((g) => g.code.startsWith("browser_send_failed"))).toBe(true);
  });

  it("does not split a code that already names its cause", () => {
    const report = buildBlockerReport({
      consults: [
        consult("send_timeout", "Timed out after 300000ms waiting for the answer.", "2026-09-08T01:00:00Z"),
        consult("send_timeout", "Timed out after 900000ms waiting for the answer.", "2026-09-08T02:00:00Z")
      ],
      roots: 1
    });
    expect(report.groups).toHaveLength(1);
    expect(report.groups[0]?.code).toBe("send_timeout");
  });
});

describe("asking whether a fix landed", () => {
  const consults = [
    consult("send_timeout", "old", "2026-09-01T00:00:00Z"),
    consult("send_timeout", "old", "2026-09-02T00:00:00Z"),
    consult("picker_not_responding", "new", "2026-09-08T00:00:00Z")
  ];

  it("counts only what happened inside the window", () => {
    const report = buildBlockerReport({ consults, roots: 1, since: "2026-09-05T00:00:00Z" });
    expect(report.totalConsults).toBe(1);
    expect(report.blocked).toBe(1);
    expect(report.groups[0]?.code).toBe("picker_not_responding");
  });

  it("keeps every consult when no window is given", () => {
    expect(buildBlockerReport({ consults, roots: 1 }).totalConsults).toBe(3);
  });
});

describe("keeping the report readable", () => {
  it("shows only the top causes but still counts them all", () => {
    const consults = ["a", "b", "c", "d"].flatMap((code, i) =>
      Array.from({ length: 4 - i }, (_, n) => consult(code, `${code} failed`, `2026-09-0${n + 1}T00:00:00Z`))
    );
    const report = buildBlockerReport({ consults, roots: 1, limit: 2 });
    expect(report.groups).toHaveLength(2);
    expect(report.groups.map((g) => g.code)).toEqual(["a", "b"]);
    expect(report.blocked).toBe(10);
  });

  it("carries one example per cause, so the reader knows what it looks like", () => {
    const report = buildBlockerReport({
      consults: [consult("send_timeout", "The answer did not arrive in time.", "2026-09-08T01:00:00Z")],
      roots: 1
    });
    expect(report.groups[0]?.example).toBe("The answer did not arrive in time.");
  });

  // Live on this machine: one cause held a pre-fix failure quoting a model name
  // and a current one quoting "Pro", and the row printed the OLD wording beside
  // the NEW timestamp. Read as a fix that had not landed, on evidence a week
  // older than the date next to it.
  it("shows the wording of the failure it dates itself by", () => {
    const report = buildBlockerReport({
      consults: [
        consult("browser_send_failed", 'picker has no "GPT-5.6 Sol" step.', "2026-08-25T00:00:00Z"),
        consult("browser_send_failed", 'picker has no "Pro" step.', "2026-09-08T00:00:00Z")
      ],
      roots: 1
    });
    expect(report.groups[0]?.count).toBe(2);
    expect(report.groups[0]?.lastSeen).toBe("2026-09-08T00:00:00Z");
    expect(report.groups[0]?.example).toBe('picker has no "Pro" step.');
  });

  it("keeps the one example it has when a later record carries no date", () => {
    const report = buildBlockerReport({
      consults: [
        consult("send_timeout", "Timed out after 15 min.", "2026-09-08T00:00:00Z"),
        { repo: "alpha", blocker: { code: "send_timeout", message: "" } }
      ],
      roots: 1
    });
    expect(report.groups[0]?.example).toBe("Timed out after 15 min.");
  });
});

// --- the command's own helpers -------------------------------------------

describe("reading the window flag", () => {
  it("takes an age, because that is how you ask whether a fix landed", () => {
    const sevenDays = readSinceFlag(["--since", "7d"]);
    const hours = (Date.now() - Date.parse(sevenDays!)) / 3_600_000;
    expect(hours).toBeGreaterThan(167);
    expect(hours).toBeLessThan(169);
    const oneDay = readSinceFlag(["--since", "24h"]);
    expect((Date.now() - Date.parse(oneDay!)) / 3_600_000).toBeCloseTo(24, 0);
  });

  it("takes a plain date too", () => {
    expect(readSinceFlag(["--since", "2026-09-01"])).toBe("2026-09-01T00:00:00.000Z");
  });

  it("is absent when not asked for", () => {
    expect(readSinceFlag([])).toBeUndefined();
  });

  it("refuses something it cannot read as a time", () => {
    expect(() => readSinceFlag(["--since", "last tuesday"])).toThrow(/7d or 24h/);
  });
});

describe("laying the report out", () => {
  const report = {
    totalConsults: 10,
    blocked: 4,
    roots: 3,
    groups: [
      { code: "send_timeout", count: 3, share: 0.75, lastSeen: "2026-09-08T01:00:00Z", example: "Timed out.", repos: ["alpha"] },
      {
        code: 'browser_send_failed: picker has no "..." step',
        count: 1,
        share: 0.25,
        lastSeen: "2026-09-07T01:00:00Z",
        example: 'picker has no "Pro" step. It showed: Instant',
        repos: ["beta"]
      }
    ]
  };

  it("leads with how much of the whole is blocked", () => {
    expect(formatBlockerReport(report)).toContain("4 of 10 consults (40%) across 3 bridge roots");
  });

  it("does not repeat the cause as its own example", () => {
    const lines = formatBlockerReport(report).split("\n");
    const split = lines.find((line) => line.includes('has no "..."'));
    expect(split).not.toContain("It showed");
  });

  it("keeps the example where the code alone says nothing", () => {
    expect(formatBlockerReport(report)).toContain("Timed out.");
  });

  it("says so plainly when nothing was blocked", () => {
    expect(formatBlockerReport({ totalConsults: 3, blocked: 0, roots: 1, groups: [] })).toContain("Nothing was blocked");
  });

  it("says so when there is nothing to report at all", () => {
    expect(formatBlockerReport({ totalConsults: 0, blocked: 0, roots: 0, groups: [] })).toMatch(/No consults recorded/);
  });
});
