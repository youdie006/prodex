import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadLocalConfig, writeLocalConfig } from "../src/config.js";

describe("local bridge config", () => {
  it("stores ChatGPT Developer Mode HTTP settings in an ignored local file", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-config-"));

    const config = await writeLocalConfig(cwd, { port: 9797, token: "test-token" });
    const loaded = await loadLocalConfig(cwd);
    const bridgeIgnore = await readFile(path.join(cwd, ".bridge", ".gitignore"), "utf8");

    expect(config.server_url).toBe("http://127.0.0.1:9797/mcp?gptprouse_token=test-token");
    expect(loaded).toEqual(config);
    expect(bridgeIgnore).toContain("config.local.json");
  });
});
