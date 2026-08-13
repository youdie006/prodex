/**
 * The interactive shell around the pure pickers in `tui.ts`.
 *
 * Node's readline in raw mode is enough for a list picker, so the package keeps
 * carrying no UI dependency. Everything here is I/O; the decisions it collects
 * are turned into a normal command line by `consultArgsFromChoices`, which is
 * what keeps the interactive path from drifting away from the documented flags.
 */
import readline from "node:readline";
import {
  consultArgsFromChoices,
  moveCursor,
  renderContextPanel,
  renderProgressBar,
  renderSelectList,
  toggleSelection,
  type ConsultChoices,
  type ContextRow,
  type ProjectMode,
  type SelectListInput
} from "./tui.js";

const ESC = "";
const CLEAR = `${ESC}[2J${ESC}[H`;
// The alternate screen buffer: the terminal comes back exactly as it was, so a
// picker does not shove the user's scrollback off the top.
const ALT_SCREEN_ON = `${ESC}[?1049h`;
const ALT_SCREEN_OFF = `${ESC}[?1049l`;
const CLEAR_LINE = `${ESC}[2K\r`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;

interface Key {
  name?: string;
  ctrl?: boolean;
}

export interface TuiIo {
  write: (text: string) => void;
  input: NodeJS.ReadStream;
}

function readKey(io: TuiIo): Promise<Key> {
  return new Promise((resolve) => {
    const onKey = (_str: string, key: Key): void => {
      io.input.off("keypress", onKey);
      resolve(key ?? {});
    };
    io.input.on("keypress", onKey);
  });
}

function isCancel(key: Key): boolean {
  return (key.ctrl === true && key.name === "c") || key.name === "escape" || key.name === "q";
}

// Terminals disagree about the Enter key: a carriage return arrives as
// "return", a line feed as "enter". Accept either, or the picker looks frozen.
function isConfirm(key: Key): boolean {
  return key.name === "return" || key.name === "enter";
}

async function pick(io: TuiIo, input: Omit<SelectListInput, "cursor">, header = ""): Promise<number | undefined> {
  let cursor = 0;
  for (;;) {
    io.write(
      CLEAR +
        header +
        renderSelectList({
          ...input,
          cursor,
          width: terminalWidth(),
          color: colorEnabled(),
          footer: "  up/down move   1-9 choose directly   enter confirm   q cancel"
        }) +
        "\n"
    );
    const key = await readKey(io);
    if (isCancel(key)) return undefined;
    const typed = numericChoice(key, input.options.length);
    if (typed !== undefined) return typed;
    if (key.name === "up" || key.name === "k") cursor = moveCursor(cursor, "up", input.options.length);
    else if (key.name === "down" || key.name === "j") cursor = moveCursor(cursor, "down", input.options.length);
    else if (isConfirm(key)) return cursor;
  }
}

function terminalWidth(): number {
  return Math.max(40, Math.min(process.stdout.columns ?? 100, 120));
}

function colorEnabled(): boolean {
  return process.stdout.isTTY === true && !process.env.NO_COLOR;
}

// Typing the row number is faster than arrowing to it, and matches how the
// pickers this sits beside are driven.
function numericChoice(key: Key, length: number): number | undefined {
  const digit = Number(key.name);
  if (!Number.isInteger(digit) || digit < 1 || digit > Math.min(9, length)) return undefined;
  return digit - 1;
}

async function pickMany(io: TuiIo, input: Omit<SelectListInput, "cursor" | "multi">, header = ""): Promise<number[] | undefined> {
  let cursor = 0;
  let selected: number[] = [];
  for (;;) {
    io.write(
      CLEAR +
        header +
        renderSelectList({
          ...input,
          cursor,
          selected,
          multi: true,
          width: terminalWidth(),
          color: colorEnabled(),
          footer: "  space toggle   1-9 toggle directly   enter confirm (none is fine)   q cancel"
        }) +
        "\n"
    );
    const key = await readKey(io);
    if (isCancel(key)) return undefined;
    const typed = numericChoice(key, input.options.length);
    if (typed !== undefined) selected = toggleSelection(selected, typed);
    else if (key.name === "up" || key.name === "k") cursor = moveCursor(cursor, "up", input.options.length);
    else if (key.name === "down" || key.name === "j") cursor = moveCursor(cursor, "down", input.options.length);
    else if (key.name === "space") selected = toggleSelection(selected, cursor);
    else if (isConfirm(key)) return selected;
  }
}

/** Read one line with the terminal back in cooked mode, so editing works. */
async function askLine(io: TuiIo, question: string): Promise<string> {
  io.input.setRawMode?.(false);
  const rl = readline.createInterface({ input: io.input, output: process.stdout, terminal: true });
  const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
  rl.close();
  // Closing the line reader detaches the keypress plumbing and pauses the
  // stream, so the next picker would sit there ignoring every key. Re-arm both.
  io.input.setRawMode?.(true);
  readline.emitKeypressEvents(io.input);
  io.input.resume();
  return answer.trim();
}

const TOOL_CHOICES: Array<{ id: string; label: string; hint?: string }> = [
  { id: "deep-research", label: "Deep research", hint: "browsed report, runs about 10 minutes" },
  { id: "web-search", label: "Web search", hint: "current facts, with sources" },
  { id: "create-image", label: "Create image" }
];

export interface InteractiveDeps {
  /** What the send will use if nothing is overridden, shown before any question. */
  describeContext?: () => Promise<ContextRow[]>;
  listProjects: () => Promise<string[]>;
  runConsult: (args: string[], onProgress: (line: string) => void) => Promise<number>;
  now?: () => number;
}

/**
 * Walk the questions a send needs, then run it with a moving progress bar.
 * Returns the process exit code.
 */
export async function runInteractiveConsult(io: TuiIo, deps: InteractiveDeps): Promise<number> {
  const now = deps.now ?? Date.now;
  readline.emitKeypressEvents(io.input);
  io.input.setRawMode?.(true);
  io.input.resume();
  io.write(ALT_SCREEN_ON + HIDE_CURSOR);
  let header = "";
  try {
    io.write(CLEAR);
    // Show what the send will use before asking anything: choosing a project or
    // a tool without knowing the model, or whether the browser is even up, is
    // choosing blind - and a browser failure after four questions wastes all four.
    if (deps.describeContext) {
      try {
        const rows = await deps.describeContext();
        if (rows.length > 0) header = `${renderContextPanel(rows, { color: colorEnabled(), width: terminalWidth() })}\n\n`;
      } catch {
        // Context is a courtesy; never let it block the consult.
      }
    }
    const prompt = await askLine(io, `${header}Ask ChatGPT Pro\n\n  prompt: `);
    if (prompt.length === 0) {
      io.write("Nothing to ask.\n");
      return 1;
    }

    const projectChoice = await pick(io, {
      title: "Where should this consult land?",
      step: { index: 1, total: 3 },
      options: [
        { label: "The chat that is already open", hint: "keeps the thread's context" },
        { label: "An existing project" },
        { label: "A new project" },
        { label: "No project", hint: "plain chat list, ignores a pinned default" }
      ]
    }, header);
    if (projectChoice === undefined) return cancel(io);

    const modes: ProjectMode[] = ["current", "existing", "new", "none"];
    const projectMode = modes[projectChoice];
    let projectName: string | undefined;
    if (projectMode === "existing") {
      const projects = await deps.listProjects();
      if (projects.length === 0) {
        io.write("\nNo projects are visible in the ChatGPT sidebar.\n");
        return 1;
      }
      const chosen = await pick(io, {
        title: "Which project?",
        options: projects.map((name) => ({ label: name }))
      }, header);
      if (chosen === undefined) return cancel(io);
      projectName = projects[chosen];
    } else if (projectMode === "new") {
      projectName = await askLine(io, `${CLEAR}New project\n\n  name: `);
      if (!projectName) return cancel(io);
    }

    const toolChoice = await pickMany(io, {
      title: "Turn on any composer tools for this send",
      step: { index: 2, total: 3 },
      options: TOOL_CHOICES.map((tool) => ({ label: tool.label, ...(tool.hint ? { hint: tool.hint } : {}) }))
    }, header);
    if (toolChoice === undefined) return cancel(io);
    const tools = toolChoice.map((index) => TOOL_CHOICES[index].id);

    const threadChoice = await pick(io, {
      title: "Start a fresh thread?",
      step: { index: 3, total: 3 },
      options: [
        { label: "Continue the current thread", hint: "follow-ups keep context" },
        { label: "Start a new chat", hint: "recommended for an unrelated question" }
      ]
    }, header);
    if (threadChoice === undefined) return cancel(io);

    const choices: ConsultChoices = {
      prompt,
      projectMode,
      ...(projectName ? { projectName } : {}),
      tools,
      newChat: threadChoice === 1
    };
    const args = consultArgsFromChoices(choices);

    // Leave the alternate screen before the send: the answer, the receipt id
    // and any blocker belong in the scrollback the user keeps.
    io.write(ALT_SCREEN_OFF + SHOW_CURSOR);
    io.write(`Sending. Equivalent command:\n  prodex ${formatCommand(args)}\n\n`);

    // Deep research runs about ten minutes; an ordinary Pro answer, minutes.
    // Fill the bar against that so the wait has a shape.
    const budgetMs = tools.includes("deep-research") ? 30 * 60_000 : 20 * 60_000;
    const startedAt = now();
    let label = "starting";
    let tick = 0;
    const timer = setInterval(() => {
      tick += 1;
      io.write(
        CLEAR_LINE +
          renderProgressBar({ elapsedMs: now() - startedAt, budgetMs, label, tick, width: Math.min(28, terminalWidth() - 52) })
      );
    }, 250);
    try {
      const code = await deps.runConsult(args, (line) => {
        label = line.replace(/^progress:\s*/, "").slice(0, 60);
      });
      clearInterval(timer);
      io.write(CLEAR_LINE);
      return code;
    } catch (error) {
      clearInterval(timer);
      io.write(CLEAR_LINE);
      throw error;
    }
  } finally {
    io.write(ALT_SCREEN_OFF + SHOW_CURSOR);
    io.input.setRawMode?.(false);
    io.input.pause();
  }
}

function cancel(io: TuiIo): number {
  io.write("\nCancelled.\n");
  return 130;
}

/** Quote only what a shell would need quoted, so the echo can be pasted. */
export function formatCommand(args: string[]): string {
  return args.map((arg) => (/^[A-Za-z0-9._\-/:=]+$/.test(arg) ? arg : JSON.stringify(arg))).join(" ");
}
