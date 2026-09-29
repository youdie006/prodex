import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { promisify } from "node:util";
import { assertOnlyOptions, printHelpIfRequested, readFlag, readPositiveNumberFlag } from "./cli-args.js";
import { createLoginContainer, discoverLoginContainer } from "./login-container.js";

interface LoginIO { stdout: (line: string) => void; stderr: (line: string) => void; }
interface ViewerOptions {
  upstreamUrl: string;
  readPassword: () => Promise<string>;
  getStatus: () => Promise<{ ready: boolean; blocker: string | null }>;
  timeoutMs: number;
}
interface Viewer {
  launchUrl: string;
  close: () => Promise<void>;
  completed: Promise<"ready" | "timeout" | "cancelled">;
}
export interface LoginDeps {
  discover: typeof discoverLoginContainer;
  createContainer: typeof createLoginContainer;
  startViewer: (options: ViewerOptions) => Promise<Viewer>;
  open: (url: string) => Promise<void>;
  env: NodeJS.ProcessEnv;
  signals: EventEmitter;
}

export function printLoginHelp(stdout: LoginIO["stdout"]): void {
  stdout(`prodex login

Usage: prodex login [--context NAME] [--container NAME] [--timeout-ms 600000] [--check] [--local-screen]

Connect to an existing local ProDex container browser. Saved logins are reused.
If needed, open a private temporary viewer on THIS computer; sign into ChatGPT
yourself. No viewer password copying, ports, or Docker commands are required.

--check          Read readiness only; no viewer, credential access or tab opening.
--context NAME   Choose a local Docker/Colima context when more than one matches.
--container NAME Choose a managed ProDex browser container explicitly.
--timeout-ms N   Stop waiting after 1000..1200000ms (default: 600000).
--local-screen   When invoked through SSH, explicitly use the SSH host's desktop.

Docker/Colima and the existing ProDex browser service must already be running.
This command never installs, replaces or restarts a service, copies a browser
profile, solves security prompts, sends a ChatGPT prompt, or changes MCP routing.
Closing the temporary viewer does not stop the browser service.`);
}

export function buildLoginOpenCommand(url: string, platform = process.platform, env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || !parsed.port || parsed.username || parsed.password ||
      parsed.pathname !== "/" || parsed.search || !/^#[A-Za-z0-9_-]{32,128}$/.test(parsed.hash)) {
    throw new Error("Invalid local login URL.");
  }
  if (platform === "darwin") return { command: "open", args: [url] };
  const wsl = platform === "linux" && Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP);
  if (platform === "win32" || wsl) {
    return { command: wsl ? "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe" : "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", `Start-Process -FilePath '${url}'`] };
  }
  if (platform === "linux" && (env.DISPLAY || env.WAYLAND_DISPLAY)) return { command: "xdg-open", args: [url] };
  throw new Error("No local desktop display was detected. Run prodex login on the computer where you will sign in.");
}

async function openLoginScreen(url: string): Promise<void> {
  const plan = buildLoginOpenCommand(url);
  try { await promisify(execFile)(plan.command, plan.args, { timeout: 10_000, killSignal: "SIGKILL", windowsHide: true, maxBuffer: 8192 }); }
  catch { throw new Error("Could not open the local login screen. Check the default browser and run prodex login on your desktop computer."); }
}

function defaultDeps(): LoginDeps {
  return { discover: discoverLoginContainer, createContainer: createLoginContainer,
    startViewer: async options => (await import("./login-viewer.js")).startLoginViewer(options),
    open: openLoginScreen, env: process.env, signals: process };
}

export async function runLoginCommand(args: string[], io: LoginIO, deps: LoginDeps = defaultDeps()): Promise<number> {
  const values = ["--context", "--container", "--timeout-ms"];
  const booleans = ["--check", "--local-screen"];
  if (printHelpIfRequested(args, "login", io.stdout, printLoginHelp, { valueFlags: values, booleanFlags: booleans })) return 0;
  assertOnlyOptions(args, "login", values, booleans);
  for (const flag of [...values, ...booleans]) if (args.filter(x => x === flag).length > 1) throw new Error(`${flag} may only be specified once.`);
  const timeoutMs = readPositiveNumberFlag(args, "--timeout-ms") ?? 600_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 1_200_000) throw new Error("Login timeout must be 1000..1200000 milliseconds.");
  const target = await deps.discover({ context: readFlag(args, "--context"), container: readFlag(args, "--container") }, undefined, deps.env);
  if (!target.running) throw new Error("The existing ProDex browser service is stopped. Start that service first; no replacement or new profile was created.");
  const container = deps.createContainer(target);
  let status = await container.status();
  const showReady = () => io.stdout(`login: READY - saved ChatGPT session is usable (${target.context}, ${target.name}). No prompt was sent.`);
  if (status.ready) { showReady(); return 0; }
  if (args.includes("--check")) { io.stdout(`login: NOT READY - ${status.blocker ?? "not_ready"} (${target.context}).`); return 2; }
  if (!status.reachable) throw new Error("The existing browser is not reachable. No replacement browser or login window was started.");
  if (status.mode !== "headed") throw new Error("The current browser mode has no verified interactive display. No mode switch or new login was attempted.");
  if ((deps.env.SSH_CONNECTION || deps.env.SSH_CLIENT || deps.env.SSH_TTY) && !args.includes("--local-screen")) {
    throw new Error("This is an SSH session. Run prodex login on the viewer computer, or use --local-screen to explicitly open the SSH host's desktop.");
  }
  if (status.blocker === "chatgpt_page_missing") {
    await container.ensureTab();
    status = await container.status();
    if (status.ready) { showReady(); return 0; }
  }
  if (!status.reachable || status.mode !== "headed") throw new Error("The existing browser is no longer ready for a manual login screen.");
  const viewer = await deps.startViewer({ upstreamUrl: target.viewerUrl, readPassword: container.readPassword,
    getStatus: async () => { const s = await container.status(); return { ready: s.ready, blocker: s.blocker }; }, timeoutMs });
  let cancelled!: (value: "cancelled") => void;
  const cancellation = new Promise<"cancelled">(resolve => { cancelled = resolve; });
  let signalCode = 130;
  const interrupt = () => { signalCode = 130; cancelled("cancelled"); };
  const terminate = () => { signalCode = 143; cancelled("cancelled"); };
  deps.signals.on("SIGINT", interrupt);
  deps.signals.on("SIGTERM", terminate);
  try {
    try { await deps.open(viewer.launchUrl); }
    catch { throw new Error("Could not open the local login screen. Run prodex login on the computer where your browser is displayed."); }
    io.stdout(`login: screen opened on this computer (${target.context}). Complete ChatGPT sign-in in that screen; no viewer password is needed.`);
    io.stderr("login: waiting for readiness. Security prompts require your manual action; Ctrl+C stops only this temporary viewer.");
    const outcome = await Promise.race([viewer.completed, cancellation]);
    if (outcome === "cancelled") { io.stderr("login: cancelled. The browser and saved profile were left running."); return signalCode; }
    if (outcome === "ready" && (await container.status()).ready) { showReady(); return 0; }
    io.stderr("login: NOT READY - the login wait ended. The existing browser and profile were preserved; no prompt was sent.");
    return 2;
  } finally {
    deps.signals.removeListener("SIGINT", interrupt);
    deps.signals.removeListener("SIGTERM", terminate);
    await viewer.close();
  }
}
