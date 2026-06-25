import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendChatGptPromptMock = vi.hoisted(() => vi.fn());

vi.mock("../src/chatgpt-browser.js", async () => {
  const actual = await vi.importActual<typeof import("../src/chatgpt-browser.js")>("../src/chatgpt-browser.js");
  return {
    ...actual,
    sendChatGptPrompt: sendChatGptPromptMock
  };
});

import { runCli } from "../src/cli.js";
import { setSafeFileTestHooks } from "../src/safe-file.js";

describe("pro browser ask persistence", () => {
  beforeEach(() => {
    sendChatGptPromptMock.mockReset();
    setSafeFileTestHooks({});
  });

  afterEach(() => {
    setSafeFileTestHooks({});
  });

  it("rejects conflicting dry-run and send modes before touching the browser", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-pro-send-"));

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
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-pro-send-"));

    await expect(
      runCli(["pro", "browser", "ask", "--dry-run", "Review this"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow(/pro browser ask.*visible-browser send|Use `gptprouse pro ask`/i);

    expect(sendChatGptPromptMock).not.toHaveBeenCalled();
    await expect(readdir(path.join(cwd, ".bridge"))).rejects.toThrow();
  });

  it("rejects direct raw ask-pro sends before touching the browser", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-pro-send-"));

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
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-pro-send-"));
    sendChatGptPromptMock.mockResolvedValueOnce({
      url: "https://chatgpt.com/c/smoke",
      title: "ChatGPT",
      answer: "GPTPROUSE_PRO_SMOKE_OK",
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
      prompt: "This is a one-time gptprouse smoke test. Reply exactly: GPTPROUSE_PRO_SMOKE_OK",
      timeoutMs: 123
    });
    expect(JSON.parse(out.join("\n"))).toEqual(
      expect.objectContaining({
        url: "https://chatgpt.com/c/smoke",
        answer: "GPTPROUSE_PRO_SMOKE_OK"
      })
    );
  });

  it("records a blocked smoke consult when ChatGPT does not return the exact smoke token", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-pro-send-"));
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
    ).rejects.toThrow(/smoke.*unexpected|GPTPROUSE_PRO_SMOKE_OK/i);

    const out: string[] = [];
    await runCli(["pro", "latest"], {
      cwd,
      stdout: (line) => out.push(line),
      stderr: () => {}
    });

    const text = out.join("\n");
    expect(text).toContain("status: blocked");
    expect(text).toContain("smoke_token_mismatch");
    expect(text).toContain("Expected exactly GPTPROUSE_PRO_SMOKE_OK");
  });

  it("records a blocked smoke consult when pro browser smoke hits a visible-browser blocker", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-pro-send-"));
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
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-pro-send-"));
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

  it("prints source-checkout retry commands when listing blocked smoke consults", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-pro-send-"));
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
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-pro-send-"));
    const sourceCli = path.join(cwd, "dist", "cli.js");
    await mkdir(path.dirname(sourceCli), { recursive: true });
    await writeFile(sourceCli, "#!/usr/bin/env node\n", "utf8");
    const blocker = {
      code: "browser_unreachable",
      message: "No Chrome DevTools endpoint is reachable on 127.0.0.1:65534.",
      retryable: true,
      next_step: "Run `gptprouse pro browser login`, log in, then retry."
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
    expect(text).not.toContain("gptprouse pro browser login");
  });

  it("records a blocked consult when the visible browser send fails", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-pro-send-"));
    sendChatGptPromptMock.mockRejectedValueOnce(new Error("ChatGPT is asking you to log in."));

    await expect(
      runCli(["pro", "browser", "ask", "Review this"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow(/log in/i);

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
    expect(checkOut.join("\n")).toContain(`latest_pro: blocked ${taskId}`);

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
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-pro-send-"));
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
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-pro-send-"));
    const sourceCli = path.join(cwd, "dist", "cli.js");
    await mkdir(path.dirname(sourceCli), { recursive: true });
    await writeFile(sourceCli, "#!/usr/bin/env node\n", "utf8");
    const blocker = {
      code: "browser_unreachable",
      message: "No Chrome DevTools endpoint is reachable on 127.0.0.1:65534.",
      retryable: true,
      next_step: "Run `gptprouse pro browser login`, log in, then retry."
    };
    sendChatGptPromptMock.mockRejectedValueOnce(Object.assign(new Error(`${blocker.message} Next: ${blocker.next_step}`), { blocker }));

    await expect(
      runCli(["pro", "browser", "ask", "--source-cli", sourceCli, "Review this"], {
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
    expect(text).not.toContain("gptprouse pro browser login");
  });

  it("stores successful browser answers as a receipt-backed artifact before result finalization", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-pro-send-"));
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
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-pro-send-"));
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
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-pro-send-"));
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
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-pro-send-"));
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
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-pro-send-"));
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
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-pro-send-"));
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
    ).rejects.toThrow(/record.*session.*before.*send|forced running session write failure/i);

    expect(sendChatGptPromptMock).not.toHaveBeenCalled();
  });

  it("completes the browser consult when optional final session writes fail", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-pro-send-"));
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
