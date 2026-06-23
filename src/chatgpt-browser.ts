import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

export interface ChatGptBrowserOptions {
  port?: number;
  profileDir?: string;
  url?: string;
}

export interface ChatGptBrowserStatus {
  reachable: boolean;
  loggedInLikely: boolean;
  hasComposer: boolean;
  url?: string;
  title?: string;
  modelHints: string[];
  blocker?: {
    code: string;
    message: string;
    retryable: boolean;
    next_step?: string;
  };
}

export interface SendChatGptPromptOptions {
  port?: number;
  prompt: string;
  timeoutMs?: number;
}

export interface SendChatGptPromptResult {
  url: string;
  title: string;
  answer: string;
  modelHints: string[];
  warnings: string[];
}

interface ChatGptAnswerState {
  title: string;
  url: string;
  answer: string;
  modelHints: string[];
  generating: boolean;
}

interface DevtoolsPage {
  type: string;
  url: string;
  title: string;
  webSocketDebuggerUrl: string;
}

interface CdpResponse {
  id?: number;
  result?: {
    result?: {
      value?: unknown;
    };
    exceptionDetails?: unknown;
  };
  error?: {
    message?: string;
  };
}

export function defaultChatGptProfileDir(): string {
  return path.join(os.homedir(), ".local", "share", "gptprouse", "chrome-chatgpt-pro");
}

export function buildChromeLaunchArgs(options: Required<ChatGptBrowserOptions>): string[] {
  return [
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${options.port}`,
    `--user-data-dir=${options.profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    options.url
  ];
}

export function inferLoggedInLikely(text: string, visibleButtonLabels: string[] = []): boolean {
  const hasLoginPrompt =
    text.includes("Sign up for free") ||
    text.includes("Log in") ||
    text.includes("로그인") ||
    text.includes("무료로 가입");
  const hasNewChat = text.includes("New chat") || text.includes("새 채팅");
  const hasProjectNav = text.includes("Projects") || text.includes("프로젝트");
  const hasProfileButton = visibleButtonLabels.some((label) => /profile|account|프로필|계정/i.test(label));
  const hasPlanHint = /\bPro\b|Plus|Team|Enterprise|매우 높음|Extra High/i.test(text);
  return !hasLoginPrompt && hasNewChat && (hasProfileButton || hasProjectNav || hasPlanHint);
}

export function isUsableChatGptAnswer(answer: string): boolean {
  const normalized = answer.trim();
  if (!normalized) return false;
  if (/^(생각 중|thinking|thought for|thought about)/i.test(normalized.replace(/\.+$/, ""))) {
    return normalized.split(/\r?\n/).filter(Boolean).length > 1;
  }
  return true;
}

export function openChatGptBrowser(options: ChatGptBrowserOptions = {}): { command: string; args: string[]; profileDir: string; port: number } {
  const command = resolveChromeCommand();
  const port = options.port ?? 9333;
  const profileDir = options.profileDir ?? defaultChatGptProfileDir();
  const args = buildChromeLaunchArgs({
    port,
    profileDir,
    url: options.url ?? "https://chatgpt.com/"
  });
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
  return { command, args, profileDir, port };
}

export async function getChatGptBrowserStatus(options: { port?: number; timeoutMs?: number } = {}): Promise<ChatGptBrowserStatus> {
  const port = options.port ?? 9333;
  const page = await findChatGptPage(port, options.timeoutMs ?? 1500);
  if (!page.ok) {
    return {
      reachable: false,
      loggedInLikely: false,
      hasComposer: false,
      modelHints: [],
      blocker: page.blocker
    };
  }
  if (!page.page) {
    return {
      reachable: true,
      loggedInLikely: false,
      hasComposer: false,
      modelHints: [],
      blocker: {
        code: "chatgpt_page_missing",
        message: "Chrome debug port is reachable, but no chatgpt.com tab is open.",
        retryable: true,
        next_step: "Open https://chatgpt.com/ in the dedicated Chrome profile."
      }
    };
  }
  const state = await evaluateOnPage<{
    title: string;
    url: string;
    loggedInLikely: boolean;
    hasComposer: boolean;
    modelHints: string[];
  }>(page.page, statusExpression());
  return {
    reachable: true,
    loggedInLikely: state.loggedInLikely,
    hasComposer: state.hasComposer,
    url: state.url,
    title: state.title,
    modelHints: state.modelHints
  };
}

export async function sendChatGptPrompt(options: SendChatGptPromptOptions): Promise<SendChatGptPromptResult> {
  const port = options.port ?? 9333;
  const timeoutMs = options.timeoutMs ?? 90_000;
  const pageResult = await findChatGptPage(port, 1500);
  if (!pageResult.ok) {
    throw new Error(pageResult.blocker?.message ?? "ChatGPT browser page is not available");
  }
  if (!pageResult.page) {
    throw new Error("Chrome debug port is reachable, but no chatgpt.com tab is open.");
  }
  const page = pageResult.page;
  const status = await evaluateOnPage<{ loggedInLikely: boolean; hasComposer: boolean; modelHints: string[] }>(page, statusExpression());
  if (!status.loggedInLikely || !status.hasComposer) {
    throw new Error("ChatGPT browser is reachable, but it is not logged in with an active composer.");
  }
  const cdp = await connectCdp(page.webSocketDebuggerUrl);
  try {
    await cdp.send("Runtime.enable");
    const focused = await cdp.evaluate<{ ok: boolean; reason?: string }>(focusComposerExpression());
    if (!focused.ok) throw new Error(focused.reason ?? "Could not focus ChatGPT composer");
    await cdp.send("Input.insertText", { text: options.prompt });
    await sleep(300);
    const submitted = await cdp.evaluate<{ ok: boolean }>(submitExpression());
    if (!submitted.ok) {
      await cdp.send("Input.dispatchKeyEvent", enterKeyEvent("keyDown"));
      await cdp.send("Input.dispatchKeyEvent", enterKeyEvent("keyUp"));
    }
  } finally {
    cdp.close();
  }

  const started = Date.now();
  let finalState: ChatGptAnswerState | undefined;
  while (Date.now() - started < timeoutMs) {
    await sleep(1000);
    finalState = await evaluateOnPage<ChatGptAnswerState>(page, answerExpression());
    if (isUsableChatGptAnswer(finalState.answer) && !finalState.generating) break;
  }
  const completed = finalState;
  if (!completed || !isUsableChatGptAnswer(completed.answer)) {
    throw new Error("Timed out waiting for ChatGPT response.");
  }
  return {
    url: completed.url,
    title: completed.title,
    answer: completed.answer.trim(),
    modelHints: completed.modelHints,
    warnings: []
  };
}

async function findChatGptPage(
  port: number,
  timeoutMs: number
): Promise<{ ok: true; page?: DevtoolsPage } | { ok: false; blocker: ChatGptBrowserStatus["blocker"] }> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const pages = (await response.json()) as DevtoolsPage[];
    return { ok: true, page: pages.find((page) => page.type === "page" && page.url.includes("chatgpt.com")) };
  } catch (error) {
    return {
      ok: false,
      blocker: {
        code: "browser_unreachable",
        message: `No Chrome DevTools endpoint is reachable on 127.0.0.1:${port}.`,
        retryable: true,
        next_step: "Run `gptprouse chatgpt open`, log in, then retry.",
        ...(error instanceof Error ? { detail: error.message } : {})
      } as ChatGptBrowserStatus["blocker"]
    };
  }
}

async function evaluateOnPage<T>(page: DevtoolsPage, expression: string): Promise<T> {
  const cdp = await connectCdp(page.webSocketDebuggerUrl);
  try {
    await cdp.send("Runtime.enable");
    return await cdp.evaluate<T>(expression);
  } finally {
    cdp.close();
  }
}

async function connectCdp(webSocketUrl: string): Promise<{
  send: (method: string, params?: Record<string, unknown>) => Promise<CdpResponse>;
  evaluate: <T>(expression: string) => Promise<T>;
  close: () => void;
}> {
  const ws = new WebSocket(webSocketUrl);
  let id = 0;
  const pending = new Map<number, (value: CdpResponse) => void>();
  ws.addEventListener("message", (event) => {
    const data = typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer).toString("utf8");
    const message = JSON.parse(data) as CdpResponse;
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)!(message);
      pending.delete(message.id);
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("Chrome DevTools websocket failed")), { once: true });
  });
  const send = (method: string, params: Record<string, unknown> = {}) => {
    const messageId = ++id;
    ws.send(JSON.stringify({ id: messageId, method, params }));
    return new Promise<CdpResponse>((resolve) => pending.set(messageId, resolve));
  };
  const evaluate = async <T>(expression: string) => {
    const response = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (response.error?.message) throw new Error(response.error.message);
    if (response.result?.exceptionDetails) throw new Error("Runtime.evaluate failed");
    return response.result?.result?.value as T;
  };
  return { send, evaluate, close: () => ws.close() };
}

function statusExpression(): string {
  return `(() => {
    const text = document.body?.innerText || "";
    const lines = text.split(String.fromCharCode(10)).map((line) => line.trim()).filter(Boolean);
    const visibleButtonLabels = [...document.querySelectorAll('button,a,[role="button"]')]
      .filter((el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length))
      .map((el) => (el.innerText || el.getAttribute("aria-label") || el.getAttribute("data-testid") || "").trim())
      .filter(Boolean);
    const hasComposer = [...document.querySelectorAll('div[role="textbox"], textarea, [contenteditable="true"]')]
      .some((el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const hasLoginPrompt = text.includes("Sign up for free") || text.includes("Log in") || text.includes("로그인") || text.includes("무료로 가입");
    const hasNewChat = text.includes("New chat") || text.includes("새 채팅");
    const hasProjectNav = text.includes("Projects") || text.includes("프로젝트");
    const hasProfileButton = visibleButtonLabels.some((label) => /profile|account|프로필|계정/i.test(label));
    const hasPlanHint = /\\bPro\\b|Plus|Team|Enterprise|매우 높음|Extra High/i.test(text);
    return {
      title: document.title,
      url: location.href,
      loggedInLikely: !hasLoginPrompt && hasNewChat && (hasProfileButton || hasProjectNav || hasPlanHint),
      hasComposer,
      modelHints: lines.filter((line) => /GPT|Pro|Thinking|ChatGPT|Extra High|Auto/i.test(line)).slice(0, 30)
    };
  })()`;
}

function focusComposerExpression(): string {
  return `(() => {
    const el = [...document.querySelectorAll('div[role="textbox"], textarea, [contenteditable="true"]')]
      .find((node) => !!(node.offsetWidth || node.offsetHeight || node.getClientRects().length));
    if (!el) return { ok: false, reason: "No visible composer" };
    el.focus();
    return { ok: true };
  })()`;
}

function submitExpression(): string {
  return `(() => {
    const button = [...document.querySelectorAll('button')].find((node) => {
      const label = (node.innerText || node.getAttribute("aria-label") || node.getAttribute("data-testid") || "").toLowerCase();
      return !node.disabled && (label.includes("send") || label.includes("submit") || node.getAttribute("data-testid") === "send-button");
    });
    if (!button) return { ok: false };
    button.click();
    return { ok: true };
  })()`;
}

function answerExpression(): string {
  return `(() => {
    const text = document.body?.innerText || "";
    const lines = text.split(String.fromCharCode(10)).map((line) => line.trim()).filter(Boolean);
    const messages = [...document.querySelectorAll('[data-message-author-role]')].map((node) => ({
      role: node.getAttribute('data-message-author-role'),
      text: node.innerText || ""
    }));
    const assistant = messages.filter((message) => message.role === "assistant").at(-1);
    const buttons = [...document.querySelectorAll('button,[role="button"]')]
      .map((node) => (node.innerText || node.getAttribute("aria-label") || node.getAttribute("data-testid") || "").trim())
      .filter(Boolean);
    const answer = assistant?.text || "";
    const placeholder = /^(생각 중|thinking|thought for|thought about)/i.test(answer.trim().replace(/\\.+$/, ""));
    return {
      title: document.title,
      url: location.href,
      answer: answer || text.slice(-4000),
      generating: placeholder || buttons.some((label) => /stop|cancel|중지|취소|응답 중지/i.test(label)),
      modelHints: lines.filter((line) => /GPT|Pro|Thinking|ChatGPT|Extra High|Auto/i.test(line)).slice(0, 30)
    };
  })()`;
}

function enterKeyEvent(type: "keyDown" | "keyUp"): Record<string, unknown> {
  return { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
}

function resolveChromeCommand(): string {
  const fromEnv = process.env.GPTPROUSE_CHROME;
  if (fromEnv) return fromEnv;
  for (const command of ["google-chrome", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"]) {
    const result = spawnSync("which", [command], { stdio: "ignore" });
    if (result.status === 0) return command;
  }
  throw new Error("Could not find Chrome/Chromium. Set GPTPROUSE_CHROME to the browser executable.");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
