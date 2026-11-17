import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseReasoningEffort } from "../src/chatgpt-browser.js";
import { parseAskProArgs, unknownOptionError } from "../src/cli-args.js";
import { runCli } from "../src/cli.js";
import { BridgeStore } from "../src/store.js";

// Found 2026-11-09 in a bug hunt against 0.40.50: the shared option parser
// kept the first of two values for the same option, could not say why a value
// starting with "--" was refused, missed help requests carrying a command's own
// flags, and offered `prodex ask -- ...` to commands that take no prompt.
async function cli(args: string[], cwd?: string): Promise<{ code: number; out: string; err: string; cwd: string }> {
  const dir = cwd ?? (await mkdtemp(path.join(tmpdir(), "prodex-flags-")));
  let out = "";
  let err = "";
  let code: number;
  try {
    code = await runCli(args, { cwd: dir, stdout: (line) => (out += `${line}\n`), stderr: (line) => (err += `${line}\n`) });
  } catch (error) {
    code = 1;
    err += error instanceof Error ? error.message : String(error);
  }
  return { code, out, err, cwd: dir };
}

describe("a single-value option given twice", () => {
  it("is refused by tasks create, which used to store the first title", async () => {
    const result = await cli(["tasks", "create", "--title", "First", "--title", "Second", "--prompt", "p"]);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/--title was given twice/);
    expect(await new BridgeStore(result.cwd).listTasks()).toEqual([]);
  });

  it("is refused by the ask parser, which used to read the first timeout and model", () => {
    const args = ["--send", "--timeout-ms", "300000", "--model", "Pro", "--timeout-ms", "900000", "--model", "GPT-5.6 Sol", "--", "hi"];
    expect(() => parseAskProArgs(args)).toThrow(/--timeout-ms was given twice/);
    expect(() => parseAskProArgs(["--send", "--model", "Pro", "--model", "GPT-5.6 Sol", "hi"])).toThrow(/--model was given twice/);
  });

  it("is refused by every kind of command", async () => {
    const first = await mkdtemp(path.join(tmpdir(), "prodex-flags-a-"));
    const second = await mkdtemp(path.join(tmpdir(), "prodex-flags-b-"));
    const cases: Array<{ args: string[]; flag: string }> = [
      // a preview: the words after -- are the prompt, and --cwd decides the repo
      { args: ["pro", "ask", "--cwd", first, "--cwd", second, "--", "hi"], flag: "--cwd" },
      { args: ["tasks", "complete", "task_x", "--summary", "a", "--summary", "b"], flag: "--summary" },
      { args: ["tasks", "list", "--status", "new", "--status", "done"], flag: "--status" },
      { args: ["receipts", "list", "--task-id", "a", "--task-id", "b"], flag: "--task-id" },
      { args: ["setup", "--host", "127.0.0.1", "--host", "127.0.0.2"], flag: "--host" }
    ];
    for (const item of cases) {
      const result = await cli(item.args);
      expect(result.err, item.args.join(" ")).toContain(`${item.flag} was given twice`);
      expect(result.code, item.args.join(" ")).toBe(1);
    }
  });

  it("does not stop the options that are meant to repeat", async () => {
    const result = await cli(["tasks", "create", "--title", "t", "--prompt", "p", "--file", "a.md", "--file", "b.md"]);
    expect(result.err).toBe("");
    const store = new BridgeStore(result.cwd);
    const [task] = await store.listTasks();
    expect(task.files.map((file) => file.path)).toEqual(["a.md", "b.md"]);

    const completed = await cli(["tasks", "complete", task.id, "--summary", "s", "--command", "npm test", "--command", "npm run build"], result.cwd);
    expect(completed.err).toBe("");
    expect((await store.getFinalizedResultReadOnly(task.id)).commands).toEqual(["npm test", "npm run build"]);

    const ask = ["--send", "--file", "a", "--file", "b", "--attach", "c.pdf", "--attach", "d.pdf", "--tool", "web-search", "--tool", "create-image", "hi"];
    expect(parseAskProArgs(ask).promptParts).toEqual(["hi"]);
  });

  it("does not count the words of the prompt after --", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-flags-"));
    const result = await cli(["pro", "ask", "--cwd", cwd, "--", "is", "--cwd", "x", "the", "same", "as", "--cwd", "y"]);
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
  });
});

describe("a value that starts with --", () => {
  it("is named as looking like an option, with what to do, instead of 'requires a value'", async () => {
    const result = await cli(["tasks", "create", "--title", "Fix", "--prompt", "--dry-run should not write files"]);
    expect(result.code).toBe(1);
    expect(result.err).not.toMatch(/requires a value/);
    expect(result.err).toContain('--prompt cannot take "--dry-run should not write files" as its value');
    expect(result.err).toMatch(/read as an option/);
    expect(result.err).toMatch(/does not start with "--"/);
  });

  it("still says a value is missing when the next argument is another option", async () => {
    const result = await cli(["tasks", "create", "--title", "--prompt", "Review the plan"]);
    expect(result.err).toBe("--title requires a value");
  });

  it("explains --flag=value instead of calling the option unknown", async () => {
    const result = await cli(["tasks", "create", "--title", "Fix", "--prompt=x"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain('give the value as the next argument: --prompt "x"');

    const dashed = await cli(["tasks", "create", "--title", "Fix", "--prompt=--dry-run should not write files"]);
    expect(dashed.err).toContain('--prompt cannot take "--dry-run should not write files" as its value');
  });
});

describe("help requests", () => {
  it("print help for ui on --help, -h and help, and still refuse anything else", async () => {
    for (const args of [["ui", "--help"], ["ui", "-h"], ["ui", "help"]]) {
      const result = await cli(args);
      expect(result.err, args.join(" ")).toBe("");
      expect(result.code, args.join(" ")).toBe(0);
      expect(result.out, args.join(" ")).toContain("prodex ui");
    }
    expect((await cli(["ui", "--bogus"])).err).toBe("Unknown option for ui: --bogus");
  });

  it("accept the boolean flags each command itself takes", async () => {
    const cases = [
      ["tasks", "list", "--json", "--help"],
      ["receipts", "list", "--json", "--help"],
      ["sessions", "list", "--json", "--help"],
      ["pro", "blockers", "--json", "--help"],
      ["pro", "list", "--json", "--help"],
      ["pro", "latest", "--json", "--help"],
      ["pro", "show", "latest", "--json", "--help"],
      ["pro", "report-issue", "--confirm", "--help"]
    ];
    for (const args of cases) {
      const result = await cli(args);
      expect(result.err, args.join(" ")).toBe("");
      expect(result.code, args.join(" ")).toBe(0);
      expect(result.out, args.join(" ")).toContain(`prodex ${args[0]}`);
    }
  });

  it("make version refuse what it does not take, like every other command", async () => {
    expect((await cli(["version", "--bogus"])).err).toBe("Unknown option for version: --bogus");
    expect((await cli(["--version", "extra"])).err).toBe("Unexpected argument for version: extra");
    const help = await cli(["version", "--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("prodex --version");
    const version = await cli(["version"]);
    const packageJson = JSON.parse(await readFile(path.resolve(import.meta.dirname, "..", "package.json"), "utf8")) as { version: string };
    expect(version.out).toBe(`${packageJson.version}\n`);
  });
});

describe("the hint for a dash-led argument", () => {
  it("is not offered by commands that take no prompt", async () => {
    const list = await cli(["tasks", "list", "-"]);
    expect(list.err).toBe("Unknown option for tasks list: -");
    const create = await cli(["tasks", "create", "--title", "a", "--prompt", "b", "--", "extra"]);
    expect(create.code).toBe(1);
    expect(create.err).not.toMatch(/prodex ask/);
    expect(unknownOptionError("-5", "tasks list", ["--json"]).message).toBe("Unknown option for tasks list: -5");
  });

  it("names the prompt command that was run", async () => {
    expect((await cli(["pro", "ask", "-5"])).err).toContain('put `--` before it: prodex pro ask -- "-5"');
    expect((await cli(["pro", "browser", "ask", "-5"])).err).toContain('put `--` before it: prodex pro browser ask -- "-5"');
    expect((await cli(["ask", "-5"])).err).toContain('put `--` before it: prodex ask -- "-5"');
    expect((await cli(["pro", "ask", "-5", "--help"])).err).toContain('put `--` before it: prodex pro ask -- "-5"');
  });
});

describe("help text", () => {
  async function helpOf(args: string[]): Promise<string> {
    const result = await cli(args);
    expect(result.code).toBe(0);
    return result.out;
  }

  it("no longer says the model rows cannot be reached", async () => {
    for (const args of [["setup", "--help"], ["pro", "browser", "help"]]) {
      const text = await helpOf(args);
      expect(text, args.join(" ")).not.toMatch(/cannot be clicked|no coordinate reaches them|so any other name warns/);
      const modelLine = text.split("\n").find((line) => line.trimStart().startsWith("--model"));
      expect(modelLine, args.join(" ")).toMatch(/keyboard/);
      expect(modelLine, args.join(" ")).toMatch(/does not offer is a warning/);
    }
  });

  it("does not call creating a project planned next to --project-new", async () => {
    const text = await helpOf(["pro", "help"]);
    expect(text).toContain('--project-new "name"');
    expect(text).not.toMatch(/Creating a new project from the CLI is planned/);
  });

  it("states what max means next to Max wherever the effort aliases are listed", async () => {
    for (const args of [["pro", "help"], ["pro", "browser", "help"]]) {
      const effortLine = (await helpOf(args)).split("\n").find((line) => line.trimStart().startsWith("--effort"));
      expect(effortLine, args.join(" ")).toMatch(/max[^.;]*매우 높음/);
      expect(effortLine, args.join(" ")).toMatch(/"Max"[^.;]*Work/);
    }
  });
});

describe("the --effort error", () => {
  it("says that max and Max are different steps", () => {
    let message = "";
    try {
      parseReasoningEffort("maximum");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/^--effort must be one of/);
    expect(message).toMatch(/max[^.;]*매우 높음/);
    expect(message).toMatch(/"Max"[^.;]*Work/);
    // The mapping itself is documented behaviour and stays as it is.
    expect(parseReasoningEffort("Max")).toBe("Max");
    expect(parseReasoningEffort("max")).toBe("매우 높음");
    expect(parseReasoningEffort("MAX")).toBe("매우 높음");
  });
});
