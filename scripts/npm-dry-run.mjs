import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// npm 11 checks registry versions even for a tarball dry-run. Packaging tests
// need an empty read-only registry, not the current public release state.
export async function publishTarballDryRun(tarballPath) {
  const root = await mkdtemp(path.join(tmpdir(), "prodex-npm-dry-run-"));
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, path: request.url });
    response.writeHead(request.method === "GET" ? 404 : 405, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: request.method === "GET" ? "not_found" : "read_only_registry" }));
  });
  try {
    const userConfig = path.join(root, "user.npmrc");
    const globalConfig = path.join(root, "global.npmrc");
    await writeFile(userConfig, "", { mode: 0o600 });
    await writeFile(globalConfig, "", { mode: 0o600 });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const registry = `http://127.0.0.1:${server.address().port}`;
    // npm requests CI identities even during dry-run. Only this subprocess
    // loses credentials; the actual publish step retains its OIDC environment.
    const excludedEnv = /^(?:npm_config_|npm_id_token$|npm_token$|node_auth_token$|actions_id_token_request_|sigstore_id_token$|circle_oidc_token)/i;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !excludedEnv.test(key)));
    const result = await run(process.platform === "win32" ? "npm.cmd" : "npm", [
      "publish", "--dry-run", path.resolve(tarballPath), "--ignore-scripts", "--provenance=false",
      `--registry=${registry}`, `--userconfig=${userConfig}`, `--globalconfig=${globalConfig}`,
      `--cache=${path.join(root, "cache")}`, "--fetch-retries=0"
    ], {
      cwd: root, env: { ...env, NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1" },
      timeout: 120_000, maxBuffer: 20 * 1024 * 1024
    });
    if (requests.some((request) => request.method !== "GET")) {
      throw new Error("npm dry-run attempted to mutate the read-only test registry");
    }
    if (!`${result.stdout}\n${result.stderr}`.includes(`Publishing to ${registry}`)) {
      throw new Error("npm dry-run did not select the isolated test registry");
    }
    return { ...result, requests };
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
}
