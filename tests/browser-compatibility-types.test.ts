import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");

it("type-checks headed and headless compatibility evidence as mutually exclusive", async () => {
  const tscPath = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  const result = await execFileAsync(process.execPath, [
    tscPath,
    "--noEmit",
    "--strict",
    "--skipLibCheck",
    "--target", "ES2022",
    "--module", "NodeNext",
    "--moduleResolution", "NodeNext",
    "--types", "node",
    "tests/browser-compatibility.types.mts"
  ], { cwd: repoRoot, timeout: 20_000, killSignal: "SIGKILL", windowsHide: true });

  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
});
