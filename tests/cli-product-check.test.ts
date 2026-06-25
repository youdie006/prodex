import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const browserStatusFixture = vi.hoisted(() => ({
  status: {
    reachable: true,
    loggedInLikely: true,
    hasComposer: true,
    visibilityState: "visible",
    url: "https://chatgpt.com/",
    title: "ChatGPT",
    modelHints: ["ChatGPT Pro"],
    blocker: {
      code: "captcha_required",
      message: "ChatGPT is asking for captcha or human verification.",
      retryable: true,
      next_step: "Solve it manually in the visible browser, then retry."
    }
  }
}));

vi.mock("../src/chatgpt-browser.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/chatgpt-browser.js")>();
  return {
    ...actual,
    getChatGptBrowserStatus: vi.fn(async () => browserStatusFixture.status)
  };
});

const { runCli } = await import("../src/cli.js");

async function runBrowserCheckResult(): Promise<{ code: number; text: string }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-cli-product-check-"));
  const out: string[] = [];

  const code = await runCli(["pro", "browser", "check"], {
    cwd,
    stdout: (line) => out.push(line),
    stderr: () => {}
  });

  return { code, text: out.join("\n") };
}

async function runBrowserCheck(): Promise<string> {
  return (await runBrowserCheckResult()).text;
}

describe("browser product check", () => {
  it("reports blockers even when ChatGPT is logged in with a composer", async () => {
    const { code, text } = await runBrowserCheckResult();
    expect(code).toBe(1);
    expect(text).toContain("chatgpt: blocked captcha_required");
    expect(text).toContain("Solve it manually");
    expect(text).not.toContain("chatgpt: ok");
  });

  it("prints model hints when the visible ChatGPT browser is ready", async () => {
    browserStatusFixture.status = {
      reachable: true,
      loggedInLikely: true,
      hasComposer: true,
      visibilityState: "visible",
      url: "https://chatgpt.com/",
      title: "ChatGPT",
      modelHints: ["GPT-5 Pro", "gptprouse v0.2 review", "Thinking", "GPTPROUSE smoke test", "Extra High"]
    };

    const text = await runBrowserCheck();

    expect(text).toContain("chatgpt: ok logged_in=true composer=true url=https://chatgpt.com/");
    expect(text).toContain("model_hints: GPT-5 Pro | Thinking | Extra High");
    expect(text).not.toContain("GPTPROUSE smoke test");
  });

  it("does not report ok when the selected ChatGPT tab is hidden", async () => {
    browserStatusFixture.status = {
      reachable: true,
      loggedInLikely: true,
      hasComposer: true,
      visibilityState: "hidden",
      url: "https://chatgpt.com/c/background",
      title: "ChatGPT",
      modelHints: ["GPT-5 Pro", "Thinking"]
    };

    const text = await runBrowserCheck();

    expect(text).toContain("chatgpt: blocked tab_not_visible visibility=hidden");
    expect(text).toContain("Select https://chatgpt.com/c/background in the dedicated browser");
    expect(text).toContain("model_hints: GPT-5 Pro | Thinking");
    expect(text).not.toContain("chatgpt: ok");
  });

  it("prints visibility detail when the browser adapter returns a hidden-tab blocker", async () => {
    browserStatusFixture.status = {
      reachable: true,
      loggedInLikely: true,
      hasComposer: true,
      visibilityState: "hidden",
      url: "https://chatgpt.com/c/background",
      title: "ChatGPT",
      modelHints: [],
      blocker: {
        code: "tab_not_visible",
        message: "Selected ChatGPT tab is hidden, not the active visible tab.",
        retryable: true,
        next_step: "Select https://chatgpt.com/c/background in the dedicated browser, then retry."
      }
    };

    const text = await runBrowserCheck();

    expect(text).toContain("chatgpt: blocked tab_not_visible visibility=hidden");
    expect(text).toContain("Selected ChatGPT tab is hidden");
  });

  it("prints a concrete next step when ChatGPT is reachable but not ready", async () => {
    browserStatusFixture.status = {
      reachable: true,
      loggedInLikely: true,
      hasComposer: false,
      visibilityState: "visible",
      url: "https://chatgpt.com/",
      title: "ChatGPT",
      modelHints: ["ChatGPT", "Auto"]
    };

    const text = await runBrowserCheck();

    expect(text).toContain("chatgpt: blocked logged_in=true composer=false");
    expect(text).toContain("model_hints: ChatGPT | Auto");
    expect(text).toContain("next: Open a normal ChatGPT chat or Project thread");
    expect(text).toContain("select the Pro/Thinking model");
  });
});
