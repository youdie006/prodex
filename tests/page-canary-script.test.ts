import { describe, expect, it } from "vitest";

import { judgePageCanary, PAGE_CANARY_EXPRESSION, settledPageFacts } from "../scripts/page-canary.mjs";

type PageCanaryFacts = Parameters<typeof judgePageCanary>[0];

// The shape measured on ChatGPT build 36d7890c on 2026-10-08, on a
// conversation page with nine sidebar projects.
const healthy: PageCanaryFacts = {
  build: "36d7890c",
  pageKind: "conversation",
  composer: { editor: true, inForm: true },
  modelButton: true,
  toolsButton: true,
  generalFileInput: true,
  sidebar: { projectRows: 9, rowsWithLabelAndId: 9, createProject: true, newChatInButtons: 9, projectActions: 9 },
  messages: { user: 1, assistant: 1, selectionIds: 1, userBubbles: 1 },
  markdown: { copyKinds: ["code-block", "contents", "exclude"] }
};

describe("judging the page canary", () => {
  it("passes the measured healthy page", () => {
    expect(judgePageCanary(healthy, healthy)).toMatchObject({ status: "ok", failures: [], changes: [] });
  });

  it("reports a new build whose controls still hold as changed, not broken", () => {
    const verdict = judgePageCanary(healthy, { ...healthy, build: "8089c0e4" });
    expect(verdict).toMatchObject({ status: "changed", buildChanged: true, failures: [] });
    expect(verdict.changes[0]?.detail).toBe("8089c0e4 -> 36d7890c");
  });

  it("reports a markdown marker never seen before, as blank-lines appeared on 2026-10-08", () => {
    const verdict = judgePageCanary({ ...healthy, markdown: { copyKinds: ["blank-lines", ...healthy.markdown.copyKinds] } }, healthy, healthy.markdown.copyKinds);
    expect(verdict.status).toBe("changed");
    expect(verdict.changes.map((c) => c.detail)).toEqual(["new: blank-lines"]);
  });

  it("reports a new answer renderer, as data-d-component appeared on 2026-10-10", () => {
    const verdict = judgePageCanary({ ...healthy, markdown: { copyKinds: [...healthy.markdown.copyKinds, "renderer:data-d-component"] } }, healthy, healthy.markdown.copyKinds);
    expect(verdict.changes.map((c) => c.detail)).toEqual(["new: renderer:data-d-component"]);
  });

  it("judges the build ChatGPT serves now, not the one an idle tab still shows", () => {
    // Measured 2026-10-10: the tab kept 4c511f80 for hours while 314720d0 was served.
    const previous = { ...healthy, build: "4c511f80", liveBuild: "4c511f80" };
    const verdict = judgePageCanary({ ...healthy, build: "4c511f80", liveBuild: "314720d0" }, previous);
    expect(verdict.status).toBe("changed");
    expect(verdict.changes.map((c) => c.check)).toEqual(["build", "stale tab"]);
    expect(verdict.changes[0]?.detail).toBe("4c511f80 -> 314720d0");
  });

  it("does not flag markers that only depend on which answer is on screen", () => {
    // Measured: a short answer shows only "contents"; the page before showed a
    // code block. Compared run to run, that read as a new marker every time.
    const short = { ...healthy, markdown: { copyKinds: ["contents"] } };
    const known = ["code-block", "contents", "exclude"];
    expect(judgePageCanary(short, healthy, known).status).toBe("ok");
    expect(judgePageCanary(healthy, short, known).status).toBe("ok");
  });

  it("fails on a missing composer control", () => {
    const verdict = judgePageCanary({ ...healthy, modelButton: false, generalFileInput: false });
    expect(verdict.status).toBe("broken");
    expect(verdict.failures.map((f) => f.check)).toEqual(["model selector", "file input"]);
  });

  it("fails when project rows lose their attributes or controls, as on 2026-09-29", () => {
    const verdict = judgePageCanary({ ...healthy, sidebar: { ...healthy.sidebar, rowsWithLabelAndId: 0, newChatInButtons: 0 } });
    expect(verdict.failures.map((f) => f.check)).toEqual(["project rows", "project entry"]);
  });

  it("fails when project rows that existed are gone, but not for an account without projects", () => {
    const none = { ...healthy, sidebar: { ...healthy.sidebar, projectRows: 0, rowsWithLabelAndId: 0, newChatInButtons: 0, projectActions: 0 } };
    expect(judgePageCanary(none, healthy).failures.map((f) => f.check)).toEqual(["project rows"]);
    expect(judgePageCanary(none, none).status).toBe("ok");
  });

  it("fails on a conversation page whose turns cannot be read, but does not judge turns on the root", () => {
    const unreadable = { ...healthy, messages: { user: 0, assistant: 0, selectionIds: 0, userBubbles: 0 } };
    expect(judgePageCanary(unreadable).failures.map((f) => f.check)).toEqual(["message units"]);
    expect(judgePageCanary({ ...unreadable, pageKind: "root" }).status).toBe("ok");
  });

  it("is a single expression that parses", () => {
    expect(() => new Function(`return ${PAGE_CANARY_EXPRESSION};`)).not.toThrow();
  });
});

// Measured 2026-10-10: the first run right after the browser restarted
// reported "broken: model selector" because the composer had not rendered
// yet; the next run was ok. The hourly job files an issue on broken, so a
// failing read is read again after a pause before it counts.
describe("reading a settled page", () => {
  const unrendered: PageCanaryFacts = { ...healthy, modelButton: false };
  const isBroken = (facts: PageCanaryFacts) => judgePageCanary(facts, undefined, undefined).status === "broken";
  const reader = (sequence: PageCanaryFacts[]) => {
    let reads = 0;
    return { read: async () => sequence[Math.min(reads++, sequence.length - 1)], reads: () => reads };
  };
  const pauses: number[] = [];
  const sleep = async (ms: number) => { pauses.push(ms); };

  it("reads once when the page is healthy", async () => {
    const page = reader([healthy]);
    expect(await settledPageFacts(page.read, isBroken, { attempts: 3, waitMs: 10, sleep })).toBe(healthy);
    expect(page.reads()).toBe(1);
  });

  it("does not report a page that was still rendering", async () => {
    const page = reader([unrendered, healthy]);
    expect(await settledPageFacts(page.read, isBroken, { attempts: 3, waitMs: 10, sleep })).toBe(healthy);
    expect(page.reads()).toBe(2);
  });

  it("still reports a control that stays missing", async () => {
    const page = reader([unrendered]);
    expect(await settledPageFacts(page.read, isBroken, { attempts: 3, waitMs: 10, sleep })).toBe(unrendered);
    expect(page.reads()).toBe(3);
  });
});
