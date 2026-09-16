import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const smokeScript = fileURLToPath(new URL("../scripts/browser-launch-smoke.mjs", import.meta.url));

describe("browser launch smoke options", () => {
  it("rejects an unknown flag before resolving or launching a browser", () => {
    const result = spawnSync(process.execPath, [smokeScript, "--unknown-smoke-option"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PRODEX_CHROME: "/definitely/not/a/browser"
      },
      timeout: 10_000
    });
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(output).toContain("browser launch smoke failed: unknown option --unknown-smoke-option");
    expect(output).not.toContain("PRODEX_CHROME");
  });
});
