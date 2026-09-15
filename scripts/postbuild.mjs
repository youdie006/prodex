#!/usr/bin/env node
// A root-level bin also receives executable tar headers from npm on Windows.
import { chmodSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binPath = path.join(repoRoot, "prodex.mjs");

try {
  chmodSync(binPath, 0o755);
  // Keep the old explicit `node dist/cli.js` entry without a second package bin.
  chmodSync(path.join(repoRoot, "dist", "cli.js"), 0o644);
} catch (error) {
  console.error(`postbuild: could not set package file modes: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
