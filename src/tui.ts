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

// Characters a backslash escapes outside quotes: a space or shell punctuation.
const ESCAPED_BY_BACKSLASH = /[ ()\[\]{}'"&;!$`*?#~<>|]/;
// A drive letter or a UNC share: such a word's backslashes are separators.
const WINDOWS_PATH_START = /^["']?(?:[A-Za-z]:[\\/]|\\\\)/;

/** Where the quote opened at `open` closes, or -1 when nothing closes it. */
function closingQuote(line: string, open: number, windows: boolean): number {
  const quote = line[open];
  for (let index = open + 1; index < line.length; index += 1) {
    if (quote === '"' && !windows && line[index] === "\\") index += 1;
    else if (line[index] === quote) return index;
  }
  return -1;
}

/**
 * Split the one line a person types into the paths the send wants one flag at
 * a time, reading it the way a shell reads words: file names have spaces in
 * them, and a dropped file arrives quoted or escaped by the terminal.
 */
export function parseAttachmentLine(line: string): string[] {
  const out: string[] = [];
  let index = 0;
  while (index < line.length) {
    if (/\s/.test(line[index]!)) {
      index += 1;
      continue;
    }
    // A Windows path keeps every backslash: `C:\repo\#1\a.pdf` read `\#` as an
    // escaped "#" and lost the separator (found 2026-11-09).
    const windows = WINDOWS_PATH_START.test(line.slice(index));
    let word = "";
    // Quoted and unquoted parts next to each other are one word, as in a
    // shell. Found 2026-11-09: GNOME Terminal drops `Bob's notes.pdf` as
    // '/home/u/Bob'\''s notes.pdf', which came back as three paths, and
    // "My File".pdf as two.
    let lastPart: "plain" | "other" | undefined;
    while (index < line.length && !/\s/.test(line[index]!)) {
      const char = line[index]!;
      // An apostrophe between letters is part of the name (`it's.txt`), as it
      // always was, and a quote with nothing to close it is taken as written.
      const apostrophe = char === "'" && lastPart === "plain" && /[\p{L}\p{N}]/u.test(word.at(-1) ?? "");
      if ((char === "'" || char === '"') && !apostrophe) {
        const close = closingQuote(line, index, windows);
        if (close !== -1) {
          const quoted = line.slice(index + 1, close);
          // In double quotes a backslash escapes only what a shell lets it.
          word += char === '"' && !windows ? quoted.replace(/\\(["\\$`])/g, "$1") : quoted;
          index = close + 1;
          lastPart = "other";
          continue;
        }
      }
      // Dropping a file onto a macOS terminal types `My\ File.pdf`, which used
      // to split into two paths that do not exist. Only a space or shell
      // punctuation counts as escaped, so `docs\report.pdf` keeps its backslash.
      if (char === "\\" && !windows && ESCAPED_BY_BACKSLASH.test(line[index + 1] ?? "")) {
        word += line[index + 1];
        index += 2;
        lastPart = "other";
        continue;
      }
      word += char;
      index += 1;
      lastPart = "plain";
    }
    const value = word.trim();
    if (value.length > 0) out.push(value);
  }
  return out;
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
 * Read only rendered links. A project id is accepted only when the visible
 * anchor itself has a canonical ChatGPT project URL.
 */
export function projectsWithIdsExpression(): string {
  return `(() => {
  const out = [];
  const seen = new Set();
  // Current sidebar rows carry the project's name and id as attributes; only
  // the open project still renders a /project link, so reading links alone
  // listed one project of nine (measured 2026-09-29).
  for (const row of document.querySelectorAll("[data-app-action-sidebar-project-row]")) {
    if (out.length >= 100) break;
    const rawId = (row.getAttribute("data-app-action-sidebar-project-id") || "").trim().toLowerCase();
    const name = (row.getAttribute("data-app-action-sidebar-project-label") || "").replace(/\\s+/g, " ").trim().slice(0, 200);
    if (!/^g-p-[0-9a-f]{1,128}$/.test(rawId) || !name || seen.has(rawId)) continue;
    seen.add(rawId);
    out.push({ id: rawId, name });
  }
  for (const anchor of document.querySelectorAll("a[href]")) {
    if (out.length >= 100) break;
    if (typeof anchor.getClientRects !== "function" || anchor.getClientRects().length === 0) continue;
    let url;
    try {
      url = new URL(anchor.getAttribute("href") || "", "https://chatgpt.com");
    } catch (error) {
      continue;
    }
    if (url.protocol !== "https:" || url.hostname !== "chatgpt.com" || url.port || url.username || url.password) continue;
    const match = /^\\/g\\/g-p-([0-9a-f]{1,128})(?:-[^/]+)?\\/project\\/?$/i.exec(url.pathname);
    if (!match) continue;
    const id = "g-p-" + match[1].toLowerCase();
    if (seen.has(id)) continue;
    const name = ((anchor.textContent || anchor.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim()).slice(0, 200);
    if (!name) continue;
    seen.add(id);
    out.push({ id, name });
  }
  return out;
})()`;
}

/**
 * The conversations that live inside a project. A project whose id is unknown
 * claims none: returning all of them listed unrelated chats under its name.
 */
export function conversationsInProject(conversations: ConversationSummary[], projectId: string | undefined): ConversationSummary[] {
  if (!projectId) return [];
  return conversations.filter((conversation) => conversation.gizmoId === projectId);
}

/**
 * Recent conversations with their titles, for the "continue an existing chat"
 * list. This is deliberately limited to rendered links; no account API or
 * transcript is read. A project association is included only when that same
 * visible conversation URL carries the project id.
 */
export function recentConversationTitlesExpression(limit = 10): string {
  const boundedLimit = Number.isFinite(limit) ? Math.max(0, Math.min(100, Math.floor(limit))) : 10;
  return `(() => {
  const out = [];
  const seen = new Map();
  const ambiguousProjects = new Set();
  let inspected = 0;
  for (const anchor of document.querySelectorAll("a[href]")) {
    if (++inspected > 2000) break;
    if (typeof anchor.getClientRects !== "function" || anchor.getClientRects().length === 0) continue;
    let url;
    try {
      url = new URL(anchor.getAttribute("href") || "", "https://chatgpt.com");
    } catch (error) {
      continue;
    }
    if (url.protocol !== "https:" || url.hostname !== "chatgpt.com" || url.port || url.username || url.password) continue;
    const projectMatch = /^\\/g\\/g-p-([0-9a-f]{1,128})(?:-[^/]+)?\\/c\\/([0-9a-f-]{16,128})\\/?$/i.exec(url.pathname);
    const plainMatch = /^\\/c\\/([0-9a-f-]{16,128})\\/?$/i.exec(url.pathname);
    const id = (projectMatch && projectMatch[2]) || (plainMatch && plainMatch[1]);
    if (!id) continue;
    const gizmoId = projectMatch ? "g-p-" + projectMatch[1].toLowerCase() : undefined;
    const existing = seen.get(id);
    if (existing) {
      if (gizmoId && !ambiguousProjects.has(id)) {
        if (existing.gizmoId && existing.gizmoId !== gizmoId) {
          delete existing.gizmoId;
          ambiguousProjects.add(id);
        } else existing.gizmoId = gizmoId;
      }
      continue;
    }
    if (out.length >= ${boundedLimit}) continue;
    const title = ((anchor.textContent || anchor.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim()).slice(0, 300) || "Untitled";
    const entry = {
      id,
      title,
      ...(gizmoId ? { gizmoId } : {})
    };
    seen.set(id, entry);
    out.push(entry);
  }
  return out;
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
  /** Lines the whole list may take, title and footer included; a longer list
   *  is shown as a window around the cursor. Omit to print every row. */
  maxLines?: number;
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

// Color codes take no columns, and must be carried through a cut whole.
const SGR_PATTERN = /^\u001b\[[0-9;]*m/;

// Wide (East Asian Width W) symbols outside the blocks charColumns checks as
// a whole: the emoji that are drawn as emoji without a selector, from
// Unicode's EastAsianWidth.txt. Found 2026-11-09: U+2705, U+2B50 and the like
// were counted one column, and terminals draw them two wide.
const WIDE_SYMBOLS: ReadonlyArray<readonly [number, number]> = [
  [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693],
  [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce],
  [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa],
  [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c],
  [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0],
  [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f202], [0x1f210, 0x1f23b],
  [0x1f240, 0x1f248], [0x1f250, 0x1f251], [0x1f260, 0x1f265]
];

const EMOJI_SELECTOR = 0xfe0f;

/**
 * Terminal columns a character takes: two for East Asian wide characters
 * (Hangul, CJK, full-width forms) and the common emoji, none for combining and
 * variation marks, one otherwise. Counting UTF-16 units instead put a Korean
 * conversation title at twice its allowance, so it wrapped into the next row.
 */
function charColumns(codePoint: number): number {
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if ((codePoint >= 0x300 && codePoint <= 0x36f) || codePoint === 0x200b || codePoint === 0x200d || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)) {
    return 0;
  }
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd) ||
    (codePoint >= 0x231a && WIDE_SYMBOLS.some(([first, last]) => codePoint >= first && codePoint <= last))
  ) {
    return 2;
  }
  return 1;
}

/**
 * Columns a character adds after one that took `previous`. The emoji selector
 * (U+FE0F) after a one-column symbol asks for the emoji, which terminals draw
 * two wide: U+2764 alone is a one-column heart, U+2764 U+FE0F a two-column one.
 */
function stepColumns(codePoint: number, previous: { codePoint: number; columns: number } | undefined): number {
  if (codePoint === EMOJI_SELECTOR) {
    return previous && previous.columns === 1 && previous.codePoint >= 0xa9 && previous.codePoint !== EMOJI_SELECTOR ? 1 : 0;
  }
  return charColumns(codePoint);
}

/** Columns a string takes on screen, ignoring color codes. */
export function displayWidth(text: string): number {
  let columns = 0;
  let previous: { codePoint: number; columns: number } | undefined;
  for (let index = 0; index < text.length; ) {
    const sgr = SGR_PATTERN.exec(text.slice(index));
    if (sgr) {
      index += sgr[0].length;
      continue;
    }
    const codePoint = text.codePointAt(index)!;
    const step = stepColumns(codePoint, previous);
    columns += step;
    previous = { codePoint, columns: step };
    index += codePoint > 0xffff ? 2 : 1;
  }
  return columns;
}

/** Pad with spaces to a number of columns, not of UTF-16 units. */
export function padEndToWidth(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

/**
 * Cut a line to the terminal rather than letting it wrap into a second row.
 * Counts columns, keeps color codes whole, never splits a character, and closes
 * a color the cut fell inside: a cut that dropped the reset left the rows
 * below in the label's color.
 */
export function truncateToWidth(text: string, width: number): string {
  if (width <= 0 || displayWidth(text) <= width) return text;
  const budget = width <= 3 ? width : width - 3;
  let out = "";
  let columns = 0;
  let colored = false;
  let previous: { codePoint: number; columns: number } | undefined;
  for (let index = 0; index < text.length; ) {
    const sgr = SGR_PATTERN.exec(text.slice(index));
    if (sgr) {
      out += sgr[0];
      colored = sgr[0] !== RESET;
      index += sgr[0].length;
      continue;
    }
    const codePoint = text.codePointAt(index)!;
    const step = stepColumns(codePoint, previous);
    // A selector that would not fit is left off: its symbol stays, one column.
    if (columns + step > budget) break;
    out += String.fromCodePoint(codePoint);
    columns += step;
    previous = { codePoint, columns: step };
    index += codePoint > 0xffff ? 2 : 1;
  }
  return `${out}${width <= 3 ? "" : "..."}${colored ? RESET : ""}`;
}

export function renderSelectList(input: SelectListInput): string {
  const color = input.color ?? true;
  const width = input.width ?? 100;
  const selected = new Set(input.selected ?? []);
  const step = input.step
    ? paint(`   Step ${input.step.index}${input.step.total ? ` of ${input.step.total}` : ""}`, DIM, color)
    : "";
  // The title and footer are cut like the rows: at 32 columns they wrapped.
  const lines = [truncateToWidth(`${paint(input.title, BOLD, color)}${step}`, width), ""];
  // Hints line up in their own column; ragged hints read as noise next to the
  // labels they belong to.
  const labelWidth = Math.max(...input.options.map((option) => displayWidth(option.label)), 0);
  // Numbers are right-aligned: "10" left-aligned like "9" pushed every label
  // from row 10 on a column to the right (found 2026-11-09).
  const ordinalWidth = String(input.options.length).length;
  const row = (option: SelectOption, index: number): string => {
    const onCursor = index === input.cursor;
    // A left bar reads as a cursor even once the row is colored, where a ">"
    // competes with the text. Rows that are not on the cursor keep the same
    // indent so nothing shifts as it moves.
    const bar = onCursor ? paint(CURSOR_BAR, ACCENT, color) : " ";
    // A number per row means a choice can be typed instead of arrowed to.
    const ordinal = paint(`${index + 1}`.padStart(ordinalWidth), onCursor ? ACCENT : DIM, color);
    const box = input.multi ? (selected.has(index) ? "[x] " : "[ ] ") : "";
    const label = onCursor ? paint(option.label, BOLD, color) : option.label;
    const base = ` ${bar} ${ordinal} ${box}${label}`;
    const gap = " ".repeat(Math.max(0, labelWidth - displayWidth(option.label)));
    // On a narrow terminal the hint gives way before the label does: a cut
    // from the right took "Keep the current selection" down to "Keep the
    // current sele..." to make room for a hint it then cut anyway.
    if (!option.hint || displayWidth(base) + gap.length + 4 + 4 > width) return truncateToWidth(base, width);
    return truncateToWidth(`${base}${gap}    ${paint(option.hint, DIM, color)}`, width);
  };
  const footerLines = input.footer ? 2 : 0;
  const room = input.maxLines === undefined ? Infinity : input.maxLines - lines.length - footerLines;
  if (input.options.length <= room) {
    input.options.forEach((option, index) => lines.push(row(option, index)));
  } else {
    // A list printed whole on a short terminal scrolled its own title and the
    // cursor off the top (found 2026-11-09: 25 projects at 24 rows). Show the
    // rows around the cursor, with a line above and below saying how many are
    // out of view; those two lines are always there, so rows do not jump as
    // the window starts to move.
    const visible = Math.max(1, room - 2);
    const cursor = Math.min(Math.max(input.cursor, 0), input.options.length - 1);
    const start = Math.min(Math.max(0, cursor - Math.floor(visible / 2)), input.options.length - visible);
    const end = start + visible;
    const indent = " ".repeat(3 + ordinalWidth + 1);
    lines.push(start > 0 ? truncateToWidth(paint(`${indent}... ${start} more above`, DIM, color), width) : "");
    input.options.slice(start, end).forEach((option, offset) => lines.push(row(option, start + offset)));
    const below = input.options.length - end;
    lines.push(below > 0 ? truncateToWidth(paint(`${indent}... ${below} more below`, DIM, color), width) : "");
  }
  if (input.footer) lines.push("", truncateToWidth(paint(input.footer, DIM, color), width));
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
  const inner = Math.min(Math.max(...texts.map((text) => displayWidth(text)), 0), Math.max(20, (options.width ?? 72) - 2));
  const body = texts.map((text) => `│${padEndToWidth(truncateToWidth(text, inner), inner)}│`);
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
  /** The terminal's width; the line is kept narrower than it. */
  columns?: number;
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
  let compose: (label: string) => string;
  if (!input.budgetMs || input.budgetMs <= 0) {
    compose = (label) => `${spinner} ${label}  ${elapsed}  ${stop}`;
  } else {
    const width = Math.max(4, input.width ?? 28);
    const ratio = input.elapsedMs / input.budgetMs;
    const filled = Math.min(width, Math.round(Math.min(ratio, 1) * width));
    const bar = `${"#".repeat(filled)}${"-".repeat(width - filled)}`;
    const over = ratio > 1 ? "  over budget" : "";
    const budget = formatElapsed(input.budgetMs);
    compose = (label) => `${spinner} [${bar}] ${elapsed} / ${budget}  ${label}${over}  ${stop}`;
  }
  const line = compose(input.label);
  if (input.columns === undefined || displayWidth(line) < input.columns) return line;
  // The line is redrawn in place, and one that wraps leaves a row behind on
  // every redraw (found 2026-11-09: 102 columns at 80, a new row every 250
  // ms). The label gives way first; a terminal too narrow even for the rest
  // gets the line cut.
  const room = input.columns - 1 - displayWidth(compose(""));
  return truncateToWidth(compose(room > 0 ? truncateToWidth(input.label, room) : ""), input.columns - 1);
}
