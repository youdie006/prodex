import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpToolHandlers } from "../src/mcp-tools.js";
import { setSafeFileTestHooks } from "../src/safe-file.js";
import { BridgeStore } from "../src/store.js";

const execFileAsync = promisify(execFile);

describe("MCP tool handlers", () => {
  afterEach(() => {
    setSafeFileTestHooks({});
  });

  it("creates tasks and fetches results through Claude-compatible handlers", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    const handlers = createMcpToolHandlers({ cwd });

    const created = await handlers.bridge_create_task({
      title: "From Claude",
      prompt: "Please hand this to Codex.",
      repo_id: "default",
      files: []
    });

    expect(created.task.id).toContain("task_");

    const listed = await handlers.bridge_list_tasks({});
    expect(listed.tasks.map((task) => task.title)).toContain("From Claude");
  });

  it("exposes read-only repo file access", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    await writeFile(path.join(cwd, "README.md"), "alpha\nbeta\n", "utf8");
    const handlers = createMcpToolHandlers({ cwd });

    const result = await handlers.repo_read_file({ path: "README.md", start_line: 2, max_lines: 1 });

    expect(result.content).toBe("beta");
  });

  it("creates a write dry-run receipt and applies it only with matching head and preimage", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    await writeFile(path.join(cwd, "notes.md"), "old\n", "utf8");
    const head = await initGitRepo(cwd);
    const handlers = createMcpToolHandlers({ cwd });

    const dryRun = await handlers.repo_write_file_dry_run({
      path: "notes.md",
      content: "new\n",
      expected_head: head
    });

    expect(await readFile(path.join(cwd, "notes.md"), "utf8")).toBe("old\n");
    expect(dryRun.receipt.kind).toBe("repo_write_dry_run");
    expect(dryRun.path).toBe("notes.md");
    expect(dryRun.diff).toContain("-old");
    expect(dryRun.diff).toContain("+new");

    const applied = await handlers.repo_write_file_apply({
      receipt_id: dryRun.receipt.id,
      expected_head: head,
      preimage_sha256: dryRun.preimage_sha256
    });

    expect(applied.receipt.kind).toBe("repo_write_applied");
    expect(await readFile(path.join(cwd, "notes.md"), "utf8")).toBe("new\n");
  });

  it("stores write dry-run replacement content as an artifact instead of receipt metadata", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    await writeFile(path.join(cwd, "notes.md"), "old\n", "utf8");
    const head = await initGitRepo(cwd);
    const handlers = createMcpToolHandlers({ cwd });

    const dryRun = await handlers.repo_write_file_dry_run({
      path: "notes.md",
      content: "new\n",
      expected_head: head
    });
    const storedReceipt = JSON.parse(
      await readFile(path.join(cwd, ".bridge", "receipts", `${dryRun.receipt.id}.json`), "utf8")
    );

    expect(storedReceipt.metadata.new_content).toBeUndefined();
    expect(storedReceipt.metadata.new_content_artifact).toMatch(/^\.bridge\/artifacts\/repo-writes\/[a-f0-9]{64}\.txt$/);
    expect(await readFile(path.join(cwd, storedReceipt.metadata.new_content_artifact), "utf8")).toBe("new\n");
  });

  it("rejects write apply when the stored payload artifact was changed", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    await writeFile(path.join(cwd, "notes.md"), "old\n", "utf8");
    const head = await initGitRepo(cwd);
    const handlers = createMcpToolHandlers({ cwd });
    const dryRun = await handlers.repo_write_file_dry_run({
      path: "notes.md",
      content: "new\n",
      expected_head: head
    });
    const storedReceipt = JSON.parse(
      await readFile(path.join(cwd, ".bridge", "receipts", `${dryRun.receipt.id}.json`), "utf8")
    );
    await writeFile(path.join(cwd, storedReceipt.metadata.new_content_artifact), "tampered\n", "utf8");

    await expect(
      handlers.repo_write_file_apply({
        receipt_id: dryRun.receipt.id,
        expected_head: head,
        preimage_sha256: dryRun.preimage_sha256
      })
    ).rejects.toThrow(/artifact content/);
  });

  it("applies legacy dry-run receipts that stored replacement content inline", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    await writeFile(path.join(cwd, "notes.md"), "old\n", "utf8");
    const head = await initGitRepo(cwd);
    const store = new BridgeStore(cwd);
    const legacyReceipt = await store.writeReceipt({
      kind: "repo_write_dry_run",
      summary: "Legacy dry-run write for notes.md",
      metadata: {
        path: "notes.md",
        expected_head: head,
        preimage_sha256: sha256("old\n"),
        new_sha256: sha256("legacy\n"),
        diff: "--- a/notes.md\n+++ b/notes.md\n-old\n+legacy",
        new_content: "legacy\n"
      }
    });
    const handlers = createMcpToolHandlers({ cwd });

    await handlers.repo_write_file_apply({
      receipt_id: legacyReceipt.id,
      expected_head: head,
      preimage_sha256: sha256("old\n")
    });

    expect(await readFile(path.join(cwd, "notes.md"), "utf8")).toBe("legacy\n");
  });

  it("rejects write apply when the file preimage changed after dry-run", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    await writeFile(path.join(cwd, "notes.md"), "old\n", "utf8");
    const head = await initGitRepo(cwd);
    const handlers = createMcpToolHandlers({ cwd });
    const dryRun = await handlers.repo_write_file_dry_run({
      path: "notes.md",
      content: "new\n",
      expected_head: head
    });
    await writeFile(path.join(cwd, "notes.md"), "changed\n", "utf8");

    await expect(
      handlers.repo_write_file_apply({
        receipt_id: dryRun.receipt.id,
        expected_head: head,
        preimage_sha256: dryRun.preimage_sha256
      })
    ).rejects.toThrow(/preimage/);
  });

  it("rejects write apply when the target is swapped to a symlink before write", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    const outside = await mkdtemp(path.join(tmpdir(), "gptprouse-outside-"));
    const outsideFile = path.join(outside, "secret.txt");
    const repoFile = path.join(cwd, "notes.md");
    await writeFile(outsideFile, "outside\n", "utf8");
    await writeFile(repoFile, "old\n", "utf8");
    const head = await initGitRepo(cwd);
    const handlers = createMcpToolHandlers({ cwd });
    const dryRun = await handlers.repo_write_file_dry_run({
      path: "notes.md",
      content: "new\n",
      expected_head: head
    });
    let swapped = false;
    setSafeFileTestHooks({
      beforeOpen: async (filePath) => {
        if (!swapped && filePath === repoFile) {
          swapped = true;
          await rm(repoFile);
          await symlink(outsideFile, repoFile);
        }
      }
    });

    await expect(
      handlers.repo_write_file_apply({
        receipt_id: dryRun.receipt.id,
        expected_head: head,
        preimage_sha256: dryRun.preimage_sha256
      })
    ).rejects.toThrow(/symlink|changed|escapes/i);
    expect(await readFile(outsideFile, "utf8")).toBe("outside\n");
  });

  it("rejects write dry-runs when git HEAD does not match", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    await writeFile(path.join(cwd, "notes.md"), "old\n", "utf8");
    await initGitRepo(cwd);
    const handlers = createMcpToolHandlers({ cwd });

    await expect(
      handlers.repo_write_file_dry_run({
        path: "notes.md",
        content: "new\n",
        expected_head: "not-the-current-head"
      })
    ).rejects.toThrow(/HEAD mismatch/);
  });

  it("rejects write dry-runs for sensitive local bridge paths", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    await writeFile(path.join(cwd, "notes.md"), "old\n", "utf8");
    const head = await initGitRepo(cwd);
    const handlers = createMcpToolHandlers({ cwd });

    await expect(
      handlers.repo_write_file_dry_run({
        path: ".bridge/config.local.json",
        content: "{}\n",
        expected_head: head
      })
    ).rejects.toThrow(/sensitive/);
  });

  it("rejects write dry-runs for nested git metadata paths", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    await writeFile(path.join(cwd, "notes.md"), "old\n", "utf8");
    const head = await initGitRepo(cwd);
    await mkdir(path.join(cwd, "services", "api", ".git"), { recursive: true });
    await writeFile(path.join(cwd, "services", "api", ".git", "config"), "old\n", "utf8");
    const handlers = createMcpToolHandlers({ cwd });

    await expect(
      handlers.repo_write_file_dry_run({
        path: "services/api/.git/config",
        content: "new\n",
        expected_head: head
      })
    ).rejects.toThrow(/sensitive/);
  });

  it("rejects forged write receipts reached through receipt id traversal", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    await writeFile(path.join(cwd, "notes.md"), "old\n", "utf8");
    const head = await initGitRepo(cwd);
    await mkdir(path.join(cwd, ".bridge"), { recursive: true });
    await writeFile(
      path.join(cwd, ".bridge", "forged.json"),
      `${JSON.stringify(
        {
          schema_version: 1,
          id: "receipt_20260623_000000_forged",
          kind: "repo_write_dry_run",
          summary: "Forged dry-run write for notes.md",
          metadata: {
            path: "notes.md",
            expected_head: head,
            preimage_sha256: sha256("old\n"),
            new_sha256: sha256("forged\n"),
            diff: "--- a/notes.md\n+++ b/notes.md\n-old\n+forged",
            new_content: "forged\n"
          },
          created_at: "2026-06-23T00:00:00.000Z"
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    const handlers = createMcpToolHandlers({ cwd });

    await expect(
      handlers.repo_write_file_apply({
        receipt_id: "../forged",
        expected_head: head,
        preimage_sha256: sha256("old\n")
      })
    ).rejects.toThrow(/record id|receipt/i);
    expect(await readFile(path.join(cwd, "notes.md"), "utf8")).toBe("old\n");
  });

  it("rejects forged write receipts reached through symlinked receipt files", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    const outside = await mkdtemp(path.join(tmpdir(), "gptprouse-outside-"));
    await writeFile(path.join(cwd, "notes.md"), "old\n", "utf8");
    const head = await initGitRepo(cwd);
    await mkdir(path.join(cwd, ".bridge", "receipts"), { recursive: true });
    const forgedReceiptId = "receipt_20260623_000000_forged";
    await writeFile(
      path.join(outside, `${forgedReceiptId}.json`),
      `${JSON.stringify(
        {
          schema_version: 1,
          id: forgedReceiptId,
          kind: "repo_write_dry_run",
          summary: "Forged dry-run write for notes.md",
          metadata: {
            path: "notes.md",
            expected_head: head,
            preimage_sha256: sha256("old\n"),
            new_sha256: sha256("forged\n"),
            diff: "--- a/notes.md\n+++ b/notes.md\n-old\n+forged",
            new_content: "forged\n"
          },
          created_at: "2026-06-23T00:00:00.000Z"
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await symlink(
      path.join(outside, `${forgedReceiptId}.json`),
      path.join(cwd, ".bridge", "receipts", `${forgedReceiptId}.json`)
    );
    const handlers = createMcpToolHandlers({ cwd });

    await expect(
      handlers.repo_write_file_apply({
        receipt_id: forgedReceiptId,
        expected_head: head,
        preimage_sha256: sha256("old\n")
      })
    ).rejects.toThrow(/record path|symlink/i);
    expect(await readFile(path.join(cwd, "notes.md"), "utf8")).toBe("old\n");
  });

  it("stages only paths backed by matching applied write receipts", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    await writeFile(path.join(cwd, "notes.md"), "old\n", "utf8");
    const head = await initGitRepo(cwd);
    const handlers = createMcpToolHandlers({ cwd });
    const dryRun = await handlers.repo_write_file_dry_run({
      path: "notes.md",
      content: "new\n",
      expected_head: head
    });
    const applied = await handlers.repo_write_file_apply({
      receipt_id: dryRun.receipt.id,
      expected_head: head,
      preimage_sha256: dryRun.preimage_sha256
    });

    const staged = await handlers.repo_stage_reviewed_paths({
      receipt_ids: [applied.receipt.id],
      expected_head: head
    });
    const { stdout } = await execFileAsync("git", ["diff", "--cached", "--name-only"], { cwd });

    expect(staged.receipt.kind).toBe("repo_stage_reviewed_paths");
    expect(staged.paths).toEqual(["notes.md"]);
    expect(stdout.trim()).toBe("notes.md");
  });

  it("rejects staging when applied receipt content changed again", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    await writeFile(path.join(cwd, "notes.md"), "old\n", "utf8");
    const head = await initGitRepo(cwd);
    const handlers = createMcpToolHandlers({ cwd });
    const dryRun = await handlers.repo_write_file_dry_run({
      path: "notes.md",
      content: "new\n",
      expected_head: head
    });
    const applied = await handlers.repo_write_file_apply({
      receipt_id: dryRun.receipt.id,
      expected_head: head,
      preimage_sha256: dryRun.preimage_sha256
    });
    await writeFile(path.join(cwd, "notes.md"), "changed again\n", "utf8");

    await expect(
      handlers.repo_stage_reviewed_paths({
        receipt_ids: [applied.receipt.id],
        expected_head: head
      })
    ).rejects.toThrow(/content changed/);
  });

  it("rejects staging when git HEAD moved after apply", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-mcp-"));
    await writeFile(path.join(cwd, "notes.md"), "old\n", "utf8");
    const head = await initGitRepo(cwd);
    const handlers = createMcpToolHandlers({ cwd });
    const dryRun = await handlers.repo_write_file_dry_run({
      path: "notes.md",
      content: "new\n",
      expected_head: head
    });
    const applied = await handlers.repo_write_file_apply({
      receipt_id: dryRun.receipt.id,
      expected_head: head,
      preimage_sha256: dryRun.preimage_sha256
    });
    await execFileAsync("git", ["add", "notes.md"], { cwd });
    await execFileAsync("git", ["commit", "-m", "move head"], { cwd });

    await expect(
      handlers.repo_stage_reviewed_paths({
        receipt_ids: [applied.receipt.id],
        expected_head: head
      })
    ).rejects.toThrow(/HEAD mismatch/);
  });
});

async function initGitRepo(cwd: string): Promise<string> {
  await execFileAsync("git", ["init"], { cwd });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd });
  await execFileAsync("git", ["add", "notes.md"], { cwd });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd });
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
  return stdout.trim();
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
