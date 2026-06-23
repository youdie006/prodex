import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
});
