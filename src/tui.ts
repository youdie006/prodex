/**
 * The interactive side of prodex.
 *
 * Everything an agent needs is already reachable as flags, but a person typing
 * `prodex` got a wall of commands and no way in. This module is the picker that
 * asks the same questions the flags answer - where the consult should land,
 * which composer tools to turn on - and then shows something moving while a
 * multi-minute Pro answer is written.
 *
 * The rendering and the choice-to-argument mapping are pure so they can be
 * tested without a terminal; only `runInteractiveConsult` touches stdin.
 */

export type ProjectMode = "current" | "existing" | "new" | "none";

export interface ConsultChoices {
  prompt: string;
  projectMode: ProjectMode;
  projectName?: string;
  /** A conversation picked from the list; a complete destination on its own. */
  targetUrl?: string;
  /** Reasoning effort for an ordinary chat; omitted means "keep the pinned model". */
  effort?: string;
  tools: string[];
  newChat: boolean;
  attachments?: string[];
}

/** Where a conversation lives, given its id. */
export function conversationThreadUrl(conversationId: string): string {
  return `https://chatgpt.com/c/${conversationId}`;
}

/**
 * Map the picker's answers onto the exact command line a person could have
 * typed. Keeping this a pure function means the interactive path cannot drift
 * from the documented flags - and the TUI can print the command it ran.
 */
export function consultArgsFromChoices(choices: ConsultChoices): string[] {
  const prompt = choices.prompt.trim();
  if (prompt.length === 0) throw new Error("The prompt is empty - there is nothing to ask.");
  const args = ["pro", "browser", "ask"];
  // A picked conversation is the whole destination: the send rejects a project
  // or a fresh chat alongside a pinned target, and rightly so.
  if (choices.targetUrl) {
    args.push("--target-url", choices.targetUrl, "--confirm-target");
    if (choices.effort) args.push("--effort", choices.effort);
    for (const attachment of choices.attachments ?? []) args.push("--attach", attachment);
    for (const tool of choices.tools) args.push("--tool", tool);
    args.push("--", prompt);
    return args;
  }
  if (choices.newChat) args.push("--new-chat");
  if (choices.effort) args.push("--effort", choices.effort);
  if (choices.projectMode === "existing" || choices.projectMode === "new") {
    const name = choices.projectName?.trim();
    if (!name) throw new Error("Pick a project name, or choose to send without a project.");
    args.push(choices.projectMode === "existing" ? "--project" : "--project-new", name);
  }
  // A pinned default project would otherwise swallow this choice.
  if (choices.projectMode === "none") args.push("--no-project");
  for (const attachment of choices.attachments ?? []) args.push("--attach", attachment);
  for (const tool of choices.tools) args.push("--tool", tool);
  args.push("--", prompt);
  return args;
}

export interface ConversationSummary {
  id: string;
  title: string;
  /** The project this conversation belongs to, when it belongs to one. */
  gizmoId?: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
}

/**
 * Projects with the id their conversations are tagged with.
 *
 * The sidebar gives names only, which is enough to ENTER a project but not to
 * tell which chats live in it - and "open the project, then pick the session
 * inside it" needs exactly that link.
 */
export function projectsWithIdsExpression(): string {
  return `(async () => {
  let token = "";
  try {
    const session = await fetch("/api/auth/session", { credentials: "include" });
    if (!session.ok) return [];
    const parsed = await session.json();
    token = (parsed && parsed.accessToken) || "";
  } catch (error) {
    return [];
  }
  try {
    const response = await fetch("/backend-api/gizmos/snorlax/sidebar", {
      credentials: "include",
      headers: token ? { Authorization: "Bearer " + token } : {}
    });
    if (!response.ok) return [];
    const listed = await response.json();
    return ((listed && listed.items) || [])
      .map((item) => item && item.gizmo)
      .filter((gizmo) => gizmo && gizmo.id)
      .map((gizmo) => ({ id: gizmo.id, name: ((gizmo.display && gizmo.display.name) || gizmo.name || "").trim() || gizmo.id }));
  } catch (error) {
    return [];
  }
})()`;
}

/** The conversations that live inside a project, or all of them without one. */
export function conversationsInProject(conversations: ConversationSummary[], projectId: string | undefined): ConversationSummary[] {
  if (!projectId) return conversations;
  return conversations.filter((conversation) => conversation.gizmoId === projectId);
}

/**
 * Recent conversations with their titles, for the "continue an existing chat"
 * list. Only the sidebar listing is fetched - the transcripts themselves are
 * large and nothing here needs them.
 */
export function recentConversationTitlesExpression(limit = 10): string {
  return `(async () => {
  let token = "";
  try {
    const session = await fetch("/api/auth/session", { credentials: "include" });
    if (!session.ok) return [];
    const parsed = await session.json();
    token = (parsed && parsed.accessToken) || "";
  } catch (error) {
    return [];
  }
  try {
    const response = await fetch("/backend-api/conversations?offset=0&limit=${limit}&order=updated", {
      credentials: "include",
      headers: token ? { Authorization: "Bearer " + token } : {}
    });
    if (!response.ok) return [];
    const listed = await response.json();
    return ((listed && listed.items) || [])
      .filter((item) => item && item.id)
      .map((item) => ({
        id: item.id,
        title: (item.title || "").trim() || "Untitled",
        ...(item.gizmo_id ? { gizmoId: item.gizmo_id } : {})
      }));
  } catch (error) {
    return [];
  }
})()`;
}

export interface SelectOption {
  label: string;
  hint?: string;
}

export interface SelectListInput {
  title: string;
  options: SelectOption[];
  cursor: number;
  /** Indices already chosen; only meaningful with `multi`. */
  selected?: number[];
  multi?: boolean;
  footer?: string;
  /** Shown beside the title so the flow has a visible length. Omit `total`
   *  where the remaining length depends on the answer being given. */
  step?: { index: number; total?: number };
  width?: number;
  color?: boolean;
}

const ESC = "";
const DIM = `${ESC}[2m`;
const BOLD = `${ESC}[1m`;
const ACCENT = `${ESC}[38;2;190;28;28m`;
const RESET = `${ESC}[0m`;
const CURSOR_BAR = "▌";

function paint(text: string, code: string, color: boolean): string {
  return color ? `${code}${text}${RESET}` : text;
}

/** Cut a line to the terminal rather than letting it wrap into a second row. */
export function truncateToWidth(text: string, width: number): string {
  if (width <= 0 || text.length <= width) return text;
  return width <= 3 ? text.slice(0, width) : `${text.slice(0, width - 3)}...`;
}

export function renderSelectList(input: SelectListInput): string {
  const color = input.color ?? true;
  const width = input.width ?? 100;
  const selected = new Set(input.selected ?? []);
  const step = input.step
    ? paint(`   Step ${input.step.index}${input.step.total ? ` of ${input.step.total}` : ""}`, DIM, color)
    : "";
  const lines = [`${paint(input.title, BOLD, color)}${step}`, ""];
  // Hints line up in their own column; ragged hints read as noise next to the
  // labels they belong to.
  const labelWidth = Math.max(...input.options.map((option) => option.label.length), 0);
  input.options.forEach((option, index) => {
    const onCursor = index === input.cursor;
    // A left bar reads as a cursor even once the row is colored, where a ">"
    // competes with the text. Rows that are not on the cursor keep the same
    // indent so nothing shifts as it moves.
    const bar = onCursor ? paint(CURSOR_BAR, ACCENT, color) : " ";
    // A number per row means a choice can be typed instead of arrowed to.
    const ordinal = paint(`${index + 1}`, onCursor ? ACCENT : DIM, color);
    const box = input.multi ? (selected.has(index) ? "[x] " : "[ ] ") : "";
    const label = onCursor ? paint(option.label, BOLD, color) : option.label;
    const gap = " ".repeat(Math.max(0, labelWidth - option.label.length));
    const hint = option.hint ? `${gap}    ${paint(option.hint, DIM, color)}` : "";
    lines.push(truncateToWidth(` ${bar} ${ordinal} ${box}${label}${hint}`, width + (color ? 64 : 0)));
  });
  if (input.footer) lines.push("", paint(input.footer, DIM, color));
  return lines.join("\n");
}

export interface ContextRow {
  label: string;
  value: string;
}

/**
 * The settings a send is about to use, framed above the questions.
 *
 * Picking a project or a tool without seeing which model is pinned, or whether
 * the browser is even reachable, is choosing blind - and a send that fails on
 * the browser after four questions wastes all four.
 */
export function renderContextPanel(rows: ContextRow[], options: { color?: boolean; width?: number } = {}): string {
  const color = options.color ?? true;
  const labelWidth = Math.max(...rows.map((row) => row.label.length), 0);
  const texts = rows.map((row) => ` ${row.label.padEnd(labelWidth)}   ${row.value} `);
  // Size the frame to its contents, capped by the terminal. A box stretched to
  // the full width is mostly empty space with a border around it.
  const inner = Math.min(Math.max(...texts.map((text) => text.length), 0), Math.max(20, (options.width ?? 72) - 2));
  const body = texts.map((text) => `│${truncateToWidth(text, inner).padEnd(inner)}│`);
  const top = `╭${"─".repeat(inner)}╮`;
  const bottom = `╰${"─".repeat(inner)}╯`;
  return [top, ...body, bottom].map((line) => (color ? paint(line, DIM, color) : line)).join("\n");
}

export function moveCursor(cursor: number, direction: "up" | "down", length: number): number {
  if (length <= 0) return 0;
  return direction === "up" ? (cursor - 1 + length) % length : (cursor + 1) % length;
}

export function toggleSelection(selected: number[], index: number): number[] {
  return selected.includes(index) ? selected.filter((entry) => entry !== index) : [...selected, index].sort((a, b) => a - b);
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

/**
 * Turn a `progress:` line from the send into the label beside the bar.
 *
 * The bar already carries the elapsed clock, so a label that opens with
 * "waiting 2m 57s" prints the same number twice and pushes the part worth
 * reading off to the right. Keep the detail, drop the duplicate.
 */
export function progressLabel(line: string): string {
  const text = line.replace(/^progress:\s*/, "").trim();
  const waiting = /^waiting\s+[0-9]+[a-z]*(?:\s+[0-9]+[a-z]*)*\s*(.*)$/i.exec(text);
  if (!waiting) return text;
  const detail = waiting[1].trim();
  if (detail.length === 0) return "waiting";
  // The send wraps its detail in parentheses; the bar reads better without them.
  const unwrapped = /^\((.*)\)$/.exec(detail);
  return (unwrapped ? unwrapped[1] : detail).trim();
}

export interface ProgressBarInput {
  elapsedMs: number;
  /** Omit when the wait has no meaningful budget to fill against. */
  budgetMs?: number;
  label: string;
  width?: number;
  /** Advances the spinner; a still frame reads as a hang. */
  tick?: number;
}

const SPINNER = ["|", "/", "-", "\\"];

/**
 * A Pro consult can run for many minutes with nothing on screen. The bar fills
 * against the send's own budget, and says so plainly once the wait outlives it
 * rather than sitting at 100% pretending to be finished.
 */
export function renderProgressBar(input: ProgressBarInput): string {
  const elapsed = formatElapsed(input.elapsedMs);
  const spinner = SPINNER[Math.abs(input.tick ?? 0) % SPINNER.length];
  // Saying how to abort belongs on the waiting line itself: a consult can run
  // for many minutes and the only other thing on screen is the bar.
  const stop = "ctrl-c to stop";
  if (!input.budgetMs || input.budgetMs <= 0) return `${spinner} ${input.label}  ${elapsed}  ${stop}`;
  const width = Math.max(4, input.width ?? 28);
  const ratio = input.elapsedMs / input.budgetMs;
  const filled = Math.min(width, Math.round(Math.min(ratio, 1) * width));
  const bar = `${"#".repeat(filled)}${"-".repeat(width - filled)}`;
  const over = ratio > 1 ? "  over budget" : "";
  return `${spinner} [${bar}] ${elapsed} / ${formatElapsed(input.budgetMs)}  ${input.label}${over}  ${stop}`;
}
