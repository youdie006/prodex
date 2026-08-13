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
  tools: string[];
  newChat: boolean;
  attachments?: string[];
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
  if (choices.newChat) args.push("--new-chat");
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
}

export function renderSelectList(input: SelectListInput): string {
  const selected = new Set(input.selected ?? []);
  const lines = [input.title, ""];
  // Hints line up in their own column; ragged hints read as noise next to the
  // labels they belong to.
  const labelWidth = Math.max(...input.options.map((option) => option.label.length), 0);
  input.options.forEach((option, index) => {
    const pointer = index === input.cursor ? ">" : " ";
    const box = input.multi ? (selected.has(index) ? "[x] " : "[ ] ") : "";
    const hint = option.hint ? `${" ".repeat(labelWidth - option.label.length)}    ${option.hint}` : "";
    lines.push(`  ${pointer} ${box}${option.label}${hint}`);
  });
  if (input.footer) lines.push("", input.footer);
  return lines.join("\n");
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

export interface ProgressBarInput {
  elapsedMs: number;
  /** Omit when the wait has no meaningful budget to fill against. */
  budgetMs?: number;
  label: string;
  width?: number;
}

/**
 * A Pro consult can run for many minutes with nothing on screen. The bar fills
 * against the send's own budget, and says so plainly once the wait outlives it
 * rather than sitting at 100% pretending to be finished.
 */
export function renderProgressBar(input: ProgressBarInput): string {
  const elapsed = formatElapsed(input.elapsedMs);
  if (!input.budgetMs || input.budgetMs <= 0) return `${input.label}  ${elapsed}`;
  const width = Math.max(4, input.width ?? 28);
  const ratio = input.elapsedMs / input.budgetMs;
  const filled = Math.min(width, Math.round(Math.min(ratio, 1) * width));
  const bar = `${"#".repeat(filled)}${"-".repeat(width - filled)}`;
  const over = ratio > 1 ? "  over budget" : "";
  return `[${bar}] ${elapsed} / ${formatElapsed(input.budgetMs)}  ${input.label}${over}`;
}
