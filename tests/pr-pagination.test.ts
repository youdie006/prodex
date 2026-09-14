import { execFile, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);
const hasGh = spawnSync("gh", ["--version"], { stdio: "ignore" }).status === 0 && spawnSync("jq", ["--version"], { stdio: "ignore" }).status === 0;

it.skipIf(!hasGh)("the PR workflow combines paginated files into one JSON array", async () => {
  const workflow = await readFile(new URL("../.github/workflows/pr-first-pass.yml", import.meta.url), "utf8");
  const command = /--paginate --jq '([^']+)' \| jq -s '([^']+)' > files\.json/.exec(workflow);
  expect(command).not.toBeNull();
  const cwd = await mkdtemp(path.join(tmpdir(), "prodex-gh-pagination-"));
  const server = createServer((request, response) => {
    const nextPage = request.url?.includes("page=2");
    if (!nextPage) response.setHeader("Link", `<http://127.0.0.1:${port}/files?page=2>; rel="next"`);
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify([{ filename: nextPage ? "tests/example.test.ts" : "src/example.ts", additions: 1, deletions: 0 }]));
  });
  let port = 0;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
  try {
    const result = await run("gh", [
      "api", `http://127.0.0.1:${port}/files`, "--paginate", "--jq", command![1]
    ], { cwd, env: { ...process.env, GH_TOKEN: "fake-review-token", GH_CONFIG_DIR: cwd }, timeout: 10_000 });
    await writeFile(path.join(cwd, "pages.json"), result.stdout);
    const combined = await run("jq", ["-s", command![2], "pages.json"], { cwd });
    expect(JSON.parse(combined.stdout)).toEqual([
      { path: "src/example.ts", additions: 1, deletions: 0 },
      { path: "tests/example.test.ts", additions: 1, deletions: 0 }
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(cwd, { recursive: true, force: true });
  }
});

it.skipIf(!hasGh)("the PR workflow picks only one existing comment across all pages", async () => {
  const workflow = await readFile(new URL("../.github/workflows/pr-first-pass.yml", import.meta.url), "utf8");
  const command = /--paginate --jq "(.*)" \| jq -sr '([^']+)'\)/.exec(workflow);
  expect(command).not.toBeNull();
  const jq = JSON.parse(`"${command![1]}"`).replaceAll("$marker", "<!-- prodex-first-pass -->");
  const cwd = await mkdtemp(path.join(tmpdir(), "prodex-gh-comments-"));
  let port = 0;
  const server = createServer((request, response) => {
    const nextPage = request.url?.includes("page=2");
    if (!nextPage) response.setHeader("Link", `<http://127.0.0.1:${port}/comments?page=2>; rel="next"`);
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify([{ id: nextPage ? 8 : 7, body: "<!-- prodex-first-pass -->\nreview" }]));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
  try {
    const result = await run("gh", [
      "api", `http://127.0.0.1:${port}/comments`, "--paginate", "--jq", jq
    ], { cwd, env: { ...process.env, GH_TOKEN: "fake-review-token", GH_CONFIG_DIR: cwd }, timeout: 10_000 });
    await writeFile(path.join(cwd, "pages.json"), result.stdout);
    const combined = await run("jq", ["-sr", command![2], "pages.json"], { cwd });
    expect(combined.stdout.trim()).toBe("7");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(cwd, { recursive: true, force: true });
  }
});
