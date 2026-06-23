import { mkdtemp, readdir, readFile } from "node:fs/promises";
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
    expect(text).toContain("ChatGPT is asking you to log in.");
    const taskId = text.match(/task_id: (task_[^\n]+)/)?.[1];
    expect(taskId).toBeDefined();
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

    await expect(
      runCli(["pro", "browser", "ask", "Review this"], {
        cwd,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toThrow(/forced final result write failure/);

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

  it("completes the browser consult when optional session writes fail", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gptprouse-pro-send-"));
    sendChatGptPromptMock.mockResolvedValueOnce({
      url: "https://chatgpt.com/c/abc",
      title: "ChatGPT",
      answer: "Session recording can fail without losing the answer.",
      modelHints: [],
      warnings: []
    });
    setSafeFileTestHooks({
      beforeOpen: (filePath, operation) => {
        if (operation === "write" && filePath.includes(`${path.sep}.sess_`)) {
          throw new Error("forced session write failure");
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
  });
});
