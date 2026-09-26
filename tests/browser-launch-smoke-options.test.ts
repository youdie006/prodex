import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { browserSmokeOutcome, parseSmokeOptions, waitForFixturePage } from "../scripts/browser-launch-smoke.mjs";

const smokeScript = fileURLToPath(new URL("../scripts/browser-launch-smoke.mjs", import.meta.url));

describe("browser launch smoke options", () => {
  it.each(["http_error", "protection", "timeout", "protocol_error", "network_error", "uncorrelated"])(
    "does not print a success marker for public outcome %s", outcome => {
      expect(browserSmokeOutcome({ outcome })).toBe("failed");
    }
  );
  it("keeps success for the default offline smoke and a completed HTTP document", () => {
    expect(browserSmokeOutcome()).toBe("ok");
    expect(browserSmokeOutcome({ outcome: "response" })).toBe("ok");
  });

  it("keeps public navigation disabled unless explicitly selected", () => {
    expect(parseSmokeOptions([])).toMatchObject({ headed: false, publicChatGpt: false });
    expect(parseSmokeOptions(["--public-chatgpt"])).toMatchObject({ headed: false, publicChatGpt: true });
    expect(() => parseSmokeOptions(["https://chatgpt.com/"])).toThrow("unexpected argument");
  });

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

const fixtureUrl = "http://127.0.0.1:4242/";

function page(id: string, url: string) {
  return { id, type: "page", url, webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/page/${id}` };
}

function listTargets(targets: ReturnType<typeof page>[]) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => targets }));
}

afterEach(() => vi.unstubAllGlobals());

describe("browser launch smoke target selection", () => {
  it("returns the navigated target when a restored page has the same fixture URL", async () => {
    const navigated = page("new-blank", fixtureUrl);
    listTargets([page("restored", fixtureUrl), navigated]);

    await expect(waitForFixturePage(9222, fixtureUrl, 1_000, navigated.id)).resolves.toEqual(navigated);
  });

  it("does not accept an unrelated fixture page when the navigated target is missing", async () => {
    listTargets([page("restored", fixtureUrl)]);

    await expect(waitForFixturePage(9222, fixtureUrl, 1, "new-blank")).rejects.toThrow(/target.*not ready|target.*missing/i);
  });

  it("does not accept an unrelated fixture page when the navigated target has a different URL", async () => {
    listTargets([page("restored", fixtureUrl), page("new-blank", "about:blank")]);

    await expect(waitForFixturePage(9222, fixtureUrl, 1, "new-blank")).rejects.toThrow(/target.*not ready|target.*URL/i);
  });

  it("still rejects genuine URL ambiguity when no target is pinned", async () => {
    listTargets([page("first", fixtureUrl), page("second", fixtureUrl)]);

    await expect(waitForFixturePage(9222, fixtureUrl, 1_000)).rejects.toThrow("expected one loopback fixture page, found 2");
  });
});
