import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadBrowserDefaults, loadLocalConfig, localConfigPath, mergeBrowserDefaultSources, writeLocalConfig } from "../src/config.js";
import { setSafeFileTestHooks } from "../src/safe-file.js";

describe("local bridge config", () => {
  afterEach(() => {
    setSafeFileTestHooks({});
  });

  it("stores ChatGPT Developer Mode HTTP settings in an ignored local file", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-config-"));

    const config = await writeLocalConfig(cwd, { port: 9797, token: "test-token" });
    const loaded = await loadLocalConfig(cwd);
    const bridgeIgnore = await readFile(path.join(cwd, ".bridge", ".gitignore"), "utf8");

    // The persisted endpoint carries no token - it lives in `token` only.
    expect(config.server_url).toBe("http://127.0.0.1:9797/mcp");
    expect(loaded).toEqual(config);
    expect(bridgeIgnore).toContain("config.local.json");
  });

  it("stores an optional token expiry when a TTL is requested", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-config-"));
    const before = Date.now();

    const config = await writeLocalConfig(cwd, { port: 9797, token: "test-token", tokenTtlHours: 2 });
    const loaded = await loadLocalConfig(cwd);
    const expiryMs = Date.parse(config.token_expires_at ?? "");

    expect(config.token_expires_at).toBeDefined();
    expect(loaded.token_expires_at).toBe(config.token_expires_at);
    expect(expiryMs).toBeGreaterThanOrEqual(before + 2 * 60 * 60 * 1000 - 1000);
    expect(expiryMs).toBeLessThanOrEqual(Date.now() + 2 * 60 * 60 * 1000 + 1000);
  });

  it("loads local MCP configs that use the explicit HTTP default port", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-config-"));

    const config = await writeLocalConfig(cwd, { port: 80, token: "test-token" });
    const loaded = await loadLocalConfig(cwd);

    expect(config.server_url).toBe("http://127.0.0.1:80/mcp");
    expect(loaded.port).toBe(80);
  });

  it("loads legacy local MCP config files without token expiry", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-config-"));
    await mkdir(path.join(cwd, ".bridge"), { recursive: true });
    await writeFile(
      localConfigPath(cwd),
      `${JSON.stringify(
        {
          schema_version: 1,
          host: "127.0.0.1",
          port: 9797,
          token: "test-token",
          server_url: "http://127.0.0.1:9797/mcp?prodex_token=test-token",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const loaded = await loadLocalConfig(cwd);

    expect(loaded.token).toBe("test-token");
    expect(loaded.token_expires_at).toBeUndefined();
  });

  it("rejects non-loopback hosts when writing local MCP config", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-config-"));

    await expect(writeLocalConfig(cwd, { host: "0.0.0.0", port: 9797, token: "test-token" })).rejects.toThrow(/loopback|local/i);
    await expect(readFile(localConfigPath(cwd), "utf8")).rejects.toThrow();
  });

  it("rejects legacy local MCP config files with non-loopback hosts", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-config-"));
    await mkdir(path.join(cwd, ".bridge"), { recursive: true });
    await writeFile(
      localConfigPath(cwd),
      `${JSON.stringify(
        {
          schema_version: 1,
          host: "0.0.0.0",
          port: 9797,
          token: "test-token",
          server_url: "http://0.0.0.0:9797/mcp?prodex_token=test-token",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await expect(loadLocalConfig(cwd)).rejects.toThrow(/loopback|local/i);
  });

  it("rejects local MCP config files whose server_url does not match the listener token", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-config-"));
    await mkdir(path.join(cwd, ".bridge"), { recursive: true });
    await writeFile(
      localConfigPath(cwd),
      `${JSON.stringify(
        {
          schema_version: 1,
          host: "127.0.0.1",
          port: 9797,
          token: "real-token",
          server_url: "http://127.0.0.1:9797/mcp?prodex_token=stale-token",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    // A stale token in the URL used to be a hard error, because the URL was a
    // second source of truth for the secret. It no longer is: the load strips
    // it, so a legacy or hand-edited config keeps working and stops carrying
    // a duplicate secret.
    const loaded = await loadLocalConfig(cwd);
    expect(loaded.server_url).toBe("http://127.0.0.1:9797/mcp");
    expect(loaded.token).toBe("real-token");
  });

  it("rejects non-positive token TTL values", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-config-"));

    await expect(writeLocalConfig(cwd, { port: 9797, token: "test-token", tokenTtlHours: 0 })).rejects.toThrow(/token ttl/i);
  });

  it("writes local MCP config with owner-only permissions", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-config-"));

    await writeLocalConfig(cwd, { port: 9797, token: "test-token" });

    if (process.platform !== "win32") {
      expect((await stat(path.join(cwd, ".bridge"))).mode & 0o777).toBe(0o700);
      expect((await stat(localConfigPath(cwd))).mode & 0o777).toBe(0o600);
    }
  });

  it("repairs existing local MCP config permissions on load", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-config-"));
    await writeLocalConfig(cwd, { port: 9797, token: "test-token" });

    if (process.platform !== "win32") {
      await chmod(path.join(cwd, ".bridge"), 0o777);
      await chmod(localConfigPath(cwd), 0o666);
      await loadLocalConfig(cwd);
      expect((await stat(path.join(cwd, ".bridge"))).mode & 0o777).toBe(0o700);
      expect((await stat(localConfigPath(cwd))).mode & 0o777).toBe(0o600);
    }
  });

  it("rejects symlinked bridge config storage", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-config-"));
    const outside = await mkdtemp(path.join(tmpdir(), "prodex-config-outside-"));
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(cwd, ".bridge"), "dir");

    await expect(writeLocalConfig(cwd, { port: 9797, token: "test-token" })).rejects.toThrow(/symlink|real directory/);
    await expect(loadLocalConfig(cwd)).rejects.toThrow(/symlink|real directory/);
    await expect(readFile(path.join(outside, "config.local.json"), "utf8")).rejects.toThrow();
  });

  it("rejects symlinked config files", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-config-"));
    const outside = await mkdtemp(path.join(tmpdir(), "prodex-config-outside-"));
    await mkdir(path.join(cwd, ".bridge"), { recursive: true });
    await writeFile(path.join(outside, "config.local.json"), "{}\n", "utf8");
    await symlink(path.join(outside, "config.local.json"), localConfigPath(cwd));

    await expect(writeLocalConfig(cwd, { port: 9797, token: "test-token" })).rejects.toThrow(/symlink/);
    await expect(loadLocalConfig(cwd)).rejects.toThrow(/symlink/);
  });

  it("rejects symlinked bridge gitignore files", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-config-"));
    const outside = await mkdtemp(path.join(tmpdir(), "prodex-config-outside-"));
    const outsideGitignore = path.join(outside, ".gitignore");
    await mkdir(path.join(cwd, ".bridge"), { recursive: true });
    await writeFile(outsideGitignore, "outside\n", "utf8");
    await symlink(outsideGitignore, path.join(cwd, ".bridge", ".gitignore"));

    await expect(writeLocalConfig(cwd, { port: 9797, token: "test-token" })).rejects.toThrow(/gitignore|symlink/i);
    expect(await readFile(outsideGitignore, "utf8")).toBe("outside\n");
  });

  it("rejects config writes when the config path is swapped to a symlink before open", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-config-"));
    const outside = await mkdtemp(path.join(tmpdir(), "prodex-config-outside-"));
    const outsideConfig = path.join(outside, "config.local.json");
    await writeFile(outsideConfig, "outside\n", "utf8");
    let swapped = false;
    setSafeFileTestHooks({
      beforeOpen: async (filePath, operation) => {
        if (!swapped && operation === "write" && filePath === localConfigPath(cwd)) {
          swapped = true;
          await symlink(outsideConfig, localConfigPath(cwd));
        }
      }
    });

    await expect(writeLocalConfig(cwd, { port: 9797, token: "test-token" })).rejects.toThrow(/symlink|changed/i);
    expect(await readFile(outsideConfig, "utf8")).toBe("outside\n");
  });

  it("rejects config reads when the config path is swapped to a symlink before open", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-config-"));
    const outside = await mkdtemp(path.join(tmpdir(), "prodex-config-outside-"));
    const outsideConfig = path.join(outside, "config.local.json");
    await writeLocalConfig(cwd, { port: 9797, token: "inside-token" });
    await writeFile(
      outsideConfig,
      `${JSON.stringify(
        {
          schema_version: 1,
          host: "127.0.0.1",
          port: 9797,
          token: "outside-token",
          server_url: "http://127.0.0.1:9797/mcp?prodex_token=outside-token",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    let swapped = false;
    setSafeFileTestHooks({
      beforeOpen: async (filePath, operation) => {
        if (!swapped && operation === "read" && filePath === localConfigPath(cwd)) {
          swapped = true;
          await rm(localConfigPath(cwd));
          await symlink(outsideConfig, localConfigPath(cwd));
        }
      }
    });

    await expect(loadLocalConfig(cwd)).rejects.toThrow(/symlink|changed/i);
  });
});

describe("browser selection defaults", () => {
  afterEach(() => {
    setSafeFileTestHooks({});
  });

  it("persists browser defaults and reloads them", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-config-"));

    const config = await writeLocalConfig(cwd, {
      token: "test-token",
      browserDefaults: { model: "Pro", proMode: "확장", project: "sandbox-demo" }
    });
    const loaded = await loadLocalConfig(cwd);

    expect(config.browser_defaults).toEqual({ model: "Pro", pro_mode: "확장", project: "sandbox-demo" });
    expect(loaded.browser_defaults).toEqual({ model: "Pro", pro_mode: "확장", project: "sandbox-demo" });
  });

  it("merges new browser defaults with existing ones", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-config-"));

    await writeLocalConfig(cwd, { token: "test-token", browserDefaults: { model: "Pro", proMode: "기본" } });
    const updated = await writeLocalConfig(cwd, { token: "test-token", browserDefaults: { effort: "높음", proMode: undefined } });

    // effort added, model preserved, proMode explicitly cleared
    expect(updated.browser_defaults).toEqual({ model: "Pro", effort: "높음" });
  });

  it("returns undefined defaults when no config exists", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-config-"));
    expect(await loadBrowserDefaults(cwd)).toBeUndefined();
  });

  it("reads persisted defaults best-effort", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-config-"));
    await writeLocalConfig(cwd, { token: "test-token", browserDefaults: { effort: "매우 높음" } });
    expect(await loadBrowserDefaults(cwd)).toEqual({ effort: "매우 높음" });
  });

  it("falls back to PRODEX_DEFAULT_* env vars from any cwd (repo wins per-field)", async () => {
    const priorProject = process.env.PRODEX_DEFAULT_PROJECT;
    const priorModel = process.env.PRODEX_DEFAULT_MODEL;
    const priorEffort = process.env.PRODEX_DEFAULT_EFFORT;
    process.env.PRODEX_DEFAULT_PROJECT = "Codex";
    process.env.PRODEX_DEFAULT_MODEL = "Pro";
    process.env.PRODEX_DEFAULT_EFFORT = "not-a-real-effort";
    try {
      // A repo with no config picks up the env default (Codex + Pro; bad enum dropped).
      const empty = await mkdtemp(path.join(tmpdir(), "prodex-config-"));
      expect(await loadBrowserDefaults(empty)).toEqual({ project: "Codex", model: "Pro" });

      // A per-repo default wins its field; env fills the rest.
      const pinned = await mkdtemp(path.join(tmpdir(), "prodex-config-"));
      await writeLocalConfig(pinned, { token: "t", browserDefaults: { project: "prodex-smoke-project" } });
      expect(await loadBrowserDefaults(pinned)).toEqual({ project: "prodex-smoke-project", model: "Pro" });
    } finally {
      if (priorProject === undefined) delete process.env.PRODEX_DEFAULT_PROJECT;
      else process.env.PRODEX_DEFAULT_PROJECT = priorProject;
      if (priorModel === undefined) delete process.env.PRODEX_DEFAULT_MODEL;
      else process.env.PRODEX_DEFAULT_MODEL = priorModel;
      if (priorEffort === undefined) delete process.env.PRODEX_DEFAULT_EFFORT;
      else process.env.PRODEX_DEFAULT_EFFORT = priorEffort;
    }
  });
});

// Defaults are a convenience, so a repo with no config has none and says
// nothing. A config that EXISTS and cannot be read is not the same answer: the
// project and model pinned in it stop applying with nothing said, and a
// consult that should have landed in a project lands in the general chat and
// looks like it worked.
describe("a config that exists and cannot be read", () => {
  it("refuses to report no defaults for a corrupt config", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-config-"));
    await writeLocalConfig(cwd, { token: "test-token", browserDefaults: { project: "pinned" } });
    await writeFile(localConfigPath(cwd), "{ not json", { mode: 0o600 });
    await expect(loadBrowserDefaults(cwd)).rejects.toThrow(/corrupt/i);
  });

  // The env defaults are still readable, and applying only those would be the
  // same silent half-answer: a global model with the repo's project missing.
  it("refuses even when the env could supply some of them", async () => {
    const prior = process.env.PRODEX_DEFAULT_MODEL;
    process.env.PRODEX_DEFAULT_MODEL = "Pro";
    try {
      const cwd = await mkdtemp(path.join(tmpdir(), "prodex-config-"));
      await writeLocalConfig(cwd, { token: "test-token", browserDefaults: { project: "pinned" } });
      await writeFile(localConfigPath(cwd), "{ not json", { mode: 0o600 });
      await expect(loadBrowserDefaults(cwd)).rejects.toThrow(/corrupt/i);
    } finally {
      if (prior === undefined) delete process.env.PRODEX_DEFAULT_MODEL;
      else process.env.PRODEX_DEFAULT_MODEL = prior;
    }
  });

  it("says what stops applying until it is fixed", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-config-"));
    await writeLocalConfig(cwd, { token: "test-token" });
    await writeFile(localConfigPath(cwd), "{ not json", { mode: 0o600 });
    await expect(loadBrowserDefaults(cwd)).rejects.toThrow(/browser defaults/i);
  });

  // The first version of this message offered a way out that does not exist:
  // the config is read before any flag is looked at, so "pass them explicitly"
  // hits the same error. Moving the file aside is the one that works - a repo
  // with no config has no defaults and sends fine.
  it("offers only the way out that actually works", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-config-"));
    await writeLocalConfig(cwd, { token: "test-token", browserDefaults: { project: "pinned" } });
    await writeFile(localConfigPath(cwd), "{ not json", { mode: 0o600 });
    const failure = await loadBrowserDefaults(cwd).catch((error: unknown) => error as Error);
    expect((failure as Error).message).toMatch(/move .bridge\/config\.local\.json aside/i);
    expect((failure as Error).message).not.toMatch(/pass them explicitly/i);
  });
});

// The project is independent of the rest. The model and the two reasoning
// fields are not: an effort is a step ChatGPT deselects the model to reach, so
// a repo pinning `model: Pro` beside PRODEX_DEFAULT_EFFORT used to produce a
// request neither side made - the send ran at the env's effort and dropped Pro.
describe("combining the global defaults with a repo's", () => {
  it("takes the whole reasoning selection from whichever side names any of it", () => {
    expect(mergeBrowserDefaultSources({ effort: "중간" }, { model: "Pro" })).toEqual({ model: "Pro" });
    expect(mergeBrowserDefaultSources({ model: "Pro" }, { effort: "중간" })).toEqual({ effort: "중간" });
  });

  it("falls back to the global selection when the repo names none of it", () => {
    expect(mergeBrowserDefaultSources({ model: "Pro", effort: "중간" }, { project: "Notes" })).toEqual({
      model: "Pro",
      effort: "중간",
      project: "Notes"
    });
  });

  it("keeps the project field-by-field, because it is nobody else's axis", () => {
    expect(mergeBrowserDefaultSources({ project: "Global", model: "Pro" }, { project: "Repo" })).toEqual({
      project: "Repo",
      model: "Pro"
    });
    expect(mergeBrowserDefaultSources(undefined, undefined)).toBeUndefined();
  });
});

describe("resolveProdexCwd", () => {
  it("prefers an absolute PRODEX_CWD over a broken process working directory", async () => {
    // The MCP server takes no flags, so when its working directory is unusable
    // (a /dev/fd pipe path, a deleted directory) the env var is the only way
    // for an operator to pin the repo without changing how the agent harness
    // spawns the server.
    const { resolveProdexCwd } = await import("../src/config.js");
    expect(resolveProdexCwd("/dev/fd/11", { PRODEX_CWD: "/home/me/repo" })).toBe("/home/me/repo");
    expect(resolveProdexCwd("/home/me/repo", {})).toBe("/home/me/repo");
    // A relative or empty value is ignored rather than silently resolved
    // against the same broken cwd.
    expect(resolveProdexCwd("/dev/fd/11", { PRODEX_CWD: "repo" })).toBe("/dev/fd/11");
    expect(resolveProdexCwd("/dev/fd/11", { PRODEX_CWD: "   " })).toBe("/dev/fd/11");
  });
});

describe("token is stored in exactly one field", () => {
  it("keeps the token out of server_url, and still composes the token-bearing URL on demand", async () => {
    // Field report: an operator's redaction masked the `token` key and leaked
    // the same secret from server_url, because setup persisted it twice. One
    // field is the only shape where masking the token masks the token.
    const { writeLocalConfig, loadLocalConfig, composeServerUrlWithToken } = await import("../src/config.js");
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-token-shape-"));
    await writeLocalConfig(cwd, { token: "s3cr3t-token-value" });

    const raw = await readFile(path.join(cwd, ".bridge", "config.local.json"), "utf8");
    expect(raw).toContain("s3cr3t-token-value");
    expect(raw.match(/s3cr3t-token-value/g)).toHaveLength(1);
    const stored = JSON.parse(raw) as { server_url: string };
    expect(stored.server_url).not.toContain("s3cr3t-token-value");
    expect(stored.server_url).not.toContain("prodex_token");

    const config = await loadLocalConfig(cwd);
    expect(composeServerUrlWithToken(config)).toContain("prodex_token=s3cr3t-token-value");
  });

  it("accepts and repairs a config written before the token was split out", async () => {
    const { loadLocalConfig, composeServerUrlWithToken } = await import("../src/config.js");
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-token-legacy-"));
    await mkdir(path.join(cwd, ".bridge"), { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(cwd, ".bridge", "config.local.json"),
      JSON.stringify({
        schema_version: 1,
        host: "127.0.0.1",
        port: 8787,
        token: "legacy-token",
        server_url: "http://127.0.0.1:8787/mcp?prodex_token=legacy-token",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z"
      }),
      { mode: 0o600 }
    );

    const config = await loadLocalConfig(cwd);
    expect(config.server_url).not.toContain("legacy-token");
    expect(composeServerUrlWithToken(config)).toContain("prodex_token=legacy-token");

    // Self-heal: the duplicate has to leave the FILE too, or an operator
    // reading config.local.json still finds the secret twice.
    const healed = await readFile(path.join(cwd, ".bridge", "config.local.json"), "utf8");
    expect(healed.match(/legacy-token/g)).toHaveLength(1);
    expect(JSON.parse(healed).server_url).toBe("http://127.0.0.1:8787/mcp");
  });
});
