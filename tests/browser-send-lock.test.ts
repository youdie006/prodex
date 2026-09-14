import { spawn, type ChildProcess } from "node:child_process";
import { access, chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { withBrowserSendLock } from "../src/browser-send-lock.js";
import { setSafeFileTestHooks } from "../src/safe-file.js";

const originalLockFile = process.env.PRODEX_SEND_LOCK_FILE;
const originalStaleMs = process.env.PRODEX_SEND_LOCK_STALE_MS;

afterEach(() => {
  setSafeFileTestHooks({});
  if (originalLockFile === undefined) delete process.env.PRODEX_SEND_LOCK_FILE;
  else process.env.PRODEX_SEND_LOCK_FILE = originalLockFile;
  if (originalStaleMs === undefined) delete process.env.PRODEX_SEND_LOCK_STALE_MS;
  else process.env.PRODEX_SEND_LOCK_STALE_MS = originalStaleMs;
});

describe("browser send lock ownership", () => {
  it("does not follow predictable temporary-file symlinks and makes the parent private", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "prodex-send-lock-"));
    const file = path.join(dir, "send.lock");
    process.env.PRODEX_SEND_LOCK_FILE = file;
    await chmod(dir, 0o777);
    const victims: string[] = [];
    for (let sequence = 1; sequence <= 20; sequence += 1) {
      const victim = path.join(dir, `victim-${sequence}.txt`);
      victims.push(victim);
      await writeFile(victim, "keep me\n", "utf8");
      await symlink(victim, `${file}.${process.pid}.${sequence}.tmp`);
    }

    await withBrowserSendLock(0, () => undefined, async () => undefined);

    for (const victim of victims) {
      await expect(readFile(victim, "utf8")).resolves.toBe("keep me\n");
    }
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it("does not reap a live owner solely because its timestamp is old", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "prodex-send-lock-"));
    const file = path.join(dir, "send.lock");
    process.env.PRODEX_SEND_LOCK_FILE = file;
    process.env.PRODEX_SEND_LOCK_STALE_MS = "1";
    await writeFile(file, JSON.stringify({ pid: process.pid, started_at: "2000-01-01T00:00:00.000Z" }), "utf8");
    let entered = false;

    await expect(
      withBrowserSendLock(0, () => undefined, async () => {
        entered = true;
      })
    ).rejects.toThrow(/Another prodex browser send is in progress/);
    expect(entered).toBe(false);
  });

  it("does not let an old same-process owner release a successor acquisition", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "prodex-send-lock-"));
    const file = path.join(dir, "send.lock");
    process.env.PRODEX_SEND_LOCK_FILE = file;
    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withBrowserSendLock(0, () => undefined, async () => {
      firstEntered();
      await hold;
    });
    await entered;

    await rm(file, { force: true });
    await writeFile(
      file,
      `${JSON.stringify({ pid: process.pid, nonce: "successor-owner", started_at: new Date().toISOString() })}\n`,
      "utf8"
    );
    releaseFirst();
    await first;

    let thirdEntered = false;
    await expect(
      withBrowserSendLock(0, () => undefined, async () => {
        thirdEntered = true;
      })
    ).rejects.toThrow(/Another prodex browser send is in progress/);
    expect(thirdEntered).toBe(false);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(expect.objectContaining({ nonce: "successor-owner" }));
  });

  it("recovers dead and malformed owners without overlapping callbacks", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "prodex-send-lock-"));
    const file = path.join(dir, "send.lock");
    process.env.PRODEX_SEND_LOCK_FILE = file;
    await writeFile(file, "not json\n", "utf8");
    const active: string[] = [];
    let overlap = false;

    await Promise.all(
      ["first", "second"].map((name) =>
        withBrowserSendLock(2_000, () => undefined, async () => {
          if (active.length > 0) overlap = true;
          active.push(name);
          await new Promise((resolve) => setTimeout(resolve, 30));
          active.pop();
        })
      )
    );
    expect(overlap).toBe(false);

    await writeFile(file, JSON.stringify({ pid: 999_999, started_at: new Date().toISOString() }), "utf8");
    await expect(withBrowserSendLock(0, () => undefined, async () => "recovered")).resolves.toBe("recovered");
  });

  it(
    "uses one reaper claim so competing dead-owner reapers cannot remove a successor",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "prodex-send-lock-reapers-"));
      const file = path.join(dir, "send.lock");
      process.env.PRODEX_SEND_LOCK_FILE = file;
      const deadOwner = { pid: 999_999, nonce: "dead-owner", started_at: new Date().toISOString() };
      const token = path.join(dir, `.send.lock.${deadOwner.pid}.${deadOwner.nonce}.owner`);
      await writeFile(token, `${JSON.stringify(deadOwner)}\n`, "utf8");
      await link(token, file);

      let releaseReaper!: () => void;
      let reaperClaimed!: () => void;
      let releaseOwner!: () => void;
      let ownerEntered!: () => void;
      let claims = 0;
      let entries = 0;
      const holdReaper = new Promise<void>((resolve) => {
        releaseReaper = resolve;
      });
      const claimReady = new Promise<void>((resolve) => {
        reaperClaimed = resolve;
      });
      const holdOwner = new Promise<void>((resolve) => {
        releaseOwner = resolve;
      });
      const ownerReady = new Promise<void>((resolve) => {
        ownerEntered = resolve;
      });
      setSafeFileTestHooks({
        afterLockReapClaim: async (lockFile) => {
          if (lockFile !== file) return;
          claims += 1;
          reaperClaimed();
          await holdReaper;
        }
      });
      const callback = async () => {
        entries += 1;
        if (entries === 1) {
          ownerEntered();
          await holdOwner;
        }
      };

      const first = withBrowserSendLock(2_000, () => undefined, callback);
      const second = withBrowserSendLock(2_000, () => undefined, callback);
      await claimReady;
      expect(claims).toBe(1);
      releaseReaper();
      await ownerReady;
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(entries).toBe(1);
      releaseOwner();
      await Promise.all([first, second]);
      expect(entries).toBe(2);
    },
    5_000
  );

  it(
    "bounds the wait for a non-regular malformed lock without removing it",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "prodex-send-lock-"));
      const file = path.join(dir, "send.lock");
      process.env.PRODEX_SEND_LOCK_FILE = file;
      await mkdir(file);
      const started = Date.now();

      await expect(withBrowserSendLock(25, () => undefined, async () => undefined)).rejects.toThrow(/held by nothing/);

      expect(Date.now() - started).toBeLessThan(500);
      expect((await stat(file)).isDirectory()).toBe(true);
    },
    1_000
  );

  it("serializes overlapping callbacks across processes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "prodex-send-lock-process-"));
    const file = path.join(dir, "send.lock");
    const firstEntered = path.join(dir, "first-entered");
    const secondEntered = path.join(dir, "second-entered");
    const releaseFirst = path.join(dir, "release-first");
    const releaseSecond = path.join(dir, "release-second");
    const children: ChildProcess[] = [];
    const completions: Promise<void>[] = [];
    const start = (entered: string, release: string) => {
      const child = spawnLockHolder(file, entered, release);
      children.push(child);
      const done = waitForChild(child);
      completions.push(done);
      void done.catch(() => undefined);
      return done;
    };
    try {
      const firstDone = start(firstEntered, releaseFirst);
      await waitForFile(firstEntered);
      const secondDone = start(secondEntered, releaseSecond);
      await waitForFile(`${secondEntered}.ready`);

      await new Promise((resolve) => setTimeout(resolve, 150));
      await expect(access(secondEntered)).rejects.toMatchObject({ code: "ENOENT" });
      await writeFile(releaseFirst, "go\n", "utf8");
      await waitForFile(secondEntered);
      await writeFile(releaseSecond, "go\n", "utf8");

      await expect(firstDone).resolves.toBeUndefined();
      await expect(secondDone).resolves.toBeUndefined();
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      }
      await Promise.allSettled(completions);
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

function spawnLockHolder(lockFile: string, enteredFile: string, releaseFile: string): ChildProcess {
  const moduleUrl = pathToFileURL(path.resolve("src/browser-send-lock.ts")).href;
  const script = `
    import { access, writeFile } from "node:fs/promises";
    import { withBrowserSendLock } from ${JSON.stringify(moduleUrl)};
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    await writeFile(process.env.ENTERED_FILE + ".ready", "ready\\n", "utf8");
    await withBrowserSendLock(20_000, () => undefined, async () => {
      await writeFile(process.env.ENTERED_FILE, "entered\\n", "utf8");
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        try { await access(process.env.RELEASE_FILE); break; } catch { await sleep(10); }
      }
    });
  `;
  return spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    env: { ...process.env, PRODEX_SEND_LOCK_FILE: lockFile, ENTERED_FILE: enteredFile, RELEASE_FILE: releaseFile },
    stdio: ["ignore", "pipe", "pipe"]
  });
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      await access(file);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${path.basename(file)}`);
}

async function waitForChild(child: ChildProcess): Promise<void> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (result.code !== 0) {
    throw new Error(
      `Lock holder exited with code ${String(result.code)} signal ${String(result.signal)}\n${Buffer.concat(stdout)}\n${Buffer.concat(stderr)}`
    );
  }
}
