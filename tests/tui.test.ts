import { describe, expect, it } from "vitest";

const { consultArgsFromChoices, moveCursor, renderProgressBar, renderSelectList, toggleSelection } = await import("../src/tui.js");

describe("interactive consult choices", () => {
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
      cursor: 1
    });
    const lines = rendered.split("\n");

    expect(lines[0]).toContain("Where should this go?");
    // Title, blank, then one row per option.
    expect(lines[3]).toContain("An existing project");
    // The cursor row is the only one carrying the pointer.
    expect(lines.filter((line) => line.trimStart().startsWith(">"))).toHaveLength(1);
    expect(lines[3].trimStart().startsWith(">")).toBe(true);
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
      multi: true
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

describe("progress bar", () => {
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
