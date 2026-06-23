import { describe, expect, it } from "vitest";
import { buildChromeLaunchArgs, getChatGptBrowserStatus, inferLoggedInLikely, isUsableChatGptAnswer } from "../src/chatgpt-browser.js";

describe("ChatGPT browser adapter", () => {
  it("returns a clear blocker when the local debug port is not reachable", async () => {
    const status = await getChatGptBrowserStatus({ port: 9, timeoutMs: 100 });

    expect(status.reachable).toBe(false);
    expect(status.blocker?.code).toBe("browser_unreachable");
  });

  it("builds a visible Chrome launch command without exposing cookies or tokens", () => {
    const args = buildChromeLaunchArgs({
      port: 9333,
      profileDir: "/tmp/gptprouse-profile",
      url: "https://chatgpt.com/"
    });

    expect(args).toContain("--remote-debugging-address=127.0.0.1");
    expect(args).toContain("--remote-debugging-port=9333");
    expect(args).toContain("--user-data-dir=/tmp/gptprouse-profile");
    expect(args.join(" ")).not.toMatch(/cookie|token|password/i);
  });

  it("recognizes a logged-in Korean ChatGPT UI snapshot", () => {
    const text = "채팅 기록\nChatGPT\n새 채팅\n프로젝트\n홍길동\nPro\n무엇이든 편하게 시작해 보세요.";
    const buttons = ["프로필 메뉴 열기", "새 채팅", "프로젝트 홈 열기"];

    expect(inferLoggedInLikely(text, buttons)).toBe(true);
  });

  it("does not treat Korean thinking placeholders as final answers", () => {
    expect(isUsableChatGptAnswer("생각 중...")).toBe(false);
    expect(isUsableChatGptAnswer("9s 동안 생각함\n\n실제 답변입니다.")).toBe(true);
  });
});
