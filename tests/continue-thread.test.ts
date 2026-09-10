import { describe, expect, it } from "vitest";

import { chatGptProjectSlug, resolveContinuationThread, threadMatchesProject } from "../src/continue-thread.js";

// "Continue" used to mean "whatever thread the shared tab is showing". Measured
// on a machine with a default project pinned: two consecutive consults into one
// project landed in two DIFFERENT /c/ threads, because entering a project
// navigates away from the tab before every send - while the tool description
// promised follow-ups stayed in one conversation. The follow-up answered
// correctly anyway, from ChatGPT's project memory, which is how nobody noticed.
const thread = (id: string, project?: string) =>
  project
    ? `https://chatgpt.com/g/g-p-6a46dda35eb48191a041e0c70b24195d-${project}/c/${id}`
    : `https://chatgpt.com/c/${id}`;

describe("which conversation a follow-up belongs to", () => {
  const consults = [
    { taskId: "task_a", thread: thread("aaa", "notes"), status: "done", createdAt: "2026-09-08T00:00:00Z" },
    { taskId: "task_b", thread: thread("bbb"), status: "done", createdAt: "2026-09-09T00:00:00Z" },
    { taskId: "task_c", thread: thread("ccc", "notes"), status: "done", createdAt: "2026-09-10T00:00:00Z" }
  ];

  it("continues the newest finished consult of this project", () => {
    const resolved = resolveContinuationThread({ consults, project: "notes" });
    expect("target" in resolved && resolved.target.taskId).toBe("task_c");
  });

  // A follow-up for the general chat must not walk into a project, and a
  // project's follow-up must not answer in another project's conversation.
  it("keeps a projectless follow-up out of every project", () => {
    const resolved = resolveContinuationThread({ consults });
    expect("target" in resolved && resolved.target.taskId).toBe("task_b");
  });

  it("refuses rather than guessing when this project has no thread yet", () => {
    const resolved = resolveContinuationThread({ consults, project: "ledger" });
    expect("error" in resolved && resolved.error).toMatch(/no finished consult/i);
  });

  it("lets the caller name the conversation, which beats the search", () => {
    const resolved = resolveContinuationThread({ consults, project: "notes", taskId: "task_a" });
    expect("target" in resolved && resolved.target.taskId).toBe("task_a");
  });

  it("refuses a named consult it has no thread for", () => {
    const resolved = resolveContinuationThread({ consults, taskId: "task_missing" });
    expect("error" in resolved && resolved.error).toMatch(/no recorded consult thread/i);
  });

  // A blocked consult never posted, so there is no conversation behind it.
  it("continues only consults that finished", () => {
    const blockedOnly = [{ taskId: "task_x", thread: thread("xxx", "notes"), status: "blocked", createdAt: "2026-09-11T00:00:00Z" }];
    expect("error" in resolveContinuationThread({ consults: blockedOnly, project: "notes" })).toBe(true);
  });
});

describe("matching a recorded thread to a project", () => {
  // Measured: the project name rides in the thread URL after its id, lowercased
  // with everything else collapsed to dashes.
  it("reads the name the way ChatGPT writes it into the URL", () => {
    expect(chatGptProjectSlug("prodex-smoke-project")).toBe("prodex-smoke-project");
    expect(chatGptProjectSlug("Codex")).toBe("codex");
    expect(chatGptProjectSlug("[회사] Notes v2")).toBe("notes-v2");
  });

  it("tells a project from another whose name starts the same way", () => {
    expect(threadMatchesProject(thread("aaa", "notes-archive"), "Notes")).toBe(false);
    expect(threadMatchesProject(thread("aaa", "notes"), "Notes")).toBe(true);
  });

  it("counts a root chat as belonging to no project", () => {
    expect(threadMatchesProject(thread("aaa"), undefined)).toBe(true);
    expect(threadMatchesProject(thread("aaa"), "Notes")).toBe(false);
    expect(threadMatchesProject(thread("aaa", "notes"), undefined)).toBe(false);
  });
});
