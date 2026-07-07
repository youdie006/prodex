import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Keep every test hermetic: BridgeStore.ensure() registers its root in
    // the machine-wide bridges registry, which must never be polluted with
    // throwaway test directories.
    setupFiles: ["./tests/setup-registry-isolation.ts"],
  },
});
