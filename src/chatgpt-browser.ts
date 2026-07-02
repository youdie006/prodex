import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export interface ChatGptBrowserOptions {
  port?: number;
  profileDir?: string;
  url?: string;
}

export interface ChatGptBrowserLaunch {
  command: string;
  args: string[];
  profileDir: string;
  port: number;
  waitForEarlyExit: (timeoutMs?: number) => Promise<ChatGptBrowserEarlyExit | undefined>;
}

export interface ChatGptBrowserEarlyExit {
  code?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
}

export interface ChatGptBrowserStatus {
  reachable: boolean;
  loggedInLikely: boolean;
  hasComposer: boolean;
  visibilityState?: string;
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

export class ChatGptBrowserBlockerError extends Error {
  readonly blocker: NonNullable<ChatGptBrowserStatus["blocker"]>;

  constructor(blocker: NonNullable<ChatGptBrowserStatus["blocker"]>) {
    super(formatBlockerError(blocker) ?? blocker.message);
    this.name = "ChatGptBrowserBlockerError";
    this.blocker = blocker;
  }
}

export type ChatGptReasoningEffort = "즉시" | "중간" | "높음" | "매우 높음";
export type ChatGptProMode = "기본" | "확장";

const REASONING_EFFORTS: readonly ChatGptReasoningEffort[] = ["즉시", "중간", "높음", "매우 높음"];
const PRO_MODES: readonly ChatGptProMode[] = ["기본", "확장"];

// Aliases map friendly CLI input onto the exact Korean menu labels the picker
// clicks by text. Keys are lowercased and space-stripped before lookup.
const REASONING_EFFORT_ALIASES: Record<string, ChatGptReasoningEffort> = {
  "매우높음": "매우 높음",
  instant: "즉시",
  medium: "중간",
  high: "높음",
  max: "매우 높음"
};

const PRO_MODE_ALIASES: Record<string, ChatGptProMode> = {
  standard: "기본",
  extended: "확장"
};

/** Normalize a CLI reasoning-effort value onto the exact ChatGPT menu label. */
export function parseReasoningEffort(raw: string): ChatGptReasoningEffort {
  const trimmed = raw.trim();
  const match = REASONING_EFFORTS.find((effort) => effort === trimmed);
  if (match) return match;
  const alias = REASONING_EFFORT_ALIASES[trimmed.toLowerCase().replace(/\s+/g, "")];
  if (alias) return alias;
  throw new Error(`--effort must be one of ${REASONING_EFFORTS.join(", ")}`);
}

/** Normalize a CLI Pro sub-mode value onto the exact ChatGPT menu label. */
export function parseProMode(raw: string): ChatGptProMode {
  const trimmed = raw.trim();
  const match = PRO_MODES.find((mode) => mode === trimmed);
  if (match) return match;
  const alias = PRO_MODE_ALIASES[trimmed.toLowerCase().replace(/\s+/g, "")];
  if (alias) return alias;
  throw new Error(`--pro-mode must be one of ${PRO_MODES.join(", ")}`);
}

export interface SendChatGptPromptOptions {
  port?: number;
  prompt: string;
  targetUrl?: string;
  timeoutMs?: number;
  /** Switch into this sidebar project (by visible name) before sending. */
  project?: string;
  /** Create a new project with this name before sending. */
  projectNew?: string;
  /** Model to select in the composer picker, e.g. "Pro" or "GPT-5.5". */
  model?: string;
  /** Pro sub-mode, used when model is Pro. */
  proMode?: ChatGptProMode;
  /** Reasoning effort, used for non-Pro models. */
  effort?: ChatGptReasoningEffort;
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

export interface ChatGptPageTextState {
  textSample: string;
  blockerTextSample?: string;
  visibleButtonLabels: string[];
}

interface ChatGptPageStatus extends ChatGptPageTextState {
  title: string;
  hasComposer: boolean;
  generating: boolean;
  modelHints: string[];
  url: string;
  visibilityState: string;
}

export const CHATGPT_RUNTIME_BLOCKER_TEXT_EXCLUDED_ANCESTORS =
  '[data-message-author-role],script,style,noscript,[aria-hidden="true"],div[role="textbox"],textarea,[contenteditable="true"]';
export const CHATGPT_COMPOSER_CANDIDATE_EXCLUDED_ANCESTORS = '[data-message-author-role],script,style,noscript,[aria-hidden="true"]';
export const PRODEX_ACTIVE_COMPOSER_ATTRIBUTE = "data-prodex-active-composer";

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
const CHATGPT_GENERATING_CONTROL_PATTERN = /\bstop\s+(?:generating|responding|response)\b|응답\s*중지|생성\s*중지/i;

export function defaultChatGptProfileDir(): string {
  return path.join(os.homedir(), ".local", "share", "prodex", "chrome-chatgpt-pro");
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
  // Only sign-up prompts and explicit login/sign-up buttons count as logged-out signals. Bare
  // "Log in"/"로그인" substrings appear in the menus and footers of a logged-in page, so matching
  // them against the full page text falsely reported logged-in Pro users as logged out.
  const hasLoginPrompt =
    text.includes("Sign up for free") ||
    text.includes("무료로 가입") ||
    visibleButtonLabels.some((label) => /^(log in|sign up|로그인|회원가입)$/i.test(label.trim()));
  const hasNewChat = text.includes("New chat") || text.includes("새 채팅");
  const hasProjectNav = text.includes("Projects") || text.includes("프로젝트");
  const hasProfileButton = visibleButtonLabels.some((label) => /profile|account|프로필|계정/i.test(label));
  const hasPlanHint = /\bPro\b|Plus|Team|Enterprise|매우 높음|Extra High/i.test(text);
  return !hasLoginPrompt && hasNewChat && (hasProfileButton || hasProjectNav || hasPlanHint);
}

export function isUsableChatGptAnswer(answer: string): boolean {
  const normalized = answer.trim();
  if (!normalized) return false;
  const stripped = normalized.replace(/\.+$/, "");
  const lineCount = normalized.split(/\r?\n/).filter(Boolean).length;
  if (/^(생각 중|thinking|thought for|thought about)/i.test(stripped)) {
    return lineCount > 1;
  }
  // Model-prefixed thinking status, e.g. "Pro 생각 중": a single short line
  // ending in 생각 중 is the placeholder, not an answer.
  if (lineCount <= 1 && /(^|\s)생각 중$/.test(stripped)) {
    return false;
  }
  return true;
}

export function hasFreshChatGptAnswer(
  previousAssistantMessageCount: number,
  state: Pick<ChatGptAnswerState, "answer" | "assistantMessageCount" | "generating">
): boolean {
  return state.assistantMessageCount > previousAssistantMessageCount && isUsableChatGptAnswer(state.answer) && !state.generating;
}

export function hasChatGptPromptAcceptance(
  previous: Pick<ChatGptAnswerState, "assistantMessageCount" | "userMessageCount">,
  state: Pick<ChatGptAnswerState, "assistantMessageCount" | "generating" | "userMessageCount">
): boolean {
  return state.userMessageCount > previous.userMessageCount || state.assistantMessageCount > previous.assistantMessageCount;
}

export function chatGptBusyBlocker(generating: boolean): ChatGptBrowserStatus["blocker"] | undefined {
  if (!generating) return undefined;
  return {
    code: "response_in_progress",
    message: "ChatGPT is still generating a previous response.",
    retryable: true,
    next_step: "Wait for the visible response to finish, or stop it manually in the browser, then retry."
  };
}

export function isLikelyChatGptSubmitButton(label: string, dataTestId: string | null): boolean {
  const normalized = label.trim().toLowerCase();
  return dataTestId === "send-button" || /\b(send|submit)\b|보내기|전송/.test(normalized);
}

export function isLikelyChatGptGeneratingControl(label: string): boolean {
  return CHATGPT_GENERATING_CONTROL_PATTERN.test(label.trim());
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
  // Match real captcha / human-verification phrasing only. Bare words like "robot"/"로봇"/"자동화"
  // appear in ordinary chat titles and sidebar history, so matching them on the full page text
  // wrongly flagged logged-in users as captcha-blocked.
  if (/captcha|보안문자|i'?m not a robot|verify you are (?:not a robot|human)|로봇이 아닙니다|사람인지 확인|자동화된 트래픽/i.test(haystack)) {
    return {
      code: "captcha_required",
      message: "ChatGPT is asking for captcha or human verification.",
      retryable: true,
      next_step: "Solve it manually in the visible browser, then retry."
    };
  }
  if (/message limit|usage limit|model limit|rate limit|you.?ve reached|try again later|limit resets|사용 한도|메시지 한도|모델 한도|요금 제한|나중에 다시/i.test(haystack)) {
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

export function detectChatGptPageBlocker(state: ChatGptPageTextState): ChatGptBrowserStatus["blocker"] | undefined {
  return detectChatGptBlocker(state.blockerTextSample ?? state.textSample, state.visibleButtonLabels);
}

export function inferChatGptPageLoggedInLikely(state: ChatGptPageTextState): boolean {
  return inferLoggedInLikely(state.blockerTextSample ?? state.textSample, state.visibleButtonLabels);
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
  return formatBlockerError(chatGptBlockerFromAnswerState(state));
}

export function chatGptBlockerFromAnswerState(state: {
  textSample: string;
  blockerTextSample?: string;
  visibleButtonLabels: string[];
}): ChatGptBrowserStatus["blocker"] | undefined {
  return detectChatGptPageBlocker(state);
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
  if (chatGptPageSelectionBlocker(pages, targetUrl, visibilityByPage)) return undefined;
  if (!targetUrl) {
    return (
      chatGptPages.find((page) => visibilityByPage.get(page.webSocketDebuggerUrl) === "visible") ??
      chatGptPages.find((page) => isVisibilityUnknown(page, visibilityByPage)) ??
      chatGptPages[0]
    );
  }
  const targetMatches = chatGptPages.filter((page) => chatGptUrlsReferToSameTarget(page.url, targetUrl));
  return (
    targetMatches.find((page) => visibilityByPage.get(page.webSocketDebuggerUrl) === "visible") ??
    targetMatches.find((page) => isVisibilityUnknown(page, visibilityByPage)) ??
    targetMatches[0]
  );
}

export function chatGptPageSelectionBlocker(
  pages: DevtoolsPage[],
  targetUrl?: string,
  visibilityByPage = new Map<string, string>()
): ChatGptBrowserStatus["blocker"] | undefined {
  if (targetUrl) return undefined;
  const possiblyVisibleChatGptPages = pages.filter(
    (page) => page.type === "page" && isChatGptPageUrl(page.url) && isChatGptPagePossiblyVisible(page, visibilityByPage)
  );
  if (possiblyVisibleChatGptPages.length <= 1) return undefined;
  const urls = possiblyVisibleChatGptPages
    .map((page) => `${page.url} (${visibilityByPage.get(page.webSocketDebuggerUrl) ?? "unknown"})`)
    .slice(0, 5)
    .join(", ");
  return {
    code: "ambiguous_chatgpt_tabs",
    message: `Multiple visible or unverified ChatGPT tabs or windows are available: ${urls}.`,
    retryable: true,
    next_step: "Close extra ChatGPT windows, leave only the intended tab visible, or pass --target-url with --confirm-target."
  };
}

function isChatGptPagePossiblyVisible(page: DevtoolsPage, visibilityByPage: Map<string, string>): boolean {
  const visibility = visibilityByPage.get(page.webSocketDebuggerUrl);
  return visibility === "visible" || visibility === undefined;
}

function isVisibilityUnknown(page: DevtoolsPage, visibilityByPage: Map<string, string>): boolean {
  return visibilityByPage.get(page.webSocketDebuggerUrl) === undefined;
}

export function assertVisibleChatGptTab(visibilityState: string | undefined, url: string, targetUrl?: string): void {
  if (visibilityState === "visible") return;
  const blocker = chatGptVisibilityBlocker(visibilityState, targetUrl ?? url);
  if (blocker) throw new ChatGptBrowserBlockerError(blocker);
}

export function assertChatGptTargetUrlMatches(currentUrl: string, targetUrl: string): void {
  if (chatGptUrlsReferToSameTarget(currentUrl, targetUrl)) return;
  throw new ChatGptBrowserBlockerError({
    code: "target_url_mismatch",
    message: "ChatGPT tab is not at the confirmed target URL.",
    retryable: true,
    next_step: `Open ${targetUrl} in the visible browser and retry. Current: ${currentUrl}`
  });
}

export function assertChatGptTargetTabAvailable(targetUrl: string): void {
  throw new ChatGptBrowserBlockerError({
    code: "target_tab_missing",
    message: "No open ChatGPT tab matches the confirmed target URL.",
    retryable: true,
    next_step: `Open ${targetUrl} in the dedicated browser and retry.`
  });
}

export function assertChatGptPageAvailable(): never {
  throw new ChatGptBrowserBlockerError(chatGptPageMissingBlocker());
}

function chatGptPageMissingBlocker(): NonNullable<ChatGptBrowserStatus["blocker"]> {
  return {
    code: "chatgpt_page_missing",
    message: "Chrome debug port is reachable, but no chatgpt.com tab is open.",
    retryable: true,
    next_step: "Open https://chatgpt.com/ in the dedicated Chrome profile, or run `prodex pro browser login` to reopen it."
  };
}

export function assertChatGptReadyForPrompt(loggedInLikely: boolean, hasComposer: boolean): void {
  if (loggedInLikely && hasComposer) return;
  const missing = [
    loggedInLikely ? undefined : "a clear logged-in ChatGPT session",
    hasComposer ? undefined : "a visible prompt composer"
  ].filter(Boolean);
  throw new ChatGptBrowserBlockerError({
    code: "chatgpt_not_ready",
    message: `ChatGPT browser is reachable, but it is missing ${missing.join(" and ")}.`,
    retryable: true,
    next_step: "Log in manually and open a normal chat or Project thread with the prompt composer visible, then retry."
  });
}

export function chatGptVisibilityBlocker(
  visibilityState: string | undefined,
  url: string | undefined
): ChatGptBrowserStatus["blocker"] | undefined {
  if (visibilityState === "visible") return undefined;
  const visibility = visibilityState ?? "unknown";
  return {
    code: "tab_not_visible",
    message: `Selected ChatGPT tab is ${visibility}, not the active visible tab.`,
    retryable: true,
    next_step: `Select ${url ?? "the ChatGPT tab"} in the dedicated browser, then retry.`
  };
}

export function openChatGptBrowser(options: ChatGptBrowserOptions = {}): ChatGptBrowserLaunch {
  const command = resolveChromeCommand();
  const port = options.port ?? 9333;
  const profileDir = options.profileDir ?? defaultChatGptProfileDir();
  const args = buildChromeLaunchArgs({
    port,
    profileDir,
    url: options.url ?? "https://chatgpt.com/"
  });
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  let earlyExit: ChatGptBrowserEarlyExit | undefined;
  const earlyExitWaiters = new Set<(exit: ChatGptBrowserEarlyExit) => void>();
  const recordEarlyExit = (exit: ChatGptBrowserEarlyExit) => {
    if (earlyExit) return;
    earlyExit = exit;
    for (const waiter of earlyExitWaiters) waiter(exit);
    earlyExitWaiters.clear();
  };
  child.once("exit", (code, signal) => recordEarlyExit({ code, signal }));
  child.once("error", (error) => recordEarlyExit({ error: error.message }));
  child.unref();
  return {
    command,
    args,
    profileDir,
    port,
    waitForEarlyExit: (timeoutMs = 1000) => {
      if (earlyExit) return Promise.resolve(earlyExit);
      return new Promise((resolve) => {
        const resolveExit = (exit: ChatGptBrowserEarlyExit) => {
          clearTimeout(timer);
          resolve(exit);
        };
        const timer = setTimeout(() => {
          earlyExitWaiters.delete(resolveExit);
          resolve(undefined);
        }, timeoutMs);
        earlyExitWaiters.add(resolveExit);
      });
    }
  };
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
    if (page.blocker) {
      return {
        reachable: true,
        loggedInLikely: false,
        hasComposer: false,
        modelHints: [],
        blocker: page.blocker
      };
    }
    return {
      reachable: true,
      loggedInLikely: false,
      hasComposer: false,
      modelHints: [],
      blocker: chatGptPageMissingBlocker()
    };
  }
  const state = await evaluateOnPage<ChatGptPageStatus>(page.page, statusExpression());
  const loggedInLikely = inferChatGptPageLoggedInLikely(state);
  const blocker = chatGptVisibilityBlocker(state.visibilityState, state.url) ?? detectChatGptPageBlocker(state) ?? chatGptBusyBlocker(state.generating);
  return {
    reachable: true,
    loggedInLikely,
    hasComposer: state.hasComposer,
    visibilityState: state.visibilityState,
    url: state.url,
    title: state.title,
    modelHints: state.modelHints,
    blocker
  };
}

type CdpConnection = Awaited<ReturnType<typeof connectCdp>>;

interface RectHit {
  ok: boolean;
  x?: number;
  y?: number;
  reason?: string;
  available?: string[];
  role?: string | null;
  haspopup?: string | null;
}

async function dispatchEscapeKey(cdp: CdpConnection): Promise<void> {
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
}

// Poll a boolean page expression instead of sleeping a fixed duration, so slow
// renders wait longer and fast ones do not waste time.
async function waitForExpressionTrue(cdp: CdpConnection, expression: string, timeoutMs: number, intervalMs = 150): Promise<boolean> {
  const startedAt = Date.now();
  for (;;) {
    if (await cdp.evaluate<boolean>(expression)) return true;
    if (Date.now() - startedAt >= timeoutMs) return false;
    await sleep(intervalMs);
  }
}

const MENU_OPEN_TIMEOUT_MS = 5_000;
const MENU_SETTLE_TIMEOUT_MS = 5_000;
const PROJECT_NAVIGATION_TIMEOUT_MS = 8_000;

export function menuOpenExpression(): string {
  return `Boolean(document.querySelector('[data-testid="composer-intelligence-picker-content"]'))`;
}

export function menuClosedExpression(): string {
  return `!document.querySelector('[data-testid="composer-intelligence-picker-content"]')`;
}

export function menuItemPresentExpression(label: string): string {
  return `[...document.querySelectorAll('[role="menuitemradio"],[role="menuitem"]')].some((r) => (r.textContent || "").trim() === ${JSON.stringify(label)})`;
}

// Shared click-point resolver: scroll the target into view, tag it with a
// temporary attribute, and return its center. The coverage check happens later
// in verifiedClickAt AFTER the pointer hovers the point, because ChatGPT uses
// hover-revealed controls (e.g. the Pro sub-mode chevron) that only become
// hit-testable once the row is hovered.
const CLICK_POINT_SNIPPET = `
    const clickPoint = (el, yCap) => {
      document.querySelectorAll('[data-prodex-click]').forEach((n) => n.removeAttribute('data-prodex-click'));
      el.scrollIntoView({ block: "center", inline: "nearest" });
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return { ok: false, reason: "target element has no visible area" };
      el.setAttribute('data-prodex-click', '1');
      const x = Math.round(r.x + r.width / 2);
      const y = Math.round(r.y + (yCap ? Math.min(r.height / 2, yCap) : r.height / 2));
      return { ok: true, x, y };
    };`;

function hoverVerifyExpression(x: number, y: number): string {
  return `(() => {
    const el = document.querySelector('[data-prodex-click]');
    const hit = document.elementFromPoint(${x}, ${y});
    const ok = Boolean(el && hit && (hit === el || el.contains(hit) || hit.contains(el)));
    if (el) el.removeAttribute('data-prodex-click');
    return ok;
  })()`;
}

// Move the pointer first, give hover styles a beat to apply, then confirm the
// tagged target is what would actually receive the click before pressing.
// These clicks land in the user's real session, so a covered or scrolled-out
// target must fail loudly instead of clicking whatever sits at the point.
async function verifiedClickAt(cdp: CdpConnection, x: number, y: number, label: string): Promise<void> {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await sleep(150);
  const onTarget = await cdp.evaluate<boolean>(hoverVerifyExpression(x, y));
  if (!onTarget) {
    throw new Error(
      `Refusing to click "${label}": another element covers its click point (overlay, scroll, or layout change). Retry, or interact manually in the visible browser.`
    );
  }
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

export function modelButtonRectExpression(): string {
  return `(() => {${CLICK_POINT_SNIPPET}
    const c = document.querySelector('#prompt-textarea,[contenteditable="true"],textarea');
    const scope = c ? (c.closest('form') || document) : document;
    const b = [...scope.querySelectorAll('[aria-haspopup="menu"]')].find((el) => {
      const t = (el.textContent || "").trim();
      const aria = el.getAttribute("aria-label") || "";
      return /\\S/.test(t) && !/파일|첨부|받아쓰기|음성|dictation|attach|file|voice|record|search|mic/i.test(t + aria);
    });
    if (!b) return { ok: false, reason: "model selector button not found" };
    return clickPoint(b);
  })()`;
}

export function menuItemRectExpression(label: string): string {
  return `(() => {${CLICK_POINT_SNIPPET}
    const m = document.querySelector('[data-testid="composer-intelligence-picker-content"]');
    if (!m) return { ok: false, reason: "reasoning/model menu did not open" };
    const items = [...m.querySelectorAll('[role="menuitemradio"],[role="menuitem"]')];
    const it = items.find((r) => (r.textContent || "").trim() === ${JSON.stringify(label)});
    if (!it) return { ok: false, reason: "menu item not found", available: items.map((r) => (r.textContent || "").trim()).slice(0, 12) };
    const point = clickPoint(it);
    if (!point.ok) return point;
    return { ...point, role: it.getAttribute("role"), haspopup: it.getAttribute("aria-haspopup") };
  })()`;
}

export function submenuItemRectExpression(label: string): string {
  return `(() => {${CLICK_POINT_SNIPPET}
    const items = [...document.querySelectorAll('[role="menuitemradio"],[role="menuitem"]')];
    const it = items.find((r) => (r.textContent || "").trim() === ${JSON.stringify(label)});
    if (!it) return { ok: false, reason: "submenu item not found" };
    return clickPoint(it);
  })()`;
}

// "Pro" itself is a plain radio; its sub-modes (Pro 기본 / Pro 확장) live behind an
// unlabeled aria-haspopup="menu" chevron sitting next to the Pro radio. Clicking
// that chevron (hovering does not work) opens the sub-mode submenu.
// The Pro radio's visible label reflects the active sub-mode ("Pro", "Pro 기본",
// or "Pro 확장"), so it must be matched by prefix, never by exact text.
const PRO_RADIO_FINDER_SNIPPET = `
    const findProRadio = (scope) =>
      [...scope.querySelectorAll('[role="menuitemradio"]')].find((r) => /^Pro( |$)/.test((r.textContent || "").trim()));`;

export function proRadioRectExpression(): string {
  return `(() => {${CLICK_POINT_SNIPPET}${PRO_RADIO_FINDER_SNIPPET}
    const m = document.querySelector('[data-testid="composer-intelligence-picker-content"]');
    if (!m) return { ok: false, reason: "reasoning/model menu did not open" };
    const proRadio = findProRadio(m);
    if (!proRadio) return { ok: false, reason: "Pro option not found in the model menu" };
    return clickPoint(proRadio);
  })()`;
}

export function proSubmenuExpanderRectExpression(): string {
  return `(() => {${CLICK_POINT_SNIPPET}${PRO_RADIO_FINDER_SNIPPET}
    const m = document.querySelector('[data-testid="composer-intelligence-picker-content"],[role="menu"]');
    if (!m) return { ok: false, reason: "model menu is not open" };
    const proRadio = findProRadio(m);
    if (!proRadio) return { ok: false, reason: "Pro option not found in the model menu" };
    const proTop = proRadio.getBoundingClientRect().top;
    const expanders = [...m.querySelectorAll('[role="menuitem"][aria-haspopup="menu"]')].filter((e) => {
      const t = (e.textContent || "").trim();
      return !/gpt|claude|gemini|o\\d|mini|thinking/i.test(t);
    });
    let best = null;
    let bestDy = Infinity;
    for (const e of expanders) {
      const dy = Math.abs(e.getBoundingClientRect().top - proTop);
      if (dy < bestDy) { best = e; bestDy = dy; }
    }
    if (!best || bestDy > 40) return { ok: false, reason: "Pro sub-mode expander not found next to Pro" };
    return clickPoint(best);
  })()`;
}

export function projectItemRectExpression(name: string): string {
  return `(() => {${CLICK_POINT_SNIPPET}
    const opt = [...document.querySelectorAll('[aria-label*="프로젝트 옵션 열기"]')].find((b) => (b.getAttribute("aria-label") || "").startsWith(${JSON.stringify(name)}));
    let target = opt ? (opt.closest('a,[role="link"],li') || opt.parentElement) : null;
    if (!target) {
      const icons = [...document.querySelectorAll('[data-testid="project-folder-icon"]')];
      for (const ic of icons) {
        const row = ic.closest('a,li,[role="link"]') || ic.parentElement?.parentElement;
        if (row && (row.textContent || "").includes(${JSON.stringify(name)})) { target = row; break; }
      }
    }
    if (!target) return { ok: false, reason: "project not found in sidebar" };
    return clickPoint(target, 18);
  })()`;
}

// Clicking a menuitemradio commits the choice and closes the picker; a menu
// that stays open means the click did not land where we intended.
async function assertSelectionCommitted(cdp: CdpConnection, label: string): Promise<void> {
  const closed = await waitForExpressionTrue(cdp, menuClosedExpression(), MENU_SETTLE_TIMEOUT_MS);
  if (!closed) {
    throw new Error(`ChatGPT selection "${label}" did not commit; the model menu stayed open. Retry, or pick it manually in the visible browser.`);
  }
}

async function selectModelReasoning(
  cdp: CdpConnection,
  options: Pick<SendChatGptPromptOptions, "model" | "proMode" | "effort">
): Promise<void> {
  if (!options.model && !options.proMode && !options.effort) return;
  const button = await cdp.evaluate<RectHit>(modelButtonRectExpression());
  if (!button.ok || button.x === undefined || button.y === undefined) {
    throw new Error(button.reason ?? "Could not open the ChatGPT model selector");
  }
  try {
    await verifiedClickAt(cdp, button.x, button.y, "model selector");
    const opened = await waitForExpressionTrue(cdp, menuOpenExpression(), MENU_OPEN_TIMEOUT_MS);
    if (!opened) throw new Error("ChatGPT model menu did not open after clicking the selector");

    const wantsProMode = Boolean(options.proMode) && (!options.model || /pro/i.test(options.model));
    if (wantsProMode && options.proMode) {
      // Open the Pro sub-mode submenu via the chevron, then pick 기본/확장.
      const expander = await cdp.evaluate<RectHit>(proSubmenuExpanderRectExpression());
      if (!expander.ok || expander.x === undefined || expander.y === undefined) {
        throw new Error(expander.reason ?? "Could not open the ChatGPT Pro sub-mode submenu");
      }
      await verifiedClickAt(cdp, expander.x, expander.y, "Pro sub-mode expander");
      const subLabel = `Pro ${options.proMode}`;
      const subVisible = await waitForExpressionTrue(cdp, menuItemPresentExpression(subLabel), MENU_OPEN_TIMEOUT_MS);
      if (!subVisible) throw new Error(`ChatGPT Pro sub-mode not found: ${subLabel}`);
      const sub = await cdp.evaluate<RectHit>(submenuItemRectExpression(subLabel));
      if (!sub.ok || sub.x === undefined || sub.y === undefined) {
        throw new Error(sub.reason ?? `ChatGPT Pro sub-mode not clickable: ${subLabel}`);
      }
      await verifiedClickAt(cdp, sub.x, sub.y, subLabel);
      await assertSelectionCommitted(cdp, subLabel);
      return;
    }

    const primaryLabel = options.model ?? options.effort;
    if (!primaryLabel) {
      await dispatchEscapeKey(cdp);
      return;
    }

    // --model Pro without a sub-mode: the Pro radio's label carries the active
    // sub-mode, so exact-label lookup would miss it.
    if (options.model && /^pro$/i.test(options.model)) {
      const proRadio = await cdp.evaluate<RectHit>(proRadioRectExpression());
      if (!proRadio.ok || proRadio.x === undefined || proRadio.y === undefined) {
        throw new Error(proRadio.reason ?? "Pro option not found in the model menu");
      }
      await verifiedClickAt(cdp, proRadio.x, proRadio.y, "Pro");
      await assertSelectionCommitted(cdp, "Pro");
      return;
    }

    const primary = await cdp.evaluate<RectHit>(menuItemRectExpression(primaryLabel));
    if (!primary.ok || primary.x === undefined || primary.y === undefined) {
      throw new Error(`ChatGPT model/effort option not found: ${primaryLabel}${primary.available ? ` (available: ${primary.available.join(", ")})` : ""}`);
    }
    if (primary.role === "menuitem" && primary.haspopup === "menu") {
      throw new Error(
        `ChatGPT model "${primaryLabel}" opens a submenu of variants instead of committing; selecting it is not supported yet. Supported today: reasoning efforts (--effort) and Pro via --pro-mode.`
      );
    }
    await verifiedClickAt(cdp, primary.x, primary.y, primaryLabel);
    await assertSelectionCommitted(cdp, primaryLabel);
  } catch (error) {
    // Leave the user's screen clean: back out of any open menu before rethrowing.
    try {
      await dispatchEscapeKey(cdp);
      await sleep(150);
      await dispatchEscapeKey(cdp);
    } catch {
      // best effort only
    }
    throw error;
  }
}

export function newProjectButtonRectExpression(): string {
  return `(() => {${CLICK_POINT_SNIPPET}
    const el =
      document.querySelector('button[aria-label="새 프로젝트"]') ||
      [...document.querySelectorAll('button,[role="button"]')].find((b) =>
        /새 프로젝트|new project/i.test(((b.textContent || "") + (b.getAttribute("aria-label") || "")).trim())
      );
    if (!el) return { ok: false, reason: "new-project button not found in the sidebar" };
    return clickPoint(el);
  })()`;
}

// The new-project popover has a single visible text input for the name;
// creation is committed by pressing Enter (there is no dedicated create button).
const VISIBLE_TEXT_INPUT_FINDER = `
    const findNameInput = () =>
      [...document.querySelectorAll('input[type="text"]')].find((i) => {
        const r = i.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });`;

export function newProjectNameInputRectExpression(): string {
  return `(() => {${CLICK_POINT_SNIPPET}${VISIBLE_TEXT_INPUT_FINDER}
    const input = findNameInput();
    if (!input) return { ok: false, reason: "new-project name input did not appear" };
    return clickPoint(input);
  })()`;
}

export function newProjectNameInputVisibleExpression(): string {
  return `(() => {${VISIBLE_TEXT_INPUT_FINDER}
    return Boolean(findNameInput());
  })()`;
}

function newProjectNameInputValueExpression(): string {
  return `(() => {${VISIBLE_TEXT_INPUT_FINDER}
    const input = findNameInput();
    return input ? input.value : null;
  })()`;
}

async function dispatchEnterKey(cdp: CdpConnection): Promise<void> {
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
}

// Creates a project in the user's real ChatGPT account: sidebar 새 프로젝트 →
// type the name into the popover input → Enter → wait for navigation into the
// new project. Backs out with Escape on any failure.
async function createChatGptProject(cdp: CdpConnection, name: string): Promise<void> {
  const hrefBefore = await cdp.evaluate<string>("location.href");
  const button = await cdp.evaluate<RectHit>(newProjectButtonRectExpression());
  if (!button.ok || button.x === undefined || button.y === undefined) {
    throw new Error(button.reason ?? "new-project button not found in the sidebar");
  }
  try {
    await verifiedClickAt(cdp, button.x, button.y, "새 프로젝트");
    const inputVisible = await waitForExpressionTrue(cdp, newProjectNameInputVisibleExpression(), MENU_OPEN_TIMEOUT_MS);
    if (!inputVisible) throw new Error("new-project name input did not appear");
    const input = await cdp.evaluate<RectHit>(newProjectNameInputRectExpression());
    if (!input.ok || input.x === undefined || input.y === undefined) {
      throw new Error(input.reason ?? "new-project name input is not clickable");
    }
    await verifiedClickAt(cdp, input.x, input.y, "project name input");
    await sleep(150);
    await cdp.send("Input.insertText", { text: name });
    await sleep(150);
    const typed = await cdp.evaluate<string | null>(newProjectNameInputValueExpression());
    if (typed !== name) {
      throw new Error(`could not type the project name into the new-project input (saw: ${typed === null ? "no input" : JSON.stringify(typed)})`);
    }
    await dispatchEnterKey(cdp);
    const navigated = await waitForExpressionTrue(
      cdp,
      `location.href !== ${JSON.stringify(hrefBefore)}`,
      PROJECT_NAVIGATION_TIMEOUT_MS
    );
    if (!navigated) throw new Error(`Creating project "${name}" did not navigate into the new project`);
    const composerReady = await waitForExpressionTrue(
      cdp,
      `Boolean(document.querySelector('#prompt-textarea,[contenteditable="true"],textarea'))`,
      PROJECT_NAVIGATION_TIMEOUT_MS
    );
    if (!composerReady) throw new Error(`ChatGPT composer did not appear after creating project "${name}"`);
  } catch (error) {
    try {
      await dispatchEscapeKey(cdp);
      await sleep(150);
      await dispatchEscapeKey(cdp);
    } catch {
      // best effort only
    }
    throw error;
  }
}

async function selectProject(
  cdp: CdpConnection,
  options: Pick<SendChatGptPromptOptions, "project" | "projectNew">
): Promise<void> {
  if (options.projectNew) {
    await createChatGptProject(cdp, options.projectNew);
    return;
  }
  if (!options.project) return;
  const hrefBefore = await cdp.evaluate<string>("location.href");
  const hit = await cdp.evaluate<RectHit>(projectItemRectExpression(options.project));
  if (!hit.ok || hit.x === undefined || hit.y === undefined) {
    const detail = hit.reason && hit.reason !== "project not found in sidebar" ? ` (${hit.reason})` : "";
    throw new Error(`ChatGPT project not found in sidebar: ${options.project}${detail}`);
  }
  await verifiedClickAt(cdp, hit.x, hit.y, `project ${options.project}`);
  const navigated = await waitForExpressionTrue(
    cdp,
    `location.href !== ${JSON.stringify(hrefBefore)}`,
    PROJECT_NAVIGATION_TIMEOUT_MS
  );
  if (!navigated) {
    throw new Error(
      `Clicking project "${options.project}" did not navigate the visible tab. If the tab is already inside this project, omit --project and retry.`
    );
  }
  const composerReady = await waitForExpressionTrue(
    cdp,
    `Boolean(document.querySelector('#prompt-textarea,[contenteditable="true"],textarea'))`,
    PROJECT_NAVIGATION_TIMEOUT_MS
  );
  if (!composerReady) {
    throw new Error(`ChatGPT composer did not appear after entering project "${options.project}"`);
  }
}

export async function sendChatGptPrompt(options: SendChatGptPromptOptions): Promise<SendChatGptPromptResult> {
  const port = options.port ?? 9333;
  const timeoutMs = options.timeoutMs ?? 90_000;
  const normalizedTargetUrl = options.targetUrl ? normalizeChatGptTargetUrl(options.targetUrl) : undefined;
  const pageResult = await findChatGptPage(port, computePageDiscoveryTimeout(timeoutMs), normalizedTargetUrl);
  if (!pageResult.ok) {
    throwBlockerOrError(pageResult.blocker, "ChatGPT browser page is not available");
  }
  if (!pageResult.page) {
    if (pageResult.blocker) {
      throw new ChatGptBrowserBlockerError(pageResult.blocker);
    }
    if (normalizedTargetUrl) {
      assertChatGptTargetTabAvailable(normalizedTargetUrl);
    }
    assertChatGptPageAvailable();
  }
  const page = pageResult.page;
  const status = await evaluateOnPage<ChatGptPageStatus>(page, statusExpression());
  const blocker = detectChatGptPageBlocker(status);
  if (blocker) {
    throw new ChatGptBrowserBlockerError(blocker);
  }
  assertChatGptReadyForPrompt(inferChatGptPageLoggedInLikely(status), status.hasComposer);
  if (normalizedTargetUrl) assertChatGptTargetUrlMatches(status.url, normalizedTargetUrl);
  assertVisibleChatGptTab(status.visibilityState, status.url, normalizedTargetUrl);
  const busyBlocker = chatGptBusyBlocker(status.generating);
  if (busyBlocker) {
    throw new ChatGptBrowserBlockerError(busyBlocker);
  }
  let beforeSubmit!: ChatGptAnswerState;
  const cdp = await connectCdp(page.webSocketDebuggerUrl);
  try {
    await cdp.send("Runtime.enable");
    await selectProject(cdp, options);
    await selectModelReasoning(cdp, options);
    // Capture the answer baseline AFTER any project navigation or model switch
    // so assistant-message counts compare within the thread we actually send
    // into; a --project/--project-new hop lands on a page with its own counts.
    beforeSubmit = await evaluateOnPage<ChatGptAnswerState>(page, answerExpression());
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
    const runtimeBlocker = chatGptBlockerFromAnswerState(finalState);
    if (runtimeBlocker) throw new ChatGptBrowserBlockerError(runtimeBlocker);
    if (hasChatGptPromptAcceptance(beforeSubmit, finalState)) {
      accepted = true;
      break;
    }
  }
  if (!accepted) {
    throw new Error("Timed out waiting for ChatGPT to accept the prompt.");
  }

  let stableAnswer: string | undefined;
  let stableConfirmations = 0;
  while (Date.now() - started < timeoutMs) {
    await sleep(1000);
    finalState = await evaluateOnPage<ChatGptAnswerState>(page, answerExpression());
    const runtimeBlocker = chatGptBlockerFromAnswerState(finalState);
    if (runtimeBlocker) throw new ChatGptBrowserBlockerError(runtimeBlocker);
    if (!hasFreshChatGptAnswer(beforeSubmit.assistantMessageCount, finalState)) continue;
    // A "fresh" answer must also be stable: ChatGPT can momentarily look done mid-stream, so accept
    // it only once the text stops changing across polls. Otherwise trailing tokens (e.g. the final
    // "_OK" of the smoke token) get dropped.
    if (finalState.answer === stableAnswer) {
      stableConfirmations += 1;
      if (stableConfirmations >= 1) break;
    } else {
      stableAnswer = finalState.answer;
      stableConfirmations = 0;
    }
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

export interface ChatGptModelOption {
  label: string;
  kind: "radio" | "submenu";
  checked: boolean;
}

export interface ListChatGptModelOptionsResult {
  url: string;
  options: ChatGptModelOption[];
}

export function modelMenuOptionsExpression(): string {
  return `(() => {
    const m = document.querySelector('[data-testid="composer-intelligence-picker-content"]');
    if (!m) return [];
    return [...m.querySelectorAll('[role="menuitemradio"],[role="menuitem"]')]
      .map((it) => ({
        label: (it.textContent || "").trim(),
        kind: it.getAttribute("aria-haspopup") === "menu" ? "submenu" : "radio",
        checked: it.getAttribute("aria-checked") === "true"
      }))
      .filter((o) => o.label.length > 0);
  })()`;
}

// Read-only discovery: open the composer model menu, read the option labels,
// and press Escape. Nothing is clicked inside the menu, so the user's model
// selection is never changed.
export async function listChatGptModelOptions(input: { port?: number; timeoutMs?: number } = {}): Promise<ListChatGptModelOptionsResult> {
  const port = input.port ?? 9333;
  const timeoutMs = input.timeoutMs ?? 15_000;
  const pageResult = await findChatGptPage(port, computePageDiscoveryTimeout(timeoutMs), undefined);
  if (!pageResult.ok) {
    throwBlockerOrError(pageResult.blocker, "ChatGPT browser page is not available");
  }
  if (!pageResult.page) {
    if (pageResult.blocker) throw new ChatGptBrowserBlockerError(pageResult.blocker);
    assertChatGptPageAvailable();
  }
  const page = pageResult.page;
  const status = await evaluateOnPage<ChatGptPageStatus>(page, statusExpression());
  const blocker = detectChatGptPageBlocker(status);
  if (blocker) throw new ChatGptBrowserBlockerError(blocker);
  assertChatGptReadyForPrompt(inferChatGptPageLoggedInLikely(status), status.hasComposer);
  assertVisibleChatGptTab(status.visibilityState, status.url, undefined);
  const cdp = await connectCdp(page.webSocketDebuggerUrl);
  try {
    await cdp.send("Runtime.enable");
    const button = await cdp.evaluate<RectHit>(modelButtonRectExpression());
    if (!button.ok || button.x === undefined || button.y === undefined) {
      throw new Error(button.reason ?? "Could not open the ChatGPT model selector");
    }
    try {
      await verifiedClickAt(cdp, button.x, button.y, "model selector");
      const opened = await waitForExpressionTrue(cdp, menuOpenExpression(), MENU_OPEN_TIMEOUT_MS);
      if (!opened) throw new Error("ChatGPT model menu did not open after clicking the selector");
      const options = await cdp.evaluate<ChatGptModelOption[]>(modelMenuOptionsExpression());
      return { url: status.url, options };
    } finally {
      try {
        await dispatchEscapeKey(cdp);
        await sleep(150);
        await dispatchEscapeKey(cdp);
      } catch {
        // best effort only
      }
    }
  } finally {
    cdp.close();
  }
}

async function findChatGptPage(
  port: number,
  timeoutMs: number,
  targetUrl?: string
): Promise<{ ok: true; page?: DevtoolsPage; blocker?: ChatGptBrowserStatus["blocker"] } | { ok: false; blocker: ChatGptBrowserStatus["blocker"] }> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const pages = (await response.json()) as DevtoolsPage[];
    const visibilityByPage = await getChatGptPageVisibility(pages);
    const blocker = chatGptPageSelectionBlocker(pages, targetUrl, visibilityByPage);
    if (blocker) return { ok: true, blocker };
    return { ok: true, page: selectChatGptPage(pages, targetUrl, visibilityByPage) };
  } catch (error) {
    return {
      ok: false,
      blocker: {
        code: "browser_unreachable",
        message: `No Chrome DevTools endpoint is reachable on 127.0.0.1:${port}.`,
        retryable: true,
        next_step: "Run `prodex pro browser login`, log in, then retry.",
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
          // Leave visibility unknown; untargeted sends treat unknown ChatGPT pages conservatively.
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

function throwBlockerOrError(blocker: ChatGptBrowserStatus["blocker"] | undefined, fallback: string): never {
  if (blocker) throw new ChatGptBrowserBlockerError(blocker);
  throw new Error(fallback);
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

export function statusExpression(): string {
  const excludedTextSelector = JSON.stringify(CHATGPT_RUNTIME_BLOCKER_TEXT_EXCLUDED_ANCESTORS);
  const generatingControlPattern = JSON.stringify(CHATGPT_GENERATING_CONTROL_PATTERN.source);
  const generatingControlFlags = JSON.stringify(CHATGPT_GENERATING_CONTROL_PATTERN.flags);
  return `(() => {
    ${composerExpressionHelpers()}
    const text = document.body?.innerText || "";
    const runtimeExcludedTextSelector = ${excludedTextSelector};
    const generatingControlPattern = new RegExp(${generatingControlPattern}, ${generatingControlFlags});
    const visibleTextOutsideMessages = () => {
      if (!document.body) return "";
      const parts = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const parent = node.parentElement;
        const value = node.nodeValue?.trim();
        if (!parent || !value) continue;
        if (parent.closest(runtimeExcludedTextSelector)) continue;
        const style = window.getComputedStyle(parent);
        if (style.display === "none" || style.visibility === "hidden") continue;
        if (!(parent.offsetWidth || parent.offsetHeight || parent.getClientRects().length)) continue;
        parts.push(value);
      }
      return parts.join(String.fromCharCode(10));
    };
    const blockerText = visibleTextOutsideMessages();
    const lines = text.split(String.fromCharCode(10)).map((line) => line.trim()).filter(Boolean);
    const visibleButtonLabels = [...document.querySelectorAll('button,a,[role="button"]')]
      .filter((el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length))
      .filter((el) => !el.closest(runtimeExcludedTextSelector))
      .map((el) => (el.innerText || el.getAttribute("aria-label") || el.getAttribute("data-testid") || "").trim())
      .filter(Boolean);
    const messages = [...document.querySelectorAll('[data-message-author-role]')].map((node) => ({
      role: node.getAttribute('data-message-author-role'),
      text: node.innerText || ""
    }));
    const assistant = messages.filter((message) => message.role === "assistant").at(-1);
    const answer = assistant?.text || "";
    const ansStripped = answer.trim().replace(/\\.+$/, "");
    const ansLines = ansStripped.split(/\\r?\\n/).filter((l) => l.trim());
    const placeholder = /^(생각 중|thinking|thought for|thought about)/i.test(ansStripped) || (ansLines.length <= 1 && /(^|\\s)생각 중$/.test(ansStripped));
    const hasComposer = Boolean(findChatGptComposerCandidate());
    return {
      title: document.title,
      url: location.href,
      visibilityState: document.visibilityState,
      textSample: text.slice(0, 12000),
      blockerTextSample: blockerText.slice(0, 12000),
      visibleButtonLabels,
      hasComposer,
      generating: placeholder || visibleButtonLabels.some((label) => generatingControlPattern.test(label)),
      modelHints: lines.filter((line) => /GPT|Pro|Thinking|ChatGPT|Extra High|Auto/i.test(line)).slice(0, 30)
    };
  })()`;
}

export function setComposerTextExpression(text: string): string {
  const serializedText = JSON.stringify(text);
  return `(() => {
    ${composerExpressionHelpers()}
    const el = findChatGptComposerCandidate();
    if (!el) return { ok: false, reason: "No visible composer" };
    const root = findChatGptComposerRoot(el);
    if (root) markChatGptComposerRoot(root);
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

export function submitExpression(): string {
  return `(() => {
    ${composerExpressionHelpers()}
    const markedRoot = findMarkedChatGptComposerRoot();
    const composer = markedRoot ? undefined : findChatGptComposerCandidate();
    const root = markedRoot || (composer ? findChatGptComposerRoot(composer) : undefined);
    const button = root ? findChatGptSubmitButton(root) : undefined;
    if (!button) return { ok: false, reason: "No enabled submit button" };
    button.click();
    return { ok: true };
  })()`;
}

function composerExpressionHelpers(): string {
  const excludedTextSelector = JSON.stringify(CHATGPT_COMPOSER_CANDIDATE_EXCLUDED_ANCESTORS);
  const activeComposerAttribute = JSON.stringify(PRODEX_ACTIVE_COMPOSER_ATTRIBUTE);
  return `
    const excludedTextSelector = ${excludedTextSelector};
    const activeComposerAttribute = ${activeComposerAttribute};
    const isVisible = (node) => !!(node.offsetWidth || node.offsetHeight || node.getClientRects().length);
    const isEditableComposer = (node) => isVisible(node) && !(node.parentElement && node.parentElement.closest(excludedTextSelector));
    const findChatGptComposerRoot = (node) =>
      node.closest('form') ||
      node.closest('[data-testid*="composer"],[data-testid*="prompt"],[class*="composer"]') ||
      node.parentElement;
    const isChatGptSubmitLikeButton = (node) => {
      const label = (node.innerText || node.getAttribute("aria-label") || node.getAttribute("data-testid") || "").toLowerCase();
      const dataTestId = node.getAttribute("data-testid");
      return isVisible(node) && (dataTestId === "send-button" || /\\b(send|submit)\\b|보내기|전송/.test(label));
    };
    const isEnabledButton = (node) => !node.disabled && node.getAttribute("aria-disabled") !== "true";
    const findChatGptSubmitButton = (root, requireEnabled = true) =>
      [...root.querySelectorAll('button')].find((node) => isChatGptSubmitLikeButton(node) && (!requireEnabled || isEnabledButton(node)));
    const markChatGptComposerRoot = (root) => {
      document.querySelectorAll('[' + activeComposerAttribute + '="true"]').forEach((node) => node.removeAttribute(activeComposerAttribute));
      root.setAttribute(activeComposerAttribute, "true");
    };
    const findMarkedChatGptComposerRoot = () => document.querySelector('[' + activeComposerAttribute + '="true"]');
    const isChatGptComposerRootEl = (root) =>
      root.tagName === 'FORM' || (root.matches && root.matches('[data-testid*="composer"],[data-testid*="prompt"],[class*="composer"]'));
    const findChatGptComposerCandidate = () => {
      const candidates = [...document.querySelectorAll('textarea[data-testid="prompt-textarea"], div[role="textbox"], textarea, [contenteditable="true"]')]
        .filter(isEditableComposer);
      // Prefer a composer whose root still shows a submit button.
      const withSubmit = candidates.find((node) => {
        const root = findChatGptComposerRoot(node);
        return root && findChatGptSubmitButton(root, false);
      });
      if (withSubmit) return withSubmit;
      // ChatGPT hides the send button until text is entered, so also accept an editable inside a
      // composer form/container even when no submit button is visible on an empty composer.
      return candidates.find((node) => {
        const root = findChatGptComposerRoot(node);
        return root && isChatGptComposerRootEl(root);
      });
    };
  `;
}

function answerExpression(): string {
  const excludedTextSelector = JSON.stringify(CHATGPT_RUNTIME_BLOCKER_TEXT_EXCLUDED_ANCESTORS);
  const generatingControlPattern = JSON.stringify(CHATGPT_GENERATING_CONTROL_PATTERN.source);
  const generatingControlFlags = JSON.stringify(CHATGPT_GENERATING_CONTROL_PATTERN.flags);
  return `(() => {
    const text = document.body?.innerText || "";
    const excludedTextSelector = ${excludedTextSelector};
    const generatingControlPattern = new RegExp(${generatingControlPattern}, ${generatingControlFlags});
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
      .filter((node) => !node.closest(excludedTextSelector))
      .map((node) => (node.innerText || node.getAttribute("aria-label") || node.getAttribute("data-testid") || "").trim())
      .filter(Boolean);
    const answer = assistant?.text || "";
    const ansStripped = answer.trim().replace(/\\.+$/, "");
    const ansLines = ansStripped.split(/\\r?\\n/).filter((l) => l.trim());
    const placeholder = /^(생각 중|thinking|thought for|thought about)/i.test(ansStripped) || (ansLines.length <= 1 && /(^|\\s)생각 중$/.test(ansStripped));
    return {
      title: document.title,
      url: location.href,
      answer: answer || text.slice(-4000),
      textSample: text.slice(0, 12000),
      blockerTextSample: visibleTextOutsideMessages().slice(0, 12000),
      visibleButtonLabels: buttons,
      generating: placeholder || buttons.some((label) => generatingControlPattern.test(label)),
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
  const fromEnv = process.env.PRODEX_CHROME;
  if (fromEnv) {
    assertChromeCommandAvailable(fromEnv, "PRODEX_CHROME");
    return fromEnv;
  }
  for (const command of ["google-chrome", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"]) {
    if (isCommandOnPath(command) && hasChromeLikeVersion(command)) return command;
  }
  throw new Error("Could not find Chrome/Chromium. Set PRODEX_CHROME to the browser executable.");
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
