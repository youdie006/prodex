import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

describe("runCli", () => {
  it("creates and lists tasks", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const out: string[] = [];

    await runCli(["init"], { cwd, stdout: (line) => out.push(line), stderr: () => {} });
    await runCli(
      ["tasks", "create", "--title", "Review", "--prompt", "Review the plan"],
      { cwd, stdout: (line) => out.push(line), stderr: () => {} }
    );
    await runCli(["tasks", "list"], { cwd, stdout: (line) => out.push(line), stderr: () => {} });

    expect(out.join("\n")).toContain("task_");
    expect(out.join("\n")).toContain("Review");
  });

  it("prints ask-pro dry-run bundles", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    await writeFile(path.join(cwd, "notes.md"), "hello\n", "utf8");
    const out: string[] = [];

    await runCli(
      ["ask-pro", "--dry-run", "--file", "notes.md", "Check this"],
      { cwd, stdout: (line) => out.push(line), stderr: () => {} }
    );

    expect(out.join("\n")).toContain("DRY RUN");
    expect(out.join("\n")).toContain("## File: notes.md");
  });

  it("lists and shows GPT Pro answers with the short pro command", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const out: string[] = [];

    const createOut: string[] = [];
    await runCli(
      ["tasks", "create", "--title", "GPT Pro consult", "--prompt", "Ask Pro"],
      { cwd, stdout: (line) => createOut.push(line), stderr: () => {} }
    );
    const taskId = createOut[0].split("\t")[0];
    await runCli(["tasks", "claim", taskId, "--by", "chatgpt-pro"], { cwd, stdout: () => {}, stderr: () => {} });
    await runCli(
      ["tasks", "complete", taskId, "--summary", "Use receipt-gated writes next.", "--command", "visible ChatGPT browser consult"],
      { cwd, stdout: () => {}, stderr: () => {} }
    );

    await runCli(["pro", "list"], { cwd, stdout: (line) => out.push(line), stderr: () => {} });
    await runCli(["pro", "latest"], { cwd, stdout: (line) => out.push(line), stderr: () => {} });
    await runCli(["pro", "show", "latest"], { cwd, stdout: (line) => out.push(line), stderr: () => {} });

    expect(out.join("\n")).toContain(taskId);
    expect(out.join("\n")).toContain("task_id:");
    expect(out.join("\n")).toContain("Use receipt-gated writes next.");
  });

  it("keeps pro ask as a dry-run preview unless browser send is explicit", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    await writeFile(path.join(cwd, "notes.md"), "manual bridge first\n", "utf8");
    const out: string[] = [];

    await runCli(["pro", "ask", "--file", "notes.md", "Review this"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(text).toContain("DRY RUN");
    expect(text).toContain("## File: notes.md");
    expect(text).toContain("manual bridge first");
  });

  it("requires explicit browser namespace for browser product checks", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const out: string[] = [];

    await runCli(["pro", "browser", "check", "--port", "65534", "--timeout-ms", "10"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    expect(out.join("\n")).toContain("chatgpt: browser_unreachable");
  });

  it("does not keep old pro browser aliases at the top level", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));

    await expect(
      runCli(["pro", "status", "--port", "65534", "--timeout-ms", "10"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow(/pro browser/);
  });

  it("prints a product check instead of failing when setup pieces are missing", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const out: string[] = [];

    await runCli(["pro", "browser", "check", "--port", "65534", "--timeout-ms", "10"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(text).toContain("bridge: ok");
    expect(text).toContain("config: missing");
    expect(text).toContain("chatgpt: browser_unreachable");
    expect(text).toContain("latest_pro: missing");
  });

  it("redacts the local MCP token in product checks", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    await runCli(["setup", "--port", "8789", "--token", "super-secret-token"], {
      cwd,
      stdout: () => {},
      stderr: () => {}
    });
    const out: string[] = [];

    await runCli(["pro", "browser", "check", "--port", "65534", "--timeout-ms", "10"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(text).toContain("gptprouse_token=***");
    expect(text).not.toContain("super-secret-token");
  });

  it("redacts local MCP tokens from setup, start, and status output by default", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const setupOut: string[] = [];

    await runCli(["setup", "--port", "8789", "--token", "super-secret-token"], {
      cwd,
      stdout: (line) => setupOut.push(line),
      stderr: () => {}
    });
    const statusOut: string[] = [];
    await runCli(["status"], {
      cwd,
      stdout: (line) => statusOut.push(line),
      stderr: () => {}
    });

    const text = [...setupOut, ...statusOut].join("\n");
    expect(text).toContain("gptprouse_token=***");
    expect(text).not.toContain("super-secret-token");
  });

  it("prints the local MCP URL token only when explicitly requested", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    await runCli(["setup", "--port", "8789", "--token", "super-secret-token"], {
      cwd,
      stdout: () => {},
      stderr: () => {}
    });
    const out: string[] = [];

    await runCli(["status", "--show-token"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    expect(out.join("\n")).toContain("super-secret-token");
  });
});
