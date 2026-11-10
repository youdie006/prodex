#!/usr/bin/env node
import { execFile as execFileCallback, spawn as nodeSpawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const DEFAULT_CONTAINER = "prodex-browser-browser-1";
const BRIDGE_CWD = "/home/node/bridge";
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const PASSWORD = /^[A-Za-z0-9_-]{8}$/;

const STATUS_EXPRESSION = `import { readFile } from 'node:fs/promises';
import { getChatGptBrowserStatus, defaultChatGptProfileDir } from '/app/dist/chatgpt-browser.js';
import { inspectBrowserProcesses, findMatchingBrowserProcesses, isMainBrowserProcess, browserProcessHasFlag } from '/app/dist/browser-process.js';
const version = JSON.parse(await readFile('/app/package.json', 'utf8')).version;
let browser_mode = 'unknown';
try {
  const matches = findMatchingBrowserProcesses(inspectBrowserProcesses(), { port: 9333, profileDir: defaultChatGptProfileDir() }).filter(isMainBrowserProcess);
  if (matches.length === 1) browser_mode = browserProcessHasFlag(matches[0], 'headless') ? 'headless' : 'headed';
} catch { /* Process inspection is evidence, not a configuration hint. */ }
try {
  const s = await getChatGptBrowserStatus({ timeoutMs: 5000 });
  const ready = s.reachable === true && s.loggedInLikely === true && s.hasComposer === true && !s.blocker;
  const blocker = s.blocker?.code ?? (!s.reachable ? 'browser_unreachable' : !s.loggedInLikely ? 'login_required' : !s.hasComposer ? 'composer_not_ready' : null);
  process.stdout.write(JSON.stringify({ version, browser_mode, browser_reachable: s.reachable === true, ready, blocker }));
} catch {
  process.stdout.write(JSON.stringify({ version, browser_mode, browser_reachable: false, ready: false, blocker: 'status_unavailable' }));
}`;

const PASSWORD_EXPRESSION = `import { open } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
const file = await open('/home/node/.vnc/viewer-password', fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
try {
  const s = await file.stat();
  if (!s.isFile() || s.nlink !== 1 || s.size > 9 || (s.mode & 0o077) !== 0 || s.uid !== process.getuid()) throw new Error('Invalid private viewer password file');
  const value = await file.readFile('utf8');
  if (!/^[A-Za-z0-9_-]{8}\\n?$/.test(value)) throw new Error('Invalid saved viewer password');
  process.stdout.write(value.trim());
} finally { await file.close(); }`;

function name(value, flag) {
  if (typeof value !== "string" || !NAME.test(value)) throw new Error(`${flag} needs a safe Docker name (letters, digits, dot, underscore, hyphen).`);
  return value;
}

function port(value) {
  if (!/^[0-9]+$/.test(value ?? "")) throw new Error("--forwarded-port must be an integer from 1 to 65535.");
  const number = Number(value);
  if (number < 1 || number > 65535) throw new Error("--forwarded-port must be an integer from 1 to 65535.");
  return number;
}

export function parseClientArgs(argv) {
  let context;
  let container = DEFAULT_CONTAINER;
  let seenContainer = false;
  let index = 0;
  while (index < argv.length && argv[index].startsWith("-")) {
    const flag = argv[index++];
    if (flag !== "--context" && flag !== "--container") throw new Error(`Unknown global option: ${flag}.`);
    const value = name(argv[index++], flag);
    if (flag === "--context") {
      if (context !== undefined) throw new Error("--context may only be specified once.");
      context = value;
    } else {
      if (seenContainer) throw new Error("--container may only be specified once.");
      container = value;
      seenContainer = true;
    }
  }
  const command = argv[index++] ?? "help";
  if (!["status", "mcp", "pro", "viewer", "help"].includes(command)) throw new Error(`Unknown command: ${command}.`);
  const rest = argv.slice(index);
  if (command === "pro") return { context, container, command, rest };
  if (command !== "viewer" && rest.length) throw new Error(`${command} does not accept arguments.`);
  if (command !== "viewer") return { context, container, command, rest: [] };
  let forwardedPort;
  let copyPassword = false;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--forwarded-port") {
      if (forwardedPort !== undefined) throw new Error("--forwarded-port may only be specified once.");
      forwardedPort = port(rest[++i]);
    } else if (rest[i] === "--copy-password") {
      if (copyPassword) throw new Error("--copy-password may only be specified once.");
      copyPassword = true;
    } else throw new Error(`Unknown viewer option: ${rest[i]}.`);
  }
  return { context, container, command, rest: [], forwardedPort, copyPassword };
}

function contextArgs(target) {
  return target.context ? ["--context", target.context] : [];
}

export function buildDockerExecArgs(target, argv, env = []) {
  return [...contextArgs(target), "exec", "-i", "--workdir", "/app", "-e", "PRODEX_NO_AUTO_LOGIN=1", ...env, target.container, ...argv];
}

const BROWSER_DEFAULTS = ["PRODEX_DEFAULT_MODEL", "PRODEX_DEFAULT_EFFORT", "PRODEX_DEFAULT_PRO_MODE", "PRODEX_DEFAULT_PROJECT"];

// The MCP server runs inside the container, so the env block of the client's
// MCP entry never reached it, and a consult that named no model ran on whatever
// another session had left selected in the shared browser. Pass the client's
// browser defaults on, and ask for Pro, as `pro` does, when none of them names
// a model or a reasoning step.
export function buildMcpServerArgs(target, env = process.env) {
  const value = key => {
    const raw = typeof env[key] === "string" ? env[key].trim() : "";
    return raw && !/[\r\n\0]/.test(raw) ? raw : undefined;
  };
  const pass = BROWSER_DEFAULTS.filter(value).flatMap(key => ["-e", `${key}=${value(key)}`]);
  const selects = value("PRODEX_DEFAULT_MODEL") !== undefined || value("PRODEX_DEFAULT_EFFORT") !== undefined;
  return buildDockerExecArgs(target, ["node", "/app/dist/cli.js", "mcp", "--cwd", BRIDGE_CWD],
    selects ? pass : [...pass, "-e", "PRODEX_DEFAULT_MODEL=Pro"]);
}

function oneShotExecBody(target, expression) {
  return ["exec", "--workdir", "/app", "-e", "PRODEX_NO_AUTO_LOGIN=1",
    target.container, "node", "--input-type=module", "-e", expression];
}

export function buildStatusReadArgs(target) {
  return [...contextArgs(target), ...oneShotExecBody(target, STATUS_EXPRESSION)];
}

export function buildPasswordReadArgs(target) {
  return [...contextArgs(target), ...oneShotExecBody(target, PASSWORD_EXPRESSION)];
}

export function buildProArgs(rest) {
  const delimiter = rest.indexOf("--");
  const options = delimiter < 0 ? rest : rest.slice(0, delimiter);
  for (const flag of ["--auto-login", "--cwd", "--source-cli", "--port"]) {
    if (options.includes(flag)) throw new Error(`${flag} is unavailable: this client uses the fixed private bridge and browser.`);
  }
  if (options.includes("--dry-run") || options.includes("--send")) throw new Error("pro is an explicit browser send; omit --send/--dry-run.");
  const selected = ["--effort", "--model", "--pro-mode"].some(flag => options.includes(flag));
  return ["node", "/app/dist/cli.js", "pro", "browser", "ask", "--cwd", BRIDGE_CWD, "--no-auto-login",
    ...(selected ? [] : ["--effort", "Pro"]), ...rest];
}

function endpointLabel(target) {
  return target.context ? `Docker context ${target.context}` : "the DOCKER_HOST endpoint";
}

function notRunning(inspect, target) {
  const status = typeof inspect?.State?.Status === "string" && /^[a-z]{1,20}$/.test(inspect.State.Status) ? ` (${inspect.State.Status})` : "";
  const start = ["docker", ...contextArgs(target), "start", target.container].join(" ");
  return `${target.container} is not running${status} in ${endpointLabel(target)}; start it with \`${start}\`, then retry. This client never starts it.`;
}

function assertRunning(inspect, target) {
  if (inspect?.State?.Running !== true) throw new Error(notRunning(inspect, target));
}

function safeToken(value, fallback = "unknown") {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/.test(value) ? value : fallback;
}

export function parseStatus(target, inspect, runtime) {
  assertRunning(inspect, target);
  const context = target.contextLabel ?? target.context;
  if (!context || !NAME.test(context)) throw new Error("Selected Docker context is unknown; status refused.");
  const health = inspect.State.Health?.Status;
  return {
    context,
    container: target.container,
    image: typeof inspect.Config?.Image === "string" && /^[A-Za-z0-9][A-Za-z0-9_./:@+-]{0,199}$/.test(inspect.Config.Image)
      ? inspect.Config.Image : "unknown",
    image_id: typeof inspect.Image === "string" && /^sha256:[a-f0-9]{64}$/.test(inspect.Image) ? inspect.Image : "unknown",
    version: safeToken(runtime?.version),
    running: true,
    health: ["healthy", "unhealthy", "starting"].includes(health) ? health : "none",
    browser_mode: ["headed", "headless"].includes(runtime?.browser_mode) ? runtime.browser_mode : "unknown",
    browser_reachable: runtime?.browser_reachable === true,
    ready: runtime?.ready === true,
    blocker: runtime?.ready === true ? null : safeToken(runtime?.blocker, "status_unavailable")
  };
}

export function parseViewerUrl(inspect, { remote, forwardedPort, container }) {
  assertRunning(inspect, { container });
  const bindings = inspect.NetworkSettings?.Ports?.["6080/tcp"];
  if (!Array.isArray(bindings) || bindings.length !== 1 || !bindings.every(binding => ["127.0.0.1", "::1"].includes(binding.HostIp))) {
    throw new Error("Viewer port 6080 must have exactly one loopback-only Docker mapping.");
  }
  if (remote && forwardedPort === undefined) throw new Error("Remote Docker context: provide an explicit local --forwarded-port for an existing loopback SSH tunnel.");
  const host = forwardedPort !== undefined ? "127.0.0.1" : bindings[0].HostIp;
  const hostPort = forwardedPort ?? port(bindings[0].HostPort);
  const url = new URL(`http://${host === "::1" ? "[::1]" : host}:${hostPort}/vnc.html`);
  for (const [key, value] of Object.entries({ host, port: String(hostPort), path: "websockify", encrypt: "0", reconnect: "0", autoconnect: "1", resize: "scale" })) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

export function selectClipboard(platform = process.platform, env = process.env) {
  if (platform === "darwin") return { command: "pbcopy", args: [], foreground: false };
  if (platform === "win32" || (platform === "linux" && (env.WSL_DISTRO_NAME || env.WSL_INTEROP))) {
    return { command: "clip.exe", args: [], foreground: false };
  }
  if (platform === "linux" && env.WAYLAND_DISPLAY) {
    return { command: "wl-copy", args: ["--foreground", "--paste-once", "--type", "text/plain"], foreground: true };
  }
  if (platform === "linux" && env.DISPLAY) {
    return { command: "xclip", args: ["-selection", "clipboard", "-loops", "1", "-verbose"], foreground: true };
  }
  throw new Error("No safe clipboard utility is available for this terminal; no password was printed.");
}

export function freezeTarget(parsed, activeContext, env = process.env) {
  if (parsed.context) return { context: name(parsed.context, "--context"), contextLabel: parsed.context, container: parsed.container };
  if (env.DOCKER_HOST && !env.DOCKER_CONTEXT) return { context: undefined, contextLabel: "DOCKER_HOST", container: parsed.container };
  const context = name(activeContext, "active Docker context");
  return { context, contextLabel: context, container: parsed.container };
}

export async function copyViewerPassword({ stdinTty, stdoutTty, readPassword, writeClipboard, output = () => {}, platform = process.platform, env = process.env }) {
  if (!stdinTty || !stdoutTty) throw new Error("viewer --copy-password requires a real stdin and stdout TTY.");
  const plan = selectClipboard(platform, env);
  const value = await readPassword();
  if (!PASSWORD.test(value)) throw new Error("Saved viewer password failed verification; nothing was copied.");
  if (plan.foreground) output("Paste the viewer password now; the clipboard owner exits after one paste or 60 seconds.");
  await writeClipboard(plan, value);
  output(plan.foreground ? "Viewer password transfer ended." : "Viewer password copied to the local clipboard.");
}

export function runStreaming(args, { parent = process, spawn = nodeSpawn, closeInputStopsChild = false } = {}) {
  const ttyInput = parent.stdin.isTTY === true;
  let child;
  try {
    child = spawn("docker", args, { shell: false, stdio: [ttyInput ? "inherit" : "pipe", "inherit", "inherit"] });
  } catch {
    return Promise.reject(new Error("Docker helper could not start."));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let stopTimer;
    let inputTimer;
    let terminatingSignal;
    let childError;
    const terminate = (signal) => {
      if (settled || terminatingSignal) return;
      terminatingSignal = signal;
      stopTimer = setTimeout(() => { if (!settled) child.kill("SIGKILL"); }, 3000);
      stopTimer.unref?.();
      child.kill(signal);
    };
    const onSigint = () => terminate("SIGINT");
    const onSigterm = () => terminate("SIGTERM");
    const onInputEnd = () => {
      child.stdin?.end();
      if (closeInputStopsChild) {
        inputTimer = setTimeout(() => terminate("SIGTERM"), 1000);
        inputTimer.unref?.();
      }
    };
    const cleanup = () => {
      clearTimeout(stopTimer);
      clearTimeout(inputTimer);
      parent.removeListener("SIGINT", onSigint);
      parent.removeListener("SIGTERM", onSigterm);
      parent.stdin.removeListener("end", onInputEnd);
      if (!ttyInput) parent.stdin.unpipe(child.stdin);
    };
    const finish = (error, code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(signal === "SIGINT" || terminatingSignal === "SIGINT" ? 130 : signal === "SIGTERM" || terminatingSignal === "SIGTERM" ? 143 : code ?? 1);
    };
    parent.on("SIGINT", onSigint);
    parent.on("SIGTERM", onSigterm);
    if (!ttyInput) {
      child.stdin?.on("error", () => {});
      parent.stdin.on("end", onInputEnd);
      parent.stdin.pipe(child.stdin);
    }
    child.once("error", () => {
      childError = new Error("Docker helper failed.");
      if (child.pid) terminate("SIGTERM");
      else finish(new Error("Docker helper could not start."));
    });
    child.once("close", (code, signal) => finish(childError, code, signal));
  });
}

const RELAY_ERROR = -32000;
const LOST_IN_FLIGHT = "The prodex browser container restarted while this request was in flight, so its answer was lost. " +
  "If it was a consult, its prompt may already be posted: run pro_recover with its request id before sending it again.";
const STILL_AWAY = "The prodex browser container is not reachable yet; the MCP relay keeps reconnecting. Retry shortly.";
const stillAway = reason => reason
  ? `The prodex browser container is not reachable: ${reason} The MCP relay keeps reconnecting and goes on once it is back.`
  : STILL_AWAY;

function lineSplitter(onLine) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  return chunk => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (line.trim()) onLine(line);
    }
  };
}

function parseMessage(line) {
  try {
    const message = JSON.parse(line);
    return message && typeof message === "object" && !Array.isArray(message) ? message : undefined;
  } catch {
    return undefined;
  }
}

// MCP over stdio carries one JSON-RPC message per line. A plain pipe ended with
// its `docker exec`, so a container restart or swap disconnected every client
// until someone reconnected it by hand. The relay keeps the client's side open:
// when `docker exec` ends while the client is still connected, it answers the
// requests that were in flight with an error, starts `docker exec` again until
// the container is back, replays the client's initialize and initialized
// messages to the new server, and then passes on what the client sent meanwhile.
// A request held too long is answered with why the container is away (from
// `explainAway`, for example a stopped Docker engine) and what starts it.
export function runMcpRelay(args, { parent = process, spawn = nodeSpawn, retryDelaysMs = [250, 500, 1000, 2000, 5000],
  queueTimeoutMs = 60000, log = line => parent.stderr?.write(`${line}\n`), explainAway = async () => undefined } = {}) {
  if (parent.stdin.isTTY === true) return runStreaming(args, { parent, spawn, closeInputStopsChild: true });
  return new Promise((resolve, reject) => {
    const ended = new WeakSet();
    const pending = new Map();
    const held = [];
    let child;
    let generation = 0;
    let attempts = 0;
    let ready = false;
    let replayId;
    let initializeLine;
    let initializeId;
    let initializeAnswered = false;
    let initializedLine;
    let stopping;
    let settled = false;
    let retryTimer;
    let inputTimer;
    let stopTimer;
    let explaining;
    let loggedReason;

    const toClient = message => parent.stdout.write(`${typeof message === "string" ? message : JSON.stringify(message)}\n`);
    const answerError = (id, text) => toClient({ jsonrpc: "2.0", id, error: { code: RELAY_ERROR, message: text } });
    // One look at a time, shared by every request that times out together.
    const explain = () => {
      explaining ??= Promise.resolve().then(explainAway).catch(() => undefined).then(reason => {
        explaining = undefined;
        if (typeof reason !== "string" || !reason) return undefined;
        if (reason !== loggedReason) log(`prodex container-client: ${reason}`);
        loggedReason = reason;
        return reason;
      });
      return explaining;
    };
    const hold = (line, id, { first = false } = {}) => {
      const entry = { line, id };
      if (id !== undefined) {
        entry.timer = setTimeout(() => {
          const index = held.indexOf(entry);
          if (index >= 0) held.splice(index, 1);
          void explain().then(reason => { if (!settled) answerError(id, stillAway(reason)); });
        }, queueTimeoutMs);
        entry.timer.unref?.();
      }
      if (first) held.unshift(entry);
      else held.push(entry);
    };
    const send = (line, id) => {
      if (id !== undefined) pending.set(JSON.stringify(id), id);
      child.stdin.write(`${line}\n`);
    };
    const becomeReady = () => {
      ready = true;
      attempts = 0;
      loggedReason = undefined;
      for (const entry of held.splice(0)) {
        clearTimeout(entry.timer);
        send(entry.line, entry.id);
      }
    };
    const finish = (error, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(retryTimer);
      clearTimeout(inputTimer);
      clearTimeout(stopTimer);
      for (const entry of held) clearTimeout(entry.timer);
      parent.removeListener("SIGINT", onSigint);
      parent.removeListener("SIGTERM", onSigterm);
      parent.stdin.removeListener("data", onInput);
      parent.stdin.removeListener("end", onInputEnd);
      if (error) reject(error);
      else resolve(code);
    };
    const scheduleRetry = () => {
      if (stopping) return;
      retryTimer = setTimeout(start, retryDelaysMs[Math.min(attempts, retryDelaysMs.length - 1)]);
      attempts += 1;
    };
    const fromServer = own => line => {
      if (own !== child) return;
      const message = parseMessage(line);
      const response = message && "id" in message && !("method" in message);
      if (response && replayId !== undefined && message.id === replayId) {
        replayId = undefined;
        if (initializedLine) child.stdin.write(`${initializedLine}\n`);
        // The new server may be a newer build with different tools.
        if (message.result?.capabilities?.tools?.listChanged === true) toClient({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
        log("prodex container-client: reconnected to the browser container.");
        becomeReady();
        return;
      }
      if (response) {
        pending.delete(JSON.stringify(message.id));
        if (message.id === initializeId) initializeAnswered = true;
      }
      toClient(line);
    };
    const onChildClose = (own, code, signal, error) => {
      if (ended.has(own)) return;
      ended.add(own);
      if (own !== child) return;
      const wasReady = ready;
      child = undefined;
      ready = false;
      replayId = undefined;
      if (error) return finish(error);
      if (stopping === "input") return finish(undefined, wasReady ? code ?? 1 : 0);
      if (stopping) return finish(undefined, stopping === "SIGINT" ? 130 : 143);
      for (const id of pending.values()) {
        if (id === initializeId && !initializeAnswered) hold(initializeLine, id, { first: true });
        else answerError(id, LOST_IN_FLIGHT);
      }
      pending.clear();
      if (wasReady) log("prodex container-client: the browser container connection ended; reconnecting.");
      scheduleRetry();
    };
    function start() {
      generation += 1;
      let own;
      try {
        own = spawn("docker", args, { shell: false, stdio: ["pipe", "pipe", "inherit"] });
      } catch {
        return finish(new Error("Docker helper could not start."));
      }
      child = own;
      own.stdin?.on("error", () => {});
      own.stdout?.on("data", lineSplitter(fromServer(own)));
      own.once("error", () => {
        if (own.pid) own.kill("SIGTERM");
        else onChildClose(own, undefined, undefined, new Error("Docker helper could not start."));
      });
      own.once("close", (code, signal) => onChildClose(own, code, signal));
      if (initializeAnswered) {
        replayId = `prodex-relay-replay-${generation}`;
        own.stdin.write(`${JSON.stringify({ ...parseMessage(initializeLine), id: replayId })}\n`);
      } else {
        becomeReady();
      }
    }
    const onInput = lineSplitter(line => {
      const message = parseMessage(line);
      const request = message && "id" in message && typeof message.method === "string";
      if (request && message.method === "initialize") {
        initializeLine = line;
        initializeId = message.id;
        initializeAnswered = false;
      }
      if (message?.method === "notifications/initialized") initializedLine = line;
      if (ready) return send(line, request ? message.id : undefined);
      // A reply to a request from the server that went away has nowhere to go.
      if (message && !("method" in message)) return;
      hold(line, request ? message.id : undefined);
    });
    const onInputEnd = () => {
      stopping = "input";
      clearTimeout(retryTimer);
      if (!child) return finish(undefined, 0);
      child.stdin?.end();
      if (!ready) return child.kill("SIGTERM");
      inputTimer = setTimeout(() => child?.kill("SIGTERM"), 1000);
      inputTimer.unref?.();
    };
    const stop = signal => {
      if (stopping === "SIGINT" || stopping === "SIGTERM") return;
      stopping = signal;
      clearTimeout(retryTimer);
      if (!child) return finish(undefined, signal === "SIGINT" ? 130 : 143);
      stopTimer = setTimeout(() => child?.kill("SIGKILL"), 3000);
      stopTimer.unref?.();
      child.kill(signal);
    };
    const onSigint = () => stop("SIGINT");
    const onSigterm = () => stop("SIGTERM");
    parent.on("SIGINT", onSigint);
    parent.on("SIGTERM", onSigterm);
    parent.stdin.on("data", onInput);
    parent.stdin.on("end", onInputEnd);
    start();
  });
}

const NO_DOCKER_COMMAND = "The docker command is not on this process's PATH; run this client with a PATH that includes the directory holding docker, then retry.";

async function docker(target, args, options = {}) {
  try {
    const result = await execFile("docker", [...contextArgs(target), ...args], { timeout: 12000, maxBuffer: 1024 * 1024, ...options });
    return result.stdout.trim();
  } catch (error) {
    if (error?.code === "ENOENT") throw Object.assign(new Error(NO_DOCKER_COMMAND), { code: "ENOENT" });
    const denied = /permission denied/i.test(String(error?.stderr ?? ""));
    if (denied) throw Object.assign(new Error("Docker refused this user: permission denied on its socket."), { code: "EACCES" });
    throw new Error("Docker command failed for the selected context; check Docker access and target, then retry. No container was started.");
  }
}

// What starts the Docker engine behind an endpoint, judged by where its socket
// lives: colima keeps one per profile, Docker Desktop and OrbStack one per user,
// and Linux (WSL included) runs the engine as a service.
function colimaStartHint(profile) {
  const flag = profile === "default" ? "" : ` --profile ${profile}`;
  return `Start its colima VM with \`colima start${flag}\`. If \`colima list\` shows it Broken, which a macOS restart can leave, run \`colima stop --force${flag}\` first.`;
}

// colima names a profile's Docker context `colima` (the default profile) or
// `colima-PROFILE`, and deletes it on `colima stop`; the profile's directory
// stays. Returns the profile when that directory is here.
export function stoppedColimaProfile(context, env = process.env) {
  const profile = context === "colima" ? "default" : context?.startsWith("colima-") ? context.slice("colima-".length) : undefined;
  if (!profile || !NAME.test(profile)) return undefined;
  const homes = env.COLIMA_HOME ? [env.COLIMA_HOME] : [path.join(homedir(), ".colima"), path.join(homedir(), ".config", "colima")];
  return homes.some(home => existsSync(path.join(home, profile, "colima.yaml"))) ? profile : undefined;
}

export function dockerStartHint(host, { platform = process.platform, env = process.env } = {}) {
  const socket = typeof host === "string" && host.startsWith("unix://") ? host.slice("unix://".length) : undefined;
  const colima = socket?.match(/\/\.colima\/([^/]+)\/docker\.sock$/);
  if (colima) {
    if (!NAME.test(colima[1])) return "Start its colima VM (`colima list` shows the profile); if it shows Broken, run `colima stop --force` on that profile first.";
    return colimaStartHint(colima[1]);
  }
  if (socket?.endsWith("/.docker/run/docker.sock") || (typeof host === "string" && host.startsWith("npipe://"))) return "Start Docker Desktop.";
  if (socket?.endsWith("/.orbstack/run/docker.sock")) return "Start OrbStack.";
  if (host !== undefined && !socket) return "Check that this remote Docker host is up and reachable from here.";
  if (platform === "linux" && (env.WSL_DISTRO_NAME || env.WSL_INTEROP)) {
    return "Start the Docker engine in this WSL distro (`sudo systemctl start docker`), or Docker Desktop if it provides Docker here.";
  }
  if (platform === "linux") return "Start the Docker engine (`sudo systemctl start docker`).";
  return "Start the Docker engine, or the Linux VM that runs it.";
}

// Why the selected container cannot be reached, in one message that says what
// to start. A wrong context name, a stopped engine or Linux VM, and a missing
// container all used to read "was not found or Docker is unavailable". Returns
// undefined when the container is running. Nothing is started here.
export async function explainUnavailable(target, { runDocker = docker, env = process.env, platform = process.platform } = {}) {
  const fallback = error => error?.code === "ENOENT" ? NO_DOCKER_COMMAND
    : error?.code === "EACCES" ? `${endpointLabel(target).replace(/^t/, "T")} refused this user (permission denied on the Docker socket); add the user to the docker group and log in again, or select a context this user may use.`
    : undefined;
  let host = target.context ? undefined : env.DOCKER_HOST;
  if (target.context) {
    try {
      host = JSON.parse(await runDocker(target, ["context", "inspect", target.context]))?.[0]?.Endpoints?.docker?.Host;
    } catch (error) {
      const known = fallback(error);
      if (known) return known;
      const profile = stoppedColimaProfile(target.context, env);
      if (profile) {
        return `colima profile ${profile} looks stopped: Docker context ${target.context} is gone, and colima removes it while the VM is stopped. ${colimaStartHint(profile)}`;
      }
      return `Docker context ${target.context} does not exist here; list the contexts with \`docker context ls\`.`;
    }
  }
  try {
    await runDocker(target, ["version", "--format", "{{.Server.Version}}"]);
  } catch (error) {
    const where = target.context ? `context ${target.context}` : "DOCKER_HOST";
    return fallback(error) ?? `Docker for ${where} is not answering, so ${target.container} cannot run. ${dockerStartHint(host, { platform, env })}`;
  }
  let inspect;
  try {
    inspect = JSON.parse(await runDocker(target, ["container", "inspect", target.container]))?.[0];
  } catch (error) {
    return fallback(error) ?? `${target.container} does not exist in ${endpointLabel(target)}; create it from containers/browser as docs/container-browser.md describes.`;
  }
  return inspect?.State?.Running === true ? undefined : notRunning(inspect, target);
}

async function inspectContainer(target) {
  let inspect;
  try {
    const parsed = JSON.parse(await docker(target, ["container", "inspect", target.container]));
    inspect = parsed?.[0];
  } catch {
    throw new Error(await explainUnavailable(target) ?? `${target.container} could not be inspected in ${endpointLabel(target)}; check Docker access, then retry.`);
  }
  assertRunning(inspect, target);
  return inspect;
}

export function isRemoteDockerHost(host) {
  if (typeof host !== "string") return true;
  if (host.startsWith("unix://") || host.startsWith("npipe://")) return false;
  return true;
}

export async function remoteContext(target, env = process.env, runDocker = docker) {
  let host = target.context ? undefined : env.DOCKER_HOST;
  if (!host) {
    const parsed = JSON.parse(await runDocker(target, ["context", "inspect", target.context]));
    host = parsed?.[0]?.Endpoints?.docker?.Host;
  }
  return isRemoteDockerHost(host);
}

async function readRuntime(target) {
  try { return JSON.parse(await docker(target, oneShotExecBody(target, STATUS_EXPRESSION))); }
  catch { return { ready: false, blocker: "status_unavailable" }; }
}

async function readVerifiedPassword(target) {
  let value;
  try { value = await docker(target, oneShotExecBody(target, PASSWORD_EXPRESSION), { maxBuffer: 128 }); }
  catch { throw new Error("Saved private viewer password is unavailable or invalid; nothing was copied."); }
  if (!PASSWORD.test(value)) throw new Error("Saved viewer password failed verification; nothing was copied.");
  return value;
}

export async function writeClipboard(plan, value, { parent = process, spawn = nodeSpawn,
  timeoutMs = plan.foreground ? 60000 : 5000, killGraceMs = 3000 } = {}) {
  await new Promise((resolve, reject) => {
    let settled = false;
    let stopping;
    let forceTimer;
    let child;
    try { child = spawn(plan.command, plan.args, { shell: false, stdio: ["pipe", "ignore", "ignore"] }); }
    catch { reject(new Error("Local clipboard utility could not start; no password was printed.")); return; }
    const stop = (reason) => {
      if (settled || stopping) return;
      stopping = reason;
      forceTimer = setTimeout(() => { if (!settled) child.kill("SIGKILL"); }, killGraceMs);
      child.kill("SIGTERM");
    };
    const onSigint = () => stop(new Error("Clipboard transfer interrupted; no password was printed."));
    const onSigterm = () => stop(new Error("Clipboard transfer interrupted; no password was printed."));
    const timer = setTimeout(() => stop(new Error("Clipboard transfer timed out; no password was printed.")), timeoutMs);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      parent.removeListener("SIGINT", onSigint);
      parent.removeListener("SIGTERM", onSigterm);
      error || stopping ? reject(error ?? stopping) : resolve();
    };
    parent.on("SIGINT", onSigint);
    parent.on("SIGTERM", onSigterm);
    child.once("error", () => {
      const error = new Error("Local clipboard utility is unavailable; no password was printed.");
      if (child.pid) stop(error);
      else finish(error);
    });
    child.once("close", (code) => finish(code === 0 ? undefined : new Error("Local clipboard transfer failed or timed out; no password was printed.")));
    child.stdin.on("error", () => stop(new Error("Local clipboard utility closed its input; nothing was copied.")));
    child.stdin.end(value);
  });
}

export async function runClient(argv = process.argv.slice(2)) {
  const parsed = parseClientArgs(argv);
  if (parsed.command === "help") {
    process.stdout.write("Usage: node scripts/container-client.mjs [--context NAME] [--container NAME] status|mcp|pro|viewer|help\n" +
      "  pro [native ask flags] [-- prompt]    Container-relative --file/--attach paths only; use --stdin for authorized host text.\n" +
      "  viewer [--forwarded-port N] [--copy-password]    Never starts a browser or a tunnel.\n");
    return 0;
  }
  const proArgs = parsed.command === "pro" ? buildProArgs(parsed.rest) : undefined;
  if (parsed.copyPassword && (process.stdin.isTTY !== true || process.stdout.isTTY !== true)) {
    throw new Error("viewer --copy-password requires a real stdin and stdout TTY.");
  }
  const activeContext = parsed.context || (process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT)
    ? undefined : await docker({ context: undefined }, ["context", "show"]);
  const target = freezeTarget(parsed, activeContext);
  const inspect = await inspectContainer(target);
  if (parsed.command === "mcp") {
    return runMcpRelay(buildMcpServerArgs(target), { explainAway: () => explainUnavailable(target) });
  }
  if (parsed.command === "pro") {
    return runStreaming(buildDockerExecArgs(target, proArgs));
  }
  if (parsed.command === "status") {
    process.stdout.write(`${JSON.stringify(parseStatus(target, inspect, await readRuntime(target)), null, 2)}\n`);
    return 0;
  }
  const remote = await remoteContext(target);
  const url = parseViewerUrl(inspect, { remote, forwardedPort: parsed.forwardedPort, container: target.container });
  process.stdout.write(`Docker context: ${target.contextLabel}; container: ${target.container}\n${url}\n`);
  if (parsed.copyPassword) await copyViewerPassword({
    stdinTty: process.stdin.isTTY === true,
    stdoutTty: process.stdout.isTTY === true,
    readPassword: () => readVerifiedPassword(target), writeClipboard,
    output: line => process.stdout.write(`${line}\n`)
  });
  return 0;
}

// Node resolves symlinks in the main module's URL, so compare against the
// resolved argv path; otherwise a client started through a link does nothing.
function startedAsMain() {
  if (!process.argv[1]) return false;
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; }
  catch { return false; }
}

if (startedAsMain()) {
  runClient().then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : "Container client failed."}\n`);
    process.exitCode = 1;
  });
}
