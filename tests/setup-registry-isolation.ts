import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Point the bridges registry at a per-run temp file unless a test already
// overrode it (registry.test.ts manages its own).
if (!process.env.PRODEX_BRIDGES_REGISTRY) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prodex-test-registry-"));
  process.env.PRODEX_BRIDGES_REGISTRY = path.join(dir, "bridges.json");
}
