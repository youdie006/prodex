import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

// Measured 2026-10-07: setup's default token never expires, and setup then
// told the user to print the URL with `prodex status --show-token --url-only`,
// which refuses a non-expiring token. Following the printed advice failed.
async function setupThenFollowHint(extra: string[]): Promise<{ hint: string; out: string[]; err: string[]; failed: boolean }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "prodex-setup-hint-"));
  const setupOut: string[] = [];
  await runCli(["setup", "--cwd", cwd, ...extra], { cwd, stdout: (l: string) => setupOut.push(l), stderr: () => {} });
  const line = setupOut.find((l) => /print the full URL with/i.test(l)) ?? "";
  const command = /`prodex (status[^`]*)`/.exec(line)?.[1] ?? "";
  const out: string[] = [];
  const err: string[] = [];
  let failed = false;
  try {
    await runCli([...command.split(" "), "--cwd", cwd], { cwd, stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) });
  } catch {
    failed = true;
  }
  return { hint: command, out, err, failed };
}

describe("the URL hint setup prints", () => {
  it("works for the default, non-expiring token", async () => {
    const result = await setupThenFollowHint([]);
    expect(result.hint).toMatch(/^status --show-token --url-only/);
    expect(result.failed).toBe(false);
    expect(result.out.join("\n")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\?prodex_token=/m);
  });

  it("works for an expiring token", async () => {
    const result = await setupThenFollowHint(["--token-ttl-hours", "24"]);
    expect(result.failed).toBe(false);
    expect(result.out.join("\n")).toMatch(/prodex_token=/);
  });
});
