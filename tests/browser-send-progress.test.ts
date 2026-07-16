import { describe, expect, it } from "vitest";

import { createBrowserSendProgressPrinter } from "../src/cli-pro.js";
import { sendChatGptPrompt, type SendChatGptProgressEvent } from "../src/chatgpt-browser.js";

describe("createBrowserSendProgressPrinter", () => {
  it("prints phase transitions immediately with detail", () => {
    const lines: string[] = [];
    const print = createBrowserSendProgressPrinter((line) => lines.push(line));

    print({ phase: "connecting", elapsedMs: 0, detail: "port 9333" });
    print({ phase: "tab_ready", elapsedMs: 350 });
    print({ phase: "selecting", elapsedMs: 900, detail: "model=Pro" });
    print({ phase: "sent", elapsedMs: 2_100, detail: "budget 5 min" });

    expect(lines).toEqual([
      "progress: connecting to browser (port 9333)",
      "progress: chatgpt tab ready",
      "progress: applying selection (model=Pro)",
      "progress: prompt sent, waiting for answer (budget 5 min)"
    ]);
  });

  it("throttles waiting heartbeats to the configured interval", () => {
    const lines: string[] = [];
    const print = createBrowserSendProgressPrinter((line) => lines.push(line), 10_000);

    print({ phase: "waiting", elapsedMs: 1_000, detail: "generating" });
    print({ phase: "waiting", elapsedMs: 5_000, detail: "generating" });
    print({ phase: "waiting", elapsedMs: 11_000, detail: "generating" });
    print({ phase: "waiting", elapsedMs: 12_000, detail: "generating" });
    print({ phase: "waiting", elapsedMs: 21_500, detail: "generating" });
    print({ phase: "waiting", elapsedMs: 90_000, detail: "generating" });

    expect(lines).toEqual([
      "progress: waiting 1s (generating)",
      "progress: waiting 11s (generating)",
      "progress: waiting 22s (generating)",
      "progress: waiting 1m 30s (generating)"
    ]);
  });

  it("reports total elapsed seconds when the answer arrives", () => {
    const lines: string[] = [];
    const print = createBrowserSendProgressPrinter((line) => lines.push(line));

    print({ phase: "answered", elapsedMs: 123_400 });

    expect(lines).toEqual(["progress: answer received after 2m 3s"]);
  });
});

describe("sendChatGptPrompt progress emission", () => {
  it("emits a connecting event before failing on an unreachable port", async () => {
    const events: SendChatGptProgressEvent[] = [];

    await expect(
      sendChatGptPrompt({
        port: 9,
        prompt: "probe",
        timeoutMs: 100,
        onProgress: (event) => events.push(event)
      })
    ).rejects.toThrow();

    expect(events.map((event) => event.phase)).toContain("connecting");
  });
});
