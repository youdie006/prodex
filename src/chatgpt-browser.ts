import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  max: "매우 높음",
  extrahigh: "매우 높음"
};

// Menu labels per canonical value, verified live in both the Korean and the
// English (US) ChatGPT UI. Matching tries every candidate so either UI works.
const EFFORT_MENU_LABELS: Record<ChatGptReasoningEffort, readonly string[]> = {
  "즉시": ["즉시", "Instant"],
  "중간": ["중간", "Medium"],
  "높음": ["높음", "High"],
  "매우 높음": ["매우 높음", "Extra High"]
};

const PRO_MODE_SUBMENU_LABELS: Record<ChatGptProMode, readonly string[]> = {
  "기본": ["Pro 기본", "Pro Standard"],
  "확장": ["Pro 확장", "Pro Extended"]
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
  throw new Error(`--effort must be one of ${REASONING_EFFORTS.join(", ")} (English aliases: instant, medium, high, max)`);
}

/** Normalize a CLI Pro sub-mode value onto the exact ChatGPT menu label. */
export function parseProMode(raw: string): ChatGptProMode {
  const trimmed = raw.trim();
  const match = PRO_MODES.find((mode) => mode === trimmed);
  if (match) return match;
  const alias = PRO_MODE_ALIASES[trimmed.toLowerCase().replace(/\s+/g, "")];
  if (alias) return alias;
  throw new Error(`--pro-mode must be one of ${PRO_MODES.join(", ")} (English aliases: standard, extended)`);
}

export const DEFAULT_CDP_PORT = 9333;

// The ChatGPT streaming caret renders as a literal text character at the end
// of the growing assistant message (a plain "_" in the current UI; "▍" and
// friends historically). Measured live 2026-07-06: the caret can stay in
// innerText for a beat AFTER the stop button disappears, so a short answer can
// look stable and non-generating while still carrying the caret.
const TRAILING_CARET_SUSPECT = /[_▍▌█▊▋]$/;

/**
 * Stability policy for the answer poll loop. Returns true once the observed
 * (answer, generating) stream should be accepted as final:
 * - normal answers: two consecutive identical, non-generating polls;
 * - answers whose tail looks like the streaming caret: six additional
 *   confirmations (~6s at the 1s poll cadence), so a lingering caret gets
 *   dropped by ChatGPT's finalization re-render first, while an answer that
 *   genuinely ends with an underscore is still accepted after the extra wait.
 */
export function createChatGptAnswerStabilityTracker(): (answer: string, generating: boolean) => boolean {
  let stableAnswer: string | undefined;
  let confirmations = 0;
  return (answer, generating) => {
    if (generating) {
      // A generating poll invalidates any baseline: the text may still grow.
      stableAnswer = undefined;
      confirmations = 0;
      return false;
    }
    if (answer !== stableAnswer) {
      stableAnswer = answer;
      confirmations = 0;
      return false;
    }
    confirmations += 1;
    // Trim before the caret check: the caller trims the returned answer, so a
    // caret followed by trailing whitespace must count as suspect too.
    const required = TRAILING_CARET_SUSPECT.test(answer.trimEnd()) ? 8 : 2;
    return confirmations >= required;
  };
}

/**
 * Resolve the Chrome DevTools port: explicit flag > PRODEX_CDP_PORT env >
 * default 9333. The env var exists so a non-default port picked at login does
 * not have to be repeated as --port on every later command.
 */
export function resolveCdpPort(explicit?: number): number {
  if (explicit !== undefined) return explicit;
  const fromEnv = process.env.PRODEX_CDP_PORT;
  if (fromEnv !== undefined && fromEnv !== "") {
    const parsed = Number(fromEnv);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
      throw new Error(`PRODEX_CDP_PORT must be an integer between 1 and 65535, got: ${fromEnv}`);
    }
    return parsed;
  }
  return DEFAULT_CDP_PORT;
}

export type SendChatGptProgressPhase = "connecting" | "tab_ready" | "selecting" | "sent" | "waiting" | "answered";

export interface SendChatGptProgressEvent {
  phase: SendChatGptProgressPhase;
  elapsedMs: number;
  detail?: string;
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
  /** Model to select in the composer picker, e.g. "Pro". */
  model?: string;
  /** Pro sub-mode, used when model is Pro. */
  proMode?: ChatGptProMode;
  /** Reasoning effort, used for non-Pro models. */
  effort?: ChatGptReasoningEffort;
  /**
   * Navigate the tab to a fresh chat (chatgpt.com root) before sending. Long
   * accumulated threads eventually break prompt-acceptance detection
   * (measured live), so agent loops and debates should send each consult
   * into a fresh chat. Incompatible with targetUrl.
   */
  newChat?: boolean;
  /** Progress callback so long sends can report phase + elapsed instead of staying silent. */
  onProgress?: (event: SendChatGptProgressEvent) => void;
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
  blockerScanTextSample?: string;
  visibleButtonLabels: string[];
}

export interface ChatGptPageTextState {
  textSample: string;
  blockerTextSample?: string;
  blockerScanTextSample?: string;
  visibleButtonLabels: string[];
}

interface ChatGptPageStatus extends ChatGptPageTextState {
  title: string;
  hasComposer: boolean;
  generating: boolean;
  modelHints: string[];
  url: string;
  visibilityState: string;
  // Text of an open [role="dialog"] (e.g. a marketing/onboarding modal), which
  // hides the composer behind aria-hidden and must be dismissed before use.
  openDialogText?: string;
}

// Text/buttons for login and status detection: exclude message bodies and the
// composer, but KEEP the sidebar/nav - the logged-in signals ("New chat",
// "Projects", the profile button, the plan hint) live there.
export const CHATGPT_RUNTIME_BLOCKER_TEXT_EXCLUDED_ANCESTORS =
  '[data-message-author-role],script,style,noscript,[aria-hidden="true"],div[role="textbox"],textarea,[contenteditable="true"]';
// Text scanned for PAGE BLOCKERS (captcha/usage-limit/cloudflare/...) also
// excludes the sidebar/nav: a past-chat title like "usage limit reset" or
// "verify human" in the history list must not be matched as a live blocker.
export const CHATGPT_BLOCKER_SCAN_EXCLUDED_ANCESTORS =
  `${'[data-message-author-role],script,style,noscript,[aria-hidden="true"],div[role="textbox"],textarea,[contenteditable="true"]'},nav,aside,[role="navigation"]`;
export const CHATGPT_COMPOSER_CANDIDATE_EXCLUDED_ANCESTORS = '[data-message-author-role],script,style,noscript,[aria-hidden="true"]';
export const PRODEX_ACTIVE_COMPOSER_ATTRIBUTE = "data-prodex-active-composer";

export interface DevtoolsPage {
  id?: string;
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
// While ChatGPT streams a response the composer's send control becomes an
// icon-only stop button (data-testid="stop-button", measured live) and the
// active assistant message carries aria-busy="true". These structural signals
// are more reliable than the button label text, which the pattern above can
// miss on an icon-only/relabeled control - a miss would let a mid-stream pause
// be accepted as the final answer, silently truncating it.
export const CHATGPT_STREAMING_SELECTOR =
  '[data-testid="stop-button"],[data-message-author-role="assistant"][aria-busy="true"],[data-message-author-role="assistant"] [aria-busy="true"]';

export function defaultChatGptProfileDir(): string {
  return path.join(os.homedir(), ".local", "share", "prodex", "chrome-chatgpt-pro");
}

export interface BrowserLoginLaunchRecord {
  profile_dir: string;
  port: number;
}

function lastBrowserLoginPath(): string {
  const override = process.env.PRODEX_LAST_LOGIN_FILE;
  if (override && override.length > 0) return override;
  return path.join(os.homedir(), ".local", "share", "prodex", "last-login.json");
}

/**
 * Remember how the last login launched the browser (profile dir + port) so
 * auto-recovery relaunches the SAME profile instead of the default one - a
 * custom-profile user must never be silently sent to a different account.
 * Best-effort: failures never break the login.
 */
export async function recordBrowserLoginLaunch(record: BrowserLoginLaunchRecord): Promise<void> {
  try {
    const file = lastBrowserLoginPath();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  } catch {
    // Advisory record only.
  }
}

export async function readLastBrowserLoginLaunch(): Promise<Partial<BrowserLoginLaunchRecord> | undefined> {
  try {
    const parsed = JSON.parse(await readFile(lastBrowserLoginPath(), "utf8")) as Partial<BrowserLoginLaunchRecord>;
    return {
      ...(typeof parsed.profile_dir === "string" && parsed.profile_dir.length > 0 ? { profile_dir: parsed.profile_dir } : {}),
      ...(typeof parsed.port === "number" && Number.isInteger(parsed.port) ? { port: parsed.port } : {})
    };
  } catch {
    return undefined;
  }
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
  const firstLine = stripped.split(/\r?\n/)[0].trim();
  // A reasoning/thinking header ("Thinking", "Thought for 5s", "9s 동안 생각함")
  // is a placeholder ONLY when it is the ENTIRE content (a single line that is
  // just the header). A substantive answer that merely starts with "Thinking"
  // (e.g. "Thinking about it, yes.") or has real text after the header (more
  // lines) is a real answer, not a placeholder.
  if (lineCount <= 1) {
    const headerOnly =
      /^(생각\s*중|thinking)$/i.test(firstLine) ||
      /^thought (for|about)\b.*$/i.test(firstLine) ||
      /\d+\s*s\s*동안\s*생각함$/.test(firstLine) ||
      /(^|\s)(생각\s*중|thinking)$/i.test(firstLine);
    if (headerOnly) return false;
  }
  return true;
}

export function hasFreshChatGptAnswer(
  previousAssistantMessageCount: number,
  state: Pick<ChatGptAnswerState, "answer" | "assistantMessageCount" | "generating">
): boolean {
  return state.assistantMessageCount > previousAssistantMessageCount && isUsableChatGptAnswer(state.answer) && !state.generating;
}

// Like hasFreshChatGptAnswer but WITHOUT requiring generation to have finished:
// a new assistant message that already contains usable text but is still
// streaming. Used to salvage the partial answer on a timeout instead of
// discarding minutes of Pro reasoning.
export interface AcceptanceTimeoutContext {
  timeoutMs: number;
  // The composer still held the prompt after submit — the send did not consume it.
  composerStillHasText: boolean;
  // submitExpression located an enabled send button to click.
  submitButtonFound: boolean;
}

// The acceptance phase waits for the prompt to POST (a new user/assistant
// message), not for the answer. So a timeout here almost never means "slow
// model" — it means the submit did not register, which is the signature of a
// changed ChatGPT UI (moved/renamed composer or send control). Distinguish that
// from a genuinely clean-but-slow submit and point the user at an update/report
// instead of a misleading "raise --timeout-ms".
export function acceptanceTimeoutError(ctx: AcceptanceTimeoutContext): Error {
  const uiLikelyChanged = ctx.composerStillHasText || !ctx.submitButtonFound;
  if (uiLikelyChanged) {
    const detail = [
      ctx.composerStillHasText ? "the composer still holds the prompt" : undefined,
      !ctx.submitButtonFound ? "no send button was found" : undefined
    ]
      .filter(Boolean)
      .join(" and ");
    return new Error(
      `Timed out after ${ctx.timeoutMs}ms and ChatGPT never registered the prompt (${detail}). ` +
        "The ChatGPT web UI may have changed, so prodex could not submit. Update prodex " +
        "(npm i -g @youdie006/prodex@latest); if it persists, report it at " +
        "https://github.com/youdie006/prodex/issues. You can also paste the prompt manually in the visible browser."
    );
  }
  return new Error(
    `Timed out after ${ctx.timeoutMs}ms waiting for ChatGPT to accept the prompt. Raise --timeout-ms and retry (Pro extended already uses a higher default).`
  );
}

export function hasPartialChatGptAnswer(
  previousAssistantMessageCount: number,
  state: Pick<ChatGptAnswerState, "answer" | "assistantMessageCount">
): boolean {
  return state.assistantMessageCount > previousAssistantMessageCount && isUsableChatGptAnswer(state.answer);
}

/**
 * True when the tab is on a fresh, empty ChatGPT chat: the root URL (not a
 * /c/<id> conversation) with zero messages. Used after a --new-chat navigation
 * to confirm the page actually reached the fresh chat before the answer-count
 * baseline is captured - a lingering old thread (slow navigation) has a /c/ URL
 * or non-zero counts and would poison the baseline.
 */
export function isFreshChatGptPage(state: {
  url: string;
  assistantMessageCount: number;
  userMessageCount: number;
}): boolean {
  const onRoot = /^https:\/\/chatgpt\.com\/?(?:[?#].*)?$/.test(state.url);
  return onRoot && state.assistantMessageCount === 0 && state.userMessageCount === 0;
}

/**
 * Poll until the tab settles on a fresh empty chat (or the timeout elapses).
 * Deterministically replaces a fixed post-navigation sleep so a slow SPA
 * navigation cannot leave the old thread's state in place. Best-effort: on
 * timeout it returns and the caller proceeds (the acceptance logic still
 * guards), but the poll removes the common race.
 */
async function waitForFreshChatGptPage(page: DevtoolsPage, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await evaluateOnPage<ChatGptAnswerState>(page, answerExpression());
    if (isFreshChatGptPage(state)) return true;
    await sleep(300);
  }
  return false;
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
  // Blocker scan uses the nav-excluded sample so a sidebar chat title cannot
  // fake a blocker; fall back to the nav-included sample / full text when the
  // scan sample is absent (older callers).
  return detectChatGptBlocker(
    state.blockerScanTextSample ?? state.blockerTextSample ?? state.textSample,
    state.visibleButtonLabels
  );
}

export function inferChatGptPageLoggedInLikely(state: ChatGptPageTextState): boolean {
  // Login detection uses the nav-INCLUDED sample: "New chat"/"Projects"/plan
  // hints live in the sidebar and are the primary logged-in signal.
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
  blockerScanTextSample?: string;
  visibleButtonLabels: string[];
}):string | undefined {
  return formatBlockerError(chatGptBlockerFromAnswerState(state));
}

export function chatGptBlockerFromAnswerState(state: {
  textSample: string;
  blockerTextSample?: string;
  blockerScanTextSample?: string;
  visibleButtonLabels: string[];
}):ChatGptBrowserStatus["blocker"] | undefined {
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

// Opt-in only: bringing the tab to the front steals OS focus, which is the
// widely-disliked bringToFront() anti-pattern and disrupts anyone running
// sends in the background. A non-minimized window (even behind other windows)
// already reports visibilityState "visible", so the default needs no
// activation; users who want the convenience set PRODEX_ACTIVATE_TAB=1.
export function isTabActivationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.PRODEX_ACTIVATE_TAB ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

async function activateChatGptPage(port: number, page: DevtoolsPage): Promise<void> {
  if (!page.id) return;
  try {
    await fetch(`http://127.0.0.1:${port}/json/activate/${page.id}`, { signal: AbortSignal.timeout(2000) });
  } catch {
    // best effort only; the visibility assert below reports the real state
  }
}

// Right after a project hop or model switch the SPA re-renders and the composer
// can momentarily read as absent. Poll a few times so a transient re-render is
// not misreported as "no logged-in session / no composer".
async function readSettledChatGptPageStatus(page: DevtoolsPage): Promise<ChatGptPageStatus> {
  let status = await evaluateOnPage<ChatGptPageStatus>(page, statusExpression());
  for (let attempt = 0; attempt < 4 && !(status.hasComposer && inferChatGptPageLoggedInLikely(status)); attempt += 1) {
    await sleep(400);
    status = await evaluateOnPage<ChatGptPageStatus>(page, statusExpression());
  }
  // An open modal dialog (e.g. the "ChatGPT for Work" onboarding promo shipped
  // with the 2026-07 update) puts the app behind aria-hidden, so the composer
  // and the logged-in signals are undetectable and every flow would report
  // "not ready". Escape dismisses such dialogs; try it (bounded) only when the
  // composer is actually blocked and a dialog is open.
  for (let attempt = 0; attempt < 2 && !status.hasComposer && (status.openDialogText ?? "").length > 0; attempt += 1) {
    await dismissOpenDialogViaEscape(page);
    await sleep(500);
    status = await evaluateOnPage<ChatGptPageStatus>(page, statusExpression());
  }
  return status;
}

async function dismissOpenDialogViaEscape(page: DevtoolsPage): Promise<void> {
  const cdp = await connectCdp(page.webSocketDebuggerUrl);
  try {
    await cdp.send("Runtime.enable");
    await dispatchEscapeKey(cdp);
  } catch {
    // Best effort: if the Escape cannot be delivered the settle loop simply
    // reports the original not-ready state.
  } finally {
    cdp.close();
  }
}

async function ensureVisibleChatGptPage(port: number, page: DevtoolsPage, status: ChatGptPageStatus): Promise<ChatGptPageStatus> {
  if (status.visibilityState === "visible") return status;
  if (!isTabActivationEnabled()) return status; // default: never steal focus; let the visibility assert report the blocker
  await activateChatGptPage(port, page);
  const deadline = Date.now() + 3_000;
  let latest = status;
  while (Date.now() < deadline) {
    await sleep(300);
    latest = await evaluateOnPage<ChatGptPageStatus>(page, statusExpression());
    if (latest.visibilityState === "visible") return latest;
  }
  return latest;
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

/**
 * Environment for the browser spawn. On Linux shells without DISPLAY or
 * WAYLAND_DISPLAY (common in WSL where a non-login shell does not export
 * them), a present WSLg X socket means a desktop is actually available -
 * inject DISPLAY=:0 so Chrome does not exit immediately with code 1.
 */
export function browserLaunchEnv(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  hasX0Socket: () => boolean = () => {
    try {
      statSync("/tmp/.X11-unix/X0");
      return true;
    } catch {
      return false;
    }
  }
): Record<string, string | undefined> {
  if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY && hasX0Socket()) {
    return { ...env, DISPLAY: ":0" };
  }
  return env;
}

export function openChatGptBrowser(options: ChatGptBrowserOptions = {}): ChatGptBrowserLaunch {
  const command = resolveChromeCommand();
  const port = resolveCdpPort(options.port);
  const profileDir = options.profileDir ?? defaultChatGptProfileDir();
  const args = buildChromeLaunchArgs({
    port,
    profileDir,
    url: options.url ?? "https://chatgpt.com/"
  });
  const child = spawn(command, args, { detached: true, stdio: "ignore", env: browserLaunchEnv() });
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
  const port = resolveCdpPort(options.port);
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

// Plain real mouse click at a point (no hover-verify). Used for the send
// button, whose coordinates come from a fresh getBoundingClientRect. A real
// CDP click is required because ChatGPT's React send handler ignores a
// synthetic element.click().
async function dispatchMouseClickAt(cdp: CdpConnection, x: number, y: number): Promise<void> {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
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

function toLabelCandidates(label: string | readonly string[]): string[] {
  return typeof label === "string" ? [label] : [...label];
}

// A menu item matches a candidate label when its trimmed text equals the
// candidate OR its FIRST LINE equals it - ChatGPT can render a description/badge
// on a second line (e.g. "High\nBalanced speed and quality"), which would break
// an exact-text match. First-line (not startsWith) matching avoids "High"
// falsely matching "Extra High" or "Pro" matching "Pro Standard".
export function menuItemLabelMatches(text: string, candidates: readonly string[]): boolean {
  const trimmed = text.trim();
  if (candidates.includes(trimmed)) return true;
  return candidates.includes(trimmed.split("\n")[0].trim());
}

function menuLabelMatchPredicate(label: string | readonly string[]): string {
  const c = JSON.stringify(toLabelCandidates(label));
  // Prefer innerText over textContent: a badge rendered next to the label (e.g.
  // the "5.5" chip on "Instant") concatenates in textContent ("Instant5.5",
  // unmatchable) but keeps a line break in innerText ("Instant\n5.5"), which the
  // first-line match handles (measured live on the 2026-07 ChatGPT update).
  return `((r) => { const t = ((r.innerText || r.textContent || "")).trim(); return ${c}.includes(t) || ${c}.includes(t.split(String.fromCharCode(10))[0].trim()); })`;
}

export function menuItemPresentExpression(label: string | readonly string[]): string {
  return `[...document.querySelectorAll('[role="menuitemradio"],[role="menuitem"]')].some(${menuLabelMatchPredicate(label)})`;
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

export function menuItemRectExpression(label: string | readonly string[]): string {
  return `(() => {${CLICK_POINT_SNIPPET}
    const m = document.querySelector('[data-testid="composer-intelligence-picker-content"]');
    if (!m) return { ok: false, reason: "reasoning/model menu did not open" };
    const items = [...m.querySelectorAll('[role="menuitemradio"],[role="menuitem"]')];
    const it = items.find(${menuLabelMatchPredicate(label)});
    if (!it) return { ok: false, reason: "menu item not found", available: items.map((r) => ((r.innerText || r.textContent || "").trim().split(String.fromCharCode(10))[0] || "").trim()).slice(0, 12) };
    const point = clickPoint(it);
    if (!point.ok) return point;
    return { ...point, role: it.getAttribute("role"), haspopup: it.getAttribute("aria-haspopup") };
  })()`;
}

export function submenuItemRectExpression(label: string | readonly string[]): string {
  return `(() => {${CLICK_POINT_SNIPPET}
    const items = [...document.querySelectorAll('[role="menuitemradio"],[role="menuitem"]')];
    const it = items.find(${menuLabelMatchPredicate(label)});
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
      [...scope.querySelectorAll('[role="menuitemradio"]')].find((r) => /^Pro( |$)/.test(((r.innerText || r.textContent || "").trim().split(String.fromCharCode(10))[0] || "").trim()));`;

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
    // Korean: "<name> 프로젝트 옵션 열기"; English: "Open project options for <name>".
    const opt = [...document.querySelectorAll('[aria-label*="프로젝트 옵션"],[aria-label*="project options" i]')].find((b) => (b.getAttribute("aria-label") || "").includes(${JSON.stringify(name)}));
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
  // --pro-mode selects a Pro sub-mode, so it is meaningless with a non-Pro
  // --model. Fail loudly instead of silently dropping the requested sub-mode.
  if (options.proMode && options.model && !/pro/i.test(options.model)) {
    throw new Error(`--pro-mode applies to the Pro model, but --model is "${options.model}". Drop --model (or set --model Pro) to choose a Pro sub-mode.`);
  }
  // Poll for the model selector button rather than checking once: right after a
  // new-chat navigation the composer form (and the selector inside it) has not
  // finished rendering yet, so a single check throws "model selector button not
  // found" even though the button appears a moment later.
  let button: RectHit = { ok: false };
  const buttonDeadline = Date.now() + 4_000;
  for (;;) {
    button = await cdp.evaluate<RectHit>(modelButtonRectExpression());
    if (button.ok && button.x !== undefined && button.y !== undefined) break;
    if (Date.now() >= buttonDeadline) break;
    await sleep(200);
  }
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
      const subLabels = PRO_MODE_SUBMENU_LABELS[options.proMode];
      const subVisible = await waitForExpressionTrue(cdp, menuItemPresentExpression(subLabels), MENU_OPEN_TIMEOUT_MS);
      if (!subVisible) throw new Error(`ChatGPT Pro sub-mode not found: ${subLabels.join(" / ")}`);
      const sub = await cdp.evaluate<RectHit>(submenuItemRectExpression(subLabels));
      if (!sub.ok || sub.x === undefined || sub.y === undefined) {
        throw new Error(sub.reason ?? `ChatGPT Pro sub-mode not clickable: ${subLabels.join(" / ")}`);
      }
      await verifiedClickAt(cdp, sub.x, sub.y, subLabels[0]);
      await assertSelectionCommitted(cdp, subLabels[0]);
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

    // A user-supplied model name is matched verbatim; efforts match any of the
    // per-locale labels for the canonical value.
    const primaryCandidates = options.model ? [options.model] : EFFORT_MENU_LABELS[options.effort as ChatGptReasoningEffort];
    const primary = await cdp.evaluate<RectHit>(menuItemRectExpression(primaryCandidates));
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
      document.querySelector('button[aria-label="새 프로젝트"],button[aria-label="New project"]') ||
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
  const port = resolveCdpPort(options.port);
  const timeoutMs = options.timeoutMs ?? 90_000;
  const sendStartedAt = Date.now();
  const emitProgress = (phase: SendChatGptProgressPhase, detail?: string): void => {
    if (!options.onProgress) return;
    try {
      options.onProgress({ phase, elapsedMs: Date.now() - sendStartedAt, ...(detail !== undefined ? { detail } : {}) });
    } catch {
      // Progress reporting must never break the send itself.
    }
  };
  emitProgress("connecting", `port ${port}`);
  const normalizedTargetUrl = options.targetUrl ? normalizeChatGptTargetUrl(options.targetUrl) : undefined;
  if (options.newChat && normalizedTargetUrl) {
    throw new Error("newChat cannot be combined with targetUrl: a fresh chat navigates away from the pinned tab.");
  }
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
  if (options.newChat) {
    // Long accumulated threads eventually break acceptance detection, so
    // start from a clean chat. Wait for the tab to actually reach the fresh
    // empty chat (root URL, zero messages) rather than a fixed sleep: a slow
    // SPA navigation could otherwise leave the old thread rendered, poisoning
    // the answer-count baseline captured below and causing a false timeout.
    await evaluateOnPage(page, `location.assign("https://chatgpt.com/")`);
    await waitForFreshChatGptPage(page, 8_000);
  }
  let status = await readSettledChatGptPageStatus(page);
  status = await ensureVisibleChatGptPage(port, page, status);
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
  emitProgress("tab_ready");
  // Progress details deliberately avoid project names (receipts redact them too).
  const selectionSummary = [
    options.model !== undefined ? `model=${options.model}` : undefined,
    options.proMode !== undefined ? `pro_mode=${options.proMode}` : undefined,
    options.effort !== undefined ? `effort=${options.effort}` : undefined,
    options.project !== undefined ? "project=set" : undefined,
    options.projectNew !== undefined ? "project_new=set" : undefined
  ]
    .filter((part): part is string => part !== undefined)
    .join(" ");
  if (selectionSummary) emitProgress("selecting", selectionSummary);
  // Env-gated send diagnostics (PRODEX_DEBUG_SEND=1) for field-debugging the
  // send/acceptance path; off by default, no user-facing effect.
  const dbgSend = (msg: string): void => {
    if (process.env.PRODEX_DEBUG_SEND) process.stderr.write(`DBG-SEND +${Date.now() - sendStartedAt}ms ${msg}\n`);
  };
  let beforeSubmit!: ChatGptAnswerState;
  let submitButtonFound = false;
  const cdp = await connectCdp(page.webSocketDebuggerUrl);
  try {
    await cdp.send("Runtime.enable");
    await selectProject(cdp, options);
    await selectModelReasoning(cdp, options);
    // Capture the answer baseline AFTER any project navigation or model switch
    // so assistant-message counts compare within the thread we actually send
    // into; a --project/--project-new hop lands on a page with its own counts.
    beforeSubmit = await evaluateOnPage<ChatGptAnswerState>(page, answerExpression());
    dbgSend(`baseline url=${beforeSubmit.url} user=${beforeSubmit.userMessageCount} assistant=${beforeSubmit.assistantMessageCount}`);
    await insertComposerTextViaCdp(cdp, options.prompt);
    // Submit. Prefer the Enter key: it goes to the focused composer and does
    // not depend on coordinates, whereas the send button moves ~100px as the
    // composer grows after the prompt lands, so a click at captured coordinates
    // can miss the button and never post (measured live: captured y=583 while
    // the button had already moved to y=693 - the core cause of intermittent
    // "ChatGPT never registered the prompt" failures). Verify the user message
    // actually appeared; only if Enter did not send (e.g. a config where Enter
    // inserts a newline) fall back to clicking the send button, re-reading
    // FRESH coordinates each attempt. Safe against double-submit: once the
    // prompt posts the composer clears and no send button is found.
    const promptPostedExpression = `document.querySelectorAll('[data-message-author-role="user"]').length > ${beforeSubmit.userMessageCount}`;
    await cdp.send("Input.dispatchKeyEvent", enterKeyEvent("keyDown"));
    await cdp.send("Input.dispatchKeyEvent", enterKeyEvent("keyUp"));
    let promptPosted = await waitForExpressionTrue(cdp, promptPostedExpression, 1_500);
    for (let attempt = 0; attempt < 3 && !promptPosted; attempt += 1) {
      const submitted = await cdp.evaluate<{ ok: boolean; x?: number; y?: number; reason?: string }>(submitExpression());
      if (submitted.ok && submitted.x !== undefined && submitted.y !== undefined) {
        submitButtonFound = true;
        await dispatchMouseClickAt(cdp, submitted.x, submitted.y);
        promptPosted = await waitForExpressionTrue(cdp, promptPostedExpression, 1_500);
      } else {
        await sleep(200);
      }
    }
    dbgSend(`submit posted=${promptPosted} submitButtonFound=${submitButtonFound}`);
  } finally {
    cdp.close();
  }
  emitProgress("sent", `timeout ${Math.round(timeoutMs / 1000)}s`);

  const started = Date.now();
  const acceptDeadline = computePromptAcceptanceDeadline(timeoutMs, started);
  let accepted = false;
  let finalState: ChatGptAnswerState | undefined;
  while (Date.now() < acceptDeadline) {
    await sleep(500);
    try {
      finalState = await evaluateOnPage<ChatGptAnswerState>(page, answerExpression());
    } catch {
      // Transient CDP failure (command timeout, mid-poll navigation): retry the
      // poll rather than aborting the whole send.
      continue;
    }
    const runtimeBlocker = chatGptBlockerFromAnswerState(finalState);
    if (runtimeBlocker) throw new ChatGptBrowserBlockerError(runtimeBlocker);
    dbgSend(`accept-poll url=${finalState.url} user=${finalState.userMessageCount} assistant=${finalState.assistantMessageCount} generating=${finalState.generating}`);
    if (hasChatGptPromptAcceptance(beforeSubmit, finalState)) {
      accepted = true;
      break;
    }
    emitProgress("waiting", "prompt posting");
  }
  if (!accepted) {
    // A successful submit clears the composer, so text still sitting there means
    // the send control did not register the prompt — the UI-changed signature.
    let composerStillHasText = false;
    try {
      const composerState = await evaluateOnPage<{ ok: boolean }>(page, composerTextStateExpression());
      composerStillHasText = composerState.ok;
    } catch {
      // best effort: fall back to submit-button signal only
    }
    throw acceptanceTimeoutError({ timeoutMs, composerStillHasText, submitButtonFound });
  }

  const answerIsStable = createChatGptAnswerStabilityTracker();
  while (Date.now() - started < timeoutMs) {
    await sleep(1000);
    try {
      finalState = await evaluateOnPage<ChatGptAnswerState>(page, answerExpression());
    } catch {
      // Transient CDP failure while the answer is streaming: retry. A throw here
      // would discard an already-streamed partial answer and skip the salvage
      // path below, so keep the last good state and poll again until timeout.
      continue;
    }
    const runtimeBlocker = chatGptBlockerFromAnswerState(finalState);
    if (runtimeBlocker) throw new ChatGptBrowserBlockerError(runtimeBlocker);
    emitProgress("waiting", finalState.generating ? "generating" : "stabilizing");
    if (!hasFreshChatGptAnswer(beforeSubmit.assistantMessageCount, finalState)) continue;
    // A "fresh" answer must also be stable: ChatGPT can momentarily look done
    // mid-stream, and the streaming caret renders as a literal trailing
    // character that can outlive the stop button. The tracker requires extra
    // confirmations for caret-suspect tails (see its doc comment).
    if (answerIsStable(finalState.answer, finalState.generating)) break;
  }
  const completed = finalState;
  if (completed && hasFreshChatGptAnswer(beforeSubmit.assistantMessageCount, completed)) {
    emitProgress("answered");
    return {
      url: completed.url,
      title: completed.title,
      answer: completed.answer.trim(),
      modelHints: completed.modelHints,
      warnings: []
    };
  }
  // Timed out while the answer was still streaming: salvage the partial text
  // (a truncated-but-real Pro answer is far more useful than losing it) and
  // flag it so the caller records the incompleteness and the retry hint.
  if (completed && hasPartialChatGptAnswer(beforeSubmit.assistantMessageCount, completed)) {
    emitProgress("answered", "partial");
    return {
      url: completed.url,
      title: completed.title,
      answer: completed.answer.trim(),
      modelHints: completed.modelHints,
      warnings: [
        `answer_incomplete: ChatGPT was still generating after ${timeoutMs}ms, so the answer below may be truncated. Raise --timeout-ms and retry for the full response.`
      ]
    };
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ChatGPT to respond. Raise --timeout-ms and retry (Pro extended already uses a higher default).`
  );
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
        label: (((it.innerText || it.textContent || "").trim().split(String.fromCharCode(10))[0]) || "").trim(),
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
  const port = resolveCdpPort(input.port);
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
  let status = await readSettledChatGptPageStatus(page);
  status = await ensureVisibleChatGptPage(port, page, status);
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

// Every CDP connect and command is bounded, even when the caller passes no
// explicit timeout, so a frozen browser (half-open TCP that never fires open,
// or a command that never gets a reply) rejects instead of leaving the poll
// loop blocked forever. The debug port is loopback, so any healthy single
// round-trip completes well under this ceiling.
const CDP_DEFAULT_TIMEOUT_MS = 20_000;

export function resolveCdpTimeoutMs(explicit?: number): number {
  return typeof explicit === "number" && explicit > 0 ? explicit : CDP_DEFAULT_TIMEOUT_MS;
}

async function connectCdp(webSocketUrl: string, timeoutMs?: number): Promise<{
  send: (method: string, params?: Record<string, unknown>) => Promise<CdpResponse>;
  evaluate: <T>(expression: string) => Promise<T>;
  close: () => void;
}> {
  const effectiveTimeoutMs = resolveCdpTimeoutMs(timeoutMs);
  const ws = new WebSocket(webSocketUrl);
  let id = 0;
  const pending = new Map<
    number,
    { resolve: (value: CdpResponse) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> }
  >();
  ws.addEventListener("message", (event) => {
    let message: CdpResponse;
    try {
      const data = typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer).toString("utf8");
      message = JSON.parse(data) as CdpResponse;
    } catch {
      // A malformed/binary frame must not throw inside the listener (it would
      // be uncaught); drop it - a real response arrives on a later frame or
      // the per-command timeout fires.
      return;
    }
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
  // Persistent error listener: the connect promise only registers a one-shot
  // "error" handler, so a second post-open "error" would otherwise be an
  // unhandled EventEmitter 'error' and crash the process. Reject any in-flight
  // commands (a "close" normally follows and clears the rest).
  ws.addEventListener("error", () => {
    for (const [messageId, waiter] of pending) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(new Error("Chrome DevTools websocket error"));
      pending.delete(messageId);
    }
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("Chrome DevTools websocket timed out"));
    }, Math.max(1, effectiveTimeoutMs));
    ws.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
    ws.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("Chrome DevTools websocket failed"));
      },
      { once: true }
    );
    // A socket that closes during connect without firing "error" would
    // otherwise wait the full timeout; fail fast instead.
    ws.addEventListener(
      "close",
      () => {
        clearTimeout(timer);
        reject(new Error("Chrome DevTools websocket closed during connect"));
      },
      { once: true }
    );
  });
  const send = (method: string, params: Record<string, unknown> = {}) => {
    const messageId = ++id;
    return new Promise<CdpResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(messageId);
        ws.close();
        reject(new Error(`Chrome DevTools command timed out: ${method}`));
      }, Math.max(1, effectiveTimeoutMs));
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

// In-page reasoning-header placeholder test, shared by statusExpression and
// answerExpression. MUST stay in sync with isUsableChatGptAnswer: a header
// ("Thinking", "Thought for 5s", "9s 동안 생각함") is a placeholder ONLY when it is
// the entire single line. A real answer that merely starts with "Thinking
// about..." must NOT be flagged as still-generating (it previously was, because
// the old regex matched any prefix - causing false send-refusals and false
// timeouts). Expects in-scope vars `ansStripped` (trimmed, trailing dots
// removed) and `ansLines` (non-empty lines).
export const CHATGPT_THINKING_PLACEHOLDER_JS =
  `ansLines.length <= 1 && (/^(생각\\s*중|thinking)$/i.test(ansStripped) || /^thought (for|about)\\b.*$/i.test(ansStripped) || /\\d+\\s*s\\s*동안\\s*생각함$/.test(ansStripped) || /(^|\\s)(생각\\s*중|thinking)$/i.test(ansStripped))`;

export function statusExpression(): string {
  const excludedTextSelector = JSON.stringify(CHATGPT_RUNTIME_BLOCKER_TEXT_EXCLUDED_ANCESTORS);
  const blockerScanExcludedSelector = JSON.stringify(CHATGPT_BLOCKER_SCAN_EXCLUDED_ANCESTORS);
  const streamingSelector = JSON.stringify(CHATGPT_STREAMING_SELECTOR);
  const generatingControlPattern = JSON.stringify(CHATGPT_GENERATING_CONTROL_PATTERN.source);
  const generatingControlFlags = JSON.stringify(CHATGPT_GENERATING_CONTROL_PATTERN.flags);
  return `(() => {
    ${composerExpressionHelpers()}
    const text = document.body?.innerText || "";
    const runtimeExcludedTextSelector = ${excludedTextSelector};
    const blockerScanExcludedSelector = ${blockerScanExcludedSelector};
    const generatingControlPattern = new RegExp(${generatingControlPattern}, ${generatingControlFlags});
    const visibleTextOutsideMessages = (excludedSelector) => {
      if (!document.body) return "";
      const parts = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const parent = node.parentElement;
        const value = node.nodeValue?.trim();
        if (!parent || !value) continue;
        if (parent.closest(excludedSelector)) continue;
        const style = window.getComputedStyle(parent);
        if (style.display === "none" || style.visibility === "hidden") continue;
        if (!(parent.offsetWidth || parent.offsetHeight || parent.getClientRects().length)) continue;
        parts.push(value);
      }
      return parts.join(String.fromCharCode(10));
    };
    const blockerText = visibleTextOutsideMessages(runtimeExcludedTextSelector);
    const blockerScanText = visibleTextOutsideMessages(blockerScanExcludedSelector);
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
    const placeholder = ${CHATGPT_THINKING_PLACEHOLDER_JS};
    const hasComposer = Boolean(findChatGptComposerCandidate());
    return {
      title: document.title,
      url: location.href,
      visibilityState: document.visibilityState,
      textSample: text.slice(0, 12000),
      blockerTextSample: blockerText.slice(0, 12000),
      blockerScanTextSample: blockerScanText.slice(0, 12000),
      visibleButtonLabels,
      hasComposer,
      generating: placeholder || Boolean(document.querySelector(${streamingSelector})) || visibleButtonLabels.some((label) => generatingControlPattern.test(label)),
      modelHints: lines.filter((line) => /GPT|Pro|Thinking|ChatGPT|Extra High|Auto/i.test(line)).slice(0, 30),
      openDialogText: (document.querySelector('[role="dialog"]')?.innerText || "").trim().slice(0, 200)
    };
  })()`;
}

// Focus, clear, and mark the real composer, WITHOUT inserting text. The prompt
// is typed separately via CDP Input.insertText: ChatGPT's ProseMirror editor
// ignores in-page execCommand/value writes for its internal model (the send
// button then submits an empty message), whereas native CDP-typed input is
// processed correctly. Returns ok so the caller can insert next.
export function prepareComposerExpression(): string {
  return `(() => {
    ${composerExpressionHelpers()}
    const el = findChatGptComposerCandidate();
    if (!el) return { ok: false, reason: "No visible composer" };
    // Clear any stale active-composer marks but do NOT set one: writing a custom
    // attribute onto the composer form makes ChatGPT's React re-render and reset
    // the ProseMirror editor, so the subsequent send posts an empty message.
    // Submit finds the composer fresh instead.
    document.querySelectorAll('[' + activeComposerAttribute + '="true"]').forEach((node) => node.removeAttribute(activeComposerAttribute));
    el.focus();
    // Only the fallback <textarea> is cleared in-page. For the ProseMirror
    // contenteditable editor we do NOT touch the DOM selection here: an in-page
    // Selection API select-all (or execCommand) desyncs ProseMirror's internal
    // state so the composer shows the text and the send button enables, but a
    // click never actually submits (measured live with an A/B repro). Clearing
    // is done submit-safely via native CDP keyboard events in the caller.
    if ("value" in el) {
      el.value = "";
      el.dispatchEvent(new InputEvent("input", { inputType: "deleteContentBackward", bubbles: true, composed: true }));
    }
    const hasText = ("value" in el ? el.value : el.innerText || el.textContent || "").trim().length > 0;
    return { ok: true, hasText };
  })()`;
}

// Read back the composer's current text and verify it MATCHES the prompt (not
// just that it is non-empty): a failed clear would leave stale text prepended,
// silently submitting a contaminated prompt. Whitespace is collapsed on both
// sides because ProseMirror round-trips newlines as extra blank lines.
export function composerTextStateExpression(expectedText?: string): string {
  const expectedJson = JSON.stringify(expectedText ?? null);
  return `(() => {
    ${composerExpressionHelpers()}
    const el = findChatGptComposerCandidate();
    if (!el) return { ok: false, reason: "No visible composer" };
    const raw = ("value" in el ? el.value : el.innerText || el.textContent || "").trim();
    if (!raw) return { ok: false, reason: "Composer stayed empty after text insertion" };
    const expected = ${expectedJson};
    if (expected === null) return { ok: true, actualText: raw.slice(0, 120) };
    const norm = (s) => s.replace(/\\s+/g, " ").trim();
    if (norm(raw) !== norm(expected)) {
      return { ok: false, reason: "Composer text did not match the prompt after insertion (possible leftover text in the composer)", actualText: raw.slice(0, 120) };
    }
    return { ok: true, actualText: raw.slice(0, 120) };
  })()`;
}

// Focus the composer, clear any leftover text submit-safely, type the prompt
// with native CDP input so ProseMirror registers it, then verify the composer
// holds exactly the prompt.
async function insertComposerTextViaCdp(cdp: CdpConnection, text: string): Promise<void> {
  const prepared = await cdp.evaluate<{ ok: boolean; reason?: string; hasText?: boolean }>(prepareComposerExpression());
  if (!prepared.ok) throw new Error(prepared.reason ?? "Could not focus the ChatGPT composer");
  // Clear leftover text (e.g. from a prior failed send) via native keyboard
  // events - Ctrl+A then Backspace - which ProseMirror processes without the
  // state desync that an in-page Selection API clear causes. Skipped when the
  // composer is already empty (the common fresh-chat case) to avoid needless
  // key events.
  if (prepared.hasText) {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    await sleep(100);
  }
  await cdp.send("Input.insertText", { text });
  await sleep(200);
  const state = await cdp.evaluate<{ ok: boolean; reason?: string }>(composerTextStateExpression(text));
  if (!state.ok) throw new Error(state.reason ?? "Composer stayed empty after text insertion");
}

export function submitExpression(): string {
  return `(() => {
    ${composerExpressionHelpers()}
    const markedRoot = findMarkedChatGptComposerRoot();
    const composer = markedRoot ? undefined : findChatGptComposerCandidate();
    const root = markedRoot || (composer ? findChatGptComposerRoot(composer) : undefined);
    const button = root ? findChatGptSubmitButton(root) : undefined;
    if (!button) return { ok: false, reason: "No enabled submit button" };
    // Return the button's click point; the caller performs a real CDP mouse
    // click because ChatGPT ignores a synthetic button.click().
    button.scrollIntoView({ block: "center", inline: "nearest" });
    const r = button.getBoundingClientRect();
    return { ok: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`;
}

function composerExpressionHelpers(): string {
  const excludedTextSelector = JSON.stringify(CHATGPT_COMPOSER_CANDIDATE_EXCLUDED_ANCESTORS);
  const activeComposerAttribute = JSON.stringify(PRODEX_ACTIVE_COMPOSER_ATTRIBUTE);
  return `
    const excludedTextSelector = ${excludedTextSelector};
    const activeComposerAttribute = ${activeComposerAttribute};
    // Require real on-screen size. ChatGPT ships a hidden 0x0 fallback <textarea>
    // (class wcDTda_fallbackTextarea) that precedes the real ProseMirror editor
    // in the DOM; getClientRects().length alone counts it as visible, so the
    // composer finder would pick it, set its .value (a false "ok"), and submit
    // the still-empty real editor. A width/height gate excludes it.
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
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
  const blockerScanExcludedSelector = JSON.stringify(CHATGPT_BLOCKER_SCAN_EXCLUDED_ANCESTORS);
  const streamingSelector = JSON.stringify(CHATGPT_STREAMING_SELECTOR);
  const generatingControlPattern = JSON.stringify(CHATGPT_GENERATING_CONTROL_PATTERN.source);
  const generatingControlFlags = JSON.stringify(CHATGPT_GENERATING_CONTROL_PATTERN.flags);
  return `(() => {
    const text = document.body?.innerText || "";
    const excludedTextSelector = ${excludedTextSelector};
    const blockerScanExcludedSelector = ${blockerScanExcludedSelector};
    const generatingControlPattern = new RegExp(${generatingControlPattern}, ${generatingControlFlags});
    const visibleTextOutsideMessages = (excludedSelector) => {
      if (!document.body) return "";
      const parts = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const parent = node.parentElement;
        const value = node.nodeValue?.trim();
        if (!parent || !value) continue;
        if (parent.closest(excludedSelector)) continue;
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
    const placeholder = ${CHATGPT_THINKING_PLACEHOLDER_JS};
    return {
      title: document.title,
      url: location.href,
      answer: assistant ? answer : text.slice(-4000),
      textSample: text.slice(0, 12000),
      blockerTextSample: visibleTextOutsideMessages(excludedTextSelector).slice(0, 12000),
      blockerScanTextSample: visibleTextOutsideMessages(blockerScanExcludedSelector).slice(0, 12000),
      visibleButtonLabels: buttons,
      generating: placeholder || Boolean(document.querySelector(${streamingSelector})) || buttons.some((label) => generatingControlPattern.test(label)),
      assistantMessageCount: assistantMessages.length,
      userMessageCount: userMessages.length,
      modelHints: lines.filter((line) => /GPT|Pro|Thinking|ChatGPT|Extra High|Auto/i.test(line)).slice(0, 30)
    };
  })()`;
}

function enterKeyEvent(type: "keyDown" | "keyUp"): Record<string, unknown> {
  return { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
}

const CHROME_PATH_BINARY_NAMES = ["google-chrome", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"] as const;

const DARWIN_CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
] as const;

function win32ChromePaths(env: Record<string, string | undefined>): string[] {
  return [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ...(env.LOCALAPPDATA ? [`${env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`] : []),
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  ];
}

const WSL_WINDOWS_CHROME_PATHS = [
  "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
  "/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
] as const;

function kernelLooksLikeWsl(): boolean {
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

/**
 * Ordered browser candidates for the current platform: PATH binary names
 * first, then well-known absolute install locations (macOS app bundles,
 * Windows Program Files/LOCALAPPDATA, and Windows-host browsers under WSL).
 * WSL detection cannot rely on WSL_DISTRO_NAME alone: non-login shells
 * (measured live) may not carry it, so WSL_INTEROP and the kernel string are
 * probed too.
 */
export function chromeCommandCandidates(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  isWsl: () => boolean = kernelLooksLikeWsl
): string[] {
  const candidates: string[] = [...CHROME_PATH_BINARY_NAMES];
  if (platform === "darwin") candidates.push(...DARWIN_CHROME_PATHS);
  if (platform === "win32") candidates.push(...win32ChromePaths(env));
  if (platform === "linux" && (env.WSL_DISTRO_NAME || env.WSL_INTEROP || isWsl())) {
    candidates.push(...WSL_WINDOWS_CHROME_PATHS);
  }
  return candidates;
}

function resolveChromeCommand(): string {
  const fromEnv = process.env.PRODEX_CHROME;
  if (fromEnv) {
    assertChromeCommandAvailable(fromEnv, "PRODEX_CHROME");
    return fromEnv;
  }
  for (const command of chromeCommandCandidates()) {
    if (isPathLikeCommand(command)) {
      try {
        if (!statSync(command).isFile()) continue;
      } catch {
        continue;
      }
      if (hasChromeLikeVersion(command)) return command;
      continue;
    }
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
