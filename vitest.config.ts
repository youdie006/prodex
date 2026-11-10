import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    reporters: process.env.CI ? ["default", "json"] : ["default"],
    outputFile: process.env.CI ? { json: "test-results/vitest.json" } : undefined,
    // Native Windows record writers spawn Node children. Excessive file-level
    // parallelism makes their I/O contend and can exhaust per-test deadlines.
    maxWorkers: process.platform === "win32" ? 4 : undefined,
    // Keep every test hermetic: BridgeStore.ensure() registers its root in
    // the machine-wide bridges registry, which must never be polluted with
    // throwaway test directories.
    setupFiles: ["./tests/setup-registry-isolation.ts", "./tests/setup-browser-isolation.ts"],
    // Vitest defaults to 5s, which this suite outgrew. Measured spend against
    // that budget: release-pack's sanitized-tarball test 4225ms (85% of it),
    // the browser-send lock test 3202ms, release pack via the CLI 2251ms and
    // 2205ms. Those tests spawn real `npm pack` and `node` subprocesses, so
    // their cost tracks machine state, not logic - and when the two CLI ones
    // crossed 5s in a full run they failed together as "Test timed out in
    // 5000ms", a shape that carries NO subprocess output, which is why nothing
    // about it was diagnosable. The suite already granted explicit budgets to
    // the two tests that visibly needed them (40_000 in cdp-port, 20_000 in
    // cli); the subprocess tests were simply missed. 30s bounds each test
    // while leaving a real margin instead of 1.2x. Full-suite duration varies
    // across native OSes.
    //
    // macOS Intel and Windows runners are 4-10x slower than Linux on the same
    // tests (CI run 37424883404: Linux's slowest test 5.0s; macOS Intel and
    // Windows had 12 and 8 tests over 15s, the slowest around 20s besides one
    // with its own budget). Tests of that band crossed 30s on a slow runner
    // and failed as timeouts four times on 2026-10-06/07, each a different
    // test. Those two platforms get 90s; the rest keep 30s.
    testTimeout: process.platform === "win32" || (process.platform === "darwin" && process.arch === "x64") ? 90_000 : 30_000,
  },
});
