import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { bridgesRegistryPath, registerBridgeRoot } from "../src/registry.js";

async function withTempRegistry(fn: (file: string, makeRoot: () => Promise<string>) => Promise<void>): Promise<void> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "prodex-registry-")));
  const file = path.join(dir, "bridges.json");
  const prev = process.env.PRODEX_BRIDGES_REGISTRY;
  process.env.PRODEX_BRIDGES_REGISTRY = file;
  let counter = 0;
  const makeRoot = async () => {
    const root = path.join(dir, `repo-${counter++}`);
    await fs.mkdir(root, { recursive: true });
    return root;
  };
  try {
    await fn(file, makeRoot);
  } finally {
    if (prev === undefined) delete process.env.PRODEX_BRIDGES_REGISTRY;
    else process.env.PRODEX_BRIDGES_REGISTRY = prev;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function readRoots(file: string): Promise<string[]> {
  return (JSON.parse(await fs.readFile(file, "utf8")) as { roots: string[] }).roots;
}

describe("registerBridgeRoot", () => {
  it("records a root once, dedupes repeats, appends new roots", async () => {
    await withTempRegistry(async (file, makeRoot) => {
      const a = await makeRoot();
      const b = await makeRoot();
      await registerBridgeRoot(a);
      await registerBridgeRoot(a);
      await registerBridgeRoot(b);
      const parsed = JSON.parse(await fs.readFile(file, "utf8"));
      expect(parsed.schema_version).toBe(1);
      expect(parsed.roots).toEqual([a, b]);
    });
  });

  it("rebuilds from scratch over a corrupt registry and never throws", async () => {
    await withTempRegistry(async (file, makeRoot) => {
      const c = await makeRoot();
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, "NOT JSON{{{", "utf8");
      await expect(registerBridgeRoot(c)).resolves.toBeUndefined();
      expect(await readRoots(file)).toEqual([c]);
    });
  });

  it("does not lose roots under concurrent registration", async () => {
    await withTempRegistry(async (file, makeRoot) => {
      const roots = await Promise.all(Array.from({ length: 20 }, () => makeRoot()));
      await Promise.all(roots.map((r) => registerBridgeRoot(r)));
      const recorded = await readRoots(file);
      for (const r of roots) {
        expect(recorded).toContain(r);
      }
    });
  });

  it("honors the env override for its location", async () => {
    await withTempRegistry(async (file) => {
      expect(bridgesRegistryPath()).toBe(file);
    });
  });

  it("canonicalizes symlinked roots so one bridge has one spelling", async () => {
    await withTempRegistry(async (file, makeRoot) => {
      const real = await makeRoot();
      const link = `${real}-link`;
      await fs.symlink(real, link);
      await registerBridgeRoot(link);
      await registerBridgeRoot(real);
      expect(await readRoots(file)).toEqual([real]);
    });
  });

  it("prunes roots whose directory no longer exists when a new root is added", async () => {
    await withTempRegistry(async (file, makeRoot) => {
      const dead = await makeRoot();
      await registerBridgeRoot(dead);
      await fs.rm(dead, { recursive: true, force: true });
      const alive = await makeRoot();
      await registerBridgeRoot(alive);
      expect(await readRoots(file)).toEqual([alive]);
    });
  });
});
