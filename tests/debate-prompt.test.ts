import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";

async function runDebatePrompt(args: string[]): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "prodex-debate-prompt-"));
  const out: string[] = [];
  await runCli(["pro", "debate-prompt", ...args], {
    cwd,
    stdout: (line) => out.push(line),
    stderr: () => {}
  });
  return out.join("\n");
}

describe("pro debate-prompt", () => {
  it("prints an orchestration prompt with the reliability guidance baked in", async () => {
    const text = await runDebatePrompt([]);

    expect(text).toContain("pro_consult");
    expect(text).toContain("new_chat: true");
    expect(text).toContain("timeout_ms: 240000");
    expect(text).toContain("2 rounds");
    expect(text).toContain("task_id");
    expect(text).toContain("<fill in the debate topic>");
  });

  it("embeds the topic and round count", async () => {
    const text = await runDebatePrompt(["--topic", "Monorepo vs polyrepo", "--rounds", "4"]);

    expect(text).toContain("Monorepo vs polyrepo");
    expect(text).toContain("4 rounds");
  });

  it("caps rounds to keep consults low-volume", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-debate-prompt-"));

    await expect(
      runCli(["pro", "debate-prompt", "--rounds", "9"], { cwd, stdout: () => {}, stderr: () => {} })
    ).rejects.toThrow(/--rounds must be between 1 and 5/);
  });

  it("keeps the CLI fallback source-aware", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-debate-prompt-"));
    const { mkdir, writeFile } = await import("node:fs/promises");
    const sourceCli = path.join(cwd, "dist", "cli.js");
    await mkdir(path.dirname(sourceCli), { recursive: true });
    await writeFile(sourceCli, "#!/usr/bin/env node\n", "utf8");
    const out: string[] = [];

    await runCli(["pro", "debate-prompt", "--source-cli", sourceCli], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    expect(out.join("\n")).toContain(`node ${sourceCli} ask`);
  });
});
