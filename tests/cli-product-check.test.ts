import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/chatgpt-browser.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/chatgpt-browser.js")>();
  return {
    ...actual,
    getChatGptBrowserStatus: vi.fn(async () => ({
      reachable: true,
      loggedInLikely: true,
      hasComposer: true,
      url: "https://chatgpt.com/",
      title: "ChatGPT",
      modelHints: ["ChatGPT Pro"],
      blocker: {
        code: "captcha_required",
        message: "ChatGPT is asking for captcha or human verification.",
        retryable: true,
        next_step: "Solve it manually in the visible browser, then retry."
      }
    }))
  };
});

const { runCli } = await import("../src/cli.js");

describe("browser product check", () => {
  it("reports blockers even when ChatGPT is logged in with a composer", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-product-check-"));
    const out: string[] = [];

    await runCli(["pro", "browser", "check"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(text).toContain("chatgpt: blocked captcha_required");
    expect(text).toContain("Solve it manually");
    expect(text).not.toContain("chatgpt: ok");
  });
});
