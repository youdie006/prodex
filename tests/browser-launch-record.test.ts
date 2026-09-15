import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readLastBrowserLoginLaunch, recordBrowserLoginLaunch } from "../src/chatgpt-browser.js";
import { setSafeFileTestHooks } from "../src/safe-file.js";

let root: string;
let file: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "prodex-login-record-"));
  file = path.join(root, "last-login.json");
  vi.stubEnv("PRODEX_LAST_LOGIN_FILE", file);
});
afterEach(async () => {
  setSafeFileTestHooks({});
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("saved browser launch identity", () => {
  it("preserves a boolean headless relaunch preference but rejects an invalid value", async () => {
    const launch = { profile_dir: "/profile", port: 9333, headless: false, resume_headless: true };
    await writeFile(file, JSON.stringify(launch));
    expect(await readLastBrowserLoginLaunch()).toEqual(launch);
    await writeFile(file, JSON.stringify({ ...launch, resume_headless: "true" }));
    expect(await readLastBrowserLoginLaunch()).not.toHaveProperty("resume_headless");
  });

  it("publishes a private complete replacement without exposing partial mode metadata", async () => {
    const old = { profile_dir: "/profile", port: 9333, headless: true };
    const next = { ...old, headless: false, resume_headless: true };
    await writeFile(file, JSON.stringify(old), { mode: 0o644 });
    const previous: unknown[] = [];
    setSafeFileTestHooks({ beforeRename: async (target) => {
      if (target === file) previous.push(JSON.parse(await readFile(file, "utf8")));
    } });
    await recordBrowserLoginLaunch(next);
    expect(previous).toEqual([old]);
    expect(await readLastBrowserLoginLaunch()).toEqual(next);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});
