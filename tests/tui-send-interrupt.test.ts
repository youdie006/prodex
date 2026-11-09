import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { formatCommand, runInteractiveConsult, type InteractiveDeps } from "../src/tui-run.js";

/** A stdin the test can type into, recording every raw-mode switch. */
function fakeInput(): { stream: PassThrough & NodeJS.ReadStream; rawModes: boolean[] } {
  const stream = new PassThrough() as unknown as PassThrough & NodeJS.ReadStream;
  const rawModes: boolean[] = [];
  stream.isTTY = true;
  stream.setRawMode = ((mode: boolean) => {
    rawModes.push(mode);
    return stream;
  }) as NodeJS.ReadStream["setRawMode"];
  return { stream, rawModes };
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function settleWithin<T>(promise: Promise<T>, ms = 250): Promise<T | "timed-out"> {
  return Promise.race([promise, new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), ms))]);
}

describe("the send phase of the interactive picker", () => {
  it("hands the terminal back before sending, so ctrl-c can still stop it", async () => {
    // The progress bar says "ctrl-c to stop". Raw mode is what the pickers need
    // to read single keys, and it also disables the terminal's own ctrl-c: the
    // key arrives as an ordinary keypress that nothing is waiting for, so the
    // process ignores it. Verified against a real pty - a raw-mode process sat
    // through ctrl-c and exited on its own timer. A send that cannot be stopped
    // is a ten-minute wait with a lie printed under it.
    const { stream, rawModes } = fakeInput();
    let out = "";
    let rawModeDuringSend: boolean | undefined;

    const finished = runInteractiveConsult(
      { write: (text) => (out += text), input: stream },
      {
        listProjects: async () => [],
        runConsult: async () => {
          rawModeDuringSend = rawModes[rawModes.length - 1];
          return 0;
        }
      }
    );

    await waitFor(() => out.includes("What kind of send is this?"), "the first question");
    stream.write("2"); // Web search: a tool kind, so no reasoning question
    await waitFor(() => out.includes("Where should it go?"), "the destination question");
    stream.write("2"); // New chat
    // Both line questions are drawn by readline straight to stdout, so the
    // recorded mode switches - cooked to read a line, raw again after - are
    // what says a reader is waiting.
    await waitFor(() => rawModes.length >= 2, "the prompt reader");
    stream.write("does raw mode swallow ctrl-c\n");
    await waitFor(() => rawModes.length >= 4, "the attachment reader");
    stream.write("\n");

    expect(await finished).toBe(0);
    expect(rawModeDuringSend).toBe(false);
  });

  it("leaves navigation to the locked send path for a picked conversation", async () => {
    const { stream, rawModes } = fakeInput();
    let out = "";
    let navigationCalls = 0;
    let sentArgs: string[] | undefined;
    const deps = {
      listProjects: async () => [],
      listConversations: async () => [{ id: "chosen-thread", title: "Chosen thread" }],
      openThread: async () => {
        navigationCalls += 1;
        return true;
      },
      runConsult: async (args: string[]) => {
        sentArgs = args;
        return 0;
      }
    };

    const finished = runInteractiveConsult({ write: (text) => (out += text), input: stream }, deps);
    try {
      await waitFor(() => out.includes("What kind of send is this?"), "the first question");
      stream.write("2");
      await waitFor(() => out.includes("Where should it go?"), "the destination question");
      stream.write("1");
      await waitFor(() => out.includes("Which conversation?"), "the conversation question");
      stream.write("1");
      await waitFor(() => rawModes.length >= 2, "the prompt reader");
      stream.write("continue here\n");
      await waitFor(() => rawModes.length >= 4, "the attachment reader");
      stream.write("\n");

      expect(await finished).toBe(0);
      expect(navigationCalls).toBe(0);
      expect(sentArgs).toEqual(
        expect.arrayContaining(["--target-url", "https://chatgpt.com/c/chosen-thread", "--confirm-target"])
      );
    } finally {
      stream.destroy();
    }
  });
});

describe("line-entry interruption", () => {
  it.each(["end", "close", "ctrl-d"])("restores the terminal on %s during a raw picker", async (action) => {
    const { stream, rawModes } = fakeInput();
    let out = "";
    let sends = 0;
    const finished = runInteractiveConsult({ write: (text) => (out += text), input: stream }, {
      listProjects: async () => [],
      runConsult: async () => { sends += 1; return 0; }
    });
    try {
      await waitFor(() => out.includes("What kind of send is this?"), "the raw picker");
      if (action === "end") stream.end();
      else if (action === "close") stream.destroy();
      else stream.write("\u0004");
      expect(await settleWithin(finished)).toBe(130);
      expect(sends).toBe(0);
      expect(out).toContain("\u001b[?1049l");
      expect(rawModes.at(-1)).toBe(false);
    } finally {
      stream.emit("keypress", "", { name: "c", ctrl: true });
      await settleWithin(finished);
      stream.destroy();
    }
  });

  it("treats ctrl-c as cancellation and restores the terminal without navigating or sending", async () => {
    const { stream, rawModes } = fakeInput();
    let out = "";
    let navigationCalls = 0;
    let sendCalls = 0;
    const deps = {
      listProjects: async () => [],
      listConversations: async () => [{ id: "cancelled-thread", title: "Cancelled thread" }],
      openThread: async () => {
        navigationCalls += 1;
        return true;
      },
      runConsult: async () => {
        sendCalls += 1;
        return 0;
      }
    };

    const finished = runInteractiveConsult({ write: (text) => (out += text), input: stream }, deps);
    try {
      await waitFor(() => out.includes("What kind of send is this?"), "the first question");
      stream.write("2");
      await waitFor(() => out.includes("Where should it go?"), "the destination question");
      stream.write("1");
      await waitFor(() => out.includes("Which conversation?"), "the conversation question");
      stream.write("1");
      await waitFor(() => rawModes.length >= 2, "the prompt reader");
      stream.write("\u0003");

      expect(await settleWithin(finished)).toBe(130);
      expect(navigationCalls).toBe(0);
      expect(sendCalls).toBe(0);
      expect(out).toContain("\u001b[?1049l");
      expect(rawModes.at(-1)).toBe(false);
    } finally {
      stream.destroy();
    }
  });

  it("treats ctrl-d EOF as cancellation and restores the terminal without sending", async () => {
    const { stream, rawModes } = fakeInput();
    let out = "";
    let sendCalls = 0;

    const finished = runInteractiveConsult(
      { write: (text) => (out += text), input: stream },
      {
        listProjects: async () => [],
        runConsult: async () => {
          sendCalls += 1;
          return 0;
        }
      }
    );
    try {
      await waitFor(() => out.includes("What kind of send is this?"), "the first question");
      stream.write("2");
      await waitFor(() => out.includes("Where should it go?"), "the destination question");
      stream.write("2");
      await waitFor(() => rawModes.length >= 2, "the prompt reader");
      stream.end();

      expect(await settleWithin(finished)).toBe(130);
      expect(sendCalls).toBe(0);
      expect(out).toContain("\u001b[?1049l");
      expect(rawModes.at(-1)).toBe(false);
    } finally {
      stream.destroy();
    }
  });
});

describe("the picker without a terminal", () => {
  it("says so instead of painting a screen nobody can answer", async () => {
    // Measured: stdout on a terminal, stdin redirected. The picker painted the
    // alternate screen, hid the cursor and waited forever for a key that could
    // not arrive - and because it never returned, the code that restores the
    // screen never ran either, so the terminal was left needing `reset`.
    const { stream } = fakeInput();
    stream.isTTY = false;
    let out = "";

    const code = await runInteractiveConsult(
      { write: (text) => (out += text), input: stream },
      { listProjects: async () => [], runConsult: async () => 0 }
    );

    expect(code).not.toBe(0);
    expect(out).not.toContain("\u001b[?1049h");
    expect(out).toContain("prodex pro browser ask");
  });
});

/** Start the picker with a fake terminal, recording the screen and the send. */
function startPicker(deps: Partial<InteractiveDeps> = {}) {
  const { stream, rawModes } = fakeInput();
  const state: { out: string; sent?: string[] } = { out: "" };
  const finished = runInteractiveConsult(
    { write: (text) => (state.out += text), input: stream },
    {
      listProjects: async () => [],
      runConsult: async (args) => {
        state.sent = args;
        return 0;
      },
      ...deps
    }
  );
  return { stream, rawModes, state, finished };
}

/** Answer the first two questions with a Web search to a new chat. */
async function reachPrompt(picker: ReturnType<typeof startPicker>): Promise<void> {
  await waitFor(() => picker.state.out.includes("What kind of send is this?"), "the first question");
  picker.stream.write("2");
  await waitFor(() => picker.state.out.includes("Where should it go?"), "the destination question");
  picker.stream.write("2");
  await waitFor(() => picker.rawModes.length >= 2, "the prompt reader");
}

describe("a pasted prompt", () => {
  // Measured with a pty: pasting these three lines sent only the first one,
  // and the rest was dropped without a word.
  const pasted = ["Explain this stack trace:", "TypeError: x is undefined", "    at foo (a.js:1:1)"];

  it("keeps every line of a marked paste and ends the prompt only on a typed enter", async () => {
    const picker = startPicker();
    try {
      await reachPrompt(picker);
      const readingPrompt = picker.rawModes.length;
      // What a terminal sends for a paste once it has been asked to mark them.
      picker.stream.write(`\u001b[200~${pasted.join("\r")}\r\u001b[201~`);
      await new Promise((resolve) => setTimeout(resolve, 300));
      // Still reading the prompt: no line break inside the paste ended it.
      expect(picker.rawModes).toHaveLength(readingPrompt);
      picker.stream.write("\r");
      await waitFor(() => picker.rawModes.length >= 4, "the attachment reader");
      picker.stream.write("\r");

      expect(await picker.finished).toBe(0);
      expect(picker.state.sent?.at(-1)).toBe(pasted.join("\n"));
      expect(picker.state.sent).not.toContain("--attach");
      // Pastes are marked only while the prompt is read.
      const on = picker.state.out.indexOf("\u001b[?2004h");
      const off = picker.state.out.indexOf("\u001b[?2004l");
      expect(on).toBeGreaterThan(-1);
      expect(off).toBeGreaterThan(on);
      expect(picker.state.out.indexOf("Sending.")).toBeGreaterThan(off);
      // The echoed command carries the whole prompt, quoted so it pastes back.
      expect(picker.state.out).toContain(`prodex ${formatCommand(picker.state.sent!)}\n`);
    } finally {
      picker.stream.destroy();
      await settleWithin(picker.finished);
    }
  });

  it("keeps the later lines of an unmarked paste in the prompt", async () => {
    const picker = startPicker();
    try {
      await reachPrompt(picker);
      // A terminal that does not mark pastes sends the text as if typed, in
      // one read, its own line breaks included.
      picker.stream.write(`${pasted.join("\r")}\r`);
      await waitFor(() => picker.rawModes.length >= 4, "the attachment reader");
      picker.stream.write("\r");

      expect(await picker.finished).toBe(0);
      expect(picker.state.sent?.at(-1)).toBe(pasted.join("\n"));
      expect(picker.state.sent).not.toContain("--attach");
    } finally {
      picker.stream.destroy();
      await settleWithin(picker.finished);
    }
  });

  it("does not hand the rest of an unmarked paste to the files question", async () => {
    const picker = startPicker();
    try {
      await reachPrompt(picker);
      // A long paste can arrive in more than one read, and a read can end
      // right after a line break.
      picker.stream.write(`${pasted[0]}\r`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      picker.stream.write(`${pasted.slice(1).join("\r")}\r`);
      await waitFor(() => picker.rawModes.length >= 4, "the attachment reader");
      picker.stream.write("\r");

      expect(await settleWithin(picker.finished, 1_000)).toBe(0);
      expect(picker.state.sent?.at(-1)).toBe(pasted.join("\n"));
      expect(picker.state.sent).not.toContain("--attach");
    } finally {
      picker.stream.destroy();
      await settleWithin(picker.finished);
    }
  });

  it.each(["ctrl-c", "end"])("stops marking pastes when the prompt is left with %s", async (action) => {
    const picker = startPicker();
    try {
      await reachPrompt(picker);
      if (action === "ctrl-c") picker.stream.write("\u0003");
      else picker.stream.end();

      expect(await settleWithin(picker.finished)).toBe(130);
      expect(picker.state.sent).toBeUndefined();
      expect(picker.state.out).toContain("\u001b[?2004h");
      expect(picker.state.out.lastIndexOf("\u001b[?2004l")).toBeGreaterThan(picker.state.out.lastIndexOf("\u001b[?2004h"));
    } finally {
      picker.stream.destroy();
      await settleWithin(picker.finished);
    }
  });
});

describe("a project's own chats", () => {
  const conversations = [
    { id: "0123456789abcdef0123", title: "Unrelated personal chat" },
    { id: "fedcba9876543210fedc", title: "Alpha planning", gizmoId: "g-p-aaa" }
  ];

  async function pickProject(picker: ReturnType<typeof startPicker>): Promise<void> {
    await waitFor(() => picker.state.out.includes("What kind of send is this?"), "the first question");
    picker.stream.write("2");
    await waitFor(() => picker.state.out.includes("Where should it go?"), "the destination question");
    picker.stream.write("3"); // New chat in an existing project
    await waitFor(() => picker.state.out.includes("Which project?"), "the project question");
    picker.stream.write("1");
  }

  it("offers none of the recent chats when the project's id is unknown", async () => {
    // With no project ids readable the list falls back to names alone, and a
    // project without an id cannot say which conversations are its own.
    // Offering all of them put an unrelated chat under the project's name, and
    // picking it sent there with --confirm-target.
    const picker = startPicker({
      listProjectsWithIds: async () => [],
      listProjects: async () => ["Alpha"],
      listConversations: async () => conversations
    });
    try {
      await pickProject(picker);
      await waitFor(
        () => picker.rawModes.length >= 2 || picker.state.out.includes("Start a new chat in this project"),
        "the step after the project"
      );
      expect(picker.state.out).not.toContain("Unrelated personal chat");
      picker.stream.write("about Alpha\r");
      await waitFor(() => picker.rawModes.length >= 4, "the attachment reader");
      picker.stream.write("\r");

      expect(await picker.finished).toBe(0);
      expect(picker.state.sent).toEqual(["pro", "browser", "ask", "--new-chat", "--project", "Alpha", "--tool", "web-search", "--", "about Alpha"]);
    } finally {
      picker.stream.destroy();
      await settleWithin(picker.finished);
    }
  });

  it("still offers the chats tagged with a known project id", async () => {
    const picker = startPicker({
      listProjectsWithIds: async () => [{ id: "g-p-aaa", name: "Alpha" }],
      listConversations: async () => conversations
    });
    try {
      await pickProject(picker);
      await waitFor(() => picker.state.out.includes("Start a new chat in this project"), "the project's chats");
      expect(picker.state.out).toContain("Alpha planning");
      expect(picker.state.out).not.toContain("Unrelated personal chat");
      picker.stream.write("2");
      await waitFor(() => picker.rawModes.length >= 2, "the prompt reader");
      picker.stream.write("follow up\r");
      await waitFor(() => picker.rawModes.length >= 4, "the attachment reader");
      picker.stream.write("\r");

      expect(await picker.finished).toBe(0);
      expect(picker.state.sent).toEqual(
        expect.arrayContaining(["--target-url", "https://chatgpt.com/c/fedcba9876543210fedc", "--confirm-target"])
      );
    } finally {
      picker.stream.destroy();
      await settleWithin(picker.finished);
    }
  });
});

describe("leaving the picker without sending", () => {
  const firstQuestion = (picker: ReturnType<typeof startPicker>) =>
    waitFor(() => picker.state.out.includes("What kind of send is this?"), "the first question");
  const destination = async (picker: ReturnType<typeof startPicker>, key: string) => {
    await firstQuestion(picker);
    picker.stream.write("2");
    await waitFor(() => picker.state.out.includes("Where should it go?"), "the destination question");
    picker.stream.write(key);
  };

  it.each([
    {
      name: "a cancel",
      message: "Cancelled.",
      code: 130,
      deps: {},
      drive: async (picker: ReturnType<typeof startPicker>) => {
        await firstQuestion(picker);
        picker.stream.write("q");
      }
    },
    {
      name: "no readable conversations",
      message: "No recent conversations were readable. Start a new chat instead.",
      code: 1,
      deps: {
        listConversations: async () => {
          throw new Error("browser not running");
        }
      },
      drive: (picker: ReturnType<typeof startPicker>) => destination(picker, "1")
    },
    {
      name: "no visible projects",
      message: "No projects are visible in the ChatGPT sidebar.",
      code: 1,
      deps: { listProjectsWithIds: async () => [], listProjects: async () => [] },
      drive: (picker: ReturnType<typeof startPicker>) => destination(picker, "3")
    },
    {
      name: "an empty prompt",
      message: "Nothing to ask.",
      code: 1,
      deps: {},
      drive: async (picker: ReturnType<typeof startPicker>) => {
        await reachPrompt(picker);
        picker.stream.write("\r");
      }
    }
  ])("says why after leaving the alternate screen, on $name", async ({ message, code, deps, drive }) => {
    // Written while the alternate screen was up, the reason vanished with it:
    // the picker exited with nothing on screen to say why.
    const picker = startPicker(deps);
    try {
      await drive(picker);
      expect(await settleWithin(picker.finished, 1_000)).toBe(code);
      const left = picker.state.out.lastIndexOf("\u001b[?1049l");
      expect(left).toBeGreaterThan(picker.state.out.lastIndexOf("\u001b[?1049h"));
      expect(picker.state.out.slice(left)).toContain(message);
      expect(picker.state.out.slice(0, left)).not.toContain(message);
    } finally {
      picker.stream.destroy();
      await settleWithin(picker.finished);
    }
  });
});

describe("after a send", () => {
  // Found 2026-11-09 in tmux: the picker left the alternate screen before the
  // send and again when it returned. Each exit puts the cursor back where the
  // picker opened, so the shell prompt that followed was drawn over "Sending.
  // Equivalent command:" and the command it printed.
  it("leaves the alternate screen once", async () => {
    const picker = startPicker();
    try {
      await reachPrompt(picker);
      picker.stream.write("what changed\r");
      await waitFor(() => picker.rawModes.length >= 4, "the attachment reader");
      picker.stream.write("\r");
      expect(await picker.finished).toBe(0);
      expect(picker.state.out.split("\u001b[?1049l")).toHaveLength(2);
      expect(picker.state.out.indexOf("\u001b[?1049l")).toBeLessThan(picker.state.out.indexOf("Sending."));
    } finally {
      picker.stream.destroy();
      await settleWithin(picker.finished);
    }
  });
});
