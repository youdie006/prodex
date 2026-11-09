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
import { shellQuote } from "./cli-args.js";
import { destinationChoices, effortChoices, SEND_KINDS, type DestinationId } from "./tui-flow.js";
import {
  consultArgsFromChoices,
  conversationsInProject,
  conversationThreadUrl,
  displayWidth,
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
// Bracketed paste: the terminal wraps a paste in ESC[200~ ... ESC[201~, which
// readline reports as "paste-start" and "paste-end" keys and otherwise ignores.
const BRACKETED_PASTE_ON = `${ESC}[?2004h`;
const BRACKETED_PASTE_OFF = `${ESC}[?2004l`;
// How long an Enter at the prompt waits before it ends the prompt. A terminal
// that does not mark pastes sends one as typed keys, its line breaks included,
// and the rest of it follows in the same read or milliseconds later; a person
// does not type the next key that fast.
const PASTE_SETTLE_MS = 100;

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
  private ended = false;

  constructor(private readonly input: NodeJS.ReadStream) {
    this.input.on("keypress", this.onKey);
    this.input.on("end", this.onEnd);
    this.input.on("close", this.onEnd);
    if (this.input.readableEnded || this.input.destroyed) this.onEnd();
  }

  private onKey = (_str: string, key: Key): void => {
    if (this.ended) return;
    const value = key ?? {};
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve(value);
      return;
    }
    this.pending.push(value);
  };

  private onEnd = (): void => {
    this.ended = true;
    this.pending.length = 0;
    const resolve = this.waiting;
    this.waiting = undefined;
    resolve?.({ name: "c", ctrl: true });
  };

  next(): Promise<Key> {
    if (this.ended) return Promise.resolve({ name: "c", ctrl: true });
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
    this.input.off("end", this.onEnd);
    this.input.off("close", this.onEnd);
  }
}

let keys: KeyQueue | undefined;

function readKey(_io: TuiIo): Promise<Key> {
  if (!keys) throw new Error("The key reader is not running.");
  return keys.next();
}

function isCancel(key: Key): boolean {
  return (key.ctrl === true && (key.name === "c" || key.name === "d")) || key.name === "escape" || key.name === "q";
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

/**
 * Read one answer with the terminal back in line-editing mode, so editing works.
 *
 * `multiline` is for the prompt, which is often pasted. readline ends a line at
 * every line break, so a pasted stack trace used to be sent as its first line
 * and the rest dropped. With it, a paste's line breaks stay in the answer and
 * only an Enter typed on its own ends it.
 */
async function askLine(io: TuiIo, question: string, options: { multiline?: boolean } = {}): Promise<string | undefined> {
  io.input.setRawMode?.(false);
  const rl = readline.createInterface({ input: io.input, output: process.stdout, terminal: true, historySize: 0 });
  // Later lines of a prompt sit under its first line, not at the margin.
  const continuation = " ".repeat(displayWidth(question.slice(question.lastIndexOf("\n") + 1)));
  try {
    if (options.multiline) io.write(BRACKETED_PASTE_ON);
    const answer = await new Promise<string | undefined>((resolve) => {
      const lines: string[] = [];
      let pasting = false;
      let previousKey: string | undefined;
      let ending: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      function settle(value: string | undefined): void {
        if (settled) return;
        settled = true;
        clearTimeout(ending);
        rl.off("SIGINT", onInterrupt);
        rl.off("close", onClose);
        rl.off("line", onLine);
        io.input.off("keypress", onKey);
        resolve(value);
      }
      function onInterrupt(): void {
        settle(undefined);
      }
      function onClose(): void {
        settle(undefined);
      }
      // Sees each key before readline does.
      function onKey(_text: string | undefined, key: Key | undefined): void {
        const name = key?.name;
        // A line feed straight after a carriage return is the same Enter.
        const sameEnter = name === "enter" && previousKey === "return";
        previousKey = name;
        // Input right behind an Enter means the Enter was a line break inside a
        // paste the terminal did not mark, so the prompt goes on.
        if (ending !== undefined && !sameEnter) {
          clearTimeout(ending);
          ending = undefined;
        }
        if (name === "paste-start") pasting = true;
        else if (name === "paste-end") pasting = false;
      }
      function onLine(line: string): void {
        if (!options.multiline) {
          settle(line);
          return;
        }
        lines.push(line);
        rl.setPrompt(continuation);
        rl.prompt();
        if (!pasting) ending = setTimeout(() => settle(lines.join("\n")), PASTE_SETTLE_MS);
      }
      rl.once("SIGINT", onInterrupt);
      rl.once("close", onClose);
      rl.on("line", onLine);
      if (options.multiline) io.input.prependListener("keypress", onKey);
      rl.setPrompt(question);
      rl.prompt();
    });
    return answer?.trim();
  } finally {
    rl.close();
    // Turned off on every way out, ctrl-c and end of input included: left on,
    // the shell would receive the markers around every later paste.
    if (options.multiline) io.write(BRACKETED_PASTE_OFF);
    // Closing the line reader detaches the keypress plumbing and pauses the
    // stream, so the next picker would sit there ignoring every key. Re-arm both.
    io.input.setRawMode?.(true);
    readline.emitKeypressEvents(io.input);
    io.input.resume();
    keys?.drain();
  }
}

export interface InteractiveDeps {
  /** What the send will use if nothing is overridden, shown before any question. */
  describeContext?: () => Promise<ContextRow[]>;
  /** Pinned project name, so the destination screen can say where "new chat" goes. */
  pinnedProject?: () => Promise<string | undefined>;
  /** Pinned model name, so the reasoning screen can name what "keep" means. */
  pinnedModel?: () => Promise<string | undefined>;
  listConversations?: () => Promise<ConversationSummary[]>;
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
  // Every question here is answered with a keystroke, so a stdin that cannot
  // deliver one has to be turned away at the door. Measured with stdin
  // redirected: the picker painted the alternate screen, hid the cursor, and
  // waited forever for a key that could not arrive - and never returning meant
  // the screen was never restored either, leaving a terminal that needed
  // `reset`.
  if (io.input.isTTY !== true) {
    io.write("The picker reads single keystrokes, so it needs a terminal on stdin.\n");
    io.write('Send without one: prodex pro browser ask "your prompt"\n');
    return 1;
  }
  const now = deps.now ?? Date.now;
  readline.emitKeypressEvents(io.input);
  io.input.setRawMode?.(true);
  io.input.resume();
  keys = new KeyQueue(io.input);
  io.write(ALT_SCREEN_ON + HIDE_CURSOR);
  let header = "";
  // Why the picker stopped is written once the alternate screen is gone.
  // Written while it was up, the reason vanished with it and the picker exited
  // with nothing on screen.
  let farewell = "";
  const leave = (message: string, code: number): number => {
    farewell = message;
    return code;
  };
  const cancel = (): number => leave("Cancelled.\n", 130);
  // Leaving it twice put the cursor back where the picker opened, and the
  // shell prompt was drawn over the echoed command (found 2026-11-09).
  let onAltScreen = true;
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
    if (kindChoice === undefined) return cancel();
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
      if (chosen === undefined) return cancel();
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
    if (destinationChoice === undefined) return cancel();
    const destination: DestinationId = destinations[destinationChoice].id;

    let projectMode: ProjectMode = "current";
    let projectName: string | undefined;
    let targetUrl: string | undefined;
    if (destination === "continue") {
      const conversations = (await conversationsPromise) ?? [];
      if (conversations.length === 0) return leave("No recent conversations were readable. Start a new chat instead.\n", 1);
      const chosen = await pick(
        io,
        { title: "Which conversation?", options: conversations.map((entry) => ({ label: entry.title })) },
        header
      );
      if (chosen === undefined) return cancel();
      targetUrl = conversationThreadUrl(conversations[chosen].id);
    } else if (destination === "project") {
      const detailed = (await deps.listProjectsWithIds?.()) ?? [];
      const projects = detailed.length > 0 ? detailed : (await deps.listProjects()).map((name) => ({ id: "", name }));
      if (projects.length === 0) return leave("No projects are visible in the ChatGPT sidebar.\n", 1);
      const chosen = await pick(io, { title: "Which project?", options: projects.map((entry) => ({ label: entry.name })) }, header);
      if (chosen === undefined) return cancel();
      projectMode = "existing";
      projectName = projects[chosen].name;

      // Entering a project usually means going back to something in it, so
      // offer its chats before starting yet another one. A project listed by
      // name alone has no id to match them by, so it goes straight to a new chat.
      const inside = conversationsInProject((await conversationsPromise) ?? [], projects[chosen].id);
      if (inside.length > 0) {
        const options = [
          { label: "Start a new chat in this project" },
          ...inside.map((entry) => ({ label: entry.title }))
        ];
        const picked = await pick(io, { title: `${projects[chosen].name}`, options }, header);
        if (picked === undefined) return cancel();
        if (picked > 0) {
          targetUrl = conversationThreadUrl(inside[picked - 1].id);
          projectMode = "current";
          projectName = undefined;
        }
      }
    } else if (destination === "project-new") {
      projectName = await askLine(io, `${CLEAR}${header}New project\n\n  name: `);
      if (projectName === undefined) return cancel();
      if (!projectName) return cancel();
      projectMode = "new";
    } else if (destination === "no-project") {
      projectMode = "none";
    }

    // The prompt comes last: what you type depends on what you just decided.
    io.write(CLEAR + header + SHOW_CURSOR);
    const kindLabel = SEND_KINDS[kindChoice].label;
    const prompt = await askLine(io, `${kindLabel}   Step ${steps} of ${steps}\n\n  prompt: `, { multiline: true });
    io.write(HIDE_CURSOR);
    if (prompt === undefined) return cancel();
    if (prompt.length === 0) return leave("Nothing to ask.\n", 1);

    // Uploading a file is the only way ChatGPT can open a pdf, pptx, xlsx or
    // image, and the picker had no way to say so. Asked after the prompt, and
    // skipped by pressing enter, so the common case costs one keystroke.
    io.write(SHOW_CURSOR);
    const attachmentLine = await askLine(io, "\n  attach files? repo-relative paths, space separated, enter to skip\n  files: ");
    io.write(HIDE_CURSOR);
    if (attachmentLine === undefined) return cancel();
    const attachments = parseAttachmentLine(attachmentLine);

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
    onAltScreen = false;
    // Hand the terminal back too. Raw mode is what let the pickers read single
    // keys, and it also turns off the terminal's own ctrl-c: the key arrives as
    // a keypress nothing is waiting for. The progress bar promises "ctrl-c to
    // stop", and under raw mode that promise was false for the whole ten
    // minutes a deep research send runs. No key is read from here on.
    io.input.setRawMode?.(false);
    io.write(`Sending. Equivalent command:\n  prodex ${formatCommand(args)}\n\n`);

    const budgetMs = 20 * 60_000;
    const startedAt = now();
    let label = "starting";
    let tick = 0;
    const timer = setInterval(() => {
      tick += 1;
      io.write(
        CLEAR_LINE +
          renderProgressBar({
            elapsedMs: now() - startedAt,
            budgetMs,
            label,
            tick,
            width: Math.min(28, terminalWidth() - 52),
            columns: process.stdout.columns ?? 100
          })
      );
    }, 250);
    try {
      const code = await deps.runConsult(args, (line) => {
        label = progressLabel(line);
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
    io.write((onAltScreen ? ALT_SCREEN_OFF : "") + SHOW_CURSOR + farewell);
    io.input.setRawMode?.(false);
    io.input.pause();
  }
}

/** Quote only what a shell would need quoted, so the echo can be pasted. */
export function formatCommand(args: string[]): string {
  return args.map((arg) => shellQuote(arg)).join(" ");
}
