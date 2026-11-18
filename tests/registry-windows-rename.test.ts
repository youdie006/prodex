import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Windows refuses to rename over a file another handle has open, with EPERM,
// EACCES or EBUSY until that handle closes. The registry replaced bridges.json
// with a plain rename, so a bridge whose registration met another process
// reading the registry was silently left out of it.
const renameCalls: string[] = [];
let inUseRenamesLeft = 0;

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const rename = async (from: string, to: string) => {
    renameCalls.push(path.basename(to));
    if (path.basename(to) === "bridges.json" && inUseRenamesLeft > 0) {
      inUseRenamesLeft -= 1;
      throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
    }
    return real.rename(from, to);
  };
  return { ...real, rename, default: { ...real, rename } };
});

const { registerBridgeRoot } = await import("../src/registry.js");

describe("registering a bridge while Windows reports the registry in use", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    renameCalls.length = 0;
    inUseRenamesLeft = 0;
  });

  it("renames again instead of leaving the bridge out", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "prodex-registry-win-")));
    const file = path.join(dir, "bridges.json");
    const root = path.join(dir, "repo");
    await fs.mkdir(root);
    const prev = process.env.PRODEX_BRIDGES_REGISTRY;
    process.env.PRODEX_BRIDGES_REGISTRY = file;
    try {
      inUseRenamesLeft = 2;
      await registerBridgeRoot(root);
      const roots = (JSON.parse(await fs.readFile(file, "utf8")) as { roots: string[] }).roots;
      expect(roots).toEqual([root]);
      expect(renameCalls.filter((name) => name === "bridges.json")).toHaveLength(3);
    } finally {
      if (prev === undefined) delete process.env.PRODEX_BRIDGES_REGISTRY;
      else process.env.PRODEX_BRIDGES_REGISTRY = prev;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
