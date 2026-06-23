import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildDryRunBundle } from "../src/bundle.js";

describe("buildDryRunBundle", () => {
  it("renders prompt and selected files without sending anything", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gptprouse-bundle-"));
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

  it("rejects env-like files as consult bundle context", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gptprouse-bundle-"));
    await writeFile(path.join(root, ".envrc"), "SECRET=leak\n", "utf8");

    await expect(buildDryRunBundle(root, { prompt: "Review this file.", files: [".envrc"] })).rejects.toThrow(/sensitive/);
  });

  it("uses unique session ids for repeated bundles created in the same second", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gptprouse-bundle-"));
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
    const root = await mkdtemp(path.join(tmpdir(), "gptprouse-bundle-"));
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
