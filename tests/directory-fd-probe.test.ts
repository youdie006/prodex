import { mkdtempSync, closeSync, constants, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { directoryFdPathsUsable } from "../src/store.js";

// The store writes records through a directory file descriptor rendered as a
// path - /proc/self/fd/N or /dev/fd/N - and joins the record name onto it. The
// probe that chose between them asked only whether the directory EXISTS.
//
// macOS has /dev/fd, so the probe accepted it, and every write then failed with
// ENOENT on a path like /dev/fd/12/receipts. Measured on a Mac:
//   /proc/self/fd   exists=false traversable=false
//   /dev/fd         exists=true  traversable=false
// which took down the whole bridge write surface there: mcp_write_smoke and
// http_mcp_smoke both failed, while both pass on Linux. Existence was never the
// property being relied on.
describe("choosing a directory file descriptor path", () => {
  it("agrees with what the platform can actually do", () => {
    // Reproduce the capability directly and check the probe reaches the same
    // verdict, so this test states the truth on whichever OS runs it.
    const dir = mkdtempSync(path.join(tmpdir(), "fd-probe-"));
    writeFileSync(path.join(dir, "child"), "x", "utf8");
    const fd = openSync(dir, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    let traversable = false;
    try {
      for (const base of ["/proc/self/fd", "/dev/fd"]) {
        try {
          readFileSync(`${base}/${fd}/child`, "utf8");
          traversable = true;
          break;
        } catch {
          // try the next base
        }
      }
    } finally {
      closeSync(fd);
    }

    expect(directoryFdPathsUsable()).toBe(traversable);
  });
});
