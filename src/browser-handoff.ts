import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import {
  ChatGptBrowserBlockerError, attachmentPresenceExpression, composerTextStateExpression, detectChatGptPageBlocker,
  findLaunchedBrowserProcesses, inferChatGptPageLoggedInLikely, statusExpression, type DevtoolsPage
} from "./chatgpt-browser.js";

type PageStatus = Parameters<typeof detectChatGptPageBlocker>[0] & {
  url: string; hasComposer: boolean; generating: boolean; awaitingResponseChoice?: boolean; openDialogText?: string;
};
type IdleState = { status: PageStatus; draft: boolean; dialog: boolean; attachments: boolean; unpersisted: boolean };
type Identity = { main: number; pids: number[]; headless: boolean };

function blocked(message: string): never {
  throw new ChatGptBrowserBlockerError({
    code: "browser_handoff_blocked", message, retryable: false,
    next_step: "Inspect the dedicated browser and keep only the intended idle ChatGPT tab open, then retry `prodex pro browser login --background`. Complete a login or permission step only if it is actually shown. Do not close active work or log in again solely because the handoff stopped."
  });
}

function browserIdentity(port: number, profileDir: string): Identity {
  const listed = spawnSync("ps", ["-Ao", "user,pid,command"], { encoding: "utf8", timeout: 5_000 });
  if (listed.status !== 0 || typeof listed.stdout !== "string") blocked("Could not verify the dedicated browser process.");
  const pids = findLaunchedBrowserProcesses(listed.stdout, { port, profileDir });
  const mains = listed.stdout.split(/\r?\n/).filter((line) => {
    const pid = Number(/^\s*\S+\s+(\d+)\s/.exec(line)?.[1]);
    return pids.includes(pid) && !/\s--type=/.test(line) && new RegExp(`--remote-debugging-port=${port}(?!\\d)`).test(line);
  });
  if (mains.length !== 1) blocked("Could not identify exactly one dedicated browser for this port.");
  if (/\s--(?:incognito|guest)(?:\s|=|$)/.test(mains[0])) blocked("An incognito or guest browser cannot preserve its login through a restart.");
  if (/\s--profile-directory(?:\s|=|$)/.test(mains[0])) blocked("An explicitly selected Chrome sub-profile cannot be preserved by this handoff; no browser was closed.");
  const actualProfile = /--user-data-dir=(.*?)(?=\s--|$)/.exec(mains[0])?.[1];
  if (!actualProfile || !path.isAbsolute(actualProfile)) blocked("The browser profile could not be verified.");
  try {
    if (realpathSync(actualProfile) !== realpathSync(profileDir)) blocked("The actual browser profile differs from the requested profile.");
  } catch (error) {
    if (error instanceof ChatGptBrowserBlockerError) throw error;
    blocked("The browser profile path could not be verified.");
  }
  return { main: Number(/^\s*\S+\s+(\d+)\s/.exec(mains[0])![1]), pids, headless: /\s--headless(?:\s|=|$)/.test(mains[0]) };
}

export function getDedicatedBrowserHeadlessMode(options: { port: number; profileDir: string }): boolean {
  return browserIdentity(options.port, options.profileDir).headless;
}

async function readJson(port: number, resource: string): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${port}/json/${resource}`, { signal: AbortSignal.timeout(2_000) });
  if (!response.ok) blocked(`The browser did not answer the ${resource} identity check.`);
  return response.json();
}

function localSocket(value: unknown, port: number, kind: "page" | "browser"): string {
  if (typeof value !== "string") blocked("Missing browser control socket.");
  const url = new URL(value);
  if (url.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      Number(url.port) !== port || url.username || url.password || !url.pathname.startsWith(`/devtools/${kind}/`)) {
    blocked("The control socket is not bound to the expected local browser.");
  }
  return value;
}

async function singlePage(port: number): Promise<DevtoolsPage> {
  const response = await readJson(port, "list");
  if (!Array.isArray(response)) blocked("The browser page list is invalid.");
  const pages = response.filter((page) => page?.type === "page");
  if (pages.length !== 1) {
    const chooser = pages.find((page) => page.url === "chrome://signin-dice-web-intercept.top-chrome/chrome-signin");
    if (chooser) {
      let state: { visibilityState?: unknown; width?: unknown; height?: unknown; isChooser?: unknown } | undefined;
      try {
        const socket = localSocket(chooser.webSocketDebuggerUrl, port, "page");
        const reply = await request(socket, "Runtime.evaluate", {
          expression: `(() => { const r = document.body?.getBoundingClientRect(); return { visibilityState: document.visibilityState, width: r?.width, height: r?.height, isChooser: !!document.querySelector('chrome-signin-app') }; })()`,
          returnByValue: true
        }) as { result?: { value?: typeof state }; exceptionDetails?: unknown };
        if (!reply.exceptionDetails) state = reply.result?.value;
      } catch { /* An unreadable internal target is not proof of a visible prompt. */ }
      if (state?.visibilityState === "visible" && state.isChooser === true &&
          typeof state.width === "number" && state.width > 0 && typeof state.height === "number" && state.height > 0) {
        throw new ChatGptBrowserBlockerError({
          code: "browser_account_confirmation", retryable: false,
          message: "Chrome is showing its browser-account connection chooser. This is separate from ChatGPT login; no browser was closed.",
          next_step: "Choose in the dedicated Chrome window yourself. 'Use Chrome without an account' declines Chrome account connection if you do not want it. Keep the ChatGPT tab open, then retry `prodex pro browser login --background`."
        });
      }
      blocked("Chrome has an internal account target, but its chooser visibility was not confirmed. This does not establish a ChatGPT login problem; nothing was closed.");
    }
    blocked("The dedicated browser has additional page targets; nothing was closed.");
  }
  const page = pages[0] as DevtoolsPage;
  const url = new URL(page.url);
  if (url.protocol !== "https:" || url.hostname !== "chatgpt.com" || url.username || url.password || url.port ||
      url.searchParams.has("temporary-chat") || !page.id) {
    blocked("Handoff requires one normal, non-temporary ChatGPT page.");
  }
  localSocket(page.webSocketDebuggerUrl, port, "page");
  return page;
}

// Unlike normal send connections this must not enable Page or answer dialogs.
async function request(socketUrl: string, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl);
    let sent = false;
    let finished = false;
    const finish = (error?: Error, value?: unknown): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.on("error", () => {});
      socket.terminate();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`${method} timed out; browser handoff stopped.`)), 5_000);
    socket.once("open", () => {
      try {
        socket.send(JSON.stringify({ id: 1, method, params }));
        sent = true;
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
    socket.on("message", (data) => {
      let reply: { id?: number; error?: { message?: string }; result?: unknown };
      try { reply = JSON.parse(data.toString()); } catch { return; }
      if (reply.id === 1) finish(reply.error ? new Error(reply.error.message ?? "CDP command failed") : undefined, reply.result);
    });
    socket.once("error", (error) => finish(error));
    socket.once("close", () => finish(method === "Browser.close" && sent ? undefined : new Error("Browser control socket closed before verification.")));
  });
}

async function verifyIdle(page: DevtoolsPage): Promise<void> {
  const expression = `(() => {
    const status = ${statusExpression()};
    const composer = ${composerTextStateExpression()};
    const visible = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
    const attachmentState = ${attachmentPresenceExpression()};
    return { status,
      draft: composer.ok !== false || composer.reason !== 'Composer stayed empty after text insertion',
      dialog: [...document.querySelectorAll('dialog[open],[role="dialog"],[aria-modal="true"]')].some(visible),
      attachments: attachmentState.removed > 0 || [...document.querySelectorAll('input[type="file"]')].some(e => e.files?.length > 0) || [...document.querySelectorAll('[role="progressbar"]')].some(visible),
      unpersisted: !location.pathname.includes('/c/') && !!document.querySelector('[data-message-author-role]')
    };
  })()`;
  const reply = await request(page.webSocketDebuggerUrl, "Runtime.evaluate", { expression, returnByValue: true }) as {
    result?: { value?: IdleState }; exceptionDetails?: unknown;
  };
  const value = reply?.result?.value;
  if (reply?.exceptionDetails || !value?.status || [value.draft, value.dialog, value.attachments, value.unpersisted].some((v) => typeof v !== "boolean")) {
    blocked("Could not verify the page's input and dialog state.");
  }
  const state = value.status;
  if (state.url !== page.url || !state.hasComposer || !inferChatGptPageLoggedInLikely(state) || detectChatGptPageBlocker(state)) {
    blocked("ChatGPT is not ready in the expected conversation; no browser was closed.");
  }
  if (state.generating || state.awaitingResponseChoice || state.openDialogText || value.draft || value.dialog || value.attachments || value.unpersisted) {
    blocked("The page has active work, unfinished input, attachments, or a dialog; no browser was closed.");
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Caller holds the shared browser send lock through this close AND relaunch. */
export async function closeIdleChatGptBrowserForHandoff(options: { port: number; profileDir: string }): Promise<{ url: string }> {
  const { port, profileDir } = options;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !path.isAbsolute(profileDir)) blocked("Invalid browser handoff identity.");
  const identity = browserIdentity(port, profileDir);
  const page = await singlePage(port);
  const version = await readJson(port, "version") as { webSocketDebuggerUrl?: unknown };
  const socket = localSocket(version?.webSocketDebuggerUrl, port, "browser");
  await verifyIdle(page);
  const current = await singlePage(port);
  const currentVersion = await readJson(port, "version") as { webSocketDebuggerUrl?: unknown };
  if (current.id !== page.id || current.url !== page.url || current.webSocketDebuggerUrl !== page.webSocketDebuggerUrl ||
      currentVersion.webSocketDebuggerUrl !== socket || browserIdentity(port, profileDir).main !== identity.main) {
    blocked("The browser or conversation changed during handoff verification.");
  }
  await verifyIdle(current);
  await request(socket, "Browser.close");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!identity.pids.some(alive)) {
      try { await readJson(port, "version"); } catch (error) {
        const cause = (error as Error & { cause?: NodeJS.ErrnoException }).cause;
        if (cause?.code === "ECONNREFUSED") return { url: page.url };
        blocked("The old browser exited, but its control port could not be verified closed.");
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  blocked("The dedicated browser did not finish closing. It was not force-killed and no replacement was launched.");
}
