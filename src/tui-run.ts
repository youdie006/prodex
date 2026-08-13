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
  renderProgressBar,
  renderSelectList,
  toggleSelection,
  type ConsultChoices,
  type ProjectMode,
  type SelectListInput
} from "./tui.js";

const ESC = "";
const CLEAR = `${ESC}[2J${ESC}[H`;
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

async function pick(io: TuiIo, input: Omit<SelectListInput, "cursor">): Promise<number | undefined> {
  let cursor = 0;
  for (;;) {
    io.write(CLEAR + renderSelectList({ ...input, cursor, footer: "  up/down move, enter choose, q cancel" }) + "\n");
    const key = await readKey(io);
    if (isCancel(key)) return undefined;
    if (key.name === "up" || key.name === "k") cursor = moveCursor(cursor, "up", input.options.length);
    else if (key.name === "down" || key.name === "j") cursor = moveCursor(cursor, "down", input.options.length);
    else if (isConfirm(key)) return cursor;
  }
}

async function pickMany(io: TuiIo, input: Omit<SelectListInput, "cursor" | "multi">): Promise<number[] | undefined> {
  let cursor = 0;
  let selected: number[] = [];
  for (;;) {
    io.write(
      CLEAR +
        renderSelectList({
          ...input,
          cursor,
          selected,
          multi: true,
          footer: "  space toggle, enter confirm (none is fine), q cancel"
        }) +
        "\n"
    );
    const key = await readKey(io);
    if (isCancel(key)) return undefined;
    if (key.name === "up" || key.name === "k") cursor = moveCursor(cursor, "up", input.options.length);
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
  io.write(HIDE_CURSOR);
  try {
    io.write(CLEAR);
    const prompt = await askLine(io, "Ask ChatGPT Pro\n\n  prompt: ");
    if (prompt.length === 0) {
      io.write("Nothing to ask.\n");
      return 1;
    }

    const projectChoice = await pick(io, {
      title: "Where should this consult land?",
      options: [
        { label: "The chat that is already open", hint: "keeps the thread's context" },
        { label: "An existing project" },
        { label: "A new project" },
        { label: "No project", hint: "plain chat list, ignores a pinned default" }
      ]
    });
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
      });
      if (chosen === undefined) return cancel(io);
      projectName = projects[chosen];
    } else if (projectMode === "new") {
      projectName = await askLine(io, `${CLEAR}New project\n\n  name: `);
      if (!projectName) return cancel(io);
    }

    const toolChoice = await pickMany(io, {
      title: "Turn on any composer tools for this send",
      options: TOOL_CHOICES.map((tool) => ({ label: tool.label, ...(tool.hint ? { hint: tool.hint } : {}) }))
    });
    if (toolChoice === undefined) return cancel(io);
    const tools = toolChoice.map((index) => TOOL_CHOICES[index].id);

    const threadChoice = await pick(io, {
      title: "Start a fresh thread?",
      options: [
        { label: "Continue the current thread", hint: "follow-ups keep context" },
        { label: "Start a new chat", hint: "recommended for an unrelated question" }
      ]
    });
    if (threadChoice === undefined) return cancel(io);

    const choices: ConsultChoices = {
      prompt,
      projectMode,
      ...(projectName ? { projectName } : {}),
      tools,
      newChat: threadChoice === 1
    };
    const args = consultArgsFromChoices(choices);

    io.write(CLEAR + SHOW_CURSOR);
    io.write(`Sending. Equivalent command:\n  prodex ${formatCommand(args)}\n\n`);

    // Deep research runs about ten minutes; an ordinary Pro answer, minutes.
    // Fill the bar against that so the wait has a shape.
    const budgetMs = tools.includes("deep-research") ? 30 * 60_000 : 20 * 60_000;
    const startedAt = now();
    let label = "starting";
    const timer = setInterval(() => {
      io.write(CLEAR_LINE + renderProgressBar({ elapsedMs: now() - startedAt, budgetMs, label }));
    }, 500);
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
    io.write(SHOW_CURSOR);
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
