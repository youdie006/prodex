import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { bridgesRegistryPath, registerBridgeRoot } from "../src/registry.js";

async function withTempRegistry(fn: (file: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "prodex-registry-"));
  const file = path.join(dir, "bridges.json");
  const prev = process.env.PRODEX_BRIDGES_REGISTRY;
  process.env.PRODEX_BRIDGES_REGISTRY = file;
  try {
    await fn(file);
  } finally {
    if (prev === undefined) delete process.env.PRODEX_BRIDGES_REGISTRY;
    else process.env.PRODEX_BRIDGES_REGISTRY = prev;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("registerBridgeRoot", () => {
  it("records a root once, dedupes repeats, appends new roots", async () => {
    await withTempRegistry(async (file) => {
      await registerBridgeRoot("/tmp/repo-a");
      await registerBridgeRoot("/tmp/repo-a");
      await registerBridgeRoot("/tmp/repo-b");
      const parsed = JSON.parse(await fs.readFile(file, "utf8"));
      expect(parsed.schema_version).toBe(1);
      expect(parsed.roots).toEqual(["/tmp/repo-a", "/tmp/repo-b"]);
    });
  });

  it("rebuilds from scratch over a corrupt registry and never throws", async () => {
    await withTempRegistry(async (file) => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, "NOT JSON{{{", "utf8");
      await expect(registerBridgeRoot("/tmp/repo-c")).resolves.toBeUndefined();
      const parsed = JSON.parse(await fs.readFile(file, "utf8"));
      expect(parsed.roots).toEqual(["/tmp/repo-c"]);
    });
  });

  it("does not lose roots under concurrent registration", async () => {
    await withTempRegistry(async (file) => {
      const roots = Array.from({ length: 20 }, (_, i) => `/tmp/repo-conc-${i}`);
      await Promise.all(roots.map((r) => registerBridgeRoot(r)));
      const parsed = JSON.parse(await fs.readFile(file, "utf8"));
      for (const r of roots) {
        expect(parsed.roots).toContain(r);
      }
    });
  });

  it("honors the env override for its location", async () => {
    await withTempRegistry(async (file) => {
      expect(bridgesRegistryPath()).toBe(file);
    });
  });
});
