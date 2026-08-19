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
    stream.write("2"); // Deep research: a tool kind, so no reasoning question
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
});
