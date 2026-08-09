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

// And the last-login record. Without this a login test writes the REAL
// ~/.local/share/prodex/last-login.json, so the next auto-recovery relaunches
// the browser with a throwaway test profile (observed: profile_dir pointing at
// /tmp/prodex-cli-*/profile, port 45463) and lands on a logged-out session.
if (!process.env.PRODEX_LAST_LOGIN_FILE) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prodex-test-lastlogin-"));
  process.env.PRODEX_LAST_LOGIN_FILE = path.join(dir, "last-login.json");
}
