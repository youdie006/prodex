import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const execute = promisify(execFile);

describe("portable package bin", () => {
  it("declares and ships a root-level executable entrypoint", async () => {
    const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    expect(manifest.bin.prodex).toBe("prodex.mjs");
    expect(manifest.files).toContain("prodex.mjs");
  });

  it("executes the same CLI through the package shim and the existing source-build path", async () => {
    const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    for (const entry of ["prodex.mjs", "dist/cli.js"]) {
      const result = await execute(process.execPath, [path.join(root, entry), "--version"], { timeout: 15_000 });
      expect(result.stdout.trim()).toBe(manifest.version);
    }
  });

  it("preserves nonzero errors without raw Node stack traces", async () => {
    await expect(execute(process.execPath, [path.join(root, "prodex.mjs"), "not-a-prodex-command"], { timeout: 15_000 }))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringMatching(/unknown command/i) });
  });
});
