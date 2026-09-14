import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
// @ts-expect-error - the packaging helper is a dependency-free Node script
import { publishTarballDryRun } from "../scripts/npm-dry-run.mjs";

const run = promisify(execFile);

afterEach(() => vi.unstubAllEnvs());

it.each(["local", "direct-token", "github-request"])("isolates a tarball dry-run from %s publishing credentials", async (credentials) => {
  const cwd = await mkdtemp(path.join(tmpdir(), "prodex-dry-run-test-"));
  let identityRequests = 0;
  const identity = createServer((_request, response) => {
    identityRequests++;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ value: "fake-dry-run-identity-token" }));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      identity.once("error", reject);
      identity.listen(0, "127.0.0.1", resolve);
    });
    const address = identity.address();
    if (!address || typeof address === "string") throw new Error("Missing identity fixture address");
    vi.stubEnv("GITHUB_ACTIONS", credentials === "local" ? undefined : "true");
    vi.stubEnv("NPM_ID_TOKEN", credentials === "direct-token" ? "fake-direct-identity-token" : undefined);
    vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_URL", `http://127.0.0.1:${address.port}/identity`);
    vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "fake-identity-request-token");
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({
      name: "@youdie006/prodex", version: "0.40.6", license: "MIT",
      publishConfig: { access: "public" }
    }));
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const packed = await run(npm, ["pack", "--json", "--ignore-scripts"], { cwd, timeout: 30_000 });
    const tarball = path.join(cwd, JSON.parse(packed.stdout)[0].filename);
    const result = await publishTarballDryRun(tarball);
    expect(`${result.stdout}\n${result.stderr}`).toContain("prodex@0.40.6");
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/Publishing to http:\/\/127\.0\.0\.1:\d+.*\(dry-run\)/);
    expect(result.requests.every((request: { method: string }) => request.method === "GET")).toBe(true);
    expect(identityRequests).toBe(0);
    expect(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBe("fake-identity-request-token");
  } finally {
    identity.closeAllConnections();
    if (identity.listening) await new Promise<void>((resolve, reject) => identity.close((error) => error ? reject(error) : resolve()));
    await rm(cwd, { recursive: true, force: true });
  }
});
