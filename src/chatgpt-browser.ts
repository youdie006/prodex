import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
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
  targetUrl?: string;
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
  assistantMessageCount: number;
  userMessageCount: number;
  textSample: string;
  blockerTextSample: string;
  visibleButtonLabels: string[];
}

interface ChatGptPageStatus {
  loggedInLikely: boolean;
  hasComposer: boolean;
  modelHints: string[];
  url: string;
  visibilityState: string;
  textSample: string;
  visibleButtonLabels: string[];
}

export const CHATGPT_RUNTIME_BLOCKER_TEXT_EXCLUDED_ANCESTORS =
  '[data-message-author-role],script,style,noscript,[aria-hidden="true"],div[role="textbox"],textarea,[contenteditable="true"]';

export interface DevtoolsPage {
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

const MAX_PAGE_DISCOVERY_TIMEOUT_MS = 5_000;
const PAGE_VISIBILITY_PROBE_TIMEOUT_MS = 1_000;

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

export function hasFreshChatGptAnswer(
  previousAssistantMessageCount: number,
  state: Pick<ChatGptAnswerState, "answer" | "assistantMessageCount" | "generating">
): boolean {
  return state.assistantMessageCount > previousAssistantMessageCount && isUsableChatGptAnswer(state.answer) && !state.generating;
}

export function isLikelyChatGptSubmitButton(label: string, dataTestId: string | null): boolean {
  const normalized = label.trim().toLowerCase();
  return dataTestId === "send-button" || /\b(send|submit)\b|보내기|전송/.test(normalized);
}

export function detectChatGptBlocker(
  text: string,
  visibleButtonLabels: string[] = []
): ChatGptBrowserStatus["blocker"] | undefined {
  const haystack = `${text}\n${visibleButtonLabels.join("\n")}`.toLowerCase();
  if (/just a moment|checking if the site connection is secure|verify you are human|잠시만 기다려|연결이 안전한지/i.test(haystack)) {
    return {
      code: "cloudflare_check",
      message: "ChatGPT is showing a Cloudflare or human-verification interstitial.",
      retryable: true,
      next_step: "Complete the visible browser check manually, then retry."
    };
  }
  if (hasLikelyChatGptLoginPrompt(haystack)) {
    return {
      code: "login_required",
      message: "ChatGPT is asking you to log in.",
      retryable: true,
      next_step: "Log in manually in the visible browser, then retry."
    };
  }
  if (/captcha|robot|로봇|사람인지|자동화|보안문자/i.test(haystack)) {
    return {
      code: "captcha_required",
      message: "ChatGPT is asking for captcha or human verification.",
      retryable: true,
      next_step: "Solve it manually in the visible browser, then retry."
    };
  }
  if (/message limit|usage limit|rate limit|you.?ve reached|try again later|limit resets|사용 한도|메시지 한도|요금 제한|나중에 다시/i.test(haystack)) {
    return {
      code: "usage_limit",
      message: "ChatGPT is reporting a usage, message, model, or rate limit.",
      retryable: true,
      next_step: "Wait for the limit to reset or choose an available model in the browser."
    };
  }
  if (/additional verification|required verification|verify your account|permission required|account verification|권한|추가 인증|계정 인증|인증 필요/i.test(haystack)) {
    return {
      code: "permission_required",
      message: "ChatGPT requires account verification or permission handling.",
      retryable: true,
      next_step: "Complete the visible account or permission prompt manually, then retry."
    };
  }
  return undefined;
}

function hasLikelyChatGptLoginPrompt(haystack: string): boolean {
  const hasSpecificSignup = /sign up for free|무료로 가입/i.test(haystack);
  const hasLogin = /\blog in\b|로그인/i.test(haystack);
  const hasSignup = /\bsign up\b|가입/i.test(haystack);
  const hasSessionPrompt = /log in to|login to|sign in to|session expired|logged out|다시 로그인|로그인이 필요/i.test(haystack);
  return hasSpecificSignup || (hasLogin && hasSignup) || hasSessionPrompt;
}

export function chatGptBlockerErrorFromAnswerState(state: {
  textSample: string;
  blockerTextSample?: string;
  visibleButtonLabels: string[];
}): string | undefined {
  return formatBlockerError(detectChatGptBlocker(state.blockerTextSample ?? state.textSample, state.visibleButtonLabels));
}

export function computePromptAcceptanceDeadline(timeoutMs: number, startedAt: number): number {
  return startedAt + Math.max(1, timeoutMs);
}

export function computePageDiscoveryTimeout(timeoutMs: number): number {
  return Math.max(1, Math.min(timeoutMs, MAX_PAGE_DISCOVERY_TIMEOUT_MS));
}

export function normalizeChatGptTargetUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Target URL must be a ChatGPT web URL.");
  }
  if (url.protocol !== "https:" || url.hostname !== "chatgpt.com") {
    throw new Error("Target URL must be a ChatGPT web URL.");
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString();
}

export function chatGptUrlsReferToSameTarget(currentUrl: string, expectedUrl: string): boolean {
  try {
    return normalizeChatGptTargetUrl(currentUrl) === normalizeChatGptTargetUrl(expectedUrl);
  } catch {
    return false;
  }
}

export function selectChatGptPage(
  pages: DevtoolsPage[],
  targetUrl?: string,
  visibilityByPage = new Map<string, string>()
): DevtoolsPage | undefined {
  const chatGptPages = pages.filter((page) => page.type === "page" && isChatGptPageUrl(page.url));
  if (!targetUrl) {
    return chatGptPages.find((page) => visibilityByPage.get(page.webSocketDebuggerUrl) === "visible") ?? chatGptPages[0];
  }
  const targetMatches = chatGptPages.filter((page) => chatGptUrlsReferToSameTarget(page.url, targetUrl));
  return targetMatches.find((page) => visibilityByPage.get(page.webSocketDebuggerUrl) === "visible") ?? targetMatches[0];
}

export function assertVisibleChatGptTab(visibilityState: string, url: string, targetUrl?: string): void {
  if (visibilityState === "visible") return;
  if (targetUrl) {
    throw new Error(`Confirmed ChatGPT target is open but not the active visible tab. Select ${targetUrl} in the dedicated browser and retry.`);
  }
  throw new Error(`Selected ChatGPT tab is not the active visible tab. Select ${url} in the dedicated browser or pass --target-url with --confirm-target.`);
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
    textSample: string;
    visibleButtonLabels: string[];
  }>(page.page, statusExpression());
  const blocker = detectChatGptBlocker(state.textSample, state.visibleButtonLabels);
  return {
    reachable: true,
    loggedInLikely: state.loggedInLikely,
    hasComposer: state.hasComposer,
    url: state.url,
    title: state.title,
    modelHints: state.modelHints,
    blocker
  };
}

export async function sendChatGptPrompt(options: SendChatGptPromptOptions): Promise<SendChatGptPromptResult> {
  const port = options.port ?? 9333;
  const timeoutMs = options.timeoutMs ?? 90_000;
  const normalizedTargetUrl = options.targetUrl ? normalizeChatGptTargetUrl(options.targetUrl) : undefined;
  const pageResult = await findChatGptPage(port, computePageDiscoveryTimeout(timeoutMs), normalizedTargetUrl);
  if (!pageResult.ok) {
    throw new Error(formatBlockerError(pageResult.blocker) ?? "ChatGPT browser page is not available");
  }
  if (!pageResult.page) {
    if (normalizedTargetUrl) {
      throw new Error(`No open ChatGPT tab matches the confirmed target URL. Open ${normalizedTargetUrl} in the dedicated browser and retry.`);
    }
    throw new Error("Chrome debug port is reachable, but no chatgpt.com tab is open.");
  }
  const page = pageResult.page;
  const status = await evaluateOnPage<ChatGptPageStatus>(page, statusExpression());
  const blocker = detectChatGptBlocker(status.textSample, status.visibleButtonLabels);
  if (blocker) {
    throw new Error(`${blocker.message}${blocker.next_step ? ` Next: ${blocker.next_step}` : ""}`);
  }
  if (!status.loggedInLikely || !status.hasComposer) {
    throw new Error("ChatGPT browser is reachable, but it is not logged in with an active composer.");
  }
  if (normalizedTargetUrl && !chatGptUrlsReferToSameTarget(status.url, normalizedTargetUrl)) {
    throw new Error(
      `ChatGPT tab is not at the confirmed target URL. Open ${normalizedTargetUrl} in the visible browser and retry. Current: ${status.url}`
    );
  }
  assertVisibleChatGptTab(status.visibilityState, status.url, normalizedTargetUrl);
  const beforeSubmit = await evaluateOnPage<ChatGptAnswerState>(page, answerExpression());
  const cdp = await connectCdp(page.webSocketDebuggerUrl);
  try {
    await cdp.send("Runtime.enable");
    const inserted = await cdp.evaluate<{ ok: boolean; reason?: string; actualText?: string }>(setComposerTextExpression(options.prompt));
    if (!inserted.ok) throw new Error(inserted.reason ?? "Could not insert text into ChatGPT composer");
    await sleep(300);
    const submitted = await cdp.evaluate<{ ok: boolean; reason?: string }>(submitExpression());
    if (!submitted.ok) {
      await cdp.send("Input.dispatchKeyEvent", enterKeyEvent("keyDown"));
      await cdp.send("Input.dispatchKeyEvent", enterKeyEvent("keyUp"));
    }
  } finally {
    cdp.close();
  }

  const started = Date.now();
  const acceptDeadline = computePromptAcceptanceDeadline(timeoutMs, started);
  let accepted = false;
  let finalState: ChatGptAnswerState | undefined;
  while (Date.now() < acceptDeadline) {
    await sleep(500);
    finalState = await evaluateOnPage<ChatGptAnswerState>(page, answerExpression());
    const runtimeBlocker = chatGptBlockerErrorFromAnswerState(finalState);
    if (runtimeBlocker) throw new Error(runtimeBlocker);
    if (
      finalState.userMessageCount > beforeSubmit.userMessageCount ||
      finalState.assistantMessageCount > beforeSubmit.assistantMessageCount ||
      finalState.generating
    ) {
      accepted = true;
      break;
    }
  }
  if (!accepted) {
    throw new Error("Timed out waiting for ChatGPT to accept the prompt.");
  }

  while (Date.now() - started < timeoutMs) {
    await sleep(1000);
    finalState = await evaluateOnPage<ChatGptAnswerState>(page, answerExpression());
    const runtimeBlocker = chatGptBlockerErrorFromAnswerState(finalState);
    if (runtimeBlocker) throw new Error(runtimeBlocker);
    if (hasFreshChatGptAnswer(beforeSubmit.assistantMessageCount, finalState)) break;
  }
  const completed = finalState;
  if (!completed || !hasFreshChatGptAnswer(beforeSubmit.assistantMessageCount, completed)) {
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
  timeoutMs: number,
  targetUrl?: string
): Promise<{ ok: true; page?: DevtoolsPage } | { ok: false; blocker: ChatGptBrowserStatus["blocker"] }> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const pages = (await response.json()) as DevtoolsPage[];
    const visibilityByPage = await getChatGptPageVisibility(pages);
    return { ok: true, page: selectChatGptPage(pages, targetUrl, visibilityByPage) };
  } catch (error) {
    return {
      ok: false,
      blocker: {
        code: "browser_unreachable",
        message: `No Chrome DevTools endpoint is reachable on 127.0.0.1:${port}.`,
        retryable: true,
        next_step: "Run `gptprouse pro browser login`, log in, then retry.",
        ...(error instanceof Error ? { detail: error.message } : {})
      } as ChatGptBrowserStatus["blocker"]
    };
  }
}

async function getChatGptPageVisibility(pages: DevtoolsPage[]): Promise<Map<string, string>> {
  const visibilityByPage = new Map<string, string>();
  await Promise.all(
    pages
      .filter((page) => page.type === "page" && isChatGptPageUrl(page.url))
      .map(async (page) => {
        try {
          visibilityByPage.set(
            page.webSocketDebuggerUrl,
            await evaluateOnPage<string>(page, "document.visibilityState", { timeoutMs: PAGE_VISIBILITY_PROBE_TIMEOUT_MS })
          );
        } catch {
          // A stale DevTools page should not prevent falling back to the first ChatGPT tab.
        }
      })
  );
  return visibilityByPage;
}

function isChatGptPageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "chatgpt.com";
  } catch {
    return false;
  }
}

function formatBlockerError(blocker: ChatGptBrowserStatus["blocker"] | undefined): string | undefined {
  if (!blocker) return undefined;
  return `${blocker.message}${blocker.next_step ? ` Next: ${blocker.next_step}` : ""}`;
}

async function evaluateOnPage<T>(page: DevtoolsPage, expression: string, options: { timeoutMs?: number } = {}): Promise<T> {
  const cdp = await connectCdp(page.webSocketDebuggerUrl, options.timeoutMs);
  try {
    await cdp.send("Runtime.enable");
    return await cdp.evaluate<T>(expression);
  } finally {
    cdp.close();
  }
}

async function connectCdp(webSocketUrl: string, timeoutMs?: number): Promise<{
  send: (method: string, params?: Record<string, unknown>) => Promise<CdpResponse>;
  evaluate: <T>(expression: string) => Promise<T>;
  close: () => void;
}> {
  const ws = new WebSocket(webSocketUrl);
  let id = 0;
  const pending = new Map<
    number,
    { resolve: (value: CdpResponse) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> }
  >();
  ws.addEventListener("message", (event) => {
    const data = typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer).toString("utf8");
    const message = JSON.parse(data) as CdpResponse;
    if (message.id && pending.has(message.id)) {
      const waiter = pending.get(message.id)!;
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(message);
      pending.delete(message.id);
    }
  });
  ws.addEventListener("close", () => {
    for (const [messageId, waiter] of pending) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(new Error("Chrome DevTools websocket closed"));
      pending.delete(messageId);
    }
  });
  await new Promise<void>((resolve, reject) => {
    const timer = timeoutMs
      ? setTimeout(() => {
          ws.close();
          reject(new Error("Chrome DevTools websocket timed out"));
        }, Math.max(1, timeoutMs))
      : undefined;
    ws.addEventListener(
      "open",
      () => {
        if (timer) clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
    ws.addEventListener(
      "error",
      () => {
        if (timer) clearTimeout(timer);
        reject(new Error("Chrome DevTools websocket failed"));
      },
      { once: true }
    );
  });
  const send = (method: string, params: Record<string, unknown> = {}) => {
    const messageId = ++id;
    return new Promise<CdpResponse>((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            pending.delete(messageId);
            ws.close();
            reject(new Error(`Chrome DevTools command timed out: ${method}`));
          }, Math.max(1, timeoutMs))
        : undefined;
      pending.set(messageId, { resolve, reject, timer });
      ws.send(JSON.stringify({ id: messageId, method, params }));
    });
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
      visibilityState: document.visibilityState,
      textSample: text.slice(0, 12000),
      visibleButtonLabels,
      loggedInLikely: !hasLoginPrompt && hasNewChat && (hasProfileButton || hasProjectNav || hasPlanHint),
      hasComposer,
      modelHints: lines.filter((line) => /GPT|Pro|Thinking|ChatGPT|Extra High|Auto/i.test(line)).slice(0, 30)
    };
  })()`;
}

function setComposerTextExpression(text: string): string {
  const serializedText = JSON.stringify(text);
  return `(() => {
    const el = [...document.querySelectorAll('div[role="textbox"], textarea, [contenteditable="true"]')]
      .find((node) => !!(node.offsetWidth || node.offsetHeight || node.getClientRects().length));
    if (!el) return { ok: false, reason: "No visible composer" };
    el.focus();
    const text = ${serializedText};
    const dispatchInput = () => {
      el.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: text, bubbles: true, composed: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };
    if ("value" in el) {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(el, text);
      else el.value = text;
      dispatchInput();
    } else {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.deleteContents();
      range.collapse(true);
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.execCommand("insertText", false, text);
      const current = el.innerText || el.textContent || "";
      if (!current.trim()) {
        el.textContent = text;
        dispatchInput();
      }
    }
    const actualText = ("value" in el ? el.value : el.innerText || el.textContent || "").trim();
    return actualText ? { ok: true, actualText: actualText.slice(0, 120) } : { ok: false, reason: "Composer stayed empty after text insertion" };
  })()`;
}

function submitExpression(): string {
  return `(() => {
    const button = [...document.querySelectorAll('button')].find((node) => {
      const label = (node.innerText || node.getAttribute("aria-label") || node.getAttribute("data-testid") || "").toLowerCase();
      const dataTestId = node.getAttribute("data-testid");
      return !node.disabled && node.getAttribute("aria-disabled") !== "true" && (dataTestId === "send-button" || /\\b(send|submit)\\b|보내기|전송/.test(label));
    });
    if (!button) return { ok: false, reason: "No enabled submit button" };
    button.click();
    return { ok: true };
  })()`;
}

function answerExpression(): string {
  const excludedTextSelector = JSON.stringify(CHATGPT_RUNTIME_BLOCKER_TEXT_EXCLUDED_ANCESTORS);
  return `(() => {
    const text = document.body?.innerText || "";
    const excludedTextSelector = ${excludedTextSelector};
    const visibleTextOutsideMessages = () => {
      if (!document.body) return "";
      const parts = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const parent = node.parentElement;
        const value = node.nodeValue?.trim();
        if (!parent || !value) continue;
        if (parent.closest(excludedTextSelector)) continue;
        const style = window.getComputedStyle(parent);
        if (style.display === "none" || style.visibility === "hidden") continue;
        if (!(parent.offsetWidth || parent.offsetHeight || parent.getClientRects().length)) continue;
        parts.push(value);
      }
      return parts.join(String.fromCharCode(10));
    };
    const lines = text.split(String.fromCharCode(10)).map((line) => line.trim()).filter(Boolean);
    const messages = [...document.querySelectorAll('[data-message-author-role]')].map((node) => ({
      role: node.getAttribute('data-message-author-role'),
      text: node.innerText || ""
    }));
    const assistantMessages = messages.filter((message) => message.role === "assistant");
    const userMessages = messages.filter((message) => message.role === "user");
    const assistant = assistantMessages.at(-1);
    const buttons = [...document.querySelectorAll('button,[role="button"]')]
      .filter((node) => !!(node.offsetWidth || node.offsetHeight || node.getClientRects().length))
      .map((node) => (node.innerText || node.getAttribute("aria-label") || node.getAttribute("data-testid") || "").trim())
      .filter(Boolean);
    const answer = assistant?.text || "";
    const placeholder = /^(생각 중|thinking|thought for|thought about)/i.test(answer.trim().replace(/\\.+$/, ""));
    return {
      title: document.title,
      url: location.href,
      answer: answer || text.slice(-4000),
      textSample: text.slice(0, 12000),
      blockerTextSample: visibleTextOutsideMessages().slice(0, 12000),
      visibleButtonLabels: buttons,
      generating: placeholder || buttons.some((label) => /stop|cancel|중지|취소|응답 중지/i.test(label)),
      assistantMessageCount: assistantMessages.length,
      userMessageCount: userMessages.length,
      modelHints: lines.filter((line) => /GPT|Pro|Thinking|ChatGPT|Extra High|Auto/i.test(line)).slice(0, 30)
    };
  })()`;
}

function enterKeyEvent(type: "keyDown" | "keyUp"): Record<string, unknown> {
  return { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
}

function resolveChromeCommand(): string {
  const fromEnv = process.env.GPTPROUSE_CHROME;
  if (fromEnv) {
    assertChromeCommandAvailable(fromEnv, "GPTPROUSE_CHROME");
    return fromEnv;
  }
  for (const command of ["google-chrome", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"]) {
    if (isCommandOnPath(command) && hasChromeLikeVersion(command)) return command;
  }
  throw new Error("Could not find Chrome/Chromium. Set GPTPROUSE_CHROME to the browser executable.");
}

function assertChromeCommandAvailable(command: string, label: string): void {
  if (isPathLikeCommand(command)) {
    try {
      if (!statSync(command).isFile()) {
        throw new Error("not a file");
      }
      accessSync(command, constants.X_OK);
    } catch {
      throw new Error(`${label} does not point to an executable browser: ${command}`);
    }
  } else if (!isCommandOnPath(command)) {
    throw new Error(`${label} browser command was not found on PATH: ${command}`);
  }
  assertChromeLikeVersion(command, label);
}

function isPathLikeCommand(command: string): boolean {
  return path.isAbsolute(command) || command.includes("/") || command.includes("\\");
}

function isCommandOnPath(command: string): boolean {
  const lookup = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(lookup, [command], { stdio: "ignore" });
  return result.status === 0;
}

function assertChromeLikeVersion(command: string, label: string): void {
  if (!hasChromeLikeVersion(command)) {
    throw new Error(`${label} must point to a Chrome/Chromium-compatible browser executable: ${command}`);
  }
}

function hasChromeLikeVersion(command: string): boolean {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    timeout: 3000,
    maxBuffer: 1024 * 1024
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return !result.error && result.status === 0 && /Chrome|Chromium|Brave|Microsoft Edge/i.test(output);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
