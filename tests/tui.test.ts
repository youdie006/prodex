import { describe, expect, it } from "vitest";

const { effortChoices } = await import("../src/tui-flow.js");
const {
  consultArgsFromChoices,
  conversationThreadUrl,
  moveCursor,
  progressLabel,
  conversationsInProject,
  projectsWithIdsExpression,
  recentConversationTitlesExpression,
  renderContextPanel,
  renderProgressBar,
  renderSelectList,
  toggleSelection,
  truncateToWidth
} = await import("../src/tui.js");

describe("interactive consult choices", () => {
  it("continues a chosen conversation by pinning its thread", () => {
    // "Continue an existing chat" needs the thread the user picked from a list,
    // not whatever tab happens to be open - and pinning a target is how the
    // send says which conversation it means.
    expect(
      consultArgsFromChoices({
        prompt: "and what about QUIC?",
        projectMode: "current",
        targetUrl: "https://chatgpt.com/c/6a780848-1660-83ee-9e1a-104f95826746",
        tools: [],
        newChat: false
      })
    ).toEqual([
      "pro",
      "browser",
      "ask",
      "--target-url",
      "https://chatgpt.com/c/6a780848-1660-83ee-9e1a-104f95826746",
      "--confirm-target",
      "--",
      "and what about QUIC?"
    ]);

    // A pinned thread is a complete destination: no project or new-chat flag
    // may ride along, which the send would reject anyway.
    expect(
      consultArgsFromChoices({
        prompt: "hi",
        projectMode: "none",
        targetUrl: "https://chatgpt.com/c/abc12345-1111-2222-3333-444455556666",
        tools: [],
        newChat: true
      })
    ).not.toContain("--new-chat");
  });

  it("carries a chosen reasoning effort, and leaves the pinned model alone otherwise", () => {
    // prodex is named for Pro, but the same browser runs the ordinary reasoning
    // levels, and a one-line question does not want minutes of Pro. Picking an
    // effort has to reach the send; picking nothing must not touch the model
    // the repo pinned.
    expect(
      consultArgsFromChoices({ prompt: "Quick one", projectMode: "current", tools: [], newChat: true, effort: "instant" })
    ).toEqual(["pro", "browser", "ask", "--new-chat", "--effort", "instant", "--", "Quick one"]);

    expect(consultArgsFromChoices({ prompt: "Quick one", projectMode: "current", tools: [], newChat: true })).not.toContain("--effort");
  });

  it("turns picker answers into the send command an agent would have typed", () => {
    expect(
      consultArgsFromChoices({
        prompt: "Explain QUIC",
        projectMode: "existing",
        projectName: "My Project",
        tools: ["deep-research"],
        newChat: true
      })
    ).toEqual(["pro", "browser", "ask", "--new-chat", "--project", "My Project", "--tool", "deep-research", "--", "Explain QUIC"]);

    // Creating a project is a different flag from entering one.
    expect(consultArgsFromChoices({ prompt: "Hi", projectMode: "new", projectName: "Fresh", tools: [], newChat: false })).toEqual([
      "pro",
      "browser",
      "ask",
      "--project-new",
      "Fresh",
      "--",
      "Hi"
    ]);

    // "No project" has to override a pinned default, or the choice is a lie.
    expect(consultArgsFromChoices({ prompt: "Hi", projectMode: "none", tools: [], newChat: false })).toEqual([
      "pro",
      "browser",
      "ask",
      "--no-project",
      "--",
      "Hi"
    ]);

    // Staying in the open thread means passing neither project flag.
    expect(consultArgsFromChoices({ prompt: "Hi", projectMode: "current", tools: [], newChat: false })).toEqual([
      "pro",
      "browser",
      "ask",
      "--",
      "Hi"
    ]);

    // Several tools repeat the flag, and attachments come along.
    expect(
      consultArgsFromChoices({
        prompt: "Read this",
        projectMode: "current",
        tools: ["web-search", "create-image"],
        newChat: false,
        attachments: ["deck.pptx"]
      })
    ).toEqual([
      "pro",
      "browser",
      "ask",
      "--attach",
      "deck.pptx",
      "--tool",
      "web-search",
      "--tool",
      "create-image",
      "--",
      "Read this"
    ]);
  });

  it("refuses choices that cannot be sent", () => {
    expect(() => consultArgsFromChoices({ prompt: "  ", projectMode: "current", tools: [], newChat: false })).toThrow(/prompt/i);
    expect(() => consultArgsFromChoices({ prompt: "Hi", projectMode: "existing", tools: [], newChat: false })).toThrow(/project/i);
  });
});

describe("select list", () => {
  it("marks the cursor and any chosen entries without decorating the rest", () => {
    const rendered = renderSelectList({
      title: "Where should this go?",
      options: [
        { label: "Continue the open thread", hint: "keeps context" },
        { label: "An existing project" },
        { label: "No project" }
      ],
      cursor: 1,
      color: false
    });
    const lines = rendered.split("\n");

    expect(lines[0]).toContain("Where should this go?");
    // Title, blank, then one row per option.
    expect(lines[3]).toContain("An existing project");
    // Exactly one row carries the cursor bar.
    expect(lines.filter((line) => line.includes("\u258c"))).toHaveLength(1);
    expect(lines[3].includes("\u258c")).toBe(true);
    expect(rendered).toContain("keeps context");
    // Terminal output stays plain text - no emoji anywhere.
    expect(/\p{Extended_Pictographic}/u.test(rendered)).toBe(false);
  });

  it("shows which entries are selected in a multi-select", () => {
    const rendered = renderSelectList({
      title: "Tools",
      options: [{ label: "Deep research" }, { label: "Web search" }],
      cursor: 0,
      selected: [1],
      multi: true,
      color: false
    });
    expect(rendered).toContain("[x] Web search");
    expect(rendered).toContain("[ ] Deep research");
  });

  it("wraps the cursor at both ends so a long list stays reachable", () => {
    expect(moveCursor(0, "up", 3)).toBe(2);
    expect(moveCursor(2, "down", 3)).toBe(0);
    expect(moveCursor(1, "down", 3)).toBe(2);
    expect(moveCursor(1, "up", 3)).toBe(0);
    expect(moveCursor(0, "up", 0)).toBe(0);
  });

  it("toggles a multi-select entry on and off", () => {
    expect(toggleSelection([], 1)).toEqual([1]);
    expect(toggleSelection([1], 1)).toEqual([]);
    expect(toggleSelection([2], 1)).toEqual([1, 2]);
  });
});

describe("reasoning choices", () => {
  it("descends from the pinned model, strongest first", () => {
    // The list reads down from what the repo pinned: Extra high sits just under
    // Keep, Instant at the bottom. Climbing up from Instant put the levels
    // closest to Pro furthest from it.
    expect(effortChoices("Pro").map((entry) => entry.label)).toEqual([
      "Keep Pro",
      "Extra high",
      "High",
      "Medium",
      "Instant"
    ]);
    expect(effortChoices(undefined)[0].label).toBe("Keep the current selection");
    expect(effortChoices("Pro").map((entry) => entry.effort)).toEqual([undefined, "max", "high", "medium", "instant"]);
  });
});

describe("conversation list", () => {
  it("lists recent conversations with titles so an existing chat can be picked", async () => {
    const listed = { items: [{ id: "c1", title: "TCP vs QUIC" }, { id: "c2", title: "" }] };
    const fakeFetch = async (url: string) =>
      url.includes("/api/auth/session")
        ? { ok: true, status: 200, json: async () => ({ accessToken: "tok" }) }
        : { ok: true, status: 200, json: async () => listed };
    const rows = await new Function("fetch", `return ${recentConversationTitlesExpression(5)}`)(fakeFetch);

    expect(rows).toEqual([
      { id: "c1", title: "TCP vs QUIC" },
      { id: "c2", title: "Untitled" }
    ]);
  });

  it("lists projects with the id their conversations are tagged with", async () => {
    const sidebar = {
      items: [
        { gizmo: { id: "g-p-aaa", display: { name: "prodex-smoke-project" } } },
        { gizmo: { id: "g-p-bbb", display: { name: "Codex" } } }
      ]
    };
    const fakeFetch = async (url: string) =>
      url.includes("/api/auth/session")
        ? { ok: true, status: 200, json: async () => ({ accessToken: "tok" }) }
        : { ok: true, status: 200, json: async () => sidebar };
    const rows = await new Function("fetch", `return ${projectsWithIdsExpression()}`)(fakeFetch);

    expect(rows).toEqual([
      { id: "g-p-aaa", name: "prodex-smoke-project" },
      { id: "g-p-bbb", name: "Codex" }
    ]);
  });

  it("keeps only the conversations belonging to a picked project", () => {
    // A project's chats are exactly the conversations tagged with its gizmo id,
    // which is what "open the project and pick a session inside it" means.
    const conversations = [
      { id: "c1", title: "in project", gizmoId: "g-p-aaa" },
      { id: "c2", title: "elsewhere", gizmoId: "g-p-bbb" },
      { id: "c3", title: "no project" }
    ];
    expect(conversationsInProject(conversations, "g-p-aaa")).toEqual([{ id: "c1", title: "in project", gizmoId: "g-p-aaa" }]);
    // Without a project id the whole list stands, which is the plain
    // "continue a recent chat" case.
    expect(conversationsInProject(conversations, undefined)).toHaveLength(3);
  });

  it("builds the thread url a picked conversation lives at", () => {
    expect(conversationThreadUrl("6a780848-1660-83ee-9e1a-104f95826746")).toBe(
      "https://chatgpt.com/c/6a780848-1660-83ee-9e1a-104f95826746"
    );
  });
});

describe("readability", () => {
  it("numbers the rows and marks the cursor with a bar, the way a picker is normally read", () => {
    // Borrowed from the pickers this sits next to: a number per row so a choice
    // can be typed directly, and a left bar for the cursor, which stays legible
    // when the row is also colored.
    const rendered = renderSelectList({
      title: "Where should this consult land?",
      step: { index: 2, total: 4 },
      options: [{ label: "The open chat", hint: "keeps context" }, { label: "An existing project" }],
      cursor: 1,
      color: false
    });
    const lines = rendered.split("\n");

    expect(lines[0]).toContain("Step 2 of 4");
    // How many steps remain depends on the answer to the first question, so
    // that screen states its position without inventing a total.
    expect(
      renderSelectList({ title: "T", step: { index: 1 }, options: [{ label: "a" }], cursor: 0, color: false }).split("\n")[0]
    ).toContain("Step 1");
    expect(
      renderSelectList({ title: "T", step: { index: 1 }, options: [{ label: "a" }], cursor: 0, color: false }).split("\n")[0]
    ).not.toContain(" of ");
    expect(rendered).toContain("1 The open chat");
    expect(rendered).toContain("2 An existing project");
    // The cursor row carries the bar; the others are indented to match.
    const cursorRows = lines.filter((line) => line.includes("\u258c"));
    expect(cursorRows).toHaveLength(1);
    expect(cursorRows[0]).toContain("An existing project");
  });

  it("truncates rows to the terminal instead of wrapping them into a mess", () => {
    expect(truncateToWidth("a".repeat(40), 10)).toHaveLength(10);
    expect(truncateToWidth("a".repeat(40), 10).endsWith("...")).toBe(true);
    expect(truncateToWidth("short", 10)).toBe("short");
    const rendered = renderSelectList({
      title: "T",
      options: [{ label: "x".repeat(200) }],
      cursor: 0,
      width: 40,
      color: false
    });
    for (const line of rendered.split("\n")) expect(line.length).toBeLessThanOrEqual(40);
  });

  it("frames the settings a send will use, so nothing is chosen blind", () => {
    const panel = renderContextPanel(
      [
        { label: "model", value: "Pro" },
        { label: "project", value: "prodex-smoke-project" },
        { label: "browser", value: "ready" }
      ],
      { color: false, width: 60 }
    );
    const lines = panel.split("\n");

    // A closed box, values aligned in one column.
    expect(lines[0].startsWith("\u256d")).toBe(true);
    expect(lines[lines.length - 1].startsWith("\u2570")).toBe(true);
    const modelRow = lines.find((line) => line.includes("model"));
    const projectRow = lines.find((line) => line.includes("project"));
    expect(modelRow?.indexOf("Pro")).toBe(projectRow?.indexOf("prodex-smoke-project"));
    expect(/\p{Extended_Pictographic}/u.test(panel)).toBe(false);
  });
});

describe("progress labels", () => {
  it("drops the elapsed time the bar already shows", () => {
    // Measured on a deep research run: the line read
    // "[###---] 2m 58s / 30m  waiting 2m 57s (deep research researching (1m 48s))"
    // - the same clock twice, with the part worth reading pushed to the end.
    expect(progressLabel("progress: waiting 2m 57s (deep research researching (1m 48s))")).toBe(
      "deep research researching (1m 48s)"
    );
    expect(progressLabel("progress: waiting 45s (generating)")).toBe("generating");
    expect(progressLabel("progress: applying selection (model=Pro)")).toBe("applying selection (model=Pro)");
    expect(progressLabel("progress: connecting to browser (port 9333)")).toBe("connecting to browser (port 9333)");
    // A bare "waiting" with no detail still has to say something.
    expect(progressLabel("progress: waiting 45s")).toBe("waiting");
  });
});

describe("progress bar", () => {
  it("says how to stop, and turns a spinner so a still frame never reads as a hang", () => {
    const first = renderProgressBar({ elapsedMs: 1_000, budgetMs: 120_000, label: "generating", width: 20, tick: 0 });
    const second = renderProgressBar({ elapsedMs: 1_000, budgetMs: 120_000, label: "generating", width: 20, tick: 1 });
    expect(first).not.toBe(second);
    expect(first).toContain("ctrl-c to stop");
  });

  it("fills against the budget and always shows elapsed time", () => {
    const bar = renderProgressBar({ elapsedMs: 30_000, budgetMs: 120_000, label: "generating", width: 20 });
    expect(bar).toContain("generating");
    expect(bar).toContain("30s");
    // A quarter of the budget is a quarter of the bar.
    expect((bar.match(/#/g) ?? []).length).toBe(5);
    expect(/\p{Extended_Pictographic}/u.test(bar)).toBe(false);
  });

  it("never overflows once a send runs past its budget", () => {
    const bar = renderProgressBar({ elapsedMs: 900_000, budgetMs: 120_000, label: "still waiting", width: 20 });
    expect((bar.match(/#/g) ?? []).length).toBe(20);
    expect(bar).toContain("15m");
    // Over budget is worth saying out loud rather than showing a full bar and
    // pretending the wait is done.
    expect(bar).toContain("over budget");
  });

  it("degrades to an elapsed counter when there is no budget to measure against", () => {
    const bar = renderProgressBar({ elapsedMs: 5_000, label: "deep research", width: 20 });
    expect(bar).toContain("deep research");
    expect(bar).toContain("5s");
    expect(bar).not.toContain("#");
  });
});
