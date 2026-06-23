import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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

  it("labels pro ask as a dry-run preview in help", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const out: string[] = [];

    await runCli(["help"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(text).toContain('gptprouse pro ask [--file path] "prompt"  # dry-run preview');
    expect(text).toContain('gptprouse pro browser ask [--file path] "prompt"  # explicit visible-browser send');
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

  it("prints a friendly browser login guide without opening Chrome in dry-run mode", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const out: string[] = [];

    await runCli(["pro", "browser", "login", "--dry-run"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(text).toContain("ChatGPT Pro browser login");
    expect(text).toContain("Log in manually");
    expect(text).toContain("pro browser check");
    expect(text).toContain("pro browser smoke");
    expect(text).toContain("You can close this Chrome window after login");
  });

  it("points unreachable browser checks at the login flow", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const out: string[] = [];

    await runCli(["pro", "browser", "check", "--port", "65534", "--timeout-ms", "10"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    expect(out.join("\n")).toContain("pro browser login");
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

  it("prints a paste-ready local MCP URL when url-only is requested", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    await runCli(["setup", "--port", "8789", "--token", "super-secret-token"], {
      cwd,
      stdout: () => {},
      stderr: () => {}
    });
    const out: string[] = [];

    await runCli(["status", "--show-token", "--url-only"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    expect(out).toEqual(["http://127.0.0.1:8789/mcp?gptprouse_token=super-secret-token"]);
  });

  it("runs a local doctor smoke for bridge storage and MCP writes", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    const out: string[] = [];

    const code = await runCli(["doctor"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(code).toBe(0);
    expect(text).toContain("gptprouse doctor");
    expect(text).toContain("bridge: ok");
    expect(text).toContain("config: missing");
    expect(text).toContain("mcp_write_smoke: ok");
    expect(text).toContain("receipt_payload=artifact");
    expect(text).toContain("staged=notes.md");
    expect(text).toContain("http_mcp_smoke: ok");
    expect(text).toContain("bridge_create_task");
    expect(text).toContain("repo_stage_reviewed_paths");
  });

  it("redacts local MCP tokens from doctor output", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    await runCli(["setup", "--port", "8789", "--token", "super-secret-token"], {
      cwd,
      stdout: () => {},
      stderr: () => {}
    });
    const out: string[] = [];

    await runCli(["doctor"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(text).toContain("gptprouse_token=***");
    expect(text).not.toContain("super-secret-token");
  });

  it("reports corrupt local MCP config as a doctor failure", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-"));
    await mkdir(path.join(cwd, ".bridge"), { recursive: true });
    await writeFile(path.join(cwd, ".bridge", "config.local.json"), "{not json", "utf8");
    const out: string[] = [];

    const code = await runCli(["doctor"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(code).toBe(1);
    expect(text).toContain("config: failed");
    expect(text).not.toContain("config: missing");
    expect(text).toContain("mcp_write_smoke: ok");
  });
});
