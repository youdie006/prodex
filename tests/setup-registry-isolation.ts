import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Point the bridges registry at a per-run temp file unless a test already
// overrode it (registry.test.ts manages its own).
if (!process.env.PRODEX_BRIDGES_REGISTRY) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prodex-test-registry-"));
  process.env.PRODEX_BRIDGES_REGISTRY = path.join(dir, "bridges.json");
}

// Same isolation for the machine-global browser send lock: without this,
// parallel test workers contend on the real ~/.local/share/prodex lock and
// unrelated send tests fail with "another prodex browser send is in progress".
if (!process.env.PRODEX_SEND_LOCK_FILE) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prodex-test-sendlock-"));
  process.env.PRODEX_SEND_LOCK_FILE = path.join(dir, "browser-send.lock");
}
