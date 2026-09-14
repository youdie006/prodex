import { execFile, spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { applyRepoWriteDryRun, createRepoWriteDryRun } from "../src/repo-write.js";
import { setSafeFileTestHooks } from "../src/safe-file.js";
import { BridgeStore } from "../src/store.js";

const execFileAsync = promisify(execFile);

afterEach(() => {
  setSafeFileTestHooks({});
});

describe("repo write apply serialization", () => {
  it("rejects the second same-process receipt reviewed from the same preimage", async () => {
    const fixture = await createWriteFixture();
    let releaseFirst!: () => void;
    let firstBeforeRename!: () => void;
    let renameCalls = 0;
    const firstReached = new Promise<void>((resolve) => {
      firstBeforeRename = resolve;
    });
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    setSafeFileTestHooks({
      beforeRename: async (filePath) => {
        if (filePath !== path.join(fixture.root, "notes.md")) return;
        renameCalls += 1;
        if (renameCalls === 1) {
          firstBeforeRename();
          await holdFirst;
        }
      }
    });

    const first = applyReceipt(fixture, fixture.first.receipt.id);
    await firstReached;
    const second = applyReceipt(fixture, fixture.second.receipt.id);
    await new Promise((resolve) => setTimeout(resolve, 150));
    releaseFirst();
    const settled = await Promise.allSettled([first, second]);

    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(renameCalls).toBe(1);
    expect(["first\n", "second\n"]).toContain(await readFile(path.join(fixture.root, "notes.md"), "utf8"));
  });

  it("rejects the second process-shared receipt after overlapping the first apply", async () => {
    const fixture = await createWriteFixture();
    const firstReady = path.join(fixture.root, "first-ready");
    const secondReady = path.join(fixture.root, "second-ready");
    const releaseFirst = path.join(fixture.root, "release-first");
    const firstProcessReady = path.join(fixture.root, "first-process-ready");
    const secondProcessReady = path.join(fixture.root, "second-process-ready");
    const startFirst = path.join(fixture.root, "start-first");
    const startSecond = path.join(fixture.root, "start-second");
    const first = spawnApply(fixture, fixture.first.receipt.id, "first", firstProcessReady, startFirst, firstReady, releaseFirst);
    const firstDone = waitForApply(first);
    const second = spawnApply(fixture, fixture.second.receipt.id, "second", secondProcessReady, startSecond, secondReady, releaseFirst);
    const secondDone = waitForApply(second);
    await Promise.all([waitForFile(firstProcessReady), waitForFile(secondProcessReady)]);
    await writeFile(startFirst, "go\n", "utf8");
    await waitForFile(firstReady);
    await writeFile(startSecond, "go\n", "utf8");

    const secondReachedBeforeRelease = await waitForFileUntil(secondReady, 1_000);
    await writeFile(releaseFirst, "go\n", "utf8");
    const outcomes = await Promise.all([firstDone, secondDone]);

    expect(secondReachedBeforeRelease).toBe(false);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === "rejected")?.message).toMatch(/preimage|already applied/i);
  });
});

interface WriteFixture {
  root: string;
  store: BridgeStore;
  head: string;
  preimage: string;
  first: Awaited<ReturnType<typeof createRepoWriteDryRun>>;
  second: Awaited<ReturnType<typeof createRepoWriteDryRun>>;
}

async function createWriteFixture(): Promise<WriteFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "prodex-repo-write-race-"));
  await writeFile(path.join(root, "notes.md"), "old\n", "utf8");
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: root });
  await execFileAsync("git", ["add", "notes.md"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root });
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root });
  const head = stdout.trim();
  const store = new BridgeStore(root, { registerRoot: false });
  const first = await createRepoWriteDryRun(root, store, { path: "notes.md", content: "first\n", expected_head: head });
  const second = await createRepoWriteDryRun(root, store, { path: "notes.md", content: "second\n", expected_head: head });
  return { root, store, head, preimage: first.preimage_sha256, first, second };
}

function applyReceipt(fixture: WriteFixture, receiptId: string) {
  return applyRepoWriteDryRun(fixture.root, fixture.store, {
    receipt_id: receiptId,
    expected_head: fixture.head,
    preimage_sha256: fixture.preimage
  });
}

function spawnApply(
  fixture: WriteFixture,
  receiptId: string,
  role: string,
  processReadyFile: string,
  startFile: string,
  readyFile: string,
  releaseFile: string
): ChildProcess {
  const repoWriteUrl = pathToFileURL(path.resolve("src/repo-write.ts")).href;
  const safeFileUrl = pathToFileURL(path.resolve("src/safe-file.ts")).href;
  const storeUrl = pathToFileURL(path.resolve("src/store.ts")).href;
  const script = `
    import { access, writeFile } from "node:fs/promises";
    import { applyRepoWriteDryRun } from ${JSON.stringify(repoWriteUrl)};
    import { setSafeFileTestHooks } from ${JSON.stringify(safeFileUrl)};
    import { BridgeStore } from ${JSON.stringify(storeUrl)};
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    await writeFile(process.env.PROCESS_READY_FILE, "ready\\n", "utf8");
    for (;;) {
      try { await access(process.env.START_FILE); break; } catch { await sleep(10); }
    }
    setSafeFileTestHooks({ beforeRename: async () => {
      await writeFile(process.env.READY_FILE, "ready\\n", "utf8");
      if (process.env.ROLE === "first") {
        for (;;) {
          try { await access(process.env.RELEASE_FILE); break; } catch { await sleep(10); }
        }
      }
    }});
    const store = new BridgeStore(process.env.ROOT, { registerRoot: false });
    try {
      await applyRepoWriteDryRun(process.env.ROOT, store, {
        receipt_id: process.env.RECEIPT_ID,
        expected_head: process.env.HEAD,
        preimage_sha256: process.env.PREIMAGE
      });
      process.stdout.write(JSON.stringify({ status: "fulfilled" }) + "\\n");
    } catch (error) {
      process.stdout.write(JSON.stringify({ status: "rejected", message: error instanceof Error ? error.message : String(error) }) + "\\n");
    }
  `;
  return spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ROOT: fixture.root,
      RECEIPT_ID: receiptId,
      HEAD: fixture.head,
      PREIMAGE: fixture.preimage,
      ROLE: role,
      PROCESS_READY_FILE: processReadyFile,
      START_FILE: startFile,
      READY_FILE: readyFile,
      RELEASE_FILE: releaseFile
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
}

async function waitForApply(child: ChildProcess): Promise<{ status: string; message?: string }> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (result.code !== 0) {
    throw new Error(`Apply child exited with ${String(result.code)} (${String(result.signal)}): ${Buffer.concat(stderr)}`);
  }
  return JSON.parse(Buffer.concat(stdout).toString("utf8")) as { status: string; message?: string };
}

async function waitForFile(file: string): Promise<void> {
  if (await waitForFileUntil(file, 5_000)) return;
  throw new Error(`Timed out waiting for ${path.basename(file)}`);
}

async function waitForFileUntil(file: string, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await fileExists(file)) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return fileExists(file);
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
