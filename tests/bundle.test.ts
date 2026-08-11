import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildDryRunBundle } from "../src/bundle.js";

describe("buildDryRunBundle", () => {
  it("renders prompt and selected files without sending anything", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-bundle-"));
    await writeFile(path.join(root, "a.ts"), "export const a = 1;\n", "utf8");

    const bundle = await buildDryRunBundle(root, {
      prompt: "Review this file.",
      files: ["a.ts"]
    });

    expect(bundle.text).toContain("Review this file.");
    expect(bundle.text).toContain("## File: a.ts");
    expect(bundle.files).toHaveLength(1);
    expect(bundle.mode).toBe("manual_copy");
  });

  it("never tells ChatGPT the real send is a preview", async () => {
    // Measured from a real thread's transcript: every visible-browser send
    // arrived at ChatGPT headed "# prodex consult dry run / This preview was
    // not sent anywhere.", because the send path reused the preview text. The
    // model was being told to ignore the very message it had to answer.
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-bundle-"));
    const bundle = await buildDryRunBundle(cwd, { prompt: "Compare TCP and QUIC.", files: [] });

    expect(bundle.sendText).not.toContain("dry run");
    expect(bundle.sendText).not.toContain("not sent anywhere");
    // With no files there is nothing to frame: the prompt goes as written.
    expect(bundle.sendText).toBe("Compare TCP and QUIC.");
    // The preview keeps its own wording.
    expect(bundle.text).toContain("This preview was not sent anywhere.");
  });

  it("frames inlined files without preview wording", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-bundle-"));
    await writeFile(path.join(cwd, "notes.md"), "alpha beta\n", "utf8");
    const bundle = await buildDryRunBundle(cwd, { prompt: "Summarize the notes.", files: ["notes.md"] });

    expect(bundle.sendText).not.toContain("dry run");
    expect(bundle.sendText).not.toContain("not sent anywhere");
    expect(bundle.sendText).toContain("Summarize the notes.");
    expect(bundle.sendText).toContain("## File: notes.md");
    expect(bundle.sendText).toContain("alpha beta");
    // The prompt must lead, so the instruction is not buried under file dumps.
    expect(bundle.sendText.indexOf("Summarize the notes.")).toBeLessThan(bundle.sendText.indexOf("## File: notes.md"));
  });

  it("rejects env-like files as consult bundle context", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-bundle-"));
    await writeFile(path.join(root, ".envrc"), "SECRET=leak\n", "utf8");

    await expect(buildDryRunBundle(root, { prompt: "Review this file.", files: [".envrc"] })).rejects.toThrow(/sensitive/);
  });

  it("uses unique session ids for repeated bundles created in the same second", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-bundle-"));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-23T17:30:00.000Z"));
    try {
      const first = await buildDryRunBundle(root, { prompt: "Review this", files: [] });
      const second = await buildDryRunBundle(root, { prompt: "Review this", files: [] });

      expect(first.id).toMatch(/^sess_\d{8}_\d{6}_[a-z0-9]{8}-review-this$/);
      expect(second.id).toMatch(/^sess_\d{8}_\d{6}_[a-z0-9]{8}-review-this$/);
      expect(second.id).not.toBe(first.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps session ids unique for long repeated prompts created in the same second", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-bundle-"));
    const prompt = "Review this very long repeated prompt whose slug would otherwise truncate the random suffix";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-23T17:31:00.000Z"));
    try {
      const first = await buildDryRunBundle(root, { prompt, files: [] });
      const second = await buildDryRunBundle(root, { prompt, files: [] });

      expect(first.id).toMatch(/^sess_\d{8}_\d{6}_[a-z0-9]{8}-/);
      expect(second.id).toMatch(/^sess_\d{8}_\d{6}_[a-z0-9]{8}-/);
      expect(second.id).not.toBe(first.id);
    } finally {
      vi.useRealTimers();
    }
  });
});
