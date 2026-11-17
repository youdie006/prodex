import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/mcp.js";
import { createMcpToolHandlers } from "../src/mcp-tools.js";

const execFileAsync = promisify(execFile);

// "가" is one character to a JSON Schema maxLength and to zod, and three bytes
// in UTF-8. Found 2026-11-09: a title of 4,000 of them was refused as "12000
// bytes > 10000 bytes" although tools/list advertised maxLength 10000, so a
// Korean client could send about a third of what it was told.
const HANGUL = "가";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function connectClient(): Promise<{ client: Client; cwd: string }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "prodex-mcp-limits-"));
  const server = createServer(cwd, { registerRoot: false });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "prodex-test", version: "0.1.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  cleanups.push(async () => {
    await client.close();
    await rm(cwd, { recursive: true, force: true });
  });
  return { client, cwd };
}

async function callJson(client: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string; json?: any }> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text ?? "";
  const isError = result.isError === true;
  return { isError, text, ...(isError ? {} : { json: JSON.parse(text) }) };
}

describe("MCP text limits count what the schema advertises", () => {
  it("accepts Korean text up to every advertised maxLength of the bridge task tools", async () => {
    const { client } = await connectClient();
    const { tools } = await client.listTools();
    const create = tools.find((tool) => tool.name === "bridge_create_task")!;
    const properties = create.inputSchema.properties as Record<string, { maxLength?: number }>;
    expect(properties.title?.maxLength).toBe(10_000);
    expect(properties.prompt?.maxLength).toBe(100_000);

    const short = HANGUL.repeat(10_000);
    const long = HANGUL.repeat(100_000);
    const created = await callJson(client, "bridge_create_task", { title: short, prompt: long, repo_id: short });
    expect(created.text.slice(0, 200)).not.toMatch(/too large/);
    expect(created.isError).toBe(false);
    expect(created.json.task.title).toBe(short);
    expect(created.json.task.prompt).toBe(long);

    const claimed = await callJson(client, "bridge_claim_task", { task_id: created.json.task.id, claimed_by: short });
    expect(claimed.isError).toBe(false);
    const completed = await callJson(client, "bridge_complete_task", {
      task_id: created.json.task.id,
      summary: long,
      commands: [long],
      warnings: [long]
    });
    expect(completed.text.slice(0, 200)).not.toMatch(/too large/);
    expect(completed.isError).toBe(false);
    expect(completed.json.result.summary).toBe(long);

    const other = await callJson(client, "bridge_create_task", { title: "blocked one", prompt: "p" });
    const blocked = await callJson(client, "bridge_block_task", { task_id: other.json.task.id, summary: long, code: short, next_step: long });
    expect(blocked.text.slice(0, 200)).not.toMatch(/too large/);
    expect(blocked.isError).toBe(false);
    expect(blocked.json.result.blocker.code).toBe(short);
  });

  it("refuses one character over the limit and says the limit is in characters", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-mcp-limits-"));
    cleanups.push(() => rm(cwd, { recursive: true, force: true }));
    const handlers = createMcpToolHandlers({ cwd, registerRoot: false });

    await expect(handlers.bridge_create_task({ title: HANGUL.repeat(10_001), prompt: "p" })).rejects.toThrow(
      "MCP title is too large (10001 characters > 10000 characters)"
    );
    await expect(handlers.bridge_create_task({ title: "t", prompt: HANGUL.repeat(100_001) })).rejects.toThrow(
      "MCP prompt is too large (100001 characters > 100000 characters)"
    );
    await expect(readdir(path.join(cwd, ".bridge", "tasks"))).rejects.toThrow();
  });

  it("says repo_write_file_dry_run content is limited in UTF-8 bytes, and refuses in those terms", async () => {
    // The written file is what the 1,000,000 limit protects (repo_read_file
    // reads at most that many bytes), so this one field stays in bytes. The
    // schema can only state characters, so the description has to say it.
    const { client, cwd } = await connectClient();
    const { tools } = await client.listTools();
    const dryRun = tools.find((tool) => tool.name === "repo_write_file_dry_run")!;
    const content = (dryRun.inputSchema.properties as Record<string, { maxLength?: number; description?: string }>).content!;
    expect(content.maxLength).toBe(1_000_000);
    expect(content.description ?? "").toMatch(/1,000,000 bytes/);
    expect(content.description ?? "").toMatch(/UTF-8/);

    await writeFile(path.join(cwd, "notes.md"), "old\n", "utf8");
    await execFileAsync("git", ["init", "-q"], { cwd });
    await execFileAsync("git", ["add", "notes.md"], { cwd });
    await execFileAsync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "initial"], { cwd });
    const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();

    // 333,334 characters, under maxLength, are 1,000,002 bytes.
    const refused = await callJson(client, "repo_write_file_dry_run", { path: "notes.md", content: HANGUL.repeat(333_334), expected_head: head });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("(1000002 bytes > 1000000 bytes in UTF-8)");
  });
});

describe("MCP schema and bridge store agree on required text", () => {
  // Found 2026-11-09: the schema let repo_id be "", the store requires at
  // least one character, and the client got the store's raw zod issue list.
  it("advertises repo_id as non-empty and refuses an empty one as invalid arguments", async () => {
    const { client, cwd } = await connectClient();
    const { tools } = await client.listTools();
    const create = tools.find((tool) => tool.name === "bridge_create_task")!;
    expect((create.inputSchema.properties as Record<string, { minLength?: number }>).repo_id?.minLength).toBe(1);

    const refused = await callJson(client, "bridge_create_task", { title: "t", prompt: "p", repo_id: "" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/^MCP error -32602: Input validation error/);
    expect(refused.text).toContain("repo_id");
    expect(await readdir(path.join(cwd, ".bridge", "tasks")).catch(() => [])).toEqual([]);
  });
});
