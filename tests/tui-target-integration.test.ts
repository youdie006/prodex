import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const send = vi.hoisted(() => vi.fn());
vi.mock("../src/chatgpt-browser.js", async () => ({
  ...await vi.importActual("../src/chatgpt-browser.js"),
  sendChatGptPrompt: send
}));
vi.mock("../src/tui-run.js", () => ({
  runInteractiveConsult: (_io: unknown, deps: { runConsult: (args: string[], progress: () => void) => Promise<number> }) =>
    deps.runConsult(["pro", "browser", "ask", "--target-url", "https://chatgpt.com/c/selected", "--confirm-target", "--", "Review"], () => {})
}));

import { runCli } from "../src/cli.js";
import { withBrowserSendLock } from "../src/browser-send-lock.js";

const roots: string[] = [];
beforeEach(() => {
  vi.stubEnv("PRODEX_MIN_SEND_INTERVAL_MS", "0");
  send.mockReset();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.each([true, false])("keeps selected-target navigation inside the send lock (TUI=%s)", async (interactive) => {
  const cwd = await mkdtemp(path.join(tmpdir(), "prodex-tui-target-"));
  roots.push(cwd);
  let heldDuringSend = false;
  send.mockImplementation(async () => {
    try {
      await withBrowserSendLock(0, () => {}, async () => undefined);
    } catch {
      heldDuringSend = true;
    }
    return { url: "https://chatgpt.com/c/selected", title: "ChatGPT", answer: "Reviewed", modelHints: [], warnings: [] };
  });
  const args = interactive ? ["ui"] : ["pro", "browser", "ask", "--target-url", "https://chatgpt.com/c/selected", "--confirm-target", "--", "Review"];
  await runCli(args, { cwd, stdout: () => {}, stderr: () => {}, isInteractive: false });
  expect(heldDuringSend).toBe(true);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0].targetUrl).toBe("https://chatgpt.com/c/selected");
  expect(send.mock.calls[0][0].navigateToTargetUrl === true).toBe(interactive);
});
