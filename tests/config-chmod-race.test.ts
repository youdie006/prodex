import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setSafeFileTestHooks } from "../src/safe-file.js";

const fsHooks = vi.hoisted(() => ({
  beforePathChmod: undefined as undefined | ((filePath: string, mode: number) => Promise<void> | void)
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    chmod: async (filePath: string, mode: number) => {
      await fsHooks.beforePathChmod?.(filePath, mode);
      return actual.chmod(filePath, mode);
    }
  };
});

const { loadLocalConfig, localConfigPath, writeLocalConfig } = await import("../src/config.js");

describe("local bridge config chmod races", () => {
  afterEach(() => {
    fsHooks.beforePathChmod = undefined;
    setSafeFileTestHooks({});
  });

  it("does not chmod a symlink target swapped in after config write", async () => {
    if (process.platform === "win32") return;
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-config-chmod-"));
    const outside = await mkdtemp(path.join(tmpdir(), "gptprouse-config-chmod-outside-"));
    const outsideConfig = path.join(outside, "config.local.json");
    await mkdir(path.join(cwd, ".bridge"), { recursive: true });
    await writeFile(outsideConfig, "outside\n", "utf8");
    await chmod(outsideConfig, 0o666);
    let swapped = false;
    fsHooks.beforePathChmod = async (filePath) => {
      if (!swapped && filePath === localConfigPath(cwd)) {
        swapped = true;
        await rm(localConfigPath(cwd));
        await symlink(outsideConfig, localConfigPath(cwd));
      }
    };

    await writeLocalConfig(cwd, { port: 9797, token: "inside-token" });

    expect(swapped).toBe(false);
    expect((await stat(outsideConfig)).mode & 0o777).toBe(0o666);
  });

  it("does not chmod a symlink target swapped in after config read", async () => {
    if (process.platform === "win32") return;
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-config-chmod-"));
    const outside = await mkdtemp(path.join(tmpdir(), "gptprouse-config-chmod-outside-"));
    const outsideConfig = path.join(outside, "config.local.json");
    await writeLocalConfig(cwd, { port: 9797, token: "inside-token" });
    await writeFile(outsideConfig, "outside\n", "utf8");
    await chmod(outsideConfig, 0o666);
    let swapped = false;
    fsHooks.beforePathChmod = async (filePath) => {
      if (!swapped && filePath === localConfigPath(cwd)) {
        swapped = true;
        await rm(localConfigPath(cwd));
        await symlink(outsideConfig, localConfigPath(cwd));
      }
    };

    const loaded = await loadLocalConfig(cwd);

    expect(loaded.token).toBe("inside-token");
    expect(swapped).toBe(false);
    expect((await stat(outsideConfig)).mode & 0o777).toBe(0o666);
  });

  it("does not chmod a symlink target swapped in before handle chmod during config read", async () => {
    if (process.platform === "win32") return;
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-config-chmod-"));
    const outside = await mkdtemp(path.join(tmpdir(), "gptprouse-config-chmod-outside-"));
    const outsideConfig = path.join(outside, "config.local.json");
    await writeLocalConfig(cwd, { port: 9797, token: "inside-token" });
    await writeFile(outsideConfig, "outside\n", "utf8");
    await chmod(outsideConfig, 0o666);
    let swapped = false;
    setSafeFileTestHooks({
      beforeChmod: async (filePath, operation) => {
        if (!swapped && operation === "read" && filePath === localConfigPath(cwd)) {
          swapped = true;
          await rm(localConfigPath(cwd));
          await symlink(outsideConfig, localConfigPath(cwd));
        }
      }
    });

    await expect(loadLocalConfig(cwd)).rejects.toThrow(/symlink|real directory|changed/i);

    expect(swapped).toBe(true);
    expect(await readFile(outsideConfig, "utf8")).toBe("outside\n");
    expect((await stat(outsideConfig)).mode & 0o777).toBe(0o666);
  });

  it("does not chmod a symlink target swapped in before handle chmod during config write", async () => {
    if (process.platform === "win32") return;
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-config-chmod-"));
    const outside = await mkdtemp(path.join(tmpdir(), "gptprouse-config-chmod-outside-"));
    const outsideConfig = path.join(outside, "config.local.json");
    await mkdir(path.join(cwd, ".bridge"), { recursive: true });
    await writeFile(outsideConfig, "outside\n", "utf8");
    await chmod(outsideConfig, 0o666);
    let swapped = false;
    setSafeFileTestHooks({
      beforeChmod: async (filePath, operation) => {
        if (!swapped && operation === "write" && filePath === localConfigPath(cwd)) {
          swapped = true;
          await symlink(outsideConfig, localConfigPath(cwd));
        }
      }
    });

    await expect(writeLocalConfig(cwd, { port: 9797, token: "inside-token" })).rejects.toThrow(/symlink|real directory|changed/i);

    expect(swapped).toBe(true);
    expect(await readFile(outsideConfig, "utf8")).toBe("outside\n");
    expect((await stat(outsideConfig)).mode & 0o777).toBe(0o666);
  });
});
