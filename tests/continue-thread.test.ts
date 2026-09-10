import { describe, expect, it } from "vitest";

import {
  chatGptProjectSlug,
  isChatGptConversationUrl,
  projectIdsByName,
  resolveContinuationThread,
  threadMatchesProject
} from "../src/continue-thread.js";

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

// Every shape below came out of this machine's own records: 136 threads, of
// which 78 carry the project name after its id, 55 are root chats, 3 carry the
// id ALONE, and 6 are not conversations at all.
describe("the shapes real records actually hold", () => {
  const named = "https://chatgpt.com/g/g-p-6a46dda35eb48191a041e0c70b24195d-notes/c/6a50a811-a914-83ee";
  const idOnly = "https://chatgpt.com/g/g-p-6a46dda35eb48191a041e0c70b24195d/c/6a7e82c3-04b4-83ee";
  const temporary = "https://chatgpt.com/?temporary-chat=true";
  const rootChat = "https://chatgpt.com/c/6a4d97c1-7870-83e8";

  // A temporary chat is never saved: going back to that URL opens a fresh empty
  // one. Continuing into it would look like a follow-up and carry no context.
  it("refuses to treat a temporary chat as a conversation", () => {
    expect(isChatGptConversationUrl(temporary)).toBe(false);
    expect(isChatGptConversationUrl("https://chatgpt.com/g/g-p-6a46/project")).toBe(false);
    expect(isChatGptConversationUrl(rootChat)).toBe(true);
    expect(isChatGptConversationUrl(named)).toBe(true);
  });

  it("never picks a temporary chat as the newest thing to continue", () => {
    const resolved = resolveContinuationThread({
      consults: [
        { taskId: "task_real", thread: rootChat, status: "done", createdAt: "2026-09-01T00:00:00Z" },
        { taskId: "task_temp", thread: temporary, status: "done", createdAt: "2026-09-09T00:00:00Z" }
      ]
    });
    expect("target" in resolved && resolved.target.taskId).toBe("task_real");
  });

  it("says why a named temporary consult cannot be continued", () => {
    const resolved = resolveContinuationThread({
      consults: [{ taskId: "task_temp", thread: temporary, status: "done" }],
      taskId: "task_temp"
    });
    expect("error" in resolved && resolved.error).toMatch(/temporary chat/i);
  });

  // The bare-id threads are the ones that would otherwise be invisible: the
  // follow-up would skip the NEWEST conversation and continue an older one.
  it("recognises a project thread whose URL carries no name, from the id it learned", () => {
    expect(projectIdsByName([named]).get("notes")).toEqual(new Set(["6a46dda35eb48191a041e0c70b24195d"]));
    expect(threadMatchesProject(idOnly, "Notes")).toBe(false);
    expect(threadMatchesProject(idOnly, "Notes", new Set(["6a46dda35eb48191a041e0c70b24195d"]))).toBe(true);
  });

  it("continues the newest of a project even when only its id is in the URL", () => {
    const resolved = resolveContinuationThread({
      consults: [
        { taskId: "task_named", thread: named, status: "done", createdAt: "2026-09-01T00:00:00Z" },
        { taskId: "task_bare", thread: idOnly, status: "done", createdAt: "2026-09-09T00:00:00Z" }
      ],
      project: "Notes"
    });
    expect("target" in resolved && resolved.target.taskId).toBe("task_bare");
  });

  // A bare-id thread still belongs to a project, so a follow-up meant for the
  // general chat must not land in it.
  it("keeps a bare-id project thread out of a projectless follow-up", () => {
    expect(threadMatchesProject(idOnly, undefined)).toBe(false);
  });
});

// A named conversation that cannot be opened is a specific, known cause, and it
// used to arrive wearing the catch-all: the message said "It may have been
// deleted" and the next step under it said "resolve the visible browser issue
// manually" - about a browser that was working. Measured on a thread whose
// project had been deleted.
describe("a conversation that cannot be reached", () => {
  it("names the cause instead of blaming the browser, and does not ask for a retry", async () => {
    const { chatGptThreadUnavailableBlocker } = await import("../src/chatgpt-browser.js");
    const blocker = chatGptThreadUnavailableBlocker("https://chatgpt.com/c/6aa23cb1");
    expect(blocker.code).toBe("thread_unavailable");
    expect(blocker.retryable).toBe(false);
    expect(blocker.next_step).not.toMatch(/resolve the visible browser issue/i);
    expect(blocker.next_step).toMatch(/--continue/);
    expect(blocker.thread).toBe("https://chatgpt.com/c/6aa23cb1");
  });
});
