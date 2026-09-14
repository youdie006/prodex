import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { runInteractiveConsult } from "../src/tui-run.js";

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
