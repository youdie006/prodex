import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendChatGptPromptMock = vi.hoisted(() => vi.fn());
const listChatGptModelOptionsMock = vi.hoisted(() => vi.fn());
const openChatGptBrowserMock = vi.hoisted(() => vi.fn());
const getChatGptBrowserStatusMock = vi.hoisted(() => vi.fn());

vi.mock("../src/chatgpt-browser.js", async () => {
  const actual = await vi.importActual<typeof import("../src/chatgpt-browser.js")>("../src/chatgpt-browser.js");
  return {
    ...actual,
    sendChatGptPrompt: sendChatGptPromptMock,
    listChatGptModelOptions: listChatGptModelOptionsMock,
    openChatGptBrowser: openChatGptBrowserMock,
    getChatGptBrowserStatus: getChatGptBrowserStatusMock
  };
});

import { runCli } from "../src/cli.js";
import { loadLocalConfig, writeLocalConfig } from "../src/config.js";
import { setSafeFileTestHooks } from "../src/safe-file.js";

beforeEach(() => {
  process.env.PRODEX_MIN_SEND_INTERVAL_MS = "0";
});

afterEach(() => {
  delete process.env.PRODEX_MIN_SEND_INTERVAL_MS;
});

describe("pro browser ask persistence", () => {
  beforeEach(() => {
    sendChatGptPromptMock.mockReset();
    openChatGptBrowserMock.mockReset();
    // Default to a realistic unreachable status so pro browser check keeps
    // working; auto-recovery tests override per-case.
    getChatGptBrowserStatusMock.mockReset();
    getChatGptBrowserStatusMock.mockResolvedValue({
      reachable: false,
      loggedInLikely: false,
      hasComposer: false,
      modelHints: [],
      blocker: {
        code: "browser_unreachable",
        message: "No Chrome DevTools endpoint is reachable on 127.0.0.1:9333.",
        retryable: true,
        next_step: "Run `prodex pro browser login`, log in, then retry."
      }
    });
    setSafeFileTestHooks({});
  });

  afterEach(() => {
    setSafeFileTestHooks({});
  });

  it("rejects conflicting dry-run and send modes before touching the browser", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));

    await expect(
      runCli(["pro", "browser", "ask", "--dry-run", "--send", "Review this"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow(/dry-run.*send|send.*dry-run/i);

    expect(sendChatGptPromptMock).not.toHaveBeenCalled();
    await expect(readdir(path.join(cwd, ".bridge"))).rejects.toThrow();
  });

  it("rejects pro browser ask dry-run mode before creating a preview", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));

    await expect(
      runCli(["pro", "browser", "ask", "--dry-run", "Review this"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow(/pro browser ask.*visible-browser send|Use `prodex pro ask`/i);

    expect(sendChatGptPromptMock).not.toHaveBeenCalled();
    await expect(readdir(path.join(cwd, ".bridge"))).rejects.toThrow();
  });

  it("rejects direct raw ask-pro sends before touching the browser", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));

    await expect(
      runCli(["ask-pro", "--send", "--timeout-ms", "1", "Review this"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow(/pro browser ask/);

    expect(sendChatGptPromptMock).not.toHaveBeenCalled();
    await expect(readdir(path.join(cwd, ".bridge"))).rejects.toThrow();
  });

  it("runs the advertised pro browser smoke command through the visible-browser adapter", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));
    sendChatGptPromptMock.mockResolvedValueOnce({
      url: "https://chatgpt.com/c/smoke",
      title: "ChatGPT",
      answer: "PRODEX_PRO_SMOKE_OK",
      modelHints: ["GPT-5 Pro"],
      warnings: []
    });
    const out: string[] = [];

    await runCli(["pro", "browser", "smoke", "--port", "65530", "--timeout-ms", "123"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    expect(sendChatGptPromptMock).toHaveBeenCalledWith({
      port: 65530,
      prompt: "This is a one-time prodex smoke test. Reply exactly: PRODEX_PRO_SMOKE_OK",
      timeoutMs: 123,
      onProgress: expect.any(Function)
    });
    expect(JSON.parse(out.join("\n"))).toEqual(
      expect.objectContaining({
        url: "https://chatgpt.com/c/smoke",
        answer: "PRODEX_PRO_SMOKE_OK"
      })
    );
  });

  it("records a blocked smoke consult when ChatGPT does not return the exact smoke token", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));
    sendChatGptPromptMock.mockResolvedValueOnce({
      url: "https://chatgpt.com/c/smoke",
      title: "ChatGPT",
      answer: "Sure, the smoke test passed.",
      modelHints: ["GPT-5 Pro"],
      warnings: []
    });

    await expect(
      runCli(["pro", "browser", "smoke"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow(/smoke.*unexpected|PRODEX_PRO_SMOKE_OK/i);

    const out: string[] = [];
    await runCli(["pro", "latest"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(text).toContain("status: blocked");
    expect(text).toContain("smoke_token_mismatch");
    expect(text).toContain("Expected exactly PRODEX_PRO_SMOKE_OK");
  });

  it("records a blocked smoke consult when pro browser smoke hits a visible-browser blocker", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));
    const blocker = {
      code: "captcha_required",
      message: "ChatGPT is asking for captcha or human verification.",
      retryable: true,
      next_step: "Solve it manually in the visible browser, then retry."
    };
    sendChatGptPromptMock.mockRejectedValueOnce(Object.assign(new Error(`${blocker.message} Next: ${blocker.next_step}`), { blocker }));

    await expect(
      runCli(["pro", "browser", "smoke", "--timeout-ms", "10"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow(/blocked consult recorded: task_/);

    const out: string[] = [];
    await runCli(["pro", "latest"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(text).toContain("status: blocked");
    expect(text).toContain("- code: captcha_required");
    expect(text).toContain("- next_step: Solve it manually in the visible browser, then retry.");
    const taskId = text.match(/task_id: (task_[^\n]+)/)?.[1];
    expect(taskId).toBeDefined();
    expect(taskId).toContain("gpt-pro-smoke");
    const task = JSON.parse(await readFile(path.join(cwd, ".bridge", "tasks", `${taskId}.json`), "utf8")) as { title: string };
    expect(task.title).toBe("GPT Pro smoke");
  });

  it("prints source-checkout retry commands when inspecting blocked smoke consults", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));
    const sourceCli = path.join(cwd, "dist", "cli.js");
    await mkdir(path.dirname(sourceCli), { recursive: true });
    await writeFile(sourceCli, "#!/usr/bin/env node\n", "utf8");
    const blocker = {
      code: "captcha_required",
      message: "ChatGPT is asking for captcha or human verification.",
      retryable: true,
      next_step: "Solve it manually in the visible browser, then retry."
    };
    sendChatGptPromptMock.mockRejectedValueOnce(Object.assign(new Error(`${blocker.message} Next: ${blocker.next_step}`), { blocker }));

    await expect(
      runCli(["pro", "browser", "smoke", "--timeout-ms", "10"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow(/captcha/i);

    const out: string[] = [];
    await runCli(["pro", "latest", "--source-cli", sourceCli], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(text).toContain(`Next: Solve it manually in the visible browser, then run \`node ${sourceCli} pro browser smoke --source-cli ${sourceCli}\`.`);
    expect(text).toContain(
      `- next_step: Solve it manually in the visible browser, then run \`node ${sourceCli} pro browser smoke --source-cli ${sourceCli}\`.`
    );
    expect(text).not.toContain("then retry.");
  });

  it("keeps explicit cwd in retry commands when inspecting blocked smoke consults from elsewhere", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));
    const launcherCwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-launcher-"));
    const sourceRoot = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-source-"));
    const sourceCli = path.join(sourceRoot, "dist", "cli.js");
    await mkdir(path.dirname(sourceCli), { recursive: true });
    await writeFile(sourceCli, "#!/usr/bin/env node\n", "utf8");
    const blocker = {
      code: "captcha_required",
      message: "ChatGPT is asking for captcha or human verification.",
      retryable: true,
      next_step: "Solve it manually in the visible browser, then retry."
    };
    sendChatGptPromptMock.mockRejectedValueOnce(Object.assign(new Error(`${blocker.message} Next: ${blocker.next_step}`), { blocker }));

    await expect(
      runCli(["pro", "browser", "smoke", "--timeout-ms", "10"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow(/captcha/i);

    const latestOut: string[] = [];
    await runCli(["pro", "latest", "--cwd", cwd, "--source-cli", sourceCli], {
      cwd: launcherCwd,
      stdout: (line) => latestOut.push(line),
      stderr: () => {}
    });
    const latestText = latestOut.join("\n");
    const taskId = latestText.match(/task_id: (task_[^\n]+)/)?.[1];
    expect(taskId).toBeDefined();
    expect(latestText).toContain(
      `- next_step: Solve it manually in the visible browser, then run \`cd ${cwd} && node ${sourceCli} pro browser smoke --source-cli ${sourceCli}\`.`
    );

    const showOut: string[] = [];
    await runCli(["pro", "show", taskId as string, "--cwd", cwd, "--source-cli", sourceCli], {
      cwd: launcherCwd,
      stdout: (line) => showOut.push(line),
      stderr: () => {}
    });

    expect(showOut.join("\n")).toContain(
      `- next_step: Solve it manually in the visible browser, then run \`cd ${cwd} && node ${sourceCli} pro browser smoke --source-cli ${sourceCli}\`.`
    );
  });

  it("prints source-checkout retry commands when listing blocked smoke consults", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));
    const sourceCli = path.join(cwd, "dist", "cli.js");
    await mkdir(path.dirname(sourceCli), { recursive: true });
    await writeFile(sourceCli, "#!/usr/bin/env node\n", "utf8");
    const blocker = {
      code: "captcha_required",
      message: "ChatGPT is asking for captcha or human verification.",
      retryable: true,
      next_step: "Solve it manually in the visible browser, then retry."
    };
    sendChatGptPromptMock.mockRejectedValueOnce(Object.assign(new Error(`${blocker.message} Next: ${blocker.next_step}`), { blocker }));

    await expect(
      runCli(["pro", "browser", "smoke", "--timeout-ms", "10"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow(/captcha/i);

    const out: string[] = [];
    await runCli(["pro", "list", "--source-cli", sourceCli], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(text).toContain(`then run \`node ${sourceCli} pro browser smoke --source-cli ${sourceCli}\`.`);
    expect(text).not.toContain("then retry.");
  });

  it("records source-checkout next steps for blocked pro browser smoke", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));
    const sourceCli = path.join(cwd, "dist", "cli.js");
    await mkdir(path.dirname(sourceCli), { recursive: true });
    await writeFile(sourceCli, "#!/usr/bin/env node\n", "utf8");
    const blocker = {
      code: "browser_unreachable",
      message: "No Chrome DevTools endpoint is reachable on 127.0.0.1:65534.",
      retryable: true,
      next_step: "Run `prodex pro browser login`, log in, then retry."
    };
    sendChatGptPromptMock.mockRejectedValueOnce(Object.assign(new Error(`${blocker.message} Next: ${blocker.next_step}`), { blocker }));

    await expect(
      runCli(["pro", "browser", "smoke", "--timeout-ms", "10", "--source-cli", sourceCli], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow(/node .*pro browser login --source-cli/);

    const out: string[] = [];
    await runCli(["pro", "latest"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(text).toContain("status: blocked");
    expect(text).toContain(`- next_step: Run \`node ${sourceCli} pro browser login --source-cli ${sourceCli}\`, log in, then retry.`);
    expect(text).not.toContain("prodex pro browser login");
  });

  it("records smoke blockers in explicit --cwd when launched from elsewhere", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));
    const launcherCwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-launcher-"));
    const sourceRoot = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-source-"));
    const sourceCli = path.join(sourceRoot, "dist", "cli.js");
    await mkdir(path.dirname(sourceCli), { recursive: true });
    await writeFile(sourceCli, "#!/usr/bin/env node\n", "utf8");
    const blocker = {
      code: "browser_unreachable",
      message: "No Chrome DevTools endpoint is reachable on 127.0.0.1:65534.",
      retryable: true,
      next_step: "Run `prodex pro browser login`, log in, then retry."
    };
    sendChatGptPromptMock.mockRejectedValueOnce(Object.assign(new Error(`${blocker.message} Next: ${blocker.next_step}`), { blocker }));

    await expect(
      runCli(["pro", "browser", "smoke", "--cwd", cwd, "--port", "65534", "--timeout-ms", "10", "--source-cli", sourceCli], {
        cwd: launcherCwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow(new RegExp(escapeRegExp(`cd ${cwd} && node ${sourceCli} pro browser login --source-cli ${sourceCli} --port 65534`)));

    expect(sendChatGptPromptMock).toHaveBeenCalledWith({
      port: 65534,
      prompt: "This is a one-time prodex smoke test. Reply exactly: PRODEX_PRO_SMOKE_OK",
      timeoutMs: 10,
      onProgress: expect.any(Function)
    });
    await expect(readdir(path.join(launcherCwd, ".bridge"))).rejects.toThrow();

    const out: string[] = [];
    await runCli(["pro", "latest", "--cwd", cwd], {
      cwd: launcherCwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(text).toContain("status: blocked");
    expect(text).toContain(`- next_step: Run \`cd ${cwd} && node ${sourceCli} pro browser login --source-cli ${sourceCli} --port 65534\`, log in, then retry.`);
  });

  it("throws cwd-aware smoke blocker guidance without --source-cli", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));
    const launcherCwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-launcher-"));
    const blocker = {
      code: "browser_unreachable",
      message: "No Chrome DevTools endpoint is reachable on 127.0.0.1:65534.",
      retryable: true,
      next_step: "Run `prodex pro browser login`, log in, then retry."
    };
    sendChatGptPromptMock.mockRejectedValueOnce(Object.assign(new Error(`${blocker.message} Next: ${blocker.next_step}`), { blocker }));

    await expect(
      runCli(["pro", "browser", "smoke", "--cwd", cwd, "--port", "65534", "--timeout-ms", "10"], {
        cwd: launcherCwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow(`cd ${cwd} && prodex pro browser login --port 65534`);

    await expect(readdir(path.join(launcherCwd, ".bridge"))).rejects.toThrow();

    const out: string[] = [];
    await runCli(["pro", "latest", "--cwd", cwd], {
      cwd: launcherCwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    expect(out.join("\n")).toContain(`- next_step: Run \`cd ${cwd} && prodex pro browser login --port 65534\`, log in, then retry.`);
  });

  it("upgrades stored cwd smoke retry commands when later inspected with --source-cli", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));
    const launcherCwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-launcher-"));
    const sourceRoot = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-source-"));
    const sourceCli = path.join(sourceRoot, "dist", "cli.js");
    await mkdir(path.dirname(sourceCli), { recursive: true });
    await writeFile(sourceCli, "#!/usr/bin/env node\n", "utf8");
    const blocker = {
      code: "browser_unreachable",
      message: "No Chrome DevTools endpoint is reachable on 127.0.0.1:65534.",
      retryable: true,
      next_step: "Run `prodex pro browser login`, log in, then retry."
    };
    sendChatGptPromptMock.mockRejectedValueOnce(Object.assign(new Error(`${blocker.message} Next: ${blocker.next_step}`), { blocker }));

    await expect(
      runCli(["pro", "browser", "smoke", "--cwd", cwd, "--port", "65534", "--timeout-ms", "10"], {
        cwd: launcherCwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow(/blocked consult recorded/);

    const out: string[] = [];
    await runCli(["pro", "latest", "--cwd", cwd, "--source-cli", sourceCli], {
      cwd: launcherCwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(text).toContain(`- next_step: Run \`cd ${cwd} && node ${sourceCli} pro browser login --source-cli ${sourceCli} --port 65534\`, log in, then retry.`);
    expect(text).not.toContain("prodex pro browser login");
  });

  it("normalizes a stored port-only smoke login next_step when later checked with --source-cli", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));
    const sourceRoot = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-source-"));
    const sourceCli = path.join(sourceRoot, "dist", "cli.js");
    await mkdir(path.dirname(sourceCli), { recursive: true });
    await writeFile(sourceCli, "#!/usr/bin/env node\n", "utf8");
    const blocker = {
      code: "browser_unreachable",
      message: "No Chrome DevTools endpoint is reachable on 127.0.0.1:65534.",
      retryable: true,
      next_step: "Run `prodex pro browser login`, log in, then retry."
    };
    sendChatGptPromptMock.mockRejectedValueOnce(Object.assign(new Error(`${blocker.message} Next: ${blocker.next_step}`), { blocker }));

    // Store a blocked smoke task with --port but no --source-cli, so the stored next_step
    // carries the port flag inside the backticked `prodex pro browser login` command.
    await expect(
      runCli(["pro", "browser", "smoke", "--port", "65534", "--timeout-ms", "10"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow();

    // A later source-checkout aware check must re-render the stored next_step in node-source
    // form; a source checkout cannot run the bare prodex command.
    const out: string[] = [];
    await runCli(["pro", "browser", "check", "--port", "65534", "--timeout-ms", "10", "--source-cli", sourceCli], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const latestNextLine = out.find((line) => line.startsWith("latest_pro_next:"));
    expect(out.some((line) => line.startsWith("latest_pro: blocked"))).toBe(true);
    expect(latestNextLine).toBeDefined();
    expect(latestNextLine).toContain(`node ${sourceCli} pro browser login --source-cli ${sourceCli} --port 65534`);
    expect(latestNextLine).not.toContain("prodex pro browser login");
  });

  it("records a blocked consult when the visible browser send fails", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));
    sendChatGptPromptMock.mockRejectedValueOnce(new Error("ChatGPT is asking you to log in."));

    let thrown: Error | undefined;
    try {
      await runCli(["pro", "browser", "ask", "Review this"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      });
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).toMatch(/log in/i);
    expect(thrown?.message).toMatch(/blocked consult recorded: task_/);
    expect(thrown?.message).toContain("prodex pro show");
    expect(thrown?.message).toContain("prodex pro latest");

    const out: string[] = [];
    await runCli(["pro", "latest"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(text).toContain("status: blocked");
    expect(text).toContain("blocker:");
    expect(text).toContain("- code: browser_send_failed");
    expect(text).toContain("- retryable: true");
    expect(text).toContain("- next_step: Resolve the visible browser issue manually, then rerun the consult if needed.");
    expect(text).toContain("ChatGPT is asking you to log in.");
    const taskId = text.match(/task_id: (task_[^\n]+)/)?.[1];
    expect(taskId).toBeDefined();

    const checkOut: string[] = [];
    await runCli(["pro", "browser", "check", "--port", "65534", "--timeout-ms", "10"], {
      cwd,
      stdout: (line) => checkOut.push(line),
      stderr: () => {}
    });
    const checkText = checkOut.join("\n");
    expect(checkText).toContain(`latest_pro: blocked ${taskId}`);
    expect(checkText).toContain("latest_pro_next: Resolve the visible browser issue manually, then rerun the consult if needed.");

    const task = JSON.parse(await readFile(path.join(cwd, ".bridge", "tasks", `${taskId}.json`), "utf8")) as {
      status: string;
      provenance: { session_id: string };
    };
    expect(task.status).toBe("blocked");
    const session = JSON.parse(await readFile(path.join(cwd, ".bridge", "sessions", `${task.provenance.session_id}.json`), "utf8")) as {
      status: string;
      task_id?: string;
      blocker?: { code: string };
    };
    expect(session).toEqual(
      expect.objectContaining({
        status: "blocked",
        task_id: taskId,
        blocker: expect.objectContaining({ code: "browser_send_failed" })
      })
    );
    const result = JSON.parse(await readFile(path.join(cwd, ".bridge", "results", `${taskId}.json`), "utf8")) as {
      blocker?: { code: string; retryable: boolean; next_step?: string };
    };
    expect(result.blocker).toEqual(
      expect.objectContaining({
        code: "browser_send_failed",
        retryable: true
      })
    );
  });

  it("preserves visible-browser blocker details when the adapter provides them", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));
    const blocker = {
      code: "captcha_required",
      message: "ChatGPT is asking for captcha or human verification.",
      retryable: true,
      next_step: "Solve it manually in the visible browser, then retry."
    };
    sendChatGptPromptMock.mockRejectedValueOnce(
      Object.assign(new Error(`${blocker.message} Next: ${blocker.next_step}`), { blocker })
    );

    await expect(
      runCli(["pro", "browser", "ask", "Review this"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow(/captcha/i);

    const out: string[] = [];
    await runCli(["pro", "latest"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(text).toContain("status: blocked");
    expect(text).toContain("- code: captcha_required");
    expect(text).toContain("- retryable: true");
    expect(text).toContain("- next_step: Solve it manually in the visible browser, then retry.");
    expect(text).not.toContain("browser_send_failed");
    const taskId = text.match(/task_id: (task_[^\n]+)/)?.[1];
    expect(taskId).toBeDefined();
    const result = JSON.parse(await readFile(path.join(cwd, ".bridge", "results", `${taskId}.json`), "utf8")) as {
      blocker?: { code: string; message: string; retryable: boolean; next_step?: string };
    };
    expect(result.blocker).toEqual(blocker);
  });

  it("records source-checkout next steps for blocked pro browser ask", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));
    const sourceCli = path.join(cwd, "dist", "cli.js");
    await mkdir(path.dirname(sourceCli), { recursive: true });
    await writeFile(sourceCli, "#!/usr/bin/env node\n", "utf8");
    const blocker = {
      code: "browser_unreachable",
      message: "No Chrome DevTools endpoint is reachable on 127.0.0.1:65534.",
      retryable: true,
      next_step: "Run `prodex pro browser login`, log in, then retry."
    };
    sendChatGptPromptMock.mockRejectedValueOnce(Object.assign(new Error(`${blocker.message} Next: ${blocker.next_step}`), { blocker }));

    let thrown: Error | undefined;
    try {
      await runCli(["pro", "browser", "ask", "--source-cli", sourceCli, "Review this"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      });
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).toContain(`cd ${cwd} && node ${sourceCli} pro browser login --source-cli ${sourceCli}`);
    expect(thrown?.message).toContain(`blocked consult recorded:`);
    expect(thrown?.message).toContain(`node ${sourceCli} pro show`);
    expect(thrown?.message).toContain(`--source-cli ${sourceCli} --cwd ${cwd}`);
    expect(thrown?.message).toContain(`node ${sourceCli} pro latest --source-cli ${sourceCli} --cwd ${cwd}`);

    const out: string[] = [];
    await runCli(["pro", "latest"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(text).toContain("status: blocked");
    expect(text).toContain(`- next_step: Run \`cd ${cwd} && node ${sourceCli} pro browser login --source-cli ${sourceCli}\`, log in, then retry.`);
    expect(text).not.toContain("prodex pro browser login");
  });

  it("records pro browser ask blockers in explicit --cwd when launched from elsewhere", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));
    const launcherCwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-launcher-"));
    const sourceRoot = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-source-"));
    const sourceCli = path.join(sourceRoot, "dist", "cli.js");
    await mkdir(path.dirname(sourceCli), { recursive: true });
    await writeFile(sourceCli, "#!/usr/bin/env node\n", "utf8");
    await writeFile(path.join(cwd, "notes.md"), "target browser ask notes\n", "utf8");
    const blocker = {
      code: "browser_unreachable",
      message: "No Chrome DevTools endpoint is reachable on 127.0.0.1:65534.",
      retryable: true,
      next_step: "Run `prodex pro browser login`, log in, then retry."
    };
    sendChatGptPromptMock.mockRejectedValueOnce(Object.assign(new Error(`${blocker.message} Next: ${blocker.next_step}`), { blocker }));

    let thrown: Error | undefined;
    try {
      await runCli(["pro", "browser", "ask", "--cwd", cwd, "--port", "65534", "--timeout-ms", "10", "--source-cli", sourceCli, "--file", "notes.md", "Review this"], {
        cwd: launcherCwd,
        stdout: () => {},
        stderr: () => {}
      });
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown?.message).toContain(`cd ${cwd} && node ${sourceCli} pro browser login --source-cli ${sourceCli} --port 65534`);
    expect(thrown?.message).toContain(`node ${sourceCli} pro show`);
    expect(thrown?.message).toContain(`--source-cli ${sourceCli} --cwd ${cwd}`);
    await expect(readdir(path.join(launcherCwd, ".bridge"))).rejects.toThrow();

    const out: string[] = [];
    await runCli(["pro", "latest", "--cwd", cwd], {
      cwd: launcherCwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(text).toContain("status: blocked");
    expect(text).toContain(`- next_step: Run \`cd ${cwd} && node ${sourceCli} pro browser login --source-cli ${sourceCli} --port 65534\`, log in, then retry.`);
    const taskId = text.match(/task_id: (task_[^\n]+)/)?.[1];
    expect(taskId).toBeDefined();
    const task = JSON.parse(await readFile(path.join(cwd, ".bridge", "tasks", `${taskId}.json`), "utf8")) as { prompt: string };
    expect(task.prompt).toContain("target browser ask notes");
  });

  it("prints source-checkout target-url commands when inspecting blocked pro browser asks", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));
    const sourceCli = path.join(cwd, "dist", "cli.js");
    await mkdir(path.dirname(sourceCli), { recursive: true });
    await writeFile(sourceCli, "#!/usr/bin/env node\n", "utf8");
    const blocker = {
      code: "ambiguous_chatgpt_tabs",
      message: "Multiple visible or unverified ChatGPT tabs or windows are available.",
      retryable: true,
      next_step: "Close extra ChatGPT windows, leave only the intended tab visible, or pass --target-url with --confirm-target."
    };
    sendChatGptPromptMock.mockRejectedValueOnce(Object.assign(new Error(`${blocker.message} Next: ${blocker.next_step}`), { blocker }));

    await expect(
      runCli(["pro", "browser", "ask", "Review this"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow(/Multiple visible/i);

    const out: string[] = [];
    await runCli(["pro", "latest", "--source-cli", sourceCli], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(text).toContain(
      `- next_step: Close extra ChatGPT windows, leave only the intended tab visible, or run \`cd ${cwd} && node ${sourceCli} pro browser ask --source-cli ${sourceCli} --target-url <chatgpt-url> --confirm-target "prompt"\`.`
    );
    expect(text).not.toContain("pass --target-url with --confirm-target");
    expect(text).not.toContain("prodex pro browser ask");
  });

  it("prints actual target-url retry commands for targeted browser ask blockers", async () => {
    const scenarios = [
      {
        code: "target_url_mismatch",
        message: "ChatGPT tab is not at the confirmed target URL.",
        targetUrl: "https://chatgpt.com/c/target",
        next_step: "Open https://chatgpt.com/c/target in the visible browser and retry. Current: https://chatgpt.com/c/current",
        expected:
          "Open https://chatgpt.com/c/target in the visible browser and run `SOURCE_COMMAND`. Current: https://chatgpt.com/c/current"
      },
      {
        code: "target_tab_missing",
        message: "No open ChatGPT tab matches the confirmed target URL.",
        targetUrl: "https://chatgpt.com/c/missing",
        next_step: "Open https://chatgpt.com/c/missing in the dedicated browser and retry.",
        expected: "Open https://chatgpt.com/c/missing in the dedicated browser and run `SOURCE_COMMAND`."
      }
    ];

    for (const scenario of scenarios) {
      const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));
      const sourceCli = path.join(cwd, "dist", "cli.js");
      await mkdir(path.dirname(sourceCli), { recursive: true });
      await writeFile(sourceCli, "#!/usr/bin/env node\n", "utf8");
      const blocker = {
        code: scenario.code,
        message: scenario.message,
        retryable: true,
        next_step: scenario.next_step
      };
      sendChatGptPromptMock.mockRejectedValueOnce(Object.assign(new Error(`${blocker.message} Next: ${blocker.next_step}`), { blocker }));

      let thrown: Error | undefined;
      try {
        await runCli(["pro", "browser", "ask", "--source-cli", sourceCli, "--target-url", scenario.targetUrl, "--confirm-target", "Review this"], {
          cwd,
          stdout: () => {},
          stderr: () => {}
        });
      } catch (error) {
        thrown = error as Error;
      }
      const command = `cd ${cwd} && node ${sourceCli} pro browser ask --source-cli ${sourceCli} --target-url ${scenario.targetUrl} --confirm-target "prompt"`;
      const expected = scenario.expected.replace("SOURCE_COMMAND", command);
      expect(thrown?.message).toContain(expected);

      const out: string[] = [];
      await runCli(["pro", "latest", "--source-cli", sourceCli], {
        cwd,
        stdout: (line) => out.push(line),
        stderr: () => {}
      });

      expect(out.join("\n")).toContain(`- next_step: ${expected}`);
    }
  });

  it("stores successful browser answers as a receipt-backed artifact before result finalization", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));
    sendChatGptPromptMock.mockResolvedValueOnce({
      url: "https://chatgpt.com/c/abc",
      title: "ChatGPT",
      answer: "Use the receipt-gated write flow next.",
      modelHints: ["GPT-5 Pro"],
      warnings: ["model hint observed"]
    });
    const out: string[] = [];

    await runCli(["pro", "browser", "ask", "Review this"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const taskId = out[0].split("\t")[0];
    const task = JSON.parse(await readFile(path.join(cwd, ".bridge", "tasks", `${taskId}.json`), "utf8")) as {
      provenance: { session_id: string; thread?: string };
    };
    expect(task.provenance.thread).toBe("https://chatgpt.com/c/abc");
    const session = JSON.parse(await readFile(path.join(cwd, ".bridge", "sessions", `${task.provenance.session_id}.json`), "utf8")) as {
      status: string;
      task_id?: string;
      thread?: string;
      warnings: string[];
    };
    expect(session).toEqual(
      expect.objectContaining({
        status: "done",
        task_id: taskId,
        thread: "https://chatgpt.com/c/abc",
        warnings: ["model hint observed"]
      })
    );
    const result = JSON.parse(await readFile(path.join(cwd, ".bridge", "results", `${taskId}.json`), "utf8")) as {
      artifacts: Array<{ path: string; role: string }>;
    };
    const resultArtifact = result.artifacts.find((artifact) => artifact.role === "result");
    expect(resultArtifact?.path).toBe(`.bridge/artifacts/pro-consults/${taskId}.md`);
    await expect(readFile(path.join(cwd, resultArtifact!.path), "utf8")).resolves.toContain("Use the receipt-gated write flow next.");

    const receiptFiles = await readdir(path.join(cwd, ".bridge", "receipts"));
    const receipts = await Promise.all(
      receiptFiles.map(async (file) => JSON.parse(await readFile(path.join(cwd, ".bridge", "receipts", file), "utf8")) as { kind: string; task_id?: string })
    );
    expect(receipts).toContainEqual(expect.objectContaining({ kind: "consult_answer_saved", task_id: taskId }));
  });

  it("keeps oversized browser answers without listing an unfetchable artifact", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));
    const largeAnswer = "x".repeat(120_000);
    sendChatGptPromptMock.mockResolvedValueOnce({
      url: "https://chatgpt.com/c/large",
      title: "ChatGPT",
      answer: largeAnswer,
      modelHints: ["GPT-5 Pro"],
      warnings: []
    });
    const out: string[] = [];
    const err: string[] = [];

    await runCli(["pro", "browser", "ask", "Review this"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line)
    });

    const taskId = out[0].split("\t")[0];
    expect(out[0]).toContain("\tdone\t");
    expect(out.join("\n")).toContain(largeAnswer.slice(0, 200));
    expect(err.join("\n")).toContain("answer_artifact_warning");
    expect(err.join("\n")).toContain("too large");
    const result = JSON.parse(await readFile(path.join(cwd, ".bridge", "results", `${taskId}.json`), "utf8")) as {
      summary: string;
      artifacts: Array<{ path: string; role: string }>;
      warnings: string[];
    };
    expect(result.summary).toBe(largeAnswer);
    expect(result.artifacts).toEqual([]);
    expect(result.warnings.join("\n")).toContain("too large");
    await expect(readdir(path.join(cwd, ".bridge", "artifacts", "pro-consults"))).rejects.toThrow();
  });

  it("does not overwrite a saved answer as a browser failure when result finalization fails", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));
    sendChatGptPromptMock.mockResolvedValueOnce({
      url: "https://chatgpt.com/c/abc",
      title: "ChatGPT",
      answer: "The answer was already received.",
      modelHints: [],
      warnings: []
    });
    let answerArtifactSeen = false;
    let taskRecordWritesAfterAnswer = 0;
    let threwFinalTaskUpdate = false;
    setSafeFileTestHooks({
      beforeOpen: (filePath, operation) => {
        if (operation !== "write") return;
        if (filePath.includes(`${path.sep}artifacts${path.sep}pro-consults${path.sep}`)) {
          answerArtifactSeen = true;
          return;
        }
        if (!answerArtifactSeen || !filePath.includes(`${path.sep}.task_`)) return;
        taskRecordWritesAfterAnswer += 1;
        if (!threwFinalTaskUpdate && taskRecordWritesAfterAnswer === 2) {
          threwFinalTaskUpdate = true;
          throw new Error("forced final result write failure");
        }
      }
    });

    const out: string[] = [];
    await expect(
      runCli(["pro", "browser", "ask", "Review this"], {
        cwd,
        stdout: (line) => out.push(line),
        stderr: () => {}
      })
    ).rejects.toThrow(/forced final result write failure/);
    expect(out.join("\n")).toContain("consult_answer_received_but_not_saved:");
    expect(out.join("\n")).toContain("The answer was already received.");

    const artifactFiles = await readdir(path.join(cwd, ".bridge", "artifacts", "pro-consults"));
    expect(artifactFiles).toHaveLength(1);
    await expect(readFile(path.join(cwd, ".bridge", "artifacts", "pro-consults", artifactFiles[0]), "utf8")).resolves.toContain(
      "The answer was already received."
    );

    const receiptFiles = await readdir(path.join(cwd, ".bridge", "receipts"));
    const receipts = await Promise.all(
      receiptFiles.map(async (file) => JSON.parse(await readFile(path.join(cwd, ".bridge", "receipts", file), "utf8")) as { kind: string })
    );
    expect(receipts).toContainEqual(expect.objectContaining({ kind: "consult_answer_saved" }));

    const resultFiles = await readdir(path.join(cwd, ".bridge", "results"));
    expect(resultFiles).toHaveLength(1);
    const result = JSON.parse(await readFile(path.join(cwd, ".bridge", "results", resultFiles[0]), "utf8")) as {
      status: string;
      summary: string;
      artifacts: Array<{ path: string; role: string }>;
    };
    expect(result.status).toBe("done");
    expect(result.summary).toContain("The answer was already received.");
    expect(result.artifacts).toContainEqual(expect.objectContaining({ role: "result" }));
  });

  it("keeps the received answer when answer artifact storage fails", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));
    sendChatGptPromptMock.mockResolvedValueOnce({
      url: "https://chatgpt.com/c/abc",
      title: "ChatGPT",
      answer: "Artifact storage failed after this answer arrived.",
      modelHints: [],
      warnings: []
    });
    setSafeFileTestHooks({
      beforeOpen: (filePath, operation) => {
        if (operation === "write" && filePath.includes(`${path.sep}artifacts${path.sep}pro-consults${path.sep}`)) {
          throw new Error("forced artifact write failure");
        }
      }
    });
    const out: string[] = [];
    const err: string[] = [];

    await runCli(["pro", "browser", "ask", "Review this"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line)
    });

    const taskId = out[0].split("\t")[0];
    expect(out[0]).toContain("\tdone\t");
    expect(out.join("\n")).toContain("Artifact storage failed after this answer arrived.");
    expect(err.join("\n")).toContain("answer_artifact_warning");
    expect(err.join("\n")).toContain("forced artifact write failure");
    const result = JSON.parse(await readFile(path.join(cwd, ".bridge", "results", `${taskId}.json`), "utf8")) as {
      summary: string;
      artifacts: Array<{ path: string; role: string }>;
      warnings: string[];
    };
    expect(result.summary).toContain("Artifact storage failed after this answer arrived.");
    expect(result.artifacts).toEqual([]);
    expect(result.warnings.join("\n")).toContain("forced artifact write failure");
    const receiptFiles = await readdir(path.join(cwd, ".bridge", "receipts"));
    const receipts = await Promise.all(
      receiptFiles.map(async (file) => JSON.parse(await readFile(path.join(cwd, ".bridge", "receipts", file), "utf8")) as { kind: string; task_id?: string })
    );
    expect(receipts).toContainEqual(expect.objectContaining({ kind: "consult_answer_saved", task_id: taskId }));
  });

  it("keeps the received answer when answer receipt storage fails", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));
    sendChatGptPromptMock.mockResolvedValueOnce({
      url: "https://chatgpt.com/c/abc",
      title: "ChatGPT",
      answer: "Receipt storage failed after this answer arrived.",
      modelHints: [],
      warnings: []
    });
    let artifactSeen = false;
    let receiptFailureThrown = false;
    setSafeFileTestHooks({
      beforeOpen: (filePath, operation) => {
        if (operation !== "write") return;
        if (filePath.includes(`${path.sep}artifacts${path.sep}pro-consults${path.sep}`)) {
          artifactSeen = true;
          return;
        }
        if (
          artifactSeen &&
          !receiptFailureThrown &&
          (filePath.includes(`${path.sep}receipts${path.sep}`) || filePath.includes(`${path.sep}.receipt_`))
        ) {
          receiptFailureThrown = true;
          throw new Error("forced receipt write failure");
        }
      }
    });
    const out: string[] = [];
    const err: string[] = [];

    await runCli(["pro", "browser", "ask", "Review this"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line)
    });

    const taskId = out[0].split("\t")[0];
    expect(out[0]).toContain("\tdone\t");
    expect(out.join("\n")).toContain("Receipt storage failed after this answer arrived.");
    expect(err.join("\n")).toContain("receipt_record_warning");
    expect(err.join("\n")).toContain("forced receipt write failure");
    const result = JSON.parse(await readFile(path.join(cwd, ".bridge", "results", `${taskId}.json`), "utf8")) as {
      summary: string;
      artifacts: Array<{ path: string; role: string }>;
      warnings: string[];
    };
    expect(result.summary).toContain("Receipt storage failed after this answer arrived.");
    expect(result.artifacts).toContainEqual(expect.objectContaining({ role: "result" }));
    expect(result.warnings.join("\n")).toContain("forced receipt write failure");
  });

  it("rejects the browser consult before send when the running session record cannot be written", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));
    setSafeFileTestHooks({
      beforeOpen: (filePath, operation) => {
        if (operation === "write" && filePath.includes(`${path.sep}.sess_`)) {
          throw new Error("forced running session write failure");
        }
      }
    });

    await expect(
      runCli(["pro", "browser", "ask", "Review this"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow(/blocked consult recorded: task_.*record.*session.*before.*send|forced running session write failure/i);

    expect(sendChatGptPromptMock).not.toHaveBeenCalled();
    const taskFiles = await readdir(path.join(cwd, ".bridge", "tasks"));
    expect(taskFiles).toHaveLength(1);
    const taskId = taskFiles[0].replace(/\.json$/, "");
    const task = JSON.parse(await readFile(path.join(cwd, ".bridge", "tasks", taskFiles[0]), "utf8")) as { status: string };
    expect(task.status).toBe("blocked");
    const result = JSON.parse(await readFile(path.join(cwd, ".bridge", "results", `${taskId}.json`), "utf8")) as {
      blocker?: { code: string; retryable: boolean };
    };
    expect(result.blocker).toEqual(
      expect.objectContaining({
        code: "session_record_failed",
        retryable: true
      })
    );
    await expect(readdir(path.join(cwd, ".bridge", "sessions"))).resolves.toEqual([]);
  });

  it("completes the browser consult when optional final session writes fail", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));
    sendChatGptPromptMock.mockResolvedValueOnce({
      url: "https://chatgpt.com/c/abc",
      title: "ChatGPT",
      answer: "Session recording can fail without losing the answer.",
      modelHints: [],
      warnings: []
    });
    let sessionWriteCount = 0;
    setSafeFileTestHooks({
      beforeOpen: (filePath, operation) => {
        if (operation === "write" && filePath.includes(`${path.sep}.sess_`)) {
          sessionWriteCount += 1;
          if (sessionWriteCount > 1) {
            throw new Error("forced final session write failure");
          }
        }
      }
    });
    const out: string[] = [];
    const err: string[] = [];

    await runCli(["pro", "browser", "ask", "Review this"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line)
    });

    const taskId = out[0].split("\t")[0];
    expect(out[0]).toContain("\tdone\t");
    await expect(readFile(path.join(cwd, ".bridge", "results", `${taskId}.json`), "utf8")).resolves.toContain(
      "Session recording can fail without losing the answer."
    );
    expect(err.join("\n")).toContain("session_record_warning");
    expect(err.join("\n")).toContain("forced final session write failure");
  });
});

describe("pro browser ask model/project selection", () => {
  beforeEach(() => {
    sendChatGptPromptMock.mockReset();
    openChatGptBrowserMock.mockReset();
    getChatGptBrowserStatusMock.mockReset();
    getChatGptBrowserStatusMock.mockResolvedValue({
      reachable: false,
      loggedInLikely: false,
      hasComposer: false,
      modelHints: [],
      blocker: {
        code: "browser_unreachable",
        message: "No Chrome DevTools endpoint is reachable on 127.0.0.1:9333.",
        retryable: true,
        next_step: "Run `prodex pro browser login`, log in, then retry."
      }
    });
    setSafeFileTestHooks({});
  });

  afterEach(() => {
    setSafeFileTestHooks({});
  });

  it("forwards model, Pro sub-mode, and project selection to the visible-browser send", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-select-"));
    sendChatGptPromptMock.mockResolvedValueOnce({
      url: "https://chatgpt.com/c/abc",
      title: "ChatGPT",
      answer: "ok",
      modelHints: [],
      warnings: []
    });

    await runCli(
      ["pro", "browser", "ask", "--model", "Pro", "--pro-mode", "확장", "--project", "sandbox-demo", "Review this"],
      { cwd, stdout: () => {}, stderr: () => {} }
    );

    expect(sendChatGptPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("Review this"),
        model: "Pro",
        proMode: "확장",
        project: "sandbox-demo"
      })
    );
  });

  it("normalizes --effort onto the exact menu label before sending", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-select-"));
    sendChatGptPromptMock.mockResolvedValueOnce({
      url: "https://chatgpt.com/c/abc",
      title: "ChatGPT",
      answer: "ok",
      modelHints: [],
      warnings: []
    });

    await runCli(["pro", "browser", "ask", "--effort", "매우높음", "Review this"], {
      cwd,
      stdout: () => {},
      stderr: () => {}
    });

    expect(sendChatGptPromptMock).toHaveBeenCalledWith(expect.objectContaining({ effort: "매우 높음" }));
  });

  it("records the selection in the consult receipt metadata", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-select-"));
    sendChatGptPromptMock.mockResolvedValueOnce({
      url: "https://chatgpt.com/c/abc",
      title: "ChatGPT",
      answer: "ok",
      modelHints: [],
      warnings: []
    });

    await runCli(["pro", "browser", "ask", "--model", "Pro", "--pro-mode", "기본", "Review this"], {
      cwd,
      stdout: () => {},
      stderr: () => {}
    });

    const receiptsDir = path.join(cwd, ".bridge", "receipts");
    const files = await readdir(receiptsDir);
    const receipts = await Promise.all(
      files
        .filter((name) => name.endsWith(".json"))
        .map(async (name) =>
          JSON.parse(await readFile(path.join(receiptsDir, name), "utf8")) as {
            kind?: string;
            metadata?: { selection?: Record<string, string> };
          }
        )
    );
    const consult = receipts.find((entry) => entry.kind === "consult_answer_saved");
    expect(consult?.metadata?.selection).toEqual({ model: "Pro", pro_mode: "기본" });
  });

  it("rejects an unknown --effort before touching the browser", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-select-"));

    await expect(
      runCli(["pro", "browser", "ask", "--effort", "turbo", "Review this"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow(/--effort must be one of/);

    expect(sendChatGptPromptMock).not.toHaveBeenCalled();
    await expect(readdir(path.join(cwd, ".bridge"))).rejects.toThrow();
  });

  it("rejects combining --project and --project-new before touching the browser", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-select-"));

    await expect(
      runCli(["pro", "browser", "ask", "--project", "sandbox-a", "--project-new", "sandbox-b", "Review this"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow(/--project.*--project-new|--project-new/);

    expect(sendChatGptPromptMock).not.toHaveBeenCalled();
    await expect(readdir(path.join(cwd, ".bridge"))).rejects.toThrow();
  });

  it("forwards --project-new to the visible-browser send and suppresses the default project", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-select-"));
    await writeLocalConfig(cwd, { token: "test-token", browserDefaults: { project: "sandbox-default" } });
    sendChatGptPromptMock.mockResolvedValueOnce({
      url: "https://chatgpt.com/c/abc",
      title: "ChatGPT",
      answer: "ok",
      modelHints: [],
      warnings: []
    });

    await runCli(["pro", "browser", "ask", "--project-new", "sandbox-new", "Review this"], {
      cwd,
      stdout: () => {},
      stderr: () => {}
    });

    expect(sendChatGptPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({ projectNew: "sandbox-new", project: undefined })
    );
  });

  it("rejects combining --target-url with --project-new before touching the browser", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-select-"));

    await expect(
      runCli(
        [
          "pro",
          "browser",
          "ask",
          "--target-url",
          "https://chatgpt.com/c/abc",
          "--confirm-target",
          "--project-new",
          "sandbox-new",
          "Review this"
        ],
        { cwd, stdout: () => {}, stderr: () => {} }
      )
    ).rejects.toThrow(/--target-url.*--project/);

    expect(sendChatGptPromptMock).not.toHaveBeenCalled();
    await expect(readdir(path.join(cwd, ".bridge"))).rejects.toThrow();
  });

  it("rejects combining --pro-mode and --effort before touching the browser", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-select-"));

    await expect(
      runCli(["pro", "browser", "ask", "--pro-mode", "확장", "--effort", "높음", "Review this"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow(/--pro-mode.*--effort|--effort.*--pro-mode/);

    expect(sendChatGptPromptMock).not.toHaveBeenCalled();
    await expect(readdir(path.join(cwd, ".bridge"))).rejects.toThrow();
  });

  it("persists browser defaults from the setup command", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-select-"));

    await runCli(["setup", "--token", "test-token", "--model", "Pro", "--pro-mode", "확장", "--project", "sandbox-demo"], {
      cwd,
      stdout: () => {},
      stderr: () => {}
    });

    const config = await loadLocalConfig(cwd);
    expect(config.browser_defaults).toEqual({ model: "Pro", pro_mode: "확장", project: "sandbox-demo" });
  });

  it("applies persisted browser defaults when no per-ask flag is given", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-select-"));
    await writeLocalConfig(cwd, { token: "test-token", browserDefaults: { model: "Pro", proMode: "기본", project: "sandbox-demo" } });
    sendChatGptPromptMock.mockResolvedValueOnce({
      url: "https://chatgpt.com/c/abc",
      title: "ChatGPT",
      answer: "ok",
      modelHints: [],
      warnings: []
    });

    await runCli(["pro", "browser", "ask", "Review this"], { cwd, stdout: () => {}, stderr: () => {} });

    expect(sendChatGptPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: "Pro", proMode: "기본", project: "sandbox-demo" })
    );
  });

  it("rejects combining --target-url with --project before touching the browser", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-select-"));

    await expect(
      runCli(
        [
          "pro",
          "browser",
          "ask",
          "--target-url",
          "https://chatgpt.com/c/abc",
          "--confirm-target",
          "--project",
          "sandbox-demo",
          "Review this"
        ],
        { cwd, stdout: () => {}, stderr: () => {} }
      )
    ).rejects.toThrow(/--target-url.*--project|--project.*--target-url/);

    expect(sendChatGptPromptMock).not.toHaveBeenCalled();
    await expect(readdir(path.join(cwd, ".bridge"))).rejects.toThrow();
  });

  it("suppresses the default project when --target-url pins the destination", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-select-"));
    await writeLocalConfig(cwd, { token: "test-token", browserDefaults: { project: "sandbox-demo" } });
    sendChatGptPromptMock.mockResolvedValueOnce({
      url: "https://chatgpt.com/c/abc",
      title: "ChatGPT",
      answer: "ok",
      modelHints: [],
      warnings: []
    });

    await runCli(
      ["pro", "browser", "ask", "--target-url", "https://chatgpt.com/c/abc", "--confirm-target", "Review this"],
      { cwd, stdout: () => {}, stderr: () => {} }
    );

    expect(sendChatGptPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({ targetUrl: "https://chatgpt.com/c/abc", project: undefined })
    );
  });

  it("raises the default timeout for Pro extended sends", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-select-"));
    sendChatGptPromptMock.mockResolvedValueOnce({
      url: "https://chatgpt.com/c/abc",
      title: "ChatGPT",
      answer: "ok",
      modelHints: [],
      warnings: []
    });

    await runCli(["pro", "browser", "ask", "--pro-mode", "확장", "Review this"], { cwd, stdout: () => {}, stderr: () => {} });

    expect(sendChatGptPromptMock).toHaveBeenCalledWith(expect.objectContaining({ proMode: "확장", timeoutMs: 300000 }));
  });

  it("keeps an explicit --timeout-ms even for Pro extended sends", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-select-"));
    sendChatGptPromptMock.mockResolvedValueOnce({
      url: "https://chatgpt.com/c/abc",
      title: "ChatGPT",
      answer: "ok",
      modelHints: [],
      warnings: []
    });

    await runCli(["pro", "browser", "ask", "--pro-mode", "확장", "--timeout-ms", "120000", "Review this"], {
      cwd,
      stdout: () => {},
      stderr: () => {}
    });

    expect(sendChatGptPromptMock).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 120000 }));
  });

  it("clears individual browser defaults via setup --clear-* flags", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-select-"));
    await writeLocalConfig(cwd, {
      token: "test-token",
      browserDefaults: { model: "Pro", proMode: "확장", project: "sandbox-demo" }
    });

    await runCli(["setup", "--token", "test-token", "--clear-pro-mode", "--clear-project"], {
      cwd,
      stdout: () => {},
      stderr: () => {}
    });

    const config = await loadLocalConfig(cwd);
    expect(config.browser_defaults).toEqual({ model: "Pro" });
  });

  it("rejects combining a set flag with its clear flag in setup", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-select-"));

    await expect(
      runCli(["setup", "--token", "test-token", "--model", "Pro", "--clear-model"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow(/--model.*--clear-model|--clear-model.*--model/);
  });

  it("shows browser defaults in status output", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-select-"));
    await writeLocalConfig(cwd, { token: "test-token", browserDefaults: { model: "Pro", effort: "높음" } });
    const out: string[] = [];

    await runCli(["status"], { cwd, stdout: (line) => out.push(line), stderr: () => {} });

    const parsed = JSON.parse(out.join("\n")) as { browser_defaults?: Record<string, string> | null };
    expect(parsed.browser_defaults).toEqual({ model: "Pro", effort: "높음" });
  });

  it("redacts the project name from receipt display output", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-select-"));
    sendChatGptPromptMock.mockResolvedValueOnce({
      url: "https://chatgpt.com/c/abc",
      title: "ChatGPT",
      answer: "ok",
      modelHints: [],
      warnings: []
    });
    await runCli(["pro", "browser", "ask", "--model", "Pro", "--project", "sandbox-demo", "Review this"], {
      cwd,
      stdout: () => {},
      stderr: () => {}
    });

    const listOut: string[] = [];
    await runCli(["receipts", "list"], { cwd, stdout: (line) => listOut.push(line), stderr: () => {} });
    const consultReceiptId = listOut
      .join("\n")
      .split("\n")
      .find((line) => line.includes("consult_answer_saved"))
      ?.split("\t")[0];
    expect(consultReceiptId).toBeDefined();

    const out: string[] = [];
    await runCli(["receipts", "show", consultReceiptId as string], { cwd, stdout: (line) => out.push(line), stderr: () => {} });
    const text = out.join("\n");
    expect(text).not.toContain("sandbox-demo");
    expect(text).toContain("project_redacted");
    expect(text).toContain("Pro");
  });

  it("collects browser defaults through the interactive setup wizard", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-select-"));
    const answers = ["1", "2", "sandbox-demo"]; // model=Pro, sub-mode=확장, project name
    const asked: string[] = [];

    await runCli(["setup", "--token", "test-token", "--interactive"], {
      cwd,
      stdout: () => {},
      stderr: () => {},
      promptUser: async (question: string) => {
        asked.push(question);
        return answers.shift() ?? "";
      }
    });

    const config = await loadLocalConfig(cwd);
    expect(config.browser_defaults).toEqual({ model: "Pro", pro_mode: "확장", project: "sandbox-demo" });
    expect(asked.length).toBe(3);
  });

  it("asks for effort instead of sub-mode when the wizard model is not Pro", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-select-"));
    const answers = ["", "4", ""]; // skip model, effort=매우 높음, skip project

    await runCli(["setup", "--token", "test-token", "--interactive"], {
      cwd,
      stdout: () => {},
      stderr: () => {},
      promptUser: async () => answers.shift() ?? ""
    });

    const config = await loadLocalConfig(cwd);
    expect(config.browser_defaults).toEqual({ effort: "매우 높음" });
  });

  it("re-asks on invalid wizard input before giving up", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-select-"));
    const answers = ["9", "1", "1", ""]; // invalid model choice, then Pro, sub-mode 기본, skip project

    await runCli(["setup", "--token", "test-token", "--interactive"], {
      cwd,
      stdout: () => {},
      stderr: () => {},
      promptUser: async () => answers.shift() ?? ""
    });

    const config = await loadLocalConfig(cwd);
    expect(config.browser_defaults).toEqual({ model: "Pro", pro_mode: "기본" });
  });

  it("rejects --interactive combined with selection flags", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-select-"));

    await expect(
      runCli(["setup", "--token", "test-token", "--interactive", "--model", "Pro"], {
        cwd,
        stdout: () => {},
        stderr: () => {},
        promptUser: async () => ""
      })
    ).rejects.toThrow(/--interactive/);
  });

  it("saves a partial answer with an answer_incomplete warning instead of discarding it", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-select-"));
    sendChatGptPromptMock.mockResolvedValueOnce({
      url: "https://chatgpt.com/c/abc",
      title: "ChatGPT",
      answer: "Partial reasoning that got cut off",
      modelHints: [],
      warnings: [
        "answer_incomplete: ChatGPT was still generating after 90000ms, so the answer below may be truncated. Raise --timeout-ms and retry for the full response."
      ]
    });
    const out: string[] = [];

    await runCli(["pro", "browser", "ask", "Review this"], { cwd, stdout: (line) => out.push(line), stderr: () => {} });

    expect(out[0]).toContain("\tdone\t");
    const receiptsDir = path.join(cwd, ".bridge", "receipts");
    const receipts = await Promise.all(
      (await readdir(receiptsDir))
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => JSON.parse(await readFile(path.join(receiptsDir, name), "utf8")) as { kind?: string; metadata?: { warnings?: string[] } })
    );
    const consult = receipts.find((entry) => entry.kind === "consult_answer_saved");
    expect(JSON.stringify(consult?.metadata?.warnings)).toContain("answer_incomplete");
  });

  it("records a likely-UI-change failure as a send_ui_changed blocker with an update hint", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-select-"));
    sendChatGptPromptMock.mockRejectedValueOnce(
      new Error(
        "Timed out after 90000ms and ChatGPT never registered the prompt (the composer still holds the prompt). The ChatGPT web UI may have changed, so prodex could not submit. Update prodex (npm i -g @youdie006/prodex@latest); if it persists, report it at https://github.com/youdie006/prodex/issues. You can also paste the prompt manually in the visible browser."
      )
    );

    await expect(
      runCli(["pro", "browser", "ask", "Review this"], { cwd, stdout: () => {}, stderr: () => {} })
    ).rejects.toThrow(/blocked consult recorded|UI may have changed/);

    const out: string[] = [];
    await runCli(["pro", "latest"], { cwd, stdout: (line) => out.push(line), stderr: () => {} });
    const text = out.join("\n");
    expect(text).toContain("status: blocked");
    expect(text).toContain("send_ui_changed");
    expect(text).toContain("npm i -g @youdie006/prodex@latest");
  });

  it("records a timeout as an actionable send_timeout blocker with a --timeout-ms hint", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-select-"));
    sendChatGptPromptMock.mockRejectedValueOnce(
      new Error("Timed out after 90000ms waiting for ChatGPT to respond. Raise --timeout-ms and retry (Pro extended already uses a higher default).")
    );

    await expect(
      runCli(["pro", "browser", "ask", "Review this"], { cwd, stdout: () => {}, stderr: () => {} })
    ).rejects.toThrow(/blocked consult recorded|Timed out/);

    const out: string[] = [];
    await runCli(["pro", "latest"], { cwd, stdout: (line) => out.push(line), stderr: () => {} });
    const text = out.join("\n");
    expect(text).toContain("status: blocked");
    expect(text).toContain("send_timeout");
    expect(text).toContain("--timeout-ms");
  });

  it("suggests a concrete doubled --timeout-ms rerun command on send timeout", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-select-"));
    sendChatGptPromptMock.mockRejectedValueOnce(
      new Error("Timed out after 90000ms waiting for ChatGPT to respond. Raise --timeout-ms and retry (Pro extended already uses a higher default).")
    );

    await expect(
      runCli(["pro", "browser", "ask", "Review this"], { cwd, stdout: () => {}, stderr: () => {} })
    ).rejects.toThrow(/--timeout-ms 180000/);

    const out: string[] = [];
    await runCli(["pro", "latest"], { cwd, stdout: (line) => out.push(line), stderr: () => {} });
    const text = out.join("\n");
    expect(text).toContain("pro browser ask --timeout-ms 180000");
  });

  it("prints a saved-artifact footer with a re-print command after a successful ask", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));
    sendChatGptPromptMock.mockResolvedValueOnce({
      url: "https://chatgpt.com/c/footer",
      title: "ChatGPT",
      answer: "footer answer",
      modelHints: [],
      warnings: []
    });
    const errs: string[] = [];

    await runCli(["pro", "browser", "ask", "Review this"], {
      cwd,
      stdout: () => {},
      stderr: (line) => errs.push(line)
    });

    const footer = errs.find((line) => line.startsWith("saved: "));
    expect(footer).toBeDefined();
    expect(footer).toMatch(/saved: \.bridge\/artifacts\/pro-consults\/task_[^\s]+\.md/);
    expect(footer).toContain("re-print: prodex pro latest");
  });

  it("lists model menu options read-only via pro browser models", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-select-"));
    listChatGptModelOptionsMock.mockResolvedValueOnce({
      url: "https://chatgpt.com/",
      options: [
        { label: "높음", kind: "radio", checked: false },
        { label: "Pro", kind: "radio", checked: true },
        { label: "GPT-5.5", kind: "submenu", checked: false }
      ]
    });
    const out: string[] = [];

    await runCli(["pro", "browser", "models"], { cwd, stdout: (line) => out.push(line), stderr: () => {} });

    const text = out.join("\n");
    expect(listChatGptModelOptionsMock).toHaveBeenCalledWith({ port: undefined, timeoutMs: undefined });
    expect(text).toContain("* Pro");
    expect(text).toContain("  높음");
    expect(text).toContain("GPT-5.5  (has sub-variants; not selectable via --model yet)");
    expect(sendChatGptPromptMock).not.toHaveBeenCalled();
  });

  it("stamps a send marker and throttles the next send at human pace", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-select-"));
    await mkdir(path.join(cwd, ".bridge"), { recursive: true });
    // A fresh prior-send marker makes the next send hit the pacing wait.
    await writeFile(path.join(cwd, ".bridge", "last-browser-send"), `${new Date().toISOString()}\n`, "utf8");
    process.env.PRODEX_MIN_SEND_INTERVAL_MS = "600";
    sendChatGptPromptMock.mockResolvedValueOnce({
      url: "https://chatgpt.com/c/abc",
      title: "ChatGPT",
      answer: "ok",
      modelHints: [],
      warnings: []
    });
    const err: string[] = [];

    const startedAt = Date.now();
    await runCli(["pro", "browser", "ask", "Review this"], { cwd, stdout: () => {}, stderr: (line) => err.push(line) });
    const elapsed = Date.now() - startedAt;

    expect(err.join("\n")).toContain("send_pacing");
    expect(elapsed).toBeGreaterThanOrEqual(400);
    expect(sendChatGptPromptMock).toHaveBeenCalledTimes(1);
    const marker = await readFile(path.join(cwd, ".bridge", "last-browser-send"), "utf8");
    expect(Number.isFinite(Date.parse(marker.trim()))).toBe(true);
  });

  it("does not throttle when pacing is disabled", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-select-"));
    await mkdir(path.join(cwd, ".bridge"), { recursive: true });
    await writeFile(path.join(cwd, ".bridge", "last-browser-send"), `${new Date().toISOString()}\n`, "utf8");
    process.env.PRODEX_MIN_SEND_INTERVAL_MS = "0";
    sendChatGptPromptMock.mockResolvedValueOnce({
      url: "https://chatgpt.com/c/abc",
      title: "ChatGPT",
      answer: "ok",
      modelHints: [],
      warnings: []
    });
    const err: string[] = [];

    await runCli(["pro", "browser", "ask", "Review this"], { cwd, stdout: () => {}, stderr: (line) => err.push(line) });

    expect(err.join("\n")).not.toContain("send_pacing");
    expect(sendChatGptPromptMock).toHaveBeenCalledTimes(1);
  });

  it("lets an explicit per-ask flag override the persisted default", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-select-"));
    await writeLocalConfig(cwd, { token: "test-token", browserDefaults: { model: "Pro", proMode: "기본" } });
    sendChatGptPromptMock.mockResolvedValueOnce({
      url: "https://chatgpt.com/c/abc",
      title: "ChatGPT",
      answer: "ok",
      modelHints: [],
      warnings: []
    });

    await runCli(["pro", "browser", "ask", "--pro-mode", "확장", "Review this"], { cwd, stdout: () => {}, stderr: () => {} });

    expect(sendChatGptPromptMock).toHaveBeenCalledWith(expect.objectContaining({ model: "Pro", proMode: "확장" }));
  });

  it("streams progress lines to stderr during a visible-browser send", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));
    sendChatGptPromptMock.mockImplementationOnce(
      async (options: { onProgress?: (event: { phase: string; elapsedMs: number; detail?: string }) => void }) => {
        options.onProgress?.({ phase: "connecting", elapsedMs: 0, detail: "port 9333" });
        options.onProgress?.({ phase: "waiting", elapsedMs: 12_000, detail: "generating" });
        options.onProgress?.({ phase: "answered", elapsedMs: 13_000 });
        return {
          url: "https://chatgpt.com/c/progress",
          title: "ChatGPT",
          answer: "done",
          modelHints: [],
          warnings: []
        };
      }
    );
    const errs: string[] = [];

    await runCli(["pro", "browser", "ask", "check progress"], {
      cwd,
      stdout: () => {},
      stderr: (line) => errs.push(line)
    });

    expect(errs).toContain("progress: connecting to browser (port 9333)");
    expect(errs).toContain("progress: waiting 12s (generating)");
    expect(errs).toContain("progress: answer received after 13s");
  });

  it("auto-recovers a closed browser and retries the send once with --auto-login", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));
    const blocker = {
      code: "browser_unreachable",
      message: "No Chrome DevTools endpoint is reachable on 127.0.0.1:9333.",
      retryable: true,
      next_step: "Run `prodex pro browser login`, log in, then retry."
    };
    sendChatGptPromptMock
      .mockRejectedValueOnce(Object.assign(new Error(blocker.message), { blocker }))
      .mockResolvedValueOnce({
        url: "https://chatgpt.com/c/recovered",
        title: "ChatGPT",
        answer: "recovered answer",
        modelHints: [],
        warnings: []
      });
    openChatGptBrowserMock.mockReturnValueOnce({
      port: 9333,
      profileDir: "/tmp/fake-profile",
      waitForEarlyExit: async () => undefined
    });
    getChatGptBrowserStatusMock.mockResolvedValue({
      reachable: true,
      loggedInLikely: true,
      hasComposer: true,
      modelHints: []
    });
    const out: string[] = [];
    const errs: string[] = [];

    await runCli(["ask", "--auto-login", "Recover please"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: (line) => errs.push(line)
    });

    expect(openChatGptBrowserMock).toHaveBeenCalledTimes(1);
    expect(sendChatGptPromptMock).toHaveBeenCalledTimes(2);
    expect(out.join("\n")).toContain("recovered answer");
    expect(errs.some((line) => line.startsWith("recover:"))).toBe(true);
  });

  it("recovers with the last recorded login profile, not the default", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));
    const lastLoginFile = path.join(cwd, "last-login.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(lastLoginFile, JSON.stringify({ profile_dir: "/custom/chrome-profile", port: 9333 }), "utf8");
    process.env.PRODEX_LAST_LOGIN_FILE = lastLoginFile;
    try {
      const blocker = {
        code: "browser_unreachable",
        message: "No Chrome DevTools endpoint is reachable on 127.0.0.1:9333.",
        retryable: true,
        next_step: "Run `prodex pro browser login`, log in, then retry."
      };
      sendChatGptPromptMock
        .mockRejectedValueOnce(Object.assign(new Error(blocker.message), { blocker }))
        .mockResolvedValueOnce({
          url: "https://chatgpt.com/c/profile",
          title: "ChatGPT",
          answer: "profile ok",
          modelHints: [],
          warnings: []
        });
      openChatGptBrowserMock.mockReturnValueOnce({
        port: 9333,
        profileDir: "/custom/chrome-profile",
        waitForEarlyExit: async () => undefined
      });
      getChatGptBrowserStatusMock.mockResolvedValue({ reachable: true, loggedInLikely: true, hasComposer: true, modelHints: [] });

      await runCli(["ask", "--auto-login", "Recover with profile"], { cwd, stdout: () => {}, stderr: () => {} });

      expect(openChatGptBrowserMock).toHaveBeenCalledWith(
        expect.objectContaining({ profileDir: "/custom/chrome-profile" })
      );
    } finally {
      delete process.env.PRODEX_LAST_LOGIN_FILE;
    }
  });

  it("records the login launch so recovery can reuse the profile", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));
    const lastLoginFile = path.join(cwd, "last-login.json");
    process.env.PRODEX_LAST_LOGIN_FILE = lastLoginFile;
    try {
      openChatGptBrowserMock.mockReturnValueOnce({
        port: 9444,
        profileDir: "/custom/other-profile",
        waitForEarlyExit: async () => undefined
      });
      getChatGptBrowserStatusMock.mockResolvedValue({ reachable: true, loggedInLikely: true, hasComposer: true, modelHints: [] });

      await runCli(["pro", "browser", "login", "--no-wait", "--profile-dir", "/custom/other-profile", "--port", "9444"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      });

      const { readFile } = await import("node:fs/promises");
      const recorded = JSON.parse(await readFile(lastLoginFile, "utf8")) as { profile_dir: string; port: number };
      expect(recorded.profile_dir).toBe("/custom/other-profile");
      expect(recorded.port).toBe(9444);
    } finally {
      delete process.env.PRODEX_LAST_LOGIN_FILE;
    }
  });

  it("auto-recovers in an interactive terminal without --auto-login", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));
    const blocker = {
      code: "browser_unreachable",
      message: "No Chrome DevTools endpoint is reachable on 127.0.0.1:9333.",
      retryable: true,
      next_step: "Run `prodex pro browser login`, log in, then retry."
    };
    sendChatGptPromptMock
      .mockRejectedValueOnce(Object.assign(new Error(blocker.message), { blocker }))
      .mockResolvedValueOnce({
        url: "https://chatgpt.com/c/tty",
        title: "ChatGPT",
        answer: "tty recovered",
        modelHints: [],
        warnings: []
      });
    openChatGptBrowserMock.mockReturnValueOnce({ port: 9333, profileDir: "/tmp/p", waitForEarlyExit: async () => undefined });
    getChatGptBrowserStatusMock.mockResolvedValue({ reachable: true, loggedInLikely: true, hasComposer: true, modelHints: [] });
    const out: string[] = [];

    await runCli(["ask", "Recover please"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {},
      isInteractive: true
    });

    expect(openChatGptBrowserMock).toHaveBeenCalledTimes(1);
    expect(out.join("\n")).toContain("tty recovered");
  });

  it("honors --no-auto-login even in an interactive terminal", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));
    const blocker = {
      code: "browser_unreachable",
      message: "No Chrome DevTools endpoint is reachable on 127.0.0.1:9333.",
      retryable: true,
      next_step: "Run `prodex pro browser login`, log in, then retry."
    };
    sendChatGptPromptMock.mockRejectedValueOnce(Object.assign(new Error(blocker.message), { blocker }));

    await expect(
      runCli(["ask", "--no-auto-login", "Recover please"], {
        cwd,
        stdout: () => {},
        stderr: () => {},
        isInteractive: true
      })
    ).rejects.toThrow(/blocked consult recorded/);

    expect(openChatGptBrowserMock).not.toHaveBeenCalled();
  });

  it("does not auto-recover in non-interactive runs by default", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));
    const blocker = {
      code: "browser_unreachable",
      message: "No Chrome DevTools endpoint is reachable on 127.0.0.1:9333.",
      retryable: true,
      next_step: "Run `prodex pro browser login`, log in, then retry."
    };
    sendChatGptPromptMock.mockRejectedValueOnce(Object.assign(new Error(blocker.message), { blocker }));

    await expect(
      runCli(["ask", "Recover please"], { cwd, stdout: () => {}, stderr: () => {} })
    ).rejects.toThrow(/blocked consult recorded/);

    expect(openChatGptBrowserMock).not.toHaveBeenCalled();
    expect(sendChatGptPromptMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the blocker when recovery never becomes ready", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));
    const blocker = {
      code: "browser_unreachable",
      message: "No Chrome DevTools endpoint is reachable on 127.0.0.1:9333.",
      retryable: true,
      next_step: "Run `prodex pro browser login`, log in, then retry."
    };
    sendChatGptPromptMock.mockRejectedValueOnce(Object.assign(new Error(blocker.message), { blocker }));
    openChatGptBrowserMock.mockReturnValueOnce({
      port: 9333,
      profileDir: "/tmp/fake-profile",
      waitForEarlyExit: async () => ({ code: 1, signal: null })
    });
    getChatGptBrowserStatusMock.mockResolvedValue({
      reachable: false,
      loggedInLikely: false,
      hasComposer: false,
      modelHints: []
    });

    await expect(
      runCli(["ask", "--auto-login", "Recover please"], { cwd, stdout: () => {}, stderr: () => {} })
    ).rejects.toThrow(/blocked consult recorded/);

    expect(sendChatGptPromptMock).toHaveBeenCalledTimes(1);
  });

  it("emits structured JSON with --json instead of the tab header format", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));
    sendChatGptPromptMock.mockResolvedValueOnce({
      url: "https://chatgpt.com/c/json",
      title: "ChatGPT",
      answer: "json answer",
      modelHints: [],
      warnings: []
    });
    const out: string[] = [];

    await runCli(["ask", "--json", "Structured please"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const payload = JSON.parse(out.join("\n")) as {
      task_id: string;
      status: string;
      thread: string;
      answer: string;
      warnings: string[];
    };
    expect(payload.status).toBe("done");
    expect(payload.task_id).toMatch(/^task_/);
    expect(payload.thread).toBe("https://chatgpt.com/c/json");
    expect(payload.answer).toBe("json answer");
    expect(payload.warnings).toEqual([]);
  });

  it("emits blocked-consult JSON on stdout when --json is set", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));
    const blocker = {
      code: "captcha_required",
      message: "ChatGPT is asking for captcha or human verification.",
      retryable: true,
      next_step: "Solve it manually in the visible browser, then retry."
    };
    sendChatGptPromptMock.mockRejectedValueOnce(Object.assign(new Error(`${blocker.message} Next: ${blocker.next_step}`), { blocker }));
    const out: string[] = [];

    await expect(
      runCli(["ask", "--json", "Blocked please"], { cwd, stdout: (line) => out.push(line), stderr: () => {} })
    ).rejects.toThrow(/blocked consult recorded/);

    const payload = JSON.parse(out.join("\n")) as {
      task_id: string;
      status: string;
      blocker: { code: string; next_step?: string };
    };
    expect(payload.status).toBe("blocked");
    expect(payload.task_id).toMatch(/^task_/);
    expect(payload.blocker.code).toBe("captcha_required");
  });

  it("suppresses a persisted default project under --new-chat", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));
    await writeLocalConfig(cwd, { token: "test-token", browserDefaults: { project: "sandbox-default" } });
    sendChatGptPromptMock.mockResolvedValueOnce({
      url: "https://chatgpt.com/c/fresh-noproj",
      title: "ChatGPT",
      answer: "ok",
      modelHints: [],
      warnings: []
    });

    await runCli(["ask", "--new-chat", "Fresh question"], { cwd, stdout: () => {}, stderr: () => {} });

    expect(sendChatGptPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({ newChat: true, project: undefined })
    );
  });

  it("keeps an explicit --project even with --new-chat", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));
    sendChatGptPromptMock.mockResolvedValueOnce({
      url: "https://chatgpt.com/c/fresh-proj",
      title: "ChatGPT",
      answer: "ok",
      modelHints: [],
      warnings: []
    });

    await runCli(["ask", "--new-chat", "--project", "sandbox-explicit", "Fresh question"], {
      cwd,
      stdout: () => {},
      stderr: () => {}
    });

    expect(sendChatGptPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({ newChat: true, project: "sandbox-explicit" })
    );
  });

  it("rejects --json on the dry-run preview path", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));

    await expect(
      runCli(["pro", "ask", "--json", "preview"], { cwd, stdout: () => {}, stderr: () => {} })
    ).rejects.toThrow(/--json.*visible-browser send/i);
  });

  it("appends piped stdin to the prompt when --stdin is set", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));
    sendChatGptPromptMock.mockResolvedValueOnce({
      url: "https://chatgpt.com/c/stdin",
      title: "ChatGPT",
      answer: "stdin ok",
      modelHints: [],
      warnings: []
    });

    await runCli(["ask", "--stdin", "Review this diff"], {
      cwd,
      stdout: () => {},
      stderr: () => {},
      readStdin: async () => "diff --git a/x b/x\n+added line"
    });

    expect(sendChatGptPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("Review this diff")
      })
    );
    const sentPrompt = (sendChatGptPromptMock.mock.calls[0][0] as { prompt: string }).prompt;
    expect(sentPrompt).toContain("--- piped input (stdin) ---");
    expect(sentPrompt).toContain("+added line");
  });

  it("rejects --stdin when no piped input arrives", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));

    await expect(
      runCli(["ask", "--stdin", "Review this"], {
        cwd,
        stdout: () => {},
        stderr: () => {},
        readStdin: async () => "   "
      })
    ).rejects.toThrow(/--stdin.*no piped input/i);

    expect(sendChatGptPromptMock).not.toHaveBeenCalled();
  });

  it("forwards --new-chat to the visible-browser send", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));
    sendChatGptPromptMock.mockResolvedValueOnce({
      url: "https://chatgpt.com/c/fresh",
      title: "ChatGPT",
      answer: "fresh ok",
      modelHints: [],
      warnings: []
    });

    await runCli(["ask", "--new-chat", "Fresh question"], { cwd, stdout: () => {}, stderr: () => {} });

    expect(sendChatGptPromptMock).toHaveBeenCalledWith(expect.objectContaining({ newChat: true }));
  });

  it("rejects --new-chat combined with --target-url before touching the browser", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));

    await expect(
      runCli(
        ["pro", "browser", "ask", "--new-chat", "--target-url", "https://chatgpt.com/c/abc", "--confirm-target", "Question"],
        { cwd, stdout: () => {}, stderr: () => {} }
      )
    ).rejects.toThrow(/new-chat.*target-url|target-url.*new-chat/i);

    expect(sendChatGptPromptMock).not.toHaveBeenCalled();
  });

  it("reports prompt errors for the ask alias without leaking the internal ask-pro name", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));

    await expect(runCli(["ask"], { cwd, stdout: () => {}, stderr: () => {} })).rejects.toThrow(/^ask requires a prompt/);
    await expect(runCli(["ask"], { cwd, stdout: () => {}, stderr: () => {} })).rejects.not.toThrow(/ask-pro/);
  });

  it("reports prompt errors for pro browser ask under its own name", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));

    await expect(runCli(["pro", "browser", "ask"], { cwd, stdout: () => {}, stderr: () => {} })).rejects.toThrow(
      /^pro browser ask requires a prompt/
    );
  });

  it("rewrites the dry-run guidance for alias users to say ask", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));

    await expect(runCli(["ask", "--dry-run", "x"], { cwd, stdout: () => {}, stderr: () => {} })).rejects.toThrow(
      /prodex ask is an explicit visible-browser send/
    );
  });

  it("echoes answer_incomplete warnings to stderr so truncation is visible at runtime", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));
    sendChatGptPromptMock.mockResolvedValueOnce({
      url: "https://chatgpt.com/c/truncated",
      title: "ChatGPT",
      answer: "partial answer",
      modelHints: [],
      warnings: [
        "answer_incomplete: ChatGPT was still generating after 10ms, so the answer below may be truncated. Raise --timeout-ms and retry for the full response."
      ]
    });
    const errs: string[] = [];

    await runCli(["pro", "browser", "ask", "Review this"], {
      cwd,
      stdout: () => {},
      stderr: (line) => errs.push(line)
    });

    expect(errs.some((line) => line.startsWith("answer_incomplete:"))).toBe(true);
  });

  it("routes top-level prodex ask to the visible-browser send", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));
    sendChatGptPromptMock.mockResolvedValueOnce({
      url: "https://chatgpt.com/c/alias",
      title: "ChatGPT",
      answer: "alias ok",
      modelHints: [],
      warnings: []
    });
    const out: string[] = [];

    await runCli(["ask", "Quick question"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    expect(sendChatGptPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: expect.stringContaining("Quick question") })
    );
    expect(out.join("\n")).toContain("alias ok");
  });

  it("passes selection flags through the top-level ask alias", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "prodex-pro-send-"));
    sendChatGptPromptMock.mockResolvedValueOnce({
      url: "https://chatgpt.com/c/alias-flags",
      title: "ChatGPT",
      answer: "flags ok",
      modelHints: [],
      warnings: []
    });

    await runCli(["ask", "--model", "Pro", "--pro-mode", "확장", "Quick question"], {
      cwd,
      stdout: () => {},
      stderr: () => {}
    });

    expect(sendChatGptPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: "Pro", proMode: "확장", timeoutMs: 300_000 })
    );
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
