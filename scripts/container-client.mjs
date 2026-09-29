#!/usr/bin/env node
import { execFile as execFileCallback, spawn as nodeSpawn } from "node:child_process";
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

export function buildDockerExecArgs(target, argv) {
  return [...contextArgs(target), "exec", "-i", "--workdir", "/app", "-e", "PRODEX_NO_AUTO_LOGIN=1", target.container, ...argv];
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

function assertRunning(inspect, target) {
  if (inspect?.State?.Running !== true) throw new Error(`${target.container} is not running in the selected Docker context; start it manually, then retry (no auto-start).`);
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

async function docker(target, args, options = {}) {
  try {
    const result = await execFile("docker", [...contextArgs(target), ...args], { timeout: 12000, maxBuffer: 1024 * 1024, ...options });
    return result.stdout.trim();
  } catch {
    throw new Error("Docker command failed for the selected context; check Docker access and target, then retry. No container was started.");
  }
}

async function inspectContainer(target) {
  let inspect;
  try {
    const parsed = JSON.parse(await docker(target, ["container", "inspect", target.container]));
    inspect = parsed?.[0];
  } catch {
    throw new Error(`${target.container} was not found or Docker is unavailable in the selected context; start the intended container manually (no auto-start).`);
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
    return runStreaming(buildDockerExecArgs(target, ["node", "/app/dist/cli.js", "mcp", "--cwd", BRIDGE_CWD]), { closeInputStopsChild: true });
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runClient().then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : "Container client failed."}\n`);
    process.exitCode = 1;
  });
}
