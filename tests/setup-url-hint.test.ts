import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

/** Split a printed command into argv, honouring the single quotes shellQuote writes. */
function shellWords(command: string): string[] {
  const words: string[] = [];
  for (const match of command.matchAll(/'((?:[^']|'\\'')*)'|(\S+)/g)) {
    words.push(match[1] !== undefined ? match[1].replaceAll("'\\''", "'") : match[2]!);
  }
  return words;
}

async function run(args: string[], cwd: string): Promise<{ out: string[]; err: string[]; error?: Error }> {
  const out: string[] = [];
  const err: string[] = [];
  try {
    await runCli(args, { cwd, stdout: (line) => out.push(line), stderr: (line) => err.push(line) });
    return { out, err };
  } catch (error) {
    return { out, err, error: error as Error };
  }
}

/** The first `prodex ...` command quoted in the line, as argv without the leading `prodex`. */
function quotedCommand(line: string, subcommand: string): string[] {
  const command = new RegExp("`prodex (" + subcommand + "[^`]*)`").exec(line)?.[1];
  return command === undefined ? [] : shellWords(command);
}

// Measured 2026-10-07: setup's default token never expires, and setup then
// told the user to print the URL with `prodex status --show-token --url-only`,
// which refuses a non-expiring token. Following the printed advice failed.
// Found 2026-11-09: `prodex setup --cwd <dir>` run from another directory
// printed the command without --cwd, and running it as printed failed with
// "status requires local MCP setup".
async function setupThenFollowHint(extra: string[]): Promise<{ hint: string[]; out: string[]; err: string[]; failed: boolean; target: string }> {
  const target = await mkdtemp(path.join(tmpdir(), "prodex-setup-hint-"));
  const launcher = await mkdtemp(path.join(tmpdir(), "prodex-setup-hint-launcher-"));
  const setup = await run(["setup", "--cwd", target, ...extra], launcher);
  if (setup.error) throw setup.error;
  const line = setup.out.find((l) => /print the full URL with/i.test(l)) ?? "";
  const hint = quotedCommand(line, "status");
  const followed = await run(hint, launcher);
  return { hint, out: followed.out, err: followed.err, failed: followed.error !== undefined, target };
}

describe("the URL hint setup prints", () => {
  it("works for the default, non-expiring token", async () => {
    const result = await setupThenFollowHint([]);
    expect(result.hint).toEqual(["status", "--cwd", result.target, "--show-token", "--url-only", "--unsafe-show-non-expiring-token"]);
    expect(result.failed).toBe(false);
    expect(result.out.join("\n")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\?prodex_token=/m);
  });

  it("works for an expiring token", async () => {
    const result = await setupThenFollowHint(["--token-ttl-hours", "24"]);
    expect(result.hint).toEqual(["status", "--cwd", result.target, "--show-token", "--url-only"]);
    expect(result.failed).toBe(false);
    expect(result.out.join("\n")).toMatch(/prodex_token=/);
  });

  it("leaves --cwd out when setup ran in the repo itself", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-setup-hint-"));
    const setup = await run(["setup", "--token-ttl-hours", "24"], cwd);
    const hint = quotedCommand(setup.out.find((l) => /print the full URL with/i.test(l)) ?? "", "status");
    expect(hint).toEqual(["status", "--show-token", "--url-only"]);
    expect((await run(hint, cwd)).error).toBeUndefined();
  });

  // Found 2026-11-09: setup kept an expired token, printed "Token expired",
  // then said "it never expires" and named `status --show-token --url-only
  // --unsafe-show-non-expiring-token`, which refuses an expired token.
  it("names a command that works when the saved token has expired", async () => {
    const target = await mkdtemp(path.join(tmpdir(), "prodex-setup-hint-"));
    const launcher = await mkdtemp(path.join(tmpdir(), "prodex-setup-hint-launcher-"));
    await writeExpiredConfig(target);

    const setup = await run(["setup", "--cwd", target, "--port", "51251"], launcher);
    expect(setup.error).toBeUndefined();
    const text = setup.out.join("\n");
    expect(text).toMatch(/^Token expired: /m);
    expect(text).not.toMatch(/never expires/);
    expect(text).not.toContain("--unsafe-show-non-expiring-token");
    const line = setup.out.find((l) => /has expired/.test(l)) ?? "";
    const fix = quotedCommand(line, "setup");
    expect(fix).toEqual(["setup", "--cwd", target, "--token-ttl-hours", "<hours>"]);

    const rotated = await run(fix.map((word) => (word === "<hours>" ? "1" : word)), launcher);
    expect(rotated.error).toBeUndefined();
    const status = await run(["status", "--cwd", target, "--show-token", "--url-only"], launcher);
    expect(status.error).toBeUndefined();
    expect(status.out.join("\n")).toMatch(/prodex_token=/);
  });

  it("refuses a TTL so small that the token would expire as it is made", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-setup-hint-"));
    const setup = await run(["setup", "--token-ttl-hours", "1e-9"], cwd);
    expect(setup.error?.message ?? "setup succeeded").toMatch(/--token-ttl-hours is too small/);
    expect(setup.out.join("\n")).not.toMatch(/Saved local/);
    await expect(readFile(path.join(cwd, ".bridge", "config.local.json"), "utf8")).rejects.toThrow();
  });
});

async function writeExpiredConfig(cwd: string): Promise<void> {
  await mkdir(path.join(cwd, ".bridge"), { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(cwd, ".bridge", "config.local.json"),
    `${JSON.stringify(
      {
        schema_version: 1,
        host: "127.0.0.1",
        port: 51250,
        token: "expired-test-token",
        server_url: "http://127.0.0.1:51250/mcp",
        token_expires_at: new Date(Date.now() - 60_000).toISOString(),
        created_at: new Date(Date.now() - 120_000).toISOString(),
        updated_at: new Date(Date.now() - 120_000).toISOString()
      },
      null,
      2
    )}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
}
