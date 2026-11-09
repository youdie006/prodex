import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

// Found 2026-11-09: `tasks complete --artifact path=text` wrote the file
// before it read the task, so a completion that was then refused still
// replaced the file. A second completion of a finished task, or a mistyped
// task id, overwrote a saved answer, and `results artifact` failed from then
// on with "Result artifact changed after finalization".
async function cli(cwd: string, args: string[]): Promise<{ code: number; out: string[]; err: string }> {
  const out: string[] = [];
  let err = "";
  let code = 0;
  try {
    code = await runCli(args, { cwd, stdout: (line) => out.push(line), stderr: (line) => (err += `${line}\n`) });
  } catch (error) {
    code = 1;
    err += error instanceof Error ? error.message : String(error);
  }
  return { code, out, err };
}

async function finishedTask(): Promise<{ cwd: string; taskId: string; artifact: string }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "prodex-complete-artifact-"));
  const created = await cli(cwd, ["tasks", "create", "--title", "Report", "--prompt", "Write the report"]);
  const taskId = created.out[0].split("\t")[0];
  const artifact = ".bridge/artifacts/results/report.md";
  const done = await cli(cwd, ["tasks", "complete", taskId, "--summary", "first", "--artifact", `${artifact}=original answer`]);
  expect(done.code).toBe(0);
  return { cwd, taskId, artifact };
}

describe("tasks complete --artifact", () => {
  it("leaves a finished task's artifact alone when completing it again is refused", async () => {
    const { cwd, taskId, artifact } = await finishedTask();
    const again = await cli(cwd, ["tasks", "complete", taskId, "--summary", "first", "--artifact", `${artifact}=REPLACED`]);
    expect(again.code).not.toBe(0);
    expect(await readFile(path.join(cwd, artifact), "utf8")).toBe("original answer");
    const fetched = await cli(cwd, ["results", "artifact", taskId]);
    expect(fetched.out.join("\n")).toContain("original answer");
  });

  it("writes nothing for a task id that does not exist", async () => {
    const { cwd, artifact } = await finishedTask();
    const typo = await cli(cwd, ["tasks", "complete", "task_20261109_000000_typo", "--summary", "x", "--artifact", `${artifact}=oops`]);
    expect(typo.code).not.toBe(0);
    expect(typo.err).toMatch(/Task not found/);
    expect(await readFile(path.join(cwd, artifact), "utf8")).toBe("original answer");
  });

  it("does not overwrite another task's artifact", async () => {
    const { cwd, taskId, artifact } = await finishedTask();
    const created = await cli(cwd, ["tasks", "create", "--title", "Second", "--prompt", "p"]);
    const second = created.out[0].split("\t")[0];
    const clash = await cli(cwd, ["tasks", "complete", second, "--summary", "s", "--artifact", `${artifact}=second answer`]);
    expect(clash.code).not.toBe(0);
    expect(clash.err).toMatch(/already exists/);
    expect(await readFile(path.join(cwd, artifact), "utf8")).toBe("original answer");
    expect((await cli(cwd, ["results", "artifact", taskId])).out.join("\n")).toContain("original answer");
  });

  it("writes nothing for a path that is not a result artifact", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-complete-artifact-"));
    const created = await cli(cwd, ["tasks", "create", "--title", "Notes", "--prompt", "p"]);
    const taskId = created.out[0].split("\t")[0];
    const refused = await cli(cwd, ["tasks", "complete", taskId, "--summary", "s", "--artifact", ".bridge/artifacts/notes/scratch.md=x"]);
    expect(refused.code).not.toBe(0);
    await expect(access(path.join(cwd, ".bridge/artifacts/notes/scratch.md"))).rejects.toThrow();
  });

  it("writes the artifact of a completion it accepts", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-complete-artifact-"));
    const created = await cli(cwd, ["tasks", "create", "--title", "Retry", "--prompt", "p"]);
    const taskId = created.out[0].split("\t")[0];
    const artifact = ".bridge/artifacts/results/retry.md";
    expect((await cli(cwd, ["tasks", "complete", taskId, "--summary", "s", "--artifact", `${artifact}=same`])).code).toBe(0);
    expect(await readFile(path.join(cwd, artifact), "utf8")).toBe("same");
  });
});
