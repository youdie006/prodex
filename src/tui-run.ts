/**
 * The interactive shell around the pure pickers in `tui.ts`.
 *
 * Node's readline in raw mode is enough for a list picker, so the package keeps
 * carrying no UI dependency. Everything here is I/O; the decisions it collects
 * are turned into a normal command line by `consultArgsFromChoices`, which is
 * what keeps the interactive path from drifting away from the documented flags.
 */
import readline from "node:readline";
import { renderBanner } from "./banner.js";
import { destinationChoices, effortChoices, SEND_KINDS, type DestinationId } from "./tui-flow.js";
import {
  consultArgsFromChoices,
  conversationsInProject,
  conversationThreadUrl,
  moveCursor,
  parseAttachmentLine,
  progressLabel,
  recentConversationTitlesExpression,
  renderContextPanel,
  renderProgressBar,
  renderSelectList,
  type ConsultChoices,
  type ContextRow,
  type ConversationSummary,
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

/**
 * Keys are queued by one long-lived listener rather than a listener attached
 * per read.
 *
 * Attaching on demand drops every key pressed while nothing is waiting - during
 * a redraw, or across the seconds it takes to read the project list out of the
 * browser. Measured by using it: the first key after the prompt vanished, so
 * "4" (no project) was swallowed and the next key landed on the wrong row.
 */
class KeyQueue {
  private readonly pending: Key[] = [];
  private waiting: ((key: Key) => void) | undefined;

  constructor(private readonly input: NodeJS.ReadStream) {
    this.input.on("keypress", this.onKey);
  }

  private onKey = (_str: string, key: Key): void => {
    const value = key ?? {};
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve(value);
      return;
    }
    this.pending.push(value);
  };

  next(): Promise<Key> {
    const buffered = this.pending.shift();
    if (buffered) return Promise.resolve(buffered);
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }

  /** Drop keys typed before a screen existed to receive them. */
  drain(): void {
    this.pending.length = 0;
  }

  dispose(): void {
    this.input.off("keypress", this.onKey);
  }
}

let keys: KeyQueue | undefined;

function readKey(_io: TuiIo): Promise<Key> {
  if (!keys) throw new Error("The key reader is not running.");
  return keys.next();
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
  keys?.drain();
  return answer.trim();
}

export interface InteractiveDeps {
  /** What the send will use if nothing is overridden, shown before any question. */
  describeContext?: () => Promise<ContextRow[]>;
  /** Pinned project name, so the destination screen can say where "new chat" goes. */
  pinnedProject?: () => Promise<string | undefined>;
  /** Pinned model name, so the reasoning screen can name what "keep" means. */
  pinnedModel?: () => Promise<string | undefined>;
  listConversations?: () => Promise<ConversationSummary[]>;
  /** Move the dedicated tab onto a picked conversation before sending. */
  openThread?: (url: string) => Promise<boolean>;
  /** Projects with the id their conversations carry, for "open the project". */
  listProjectsWithIds?: () => Promise<Array<{ id: string; name: string }>>;
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
  keys = new KeyQueue(io.input);
  io.write(ALT_SCREEN_ON + HIDE_CURSOR);
  let header = "";
  try {
    // The logo is the program saying which program it is; the panel says what
    // this send will use. Both belong above the first question, not nowhere.
    const banner = colorEnabled() ? `${renderBanner({ color: true })}\n` : "";
    io.write(CLEAR + banner);
    // Everything the later screens need is fetched while the first question is
    // being read, so no step waits on the network.
    const contextPromise = deps.describeContext?.().catch(() => [] as ContextRow[]);
    const pinnedPromise = deps.pinnedProject?.().catch(() => undefined);
    const pinnedModelPromise = deps.pinnedModel?.().catch(() => undefined);
    const conversationsPromise = deps.listConversations?.().catch(() => [] as ConversationSummary[]);

    // A normal chat asks one more question than the tool kinds do, so how many
    // steps remain is not known until this first answer is given.
    const totalSteps = 4;
    const kindChoice = await pick(
      io,
      {
        title: "What kind of send is this?",
        step: { index: 1 },
        options: SEND_KINDS.map((kind) => ({ label: kind.label, ...(kind.hint ? { hint: kind.hint } : {}) }))
      },
      banner
    );
    if (kindChoice === undefined) return cancel(io);
    const tools = SEND_KINDS[kindChoice].tools;

    // Only an ordinary chat has a reasoning level to choose: the tool kinds
    // bring their own pipeline, and an effort would deselect Pro under them.
    let effort: string | undefined;
    const asksReasoning = SEND_KINDS[kindChoice].id === "chat";
    const steps = asksReasoning ? totalSteps : totalSteps - 1;
    if (asksReasoning) {
      const efforts = effortChoices(await pinnedModelPromise);
      const chosen = await pick(
        io,
        {
          title: "How much reasoning?",
          step: { index: 2, total: steps },
          options: efforts.map((entry) => ({ label: entry.label, ...(entry.hint ? { hint: entry.hint } : {}) }))
        },
        banner
      );
      if (chosen === undefined) return cancel(io);
      effort = efforts[chosen].effort;
    }

    const rows = (await contextPromise) ?? [];
    if (rows.length > 0) header = `${banner}${renderContextPanel(rows, { color: colorEnabled(), width: terminalWidth() })}\n\n`;
    else header = banner;

    const pinnedProject = await pinnedPromise;
    const destinations = destinationChoices(pinnedProject);
    const destinationChoice = await pick(
      io,
      {
        title: "Where should it go?",
        step: { index: asksReasoning ? 3 : 2, total: steps },
        options: destinations.map((entry) => ({ label: entry.label, ...(entry.hint ? { hint: entry.hint } : {}) }))
      },
      header
    );
    if (destinationChoice === undefined) return cancel(io);
    const destination: DestinationId = destinations[destinationChoice].id;

    let projectMode: ProjectMode = "current";
    let projectName: string | undefined;
    let targetUrl: string | undefined;
    if (destination === "continue") {
      const conversations = (await conversationsPromise) ?? [];
      if (conversations.length === 0) {
        io.write("\nNo recent conversations were readable. Start a new chat instead.\n");
        return 1;
      }
      const chosen = await pick(
        io,
        { title: "Which conversation?", options: conversations.map((entry) => ({ label: entry.title })) },
        header
      );
      if (chosen === undefined) return cancel(io);
      targetUrl = conversationThreadUrl(conversations[chosen].id);
    } else if (destination === "project") {
      const detailed = (await deps.listProjectsWithIds?.()) ?? [];
      const projects = detailed.length > 0 ? detailed : (await deps.listProjects()).map((name) => ({ id: "", name }));
      if (projects.length === 0) {
        io.write("\nNo projects are visible in the ChatGPT sidebar.\n");
        return 1;
      }
      const chosen = await pick(io, { title: "Which project?", options: projects.map((entry) => ({ label: entry.name })) }, header);
      if (chosen === undefined) return cancel(io);
      projectMode = "existing";
      projectName = projects[chosen].name;

      // Entering a project usually means going back to something in it, so
      // offer its chats before starting yet another one.
      const inside = conversationsInProject((await conversationsPromise) ?? [], projects[chosen].id || undefined);
      if (inside.length > 0) {
        const options = [
          { label: "Start a new chat in this project" },
          ...inside.map((entry) => ({ label: entry.title }))
        ];
        const picked = await pick(io, { title: `${projects[chosen].name}`, options }, header);
        if (picked === undefined) return cancel(io);
        if (picked > 0) {
          targetUrl = conversationThreadUrl(inside[picked - 1].id);
          projectMode = "current";
          projectName = undefined;
        }
      }
    } else if (destination === "project-new") {
      projectName = await askLine(io, `${CLEAR}${header}New project\n\n  name: `);
      if (!projectName) return cancel(io);
      projectMode = "new";
    } else if (destination === "no-project") {
      projectMode = "none";
    }

    // The prompt comes last: what you type depends on what you just decided.
    io.write(CLEAR + header + SHOW_CURSOR);
    const kindLabel = SEND_KINDS[kindChoice].label;
    const prompt = await askLine(io, `${kindLabel}   Step ${steps} of ${steps}\n\n  prompt: `);
    io.write(HIDE_CURSOR);
    if (prompt.length === 0) {
      io.write("Nothing to ask.\n");
      return 1;
    }

    // Uploading a file is the only way ChatGPT can open a pdf, pptx, xlsx or
    // image, and the picker had no way to say so. Asked after the prompt, and
    // skipped by pressing enter, so the common case costs one keystroke.
    io.write(SHOW_CURSOR);
    const attachments = parseAttachmentLine(
      await askLine(io, "\n  attach files? repo-relative paths, space separated, enter to skip\n  files: ")
    );
    io.write(HIDE_CURSOR);

    const choices: ConsultChoices = {
      prompt,
      projectMode,
      ...(projectName ? { projectName } : {}),
      ...(targetUrl ? { targetUrl } : {}),
      ...(effort ? { effort } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      tools,
      newChat: !targetUrl
    };
    const args = consultArgsFromChoices(choices);

    // Leave the alternate screen before the send: the answer, the receipt id
    // and any blocker belong in the scrollback the user keeps.
    io.write(ALT_SCREEN_OFF + SHOW_CURSOR);
    // Hand the terminal back too. Raw mode is what let the pickers read single
    // keys, and it also turns off the terminal's own ctrl-c: the key arrives as
    // a keypress nothing is waiting for. The progress bar promises "ctrl-c to
    // stop", and under raw mode that promise was false for the whole ten
    // minutes a deep research send runs. No key is read from here on.
    io.input.setRawMode?.(false);
    // --target-url confirms which conversation a send means; it deliberately
    // does not navigate. Picking one from a list IS a request to go there, so
    // move the tab first and let the flag confirm it landed.
    if (targetUrl && deps.openThread) {
      io.write("Opening the conversation you picked...\n");
      if (!(await deps.openThread(targetUrl))) {
        io.write(`Could not open ${targetUrl} in the dedicated browser.\n`);
        return 1;
      }
    }
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
        label = progressLabel(line).slice(0, 60);
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
    keys?.dispose();
    keys = undefined;
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
