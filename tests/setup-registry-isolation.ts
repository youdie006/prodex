import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeEach } from "vitest";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "prodex-test-state-"));
const isolated = {
  PRODEX_BRIDGES_REGISTRY: path.join(root, "bridges.json"),
  PRODEX_SEND_LOCK_FILE: path.join(root, "browser-send.lock"),
  PRODEX_LAST_LOGIN_FILE: path.join(root, "last-login.json")
};

function restoreIsolation(): void {
  Object.assign(process.env, isolated);
}

// Set this before module imports and at every test boundary. A test that
// deletes its override must not send the next test to the user's real state.
// Per-test hooks can still replace these paths with their own fixtures.
restoreIsolation();
beforeEach(restoreIsolation);
afterEach(restoreIsolation);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
