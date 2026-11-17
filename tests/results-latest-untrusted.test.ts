import { mkdir, mkdtemp, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { createMcpToolHandlers } from "../src/mcp-tools.js";
import { BridgeStore } from "../src/store.js";

// Found 2026-11-09: one older result whose task_completed receipt had been
// moved away made `results show latest`, `results artifact latest` and MCP
// `bridge_list_results` fail on that record, while `results show <newer id>`
// worked. `pro latest` and `pro list` already step past such a record.

async function completeWithArtifact(cwd: string, title: string, answer: string): Promise<string> {
  const out: string[] = [];
  await runCli(["tasks", "create", "--title", title, "--prompt", "Answer this."], { cwd, stdout: (line) => out.push(line), stderr: () => {} });
  const taskId = out[0]!.split("\t")[0]!;
  await runCli(["tasks", "complete", taskId, "--summary", `${title} done`, "--artifact", `.bridge/artifacts/results/${title.replaceAll(" ", "-")}.md=${answer}`], {
    cwd,
    stdout: () => {},
    stderr: () => {}
  });
  return taskId;
}

// The titles sort the same way as the completions, so the order holds even
// when both tasks get the same second in their ids.
async function twoResults(): Promise<{ cwd: string; older: string; newer: string }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "prodex-results-latest-"));
  const older = await completeWithArtifact(cwd, "first older", "older answer");
  const newer = await completeWithArtifact(cwd, "second newer", "newer answer");
  return { cwd, older, newer };
}

async function moveCompletionReceiptAside(cwd: string, taskId: string): Promise<void> {
  const receipts = await new BridgeStore(cwd).listReceiptsReadOnly({ kind: "task_completed", task_id: taskId });
  expect(receipts).toHaveLength(1);
  const aside = await mkdtemp(path.join(tmpdir(), "prodex-receipt-aside-"));
  await rename(path.join(cwd, ".bridge", "receipts", `${receipts[0]!.id}.json`), path.join(aside, `${receipts[0]!.id}.json`));
}

async function cliOut(args: string[], cwd: string): Promise<string> {
  const out: string[] = [];
  await runCli(args, { cwd, stdout: (line) => out.push(line), stderr: () => {} });
  return out.join("\n");
}

describe("reading the latest result past an untrusted one", () => {
  it("shows the newest trusted result when an older one has lost its completion receipt", async () => {
    const { cwd, older, newer } = await twoResults();
    await moveCompletionReceiptAside(cwd, older);

    expect(JSON.parse(await cliOut(["results", "show", "latest"], cwd))).toEqual(expect.objectContaining({ task_id: newer }));
    expect(await cliOut(["results", "artifact", "latest"], cwd)).toBe("newer answer");
    // Naming the untrusted record still refuses it.
    await expect(cliOut(["results", "show", older], cwd)).rejects.toThrow(/Result record is untrusted: \.bridge\/results\/.*first-older\.json/);
    await expect(cliOut(["results", "artifact", older], cwd)).rejects.toThrow(/Result record is untrusted/);
  });

  it("steps past a newer untrusted result to the newest trusted one, as `pro latest` does", async () => {
    const { cwd, older, newer } = await twoResults();
    await moveCompletionReceiptAside(cwd, newer);

    expect(JSON.parse(await cliOut(["results", "show", "latest"], cwd))).toEqual(expect.objectContaining({ task_id: older }));
    expect(await cliOut(["results", "artifact", "latest"], cwd)).toBe("older answer");
  });

  it("still refuses with the untrusted record's reason when no result is trusted", async () => {
    const { cwd, older, newer } = await twoResults();
    await moveCompletionReceiptAside(cwd, older);
    await moveCompletionReceiptAside(cwd, newer);

    await expect(cliOut(["results", "show", "latest"], cwd)).rejects.toThrow(/Result record is untrusted: \.bridge\/results\/.*second-newer\.json/);
  });

  it("still says there are no results in a repo without any", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-results-latest-"));
    await mkdir(path.join(cwd, ".bridge"), { recursive: true });
    await expect(cliOut(["results", "show", "latest"], cwd)).rejects.toThrow("No results found");
  });
});

describe("listing results over MCP past an untrusted one", () => {
  it("lists the trusted results and says how many were skipped as untrusted, and why", async () => {
    const { cwd, older, newer } = await twoResults();
    await moveCompletionReceiptAside(cwd, older);
    const handlers = createMcpToolHandlers({ cwd, registerRoot: false });

    const response = await handlers.bridge_list_results();
    expect(response.results.map((result) => result.task_id)).toEqual([newer]);
    expect(response.untrusted_skipped).toBe(1);
    expect(response.untrusted).toEqual([
      {
        task_id: older,
        status: "untrusted",
        summary: expect.stringMatching(/^Result record is untrusted: \.bridge\/results\/.*first-older\.json has no trusted task_completed receipt/)
      }
    ]);
    expect(JSON.stringify(response)).not.toContain(cwd);
    // Fetching the untrusted record by id still refuses it.
    await expect(handlers.bridge_fetch_result({ task_id: older })).rejects.toThrow(/Result record is untrusted/);
  });

  it("adds nothing to the response when every result is trusted", async () => {
    const { cwd, older, newer } = await twoResults();
    const response = await createMcpToolHandlers({ cwd, registerRoot: false }).bridge_list_results();
    expect(response.results.map((result) => result.task_id)).toEqual([older, newer]);
    expect(Object.keys(response)).toEqual(["results"]);
  });
});
