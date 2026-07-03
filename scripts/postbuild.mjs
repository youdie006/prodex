#!/usr/bin/env node
// Make the packaged bin executable after `tsc` (which emits mode 0644). The
// `bin` entry (dist/cli.js) must be 0755 or `release-check` / npm publish
// reject it. Runs automatically as the `postbuild` lifecycle after `npm run
// build`, so CI and publish no longer need a manual `chmod +x`.
import { chmodSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binPath = path.join(repoRoot, "dist", "cli.js");

try {
  chmodSync(binPath, 0o755);
} catch (error) {
  // On Windows the executable bit is meaningless; only fail loudly elsewhere.
  if (process.platform !== "win32") {
    console.error(`postbuild: could not chmod ${binPath}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
