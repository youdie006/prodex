import { onTestFinished } from "vitest";

/**
 * Run this test against prodex's default DevTools port.
 *
 * The suite otherwise points PRODEX_CDP_PORT at a dead port so that nothing
 * wanders into a developer's real logged-in browser. A handful of tests are
 * about what the guidance says when the port IS the default - port-awareness
 * only appears for a non-default one - so they take the variable back for their
 * own duration and hand it over again afterwards.
 */
export function useDefaultCdpPort(): void {
  const isolated = process.env.PRODEX_CDP_PORT;
  delete process.env.PRODEX_CDP_PORT;
  onTestFinished(() => {
    if (isolated === undefined) delete process.env.PRODEX_CDP_PORT;
    else process.env.PRODEX_CDP_PORT = isolated;
  });
}
