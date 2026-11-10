import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ASK_PRO_BOOLEAN_FLAGS, ASK_PRO_VALUE_FLAGS, findHelpRequestIndex } from "../src/cli-args.js";
import { runCli } from "../src/cli.js";

// Found 2026-11-09. Unquoted words after `ask` are the prompt, but any of
// them reading "help" made the command a help request, which then failed on
// the first word: `prodex ask can you help me fix this` printed
// "Unexpected argument for ask: can". And `prodex pro ask -- what does
// --project do` was refused as if --project had been passed, although the
// words after `--` are the prompt.
async function cli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "prodex-ask-words-"));
  let out = "";
  let err = "";
  let code: number;
  try {
    code = await runCli(args, { cwd, stdout: (line) => (out += `${line}\n`), stderr: (line) => (err += `${line}\n`) });
  } catch (error) {
    code = 1;
    err += error instanceof Error ? error.message : String(error);
  }
  return { code, out, err };
}

const askFlags = { valueFlags: [...ASK_PRO_VALUE_FLAGS], booleanFlags: [...ASK_PRO_BOOLEAN_FLAGS], promptWords: true };

describe("help among a prompt's words", () => {
  it("is part of the prompt when other words come with it", () => {
    expect(findHelpRequestIndex(["can", "you", "help", "me", "fix", "this"], askFlags)).toBe(-1);
    expect(findHelpRequestIndex(["--model", "Pro", "help", "me"], askFlags)).toBe(-1);
  });

  it("is a help request on its own, and --help or -h always is", () => {
    expect(findHelpRequestIndex(["help"], askFlags)).toBe(0);
    expect(findHelpRequestIndex(["--model", "Pro", "help"], askFlags)).toBe(2);
    expect(findHelpRequestIndex(["can", "you", "help", "--help"], askFlags)).toBe(3);
    expect(findHelpRequestIndex(["fix", "-h"], askFlags)).toBe(1);
    expect(findHelpRequestIndex(["--", "help"], askFlags)).toBe(-1);
  });

  it("previews a prompt with the word help in it", async () => {
    const result = await cli(["pro", "ask", "can", "you", "help", "me", "fix", "this"]);
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(result.out).toContain("can you help me fix this");
  });

  it("still prints help for `pro ask help`", async () => {
    const result = await cli(["pro", "ask", "help"]);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/Usage|prodex pro/);
  });
});

describe("words after -- in a pro ask preview", () => {
  it("are not taken for send-only options", async () => {
    const result = await cli(["pro", "ask", "--", "what", "does", "--project", "do"]);
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(result.out).toContain("what does --project do");
  });

  it("still refuses a send-only option before --", async () => {
    const result = await cli(["pro", "ask", "--project", "Notes", "--", "hello"]);
    expect(result.code).not.toBe(0);
    expect(result.err).toMatch(/--project only applies when sending/);
  });
});
