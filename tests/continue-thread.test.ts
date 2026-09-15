import { describe, expect, it } from "vitest";

import {
  chatGptProjectSlug,
  isChatGptConversationUrl,
  projectIdFromSidebar,
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
    { taskId: "task_a", thread: thread("aaa", "notes"), status: "done", sessionKey: "client-a", createdAt: "2026-09-08T00:00:00Z" },
    { taskId: "task_b", thread: thread("bbb"), status: "done", sessionKey: "client-a", createdAt: "2026-09-09T00:00:00Z" },
    { taskId: "task_c", thread: thread("ccc", "notes"), status: "done", sessionKey: "client-a", createdAt: "2026-09-10T00:00:00Z" }
  ];

  it("continues the newest finished consult of this project", () => {
    const resolved = resolveContinuationThread({ consults, project: "notes", sessionKey: "client-a" });
    expect("target" in resolved && resolved.target.taskId).toBe("task_c");
  });

  it("treats the live project id as authoritative when duplicate slugs were recorded", () => {
    const resolved = resolveContinuationThread({
      consults: [
        {
          taskId: "task_notes",
          thread: "https://chatgpt.com/g/g-p-aaaaaaaa-notes/c/111",
          status: "done",
          sessionKey: "client-a",
          createdAt: "2026-09-10T00:00:00Z"
        },
        {
          taskId: "task_other_notes",
          thread: "https://chatgpt.com/g/g-p-bbbbbbbb-notes/c/222",
          status: "done",
          sessionKey: "client-a",
          createdAt: "2026-09-11T00:00:00Z"
        }
      ],
      project: "Notes",
      projectId: "aaaaaaaa",
      sessionKey: "client-a"
    });

    expect("target" in resolved && resolved.target.taskId).toBe("task_notes");
  });

  it("accepts a thread recorded before the same project id was renamed", () => {
    const resolved = resolveContinuationThread({
      consults: [
        {
          taskId: "task_before_rename",
          thread: "https://chatgpt.com/g/g-p-aaaaaaaa-old-notes/c/111",
          status: "done",
          sessionKey: "client-a",
          createdAt: "2026-09-10T00:00:00Z"
        }
      ],
      project: "Notes",
      projectId: "aaaaaaaa",
      sessionKey: "client-a"
    });

    expect("target" in resolved && resolved.target.taskId).toBe("task_before_rename");
  });

  it("refuses an ambiguous recorded project name without a live project id", () => {
    const resolved = resolveContinuationThread({
      consults: [
        {
          taskId: "task_old_project",
          thread: "https://chatgpt.com/g/g-p-aaaaaaaa-notes/c/111",
          status: "done",
          sessionKey: "client-a",
          createdAt: "2026-09-10T00:00:00Z"
        },
        {
          taskId: "task_new_project",
          thread: "https://chatgpt.com/g/g-p-bbbbbbbb-notes/c/222",
          status: "done",
          sessionKey: "client-a",
          createdAt: "2026-09-11T00:00:00Z"
        }
      ],
      project: "Notes",
      sessionKey: "client-a"
    });

    expect("error" in resolved && resolved.error).toMatch(/ambiguous.*--continue-task/is);
  });

  it("uses a unique recorded project id for legacy name and id-only URLs", () => {
    const resolved = resolveContinuationThread({
      consults: [
        {
          taskId: "task_named",
          thread: "https://chatgpt.com/g/g-p-aaaaaaaa-notes/c/111",
          status: "done",
          sessionKey: "client-a",
          createdAt: "2026-09-10T00:00:00Z"
        },
        {
          taskId: "task_id_only",
          thread: "https://chatgpt.com/g/g-p-aaaaaaaa/c/222",
          status: "done",
          sessionKey: "client-a",
          createdAt: "2026-09-11T00:00:00Z"
        }
      ],
      project: "Notes",
      sessionKey: "client-a"
    });

    expect("target" in resolved && resolved.target.taskId).toBe("task_id_only");
  });

  // A follow-up for the general chat must not walk into a project, and a
  // project's follow-up must not answer in another project's conversation.
  it("keeps a projectless follow-up out of every project", () => {
    const resolved = resolveContinuationThread({ consults, sessionKey: "client-a" });
    expect("target" in resolved && resolved.target.taskId).toBe("task_b");
  });

  it("refuses rather than guessing when this project has no thread yet", () => {
    const resolved = resolveContinuationThread({ consults, project: "ledger", sessionKey: "client-a" });
    expect("error" in resolved && resolved.error).toMatch(/no finished consult/i);
  });

  it("scopes an unnamed continuation to the caller session key", () => {
    const resolved = resolveContinuationThread({
      consults: [
        { taskId: "task_a", thread: thread("aaa", "notes"), status: "done", sessionKey: "client-a", createdAt: "2026-09-10T00:00:00Z" },
        { taskId: "task_b", thread: thread("bbb", "notes"), status: "done", sessionKey: "client-b", createdAt: "2026-09-11T00:00:00Z" }
      ],
      project: "notes",
      sessionKey: "client-a"
    });

    expect("target" in resolved && resolved.target.taskId).toBe("task_a");
  });

  it("refuses an unnamed continuation without a caller session key", () => {
    const resolved = resolveContinuationThread({ consults, project: "notes" });
    expect("error" in resolved && resolved.error).toMatch(/--session-key|--continue-task/i);
  });

  it("lets the caller name the conversation, which beats the search", () => {
    const resolved = resolveContinuationThread({ consults, project: "notes", taskId: "task_a" });
    expect("target" in resolved && resolved.target.taskId).toBe("task_a");
  });

  it("lets an explicit task id deliberately override an unreliable implicit record", () => {
    const resolved = resolveContinuationThread({
      consults: [
        {
          taskId: "task_named",
          thread: thread("aaa", "notes"),
          status: "done",
          warnings: ["answer_incomplete: response was still generating"]
        }
      ],
      project: "notes",
      taskId: "task_named"
    });

    expect("target" in resolved && resolved.target.taskId).toBe("task_named");
  });

  it("refuses a named consult it has no thread for", () => {
    const resolved = resolveContinuationThread({ consults, taskId: "task_missing" });
    expect("error" in resolved && resolved.error).toMatch(/no recorded consult thread/i);
  });

  // A blocked consult never posted, so there is no conversation behind it.
  it("continues only consults that finished", () => {
    const blockedOnly = [{ taskId: "task_x", thread: thread("xxx", "notes"), status: "blocked", sessionKey: "client-a", createdAt: "2026-09-11T00:00:00Z" }];
    expect("error" in resolveContinuationThread({ consults: blockedOnly, project: "notes", sessionKey: "client-a" })).toBe(true);
  });

  it.each(["answer_incomplete:", "request_unverified:"])(
    "refuses the newest implicit consult with %s instead of falling back to an older answer",
    (warningPrefix) => {
      const resolved = resolveContinuationThread({
        consults: [
          {
            taskId: "task_older",
            thread: thread("aaa", "notes"),
            status: "done",
            sessionKey: "client-a",
            createdAt: "2026-09-10T00:00:00Z"
          },
          {
            taskId: "task_newest",
            thread: thread("bbb", "notes"),
            status: "done",
            sessionKey: "client-a",
            createdAt: "2026-09-11T00:00:00Z",
            warnings: [`${warningPrefix} recorded answer is not reliable`]
          }
        ],
        project: "Notes",
        sessionKey: "client-a"
      });

      expect("error" in resolved && resolved.error).toMatch(new RegExp(warningPrefix));
      expect("error" in resolved && resolved.error).toMatch(/--continue-task/i);
    }
  );

  it.each(["receipt_record_warning:", "session_record_warning:"])(
    "refuses an implicit consult carrying %s",
    (warningPrefix) => {
      const resolved = resolveContinuationThread({
        consults: [
          {
            taskId: "task_warned",
            thread: thread("aaa", "notes"),
            status: "done",
            sessionKey: "client-a",
            createdAt: "2026-09-11T00:00:00Z",
            warnings: [`${warningPrefix} persistence failed`]
          }
        ],
        project: "Notes",
        sessionKey: "client-a"
      });

      expect("error" in resolved && resolved.error).toMatch(new RegExp(warningPrefix));
    }
  );
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
  // Measured in a send's own debug trace: between the prompt posting and the
  // server naming the conversation, the tab sits on "/c/WEB:<uuid>". The id
  // parser used for navigation already refuses that, so accepting it here
  // would let a follow-up choose a thread that cannot be opened - and fail
  // with a complaint about the URL rather than about the conversation.
  it("refuses the provisional id a conversation carries before the server names it", () => {
    expect(isChatGptConversationUrl("https://chatgpt.com/c/WEB:d5ba5c50-51d1-4c01-a289-17b84b1ac9a2")).toBe(false);
    expect(isChatGptConversationUrl("https://chatgpt.com/c/6aa36ada-1890-83e8-a859-8e8458804a80")).toBe(true);
  });

  it("refuses to treat a temporary chat as a conversation", () => {
    expect(isChatGptConversationUrl(temporary)).toBe(false);
    expect(isChatGptConversationUrl("https://chatgpt.com/g/g-p-6a46/project")).toBe(false);
    expect(isChatGptConversationUrl(rootChat)).toBe(true);
    expect(isChatGptConversationUrl(named)).toBe(true);
  });

  it("never picks a temporary chat as the newest thing to continue", () => {
    const resolved = resolveContinuationThread({
      consults: [
        { taskId: "task_real", thread: rootChat, status: "done", sessionKey: "client-a", createdAt: "2026-09-01T00:00:00Z" },
        { taskId: "task_temp", thread: temporary, status: "done", sessionKey: "client-a", createdAt: "2026-09-09T00:00:00Z" }
      ],
      sessionKey: "client-a"
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
        { taskId: "task_named", thread: named, status: "done", sessionKey: "client-a", createdAt: "2026-09-01T00:00:00Z" },
        { taskId: "task_bare", thread: idOnly, status: "done", sessionKey: "client-a", createdAt: "2026-09-09T00:00:00Z" }
      ],
      project: "Notes",
      sessionKey: "client-a"
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

// Four of this account's five projects have Korean names, and the slug - the
// name with everything but ASCII letters and digits turned to dashes - is
// "" for two of them and "ess" for another. A follow-up into any of them could
// never match a thread by name, first consult or hundredth. The sidebar knows
// the id, and the id is what thread URLs carry.
describe("a project whose name the URL cannot carry", () => {
  const sidebar = [
    { id: "g-p-6a06a76991ec8191a6faa4d9ecf4dc46", name: "[\ud68c\uc0ac] \uc628\ub514\ubc14\uc774\uc2a4" },
    { id: "g-p-6a3b24056f9c8191ac8282efd2e0b3c3", name: "Codex" }
  ];
  const koreanName = sidebar[0].name;
  const koreanId = "6a06a76991ec8191a6faa4d9ecf4dc46";

  it("slugs to nothing, which is why the name cannot be the key", () => {
    expect(chatGptProjectSlug(koreanName)).toBe("");
  });

  it("reads the id off the sidebar, exact name first", () => {
    expect(projectIdFromSidebar(sidebar, koreanName)).toBe(koreanId);
    expect(projectIdFromSidebar(sidebar, "codex")).toBe("6a3b24056f9c8191ac8282efd2e0b3c3");
    expect(projectIdFromSidebar(sidebar, "Ledger")).toBeUndefined();
  });

  it("refuses to guess between two projects with the same name", () => {
    const twice = [...sidebar, { id: "g-p-ffffffffffffffffffffffffffffffff", name: "Codex" }];
    expect(projectIdFromSidebar(twice, "Codex")).toBeUndefined();
  });

  it("continues the newest thread of a Korean-named project by its id", () => {
    const consults = [
      { taskId: "task_old", thread: thread("aaa", "codex"), status: "done", sessionKey: "client-a", createdAt: "2026-09-10T00:00:00Z" },
      { taskId: "task_kr", thread: `https://chatgpt.com/g/g-p-${koreanId}/c/bbb`, status: "done", sessionKey: "client-a", createdAt: "2026-09-11T00:00:00Z" }
    ];
    const withoutId = resolveContinuationThread({ consults, project: koreanName, sessionKey: "client-a" });
    expect("error" in withoutId).toBe(true);
    const withId = resolveContinuationThread({ consults, project: koreanName, projectId: koreanId, sessionKey: "client-a" });
    expect("target" in withId && withId.target.taskId).toBe("task_kr");
  });
});
