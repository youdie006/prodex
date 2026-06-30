import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadLocalConfig, localConfigPath, writeLocalConfig } from "../src/config.js";
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

    expect(config.server_url).toBe("http://127.0.0.1:9797/mcp?prodex_token=test-token");
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

    expect(config.server_url).toBe("http://127.0.0.1:80/mcp?prodex_token=test-token");
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

    await expect(loadLocalConfig(cwd)).rejects.toThrow(/server_url|token|match/i);
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
