import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Keep every test hermetic: BridgeStore.ensure() registers its root in
    // the machine-wide bridges registry, which must never be polluted with
    // throwaway test directories.
    setupFiles: ["./tests/setup-registry-isolation.ts"],
    // Vitest defaults to 5s, which this suite outgrew. Measured spend against
    // that budget: release-pack's sanitized-tarball test 4225ms (85% of it),
    // the browser-send lock test 3202ms, release pack via the CLI 2251ms and
    // 2205ms. Those tests spawn real `npm pack` and `node` subprocesses, so
    // their cost tracks machine state, not logic - and when the two CLI ones
    // crossed 5s in a full run they failed together as "Test timed out in
    // 5000ms", a shape that carries NO subprocess output, which is why nothing
    // about it was diagnosable. The suite already granted explicit budgets to
    // the two tests that visibly needed them (40_000 in cdp-port, 20_000 in
    // cli); the subprocess tests were simply missed. 30s keeps a genuine hang
    // failing - the whole suite runs in under a minute - while leaving a real
    // margin instead of 1.2x.
    testTimeout: 30_000,
  },
});
