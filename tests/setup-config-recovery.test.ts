import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { shellQuote } from "../src/cli-args.js";
import { runCli } from "../src/cli.js";
import { localConfigPath, writeLocalConfigWithRecovery } from "../src/config.js";

// A fixture value, never a real token. Assertions compare it as a boolean so a
// failure cannot print a token either.
const FIXTURE_TOKEN = "recovery-fixture-token-not-real";
const FUTURE_EXPIRY = "2099-01-01T00:00:00.000Z";
const OLD_CREATED_AT = "2026-01-02T03:04:05.000Z";

function validConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    host: "127.0.0.1",
    port: 51260,
    token: FIXTURE_TOKEN,
    server_url: "http://127.0.0.1:51260/mcp",
    token_expires_at: FUTURE_EXPIRY,
    browser_defaults: { model: "Pro", project: "Test Project" },
    created_at: OLD_CREATED_AT,
    updated_at: OLD_CREATED_AT,
    ...overrides
  };
}

async function repoWithConfig(content: string | Record<string, unknown>): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "prodex-config-recovery-"));
  await mkdir(path.join(cwd, ".bridge"), { recursive: true, mode: 0o700 });
  await writeFile(localConfigPath(cwd), typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  return cwd;
}

async function savedConfig(cwd: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(localConfigPath(cwd), "utf8"));
}

async function run(args: string[], cwd: string): Promise<{ text: string; error?: Error }> {
  const lines: string[] = [];
  try {
    await runCli(args, { cwd, stdout: (line) => lines.push(line), stderr: (line) => lines.push(line) });
    return { text: lines.join("\n") };
  } catch (error) {
    return { text: lines.join("\n"), error: error as Error };
  }
}

// Found 2026-11-09: one invalid optional field (browser_defaults.effort "Extra
// High") made setup treat the whole config as missing. It replaced the token
// with a random one, dropped the valid model and project, removed the expiry
// and reset created_at, and said none of it.
describe("setup over a config with an invalid field", () => {
  it("keeps every field that is still valid and names the one it dropped", async () => {
    const cwd = await repoWithConfig(validConfig({ browser_defaults: { model: "Pro", project: "Test Project", effort: "Extra High" } }));

    const { config, recovery } = await writeLocalConfigWithRecovery(cwd, { port: 51261 });

    expect(config.token === FIXTURE_TOKEN).toBe(true);
    expect(config.token_expires_at).toBe(FUTURE_EXPIRY);
    expect(config.created_at).toBe(OLD_CREATED_AT);
    expect(config.browser_defaults).toEqual({ model: "Pro", project: "Test Project" });
    expect(config.port).toBe(51261);
    expect(recovery).toEqual({ unreadable: false, dropped: ["browser_defaults.effort"], tokenReplaced: false });
    expect((await savedConfig(cwd)).token === FIXTURE_TOKEN).toBe(true);
  });

  it("replaces the token, and says so, when its expiry cannot be read", async () => {
    // Keeping the token without its expiry would turn a token meant to lapse
    // into one that never does.
    const cwd = await repoWithConfig(validConfig({ token_expires_at: "next week" }));

    const { config, recovery } = await writeLocalConfigWithRecovery(cwd, {});

    expect(config.token === FIXTURE_TOKEN).toBe(false);
    expect(config.token.length).toBeGreaterThan(0);
    expect(config.token_expires_at).toBeUndefined();
    expect(config.browser_defaults).toEqual({ model: "Pro", project: "Test Project" });
    expect(config.created_at).toBe(OLD_CREATED_AT);
    expect(recovery).toEqual({ unreadable: false, dropped: ["token_expires_at"], tokenReplaced: true });
  });

  it("reports a file it could not read at all as replaced", async () => {
    const cwd = await repoWithConfig("{not json");

    const { recovery } = await writeLocalConfigWithRecovery(cwd, {});

    expect(recovery).toEqual({ unreadable: true, dropped: [], tokenReplaced: true });
  });

  it("reports nothing for a valid config, and no token change when a new one was asked for", async () => {
    const valid = await repoWithConfig(validConfig());
    expect((await writeLocalConfigWithRecovery(valid, { port: 51262 })).recovery).toBeUndefined();

    const invalid = await repoWithConfig(validConfig({ browser_defaults: { project: "Test Project", effort: "Extra High" } }));
    const { config, recovery } = await writeLocalConfigWithRecovery(invalid, { tokenTtlHours: 1 });
    expect(config.token === FIXTURE_TOKEN).toBe(false);
    expect(recovery).toEqual({ unreadable: false, dropped: ["browser_defaults.effort"], tokenReplaced: false });
  });

  it("prints which field setup dropped, and that the token was kept, without printing the token", async () => {
    const target = await repoWithConfig(validConfig({ browser_defaults: { project: "Test Project", effort: "Extra High" } }));
    const launcher = await mkdtemp(path.join(tmpdir(), "prodex-config-recovery-launcher-"));

    const status = await run(["status", "--cwd", target], launcher);
    expect(status.error?.message ?? "").toMatch(/corrupt/);

    const setup = await run(["setup", "--cwd", target, "--port", "51263"], launcher);
    expect(setup.error).toBeUndefined();
    expect(setup.text).toMatch(/Dropped browser_defaults\.effort from \.bridge\/config\.local\.json/);
    expect(setup.text).toMatch(/token .*kept/i);
    expect(setup.text.includes(FIXTURE_TOKEN)).toBe(false);

    const after = await run(["status", "--cwd", target], launcher);
    expect(after.error).toBeUndefined();
    expect(JSON.parse(after.text).browser_defaults).toEqual({ project: "Test Project" });
  });

  it("says plainly that the token changed when the file could not be read", async () => {
    const target = await repoWithConfig("{not json");
    const launcher = await mkdtemp(path.join(tmpdir(), "prodex-config-recovery-launcher-"));

    const setup = await run(["setup", "--cwd", target, "--port", "51264"], launcher);
    expect(setup.error).toBeUndefined();
    expect(setup.text).toMatch(/could not be read/);
    expect(setup.text).toMatch(/token changed/i);
    expect(setup.text).toContain(`prodex status --cwd ${shellQuote(target)} --show-token --url-only`);
    expect(setup.text.includes((await savedConfig(target)).token)).toBe(false);
  });
});

// Found 2026-11-09: with "host": "0.0.0.0" hand-edited into the config,
// status, start and plain setup all said only that the host must be
// loopback-only. Only `setup --host 127.0.0.1` recovered, and nothing said so.
describe("a non-loopback host saved in the config", () => {
  it("names the config file and the setup command that replaces it, with --cwd", async () => {
    // No browser defaults: setup would check them against the picker.
    const target = await repoWithConfig(validConfig({ host: "0.0.0.0", server_url: "http://0.0.0.0:51260/mcp", browser_defaults: undefined }));
    const launcher = await mkdtemp(path.join(tmpdir(), "prodex-config-recovery-launcher-"));
    const fix = `prodex setup --cwd ${shellQuote(target)} --host 127.0.0.1`;

    for (const command of [["status"], ["setup"]]) {
      const result = await run([...command, "--cwd", target], launcher);
      expect(result.error?.message ?? "succeeded").toContain(`\`${fix}\``);
      expect(result.error?.message).toContain('"0.0.0.0"');
      expect(result.error?.message).toContain(".bridge/config.local.json");
      expect(result.error?.message).toMatch(/loopback/);
    }
    const start = runCli(["start", "--cwd", target], { cwd: launcher, stdout: () => {}, stderr: () => {} });
    const stop = setTimeout(() => process.emit("SIGTERM"), 2_000);
    await expect(start).rejects.toThrow(`\`${fix}\``);
    clearTimeout(stop);

    const fixed = await run(fix.split(" ").slice(1).map((word) => (word === shellQuote(target) ? target : word)), launcher);
    expect(fixed.error).toBeUndefined();
    expect((await savedConfig(target)).token === FIXTURE_TOKEN).toBe(true);
    expect((await run(["status", "--cwd", target], launcher)).error).toBeUndefined();
  });

  it("names plain setup when only server_url carries the other host", async () => {
    const target = await repoWithConfig(validConfig({ server_url: "http://0.0.0.0:51260/mcp", browser_defaults: undefined }));
    const launcher = await mkdtemp(path.join(tmpdir(), "prodex-config-recovery-launcher-"));

    const status = await run(["status", "--cwd", target], launcher);
    expect(status.error?.message ?? "succeeded").toContain(`\`prodex setup --cwd ${shellQuote(target)}\``);
    expect(status.error?.message).toContain("server_url");

    expect((await run(["setup", "--cwd", target], launcher)).error).toBeUndefined();
    expect((await run(["status", "--cwd", target], launcher)).error).toBeUndefined();
  });
});

// Found 2026-11-09: `prodex setup --help` listed --allow-model-fallback among
// the defaults setup saves, and `prodex setup --allow-model-fallback` failed
// with "Unknown option for setup".
describe("setup --help", () => {
  it("lists only options setup accepts", async () => {
    const help = await run(["setup", "--help"], await mkdtemp(path.join(tmpdir(), "prodex-setup-help-")));
    const options = [...new Set(help.text.match(/--[a-z][a-z-]*/g) ?? [])].filter((option) => option !== "--help");
    expect(options).toContain("--token-ttl-hours");

    const refused: string[] = [];
    for (const option of options) {
      const result = await run(["setup", option, "--help"], await mkdtemp(path.join(tmpdir(), "prodex-setup-help-")));
      if (result.error) refused.push(`${option}: ${result.error.message}`);
    }
    expect(refused).toEqual([]);
  });
});
