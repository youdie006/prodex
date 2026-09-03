import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { temporaryChatWarning } from "../src/chatgpt-browser.js";
import {
  captureBrowserDiagnostics,
  diagnosticsDir,
  diagnosticsEnabled,
  diagnosticsNote,
  pageShapeExpression
} from "../src/browser-diagnostics.js";

// Every UI break in this project cost a live debugging session - opening the
// picker by hand, reading rects, asking elementFromPoint what was on top. A
// report from another machine carries none of it, so the archaeology gets
// repeated by whoever can reproduce it. This captures it at the moment of
// failure instead.
describe("capturing a failed send", () => {
  const target = {
    evaluate: async <T>() => ({ url: "https://chatgpt.com/", pickerOpen: true }) as T,
    send: async () => ({ data: Buffer.from("not really a png").toString("base64") })
  };

  it("writes the shape and the screenshot where the failure can be found again", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-diag-"));
    const capture = await captureBrowserDiagnostics(target, { cwd, label: "task_20260903_000000_demo" });
    expect(capture).toBeDefined();
    expect(await readdir(capture!.dir)).toEqual(expect.arrayContaining(["page-shape.json", "screen.png"]));
    expect(JSON.parse(await readFile(path.join(capture!.dir, "page-shape.json"), "utf8")).url).toBe("https://chatgpt.com/");
  });

  it("says the capture stays on this machine", () => {
    // A screenshot of ChatGPT shows the conversation. `pro report-issue` already
    // refuses to carry the prompt or the answer; this must not undo that by the
    // side door.
    const note = diagnosticsNote({ dir: "/tmp/x", files: ["/tmp/x/screen.png"] });
    expect(note).toMatch(/stay on this machine/i);
    expect(note).toMatch(/nothing attaches them/i);
  });

  it("never lets a failed capture replace the failure it was capturing", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-diag-"));
    const broken = {
      evaluate: async () => {
        throw new Error("page is gone");
      },
      send: async () => {
        throw new Error("no screenshot here");
      }
    };
    await expect(captureBrowserDiagnostics(broken, { cwd, label: "x" })).resolves.toBeUndefined();
  });

  it("is off unless it is turned on", () => {
    expect(diagnosticsEnabled({})).toBe(false);
    expect(diagnosticsEnabled({ PRODEX_BROWSER_DIAGNOSTICS: "0" })).toBe(false);
    expect(diagnosticsEnabled({ PRODEX_BROWSER_DIAGNOSTICS: "false" })).toBe(false);
    expect(diagnosticsEnabled({ PRODEX_BROWSER_DIAGNOSTICS: "1" })).toBe(true);
  });

  it("cannot be walked out of the diagnostics directory", () => {
    // The label comes from a task id, but a capture must land under .bridge no
    // matter what it is handed. Asserting containment says that; asserting an
    // exact sanitized string only says how it is spelled today.
    const root = path.join("/repo", ".bridge", "diagnostics");
    for (const label of ["task/../../etc", "../../..", "a\\b", "", "task_20260903_000000_demo"]) {
      const dir = diagnosticsDir("/repo", label);
      // `..-..-..` starts with ".." without being a traversal, so the test has
      // to ask whether the relative path STEPS up, not how it is spelled.
      const rel = path.relative(root, dir);
      expect(rel === ".." || rel.startsWith(`..${path.sep}`), `${label} escaped`).toBe(false);
      expect(path.dirname(dir)).toBe(root);
    }
  });

  it("reads the things that actually explain a refused click", () => {
    // pointer-events and the rects are what identified an inert row; the slider's
    // value attributes are what identified a step it could not read.
    const expression = pageShapeExpression();
    expect(expression).toContain("pointerEvents");
    expect(expression).toContain("aria-valuenow");
    expect(expression).toContain("composer-intelligence-picker-content");
  });
});

// Measured: the chat list is byte-identical before and after a temporary send,
// which is the point - but the answer arrives without the "(transcript ...)" a
// normal send reports, because the transcript API does not hold a chat that was
// never saved. The answer is read off the page instead, which is where prodex
// loses markdown tables and citation urls.
describe("a temporary chat", () => {
  it("says what it costs, because trading fidelity for privacy must not be silent", () => {
    const warning = temporaryChatWarning(true);
    expect(warning).toMatch(/not saved/i);
    expect(warning).toMatch(/page rather than the transcript/i);
    expect(warning).toMatch(/recover/i);
  });

  it("says nothing for an ordinary send", () => {
    expect(temporaryChatWarning(false)).toBeUndefined();
    expect(temporaryChatWarning(undefined)).toBeUndefined();
  });
});
