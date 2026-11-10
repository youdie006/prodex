import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const script = path.resolve("scripts/colima-start.sh");

// Found 2026-11-10: M3's colima VM stayed stopped for about a day after a macOS
// restart. A login LaunchAgent now runs this script; a restart can also leave
// the VM "Broken", which `colima start` cannot get past until
// `colima stop --force` has run (Colima FAQ).
async function run(profile: string, { state, startExit = 0 }: { state?: string; startExit?: number } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "prodex-colima-start-"));
  const calls = path.join(dir, "calls");
  const row = state ? `${profile}    ${state}    aarch64    2    4GiB    16GiB    docker` : "default    Stopped    aarch64    2    4GiB    30GiB    docker";
  await writeFile(path.join(dir, "colima"), [
    "#!/bin/sh",
    `echo "$*" >> '${calls}'`,
    "case $1 in",
    `  list) printf '%s\\n' 'PROFILE    STATUS    ARCH    CPUS    MEMORY    DISK    RUNTIME    ADDRESS' '${row}' ;;`,
    `  start) exit ${startExit} ;;`,
    "esac",
    ""
  ].join("\n"));
  await chmod(path.join(dir, "colima"), 0o755);
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` };
  const result = await execFileAsync("/bin/sh", [script, profile], { env }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error: { code: number; stdout: string; stderr: string }) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr })
  );
  const made = await readFile(calls, "utf8").then(text => text.trim().split("\n"), () => []);
  return { ...result, calls: made };
}

describe.skipIf(process.platform === "win32")("starting the colima VM at login", () => {
  it("leaves a running VM alone", async () => {
    const result = await run("prodex-check", { state: "Running" });
    expect(result.code).toBe(0);
    expect(result.calls).toEqual(["list"]);
  });

  it("starts a stopped VM", async () => {
    const result = await run("prodex-check", { state: "Stopped" });
    expect(result.code).toBe(0);
    expect(result.calls).toEqual(["list", "start --profile prodex-check"]);
  });

  it("force-stops a Broken VM before starting it", async () => {
    const result = await run("prodex-check", { state: "Broken" });
    expect(result.code).toBe(0);
    expect(result.calls).toEqual(["list", "stop --force --profile prodex-check", "start --profile prodex-check"]);
    expect(result.stdout).toMatch(/prodex-check is Broken/);
  });

  it("exits non-zero when the start fails, so launchd tries again", async () => {
    const result = await run("prodex-check", { state: "Stopped", startExit: 3 });
    expect(result.code).toBe(3);
  });

  // `colima start --profile NAME` would create a new, empty VM.
  it("does not create a VM for a profile colima does not list", async () => {
    const result = await run("prodex-check");
    expect(result.code).toBe(0);
    expect(result.calls).toEqual(["list"]);
    expect(result.stderr).toMatch(/no colima profile named prodex-check/);
  });

  it("refuses a profile name that is not a plain name", async () => {
    for (const profile of ["", "-p", "a;b", "a b"]) {
      const result = await run(profile);
      expect(result.code).toBe(64);
      expect(result.calls).toEqual([]);
    }
  });
});
