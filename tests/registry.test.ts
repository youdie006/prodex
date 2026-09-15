import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { bridgesRegistryPath, registerBridgeRoot } from "../src/registry.js";
import { BridgeStore } from "../src/store.js";

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

  it("does not follow a pre-created predictable temporary-file symlink", async () => {
    await withTempRegistry(async (file, makeRoot) => {
      const root = await makeRoot();
      const unrelated = path.join(path.dirname(file), "unrelated.txt");
      const predictableTemp = `${file}.${process.pid}.0.tmp`;
      await fs.writeFile(unrelated, "keep me\n", "utf8");
      await fs.symlink(unrelated, predictableTemp);

      await expect(registerBridgeRoot(root)).resolves.toBeUndefined();

      await expect(fs.readFile(unrelated, "utf8")).resolves.toBe("keep me\n");
      await expect(readRoots(file)).resolves.toContain(root);
    });
  });

  it("makes the registry parent private before writing", async () => {
    await withTempRegistry(async (file, makeRoot) => {
      await fs.chmod(path.dirname(file), 0o777);
      await registerBridgeRoot(await makeRoot());

      if (process.platform !== "win32") expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700);
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
      await fs.symlink(real, link, process.platform === "win32" ? "junction" : "dir");
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

// Every `doctor` run built a smoke bridge in a temp directory, deleted it, and
// left a dead entry behind in the user's registry - and one test spawned the
// CLI without the isolation variables and registered a temp root in the REAL
// registry on every run: 54 leaked roots over three days, and every
// `pro blockers` reporting "across 77 bridge roots" on a machine with 19.
describe("keeping throwaway bridges out of the registry", () => {
  it("does not register a bridge that says it is throwaway", async () => {
    await withTempRegistry(async (file, makeRoot) => {
      const root = await makeRoot();
      await new BridgeStore(root, { registerRoot: false }).ensure();
      await expect(fs.readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("still registers an ordinary bridge", async () => {
    await withTempRegistry(async (file, makeRoot) => {
      const root = await makeRoot();
      await new BridgeStore(root).ensure();
      expect(await readRoots(file)).toContain(await fs.realpath(root));
    });
  });
});
