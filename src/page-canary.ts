/**
 * A read-only check of the ChatGPT page structure prodex depends on.
 *
 * ChatGPT ships new builds without notice, and each redesign so far broke
 * prodex in ways that only showed up as failed consults (2026-09-29,
 * 2026-10-06). The canary reads the page that is already open - it never
 * navigates, types or sends - records the build id and whether each control
 * prodex relies on is present, and compares with the previous run, so a change
 * is noticed before a consult trips over it. It records counts and booleans
 * only: no prompt, answer, title or project name.
 */

/** What one canary run saw. Only structure: counts, booleans and the build id. */
export interface PageCanaryFacts {
  build: string | null;
  pageKind: "root" | "conversation" | "project" | "other";
  composer: { editor: boolean; inForm: boolean };
  modelButton: boolean;
  toolsButton: boolean;
  generalFileInput: boolean;
  sidebar: { projectRows: number; rowsWithLabelAndId: number; createProject: boolean; newChatInButtons: number; projectActions: number };
  messages: { user: number; assistant: number; selectionIds: number; userBubbles: number };
  markdown: { copyKinds: string[] };
}

export const PAGE_CANARY_EXPRESSION = `(() => {
  const visible = (el) => !!el && el.getClientRects().length > 0;
  const all = (selector) => [...document.querySelectorAll(selector)];
  const editor = all('#prompt-textarea,[contenteditable="true"]').find((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  const form = editor ? editor.closest("form") : null;
  const units = all("[data-chatgpt-search-unit-key]").filter(visible);
  const keyOf = (unit) => unit.getAttribute("data-chatgpt-search-unit-key") || "";
  const rows = all("[data-app-action-sidebar-project-row]");
  const path = location.pathname;
  return {
    build: document.documentElement.getAttribute("data-build"),
    pageKind: path === "/" ? "root" : /^\\/g\\/g-p-[^/]+\\/c\\//.test(path) || /^\\/c\\//.test(path) ? "conversation" : /^\\/g\\/g-p-/.test(path) ? "project" : "other",
    composer: { editor: !!editor, inForm: !!form },
    modelButton: !!(form && form.querySelector('button[aria-label="Select ChatGPT model"]')),
    toolsButton: !!(form && form.querySelector('button[data-composer-navigation-target="add-context"],button[aria-label="Add files and more"]')),
    generalFileInput: !!(form && form.querySelector('input[type="file"]:not([accept*="image"])')),
    sidebar: {
      projectRows: rows.length,
      rowsWithLabelAndId: rows.filter((row) => row.hasAttribute("data-app-action-sidebar-project-label") && row.hasAttribute("data-app-action-sidebar-project-id")).length,
      createProject: !!document.querySelector("[data-app-action-sidebar-project-create]"),
      newChatInButtons: all('button[aria-label^="New chat in "]').length,
      projectActions: all('button[aria-label^="Project actions for "]').length
    },
    messages: {
      user: units.filter((unit) => /:user$/.test(keyOf(unit))).length,
      assistant: units.filter((unit) => /:assistant$/.test(keyOf(unit))).length,
      selectionIds: all("[data-chatgpt-selection-message-id]").filter(visible).length,
      userBubbles: all("[data-user-message-bubble]").filter(visible).length
    },
    markdown: { copyKinds: [...new Set(all("[data-markdown-copy]").map((el) => el.getAttribute("data-markdown-copy") || ""))].sort() }
  };
})()`;

export interface PageCanaryFinding {
  check: string;
  detail: string;
}

export interface PageCanaryVerdict {
  /** ok: every check held; changed: checks held but the build or the marker set moved; broken: a check failed. */
  status: "ok" | "changed" | "broken";
  buildChanged: boolean;
  failures: PageCanaryFinding[];
  changes: PageCanaryFinding[];
}

/**
 * Judge one run against what prodex needs, and against the previous run.
 *
 * A check that can only be judged on some pages (messages on a conversation,
 * project controls when the account has projects) is skipped elsewhere rather
 * than failed, and a sidebar that HAD project rows and now has none counts as
 * broken, since the account did not lose its projects.
 */
export function judgePageCanary(facts: PageCanaryFacts, previous?: PageCanaryFacts, knownMarkers?: readonly string[]): PageCanaryVerdict {
  const failures: PageCanaryFinding[] = [];
  const fail = (check: string, detail: string): void => {
    failures.push({ check, detail });
  };
  if (!facts.composer.editor) fail("composer", "no visible prompt editor");
  else if (!facts.composer.inForm) fail("composer", "the prompt editor is not inside a form");
  if (facts.composer.inForm) {
    if (!facts.modelButton) fail("model selector", 'no "Select ChatGPT model" button in the composer');
    if (!facts.toolsButton) fail("tools button", 'no "Add files and more" control in the composer');
    if (!facts.generalFileInput) fail("file input", "no general file input in the composer form");
  }
  const rows = facts.sidebar.projectRows;
  if (rows > 0) {
    if (facts.sidebar.rowsWithLabelAndId !== rows) fail("project rows", `${rows - facts.sidebar.rowsWithLabelAndId} of ${rows} project rows lack their label or id attribute`);
    if (facts.sidebar.newChatInButtons !== rows) fail("project entry", `${facts.sidebar.newChatInButtons} "New chat in" controls for ${rows} project rows`);
    if (facts.sidebar.projectActions !== rows) fail("project actions", `${facts.sidebar.projectActions} "Project actions for" controls for ${rows} project rows`);
  } else if (previous && previous.sidebar.projectRows > 0) {
    fail("project rows", `the sidebar showed ${previous.sidebar.projectRows} project rows last time and none now`);
  }
  if (!facts.sidebar.createProject) fail("project create", "no add-project control in the sidebar");
  if (facts.pageKind === "conversation") {
    if (facts.messages.user + facts.messages.assistant === 0) fail("message units", "a conversation page with no visible message units");
    if (facts.messages.user > 0 && facts.messages.userBubbles === 0) fail("user turns", "user turns without a user message bubble");
    if (facts.messages.assistant > 0 && facts.messages.selectionIds === 0) fail("assistant turns", "assistant turns without a selection message id");
  }
  const changes: PageCanaryFinding[] = [];
  const buildChanged = Boolean(previous && previous.build !== facts.build);
  if (buildChanged) changes.push({ check: "build", detail: `${previous?.build ?? "unknown"} -> ${facts.build ?? "unknown"}` });
  // Which markers a page carries depends on the answer on screen (a short
  // reply has no code block), so a marker counts as new only against every
  // marker seen before, not against the previous page.
  if (knownMarkers && knownMarkers.length > 0) {
    const added = facts.markdown.copyKinds.filter((kind) => !knownMarkers.includes(kind));
    if (added.length > 0) changes.push({ check: "markdown markers", detail: `new: ${added.join(", ")}` });
  }
  return { status: failures.length > 0 ? "broken" : changes.length > 0 ? "changed" : "ok", buildChanged, failures, changes };
}
