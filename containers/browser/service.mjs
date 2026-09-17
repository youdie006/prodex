import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, open } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";

import {
  buildChromeLaunchArgs,
  defaultChatGptProfileDir,
  recordBrowserLoginLaunch
} from "../../dist/chatgpt-browser.js";
import {
  assertLaunchedBrowserMainProcess,
  browserProcessHasFlag,
  findMatchingBrowserProcesses,
  inspectBrowserProcesses
} from "../../dist/browser-process.js";

const READY_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 3_000;
const PASSWORD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function generateVncPassword(random = randomBytes) {
  const bytes = random(8);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 8) throw new Error("VNC password entropy source returned an invalid result.");
  return [...bytes].map((byte) => PASSWORD_ALPHABET[byte & 63]).join("");
}

export async function loadOrCreateVncPassword(file) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const password = generateVncPassword();
    handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { await handle.writeFile(`${password}\n`, "utf8"); }
    finally { await handle.close(); }
    return password;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 9 ||
        (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()))) {
      throw new Error("Viewer password must be a private regular file owned by this user.");
    }
    const value = await handle.readFile("utf8");
    if (!/^[A-Za-z0-9_-]{8}\n?$/.test(value)) throw new Error("Saved viewer password is invalid.");
    return value.trim();
  } finally {
    await handle.close();
  }
}

export function buildServiceLaunchPlan(config) {
  return {
    xvfb: {
      command: "Xvfb",
      args: [config.display, "-screen", "0", "1440x900x24", "-nolisten", "tcp", "-auth", config.xauthority]
    },
    chromium: {
      command: config.chromeCommand,
      args: [
        // Retain Debian's background-network restrictions without its memory/GPU overrides.
        "--disable-background-networking",
        "--disable-extensions",
        "--disable-pings",
        "--media-router=0",
        ...buildChromeLaunchArgs({
          port: config.cdpPort,
          profileDir: config.profileDir,
          url: "about:blank",
          headless: false
        })
      ]
    },
    x11vnc: {
      command: "x11vnc",
      args: [
        "-display", config.display,
        "-auth", config.xauthority,
        "-rfbauth", config.rfbauthPath,
        "-rfbport", String(config.vncPort),
        "-localhost",
        "-forever",
        "-shared"
      ]
    },
    websockify: {
      command: "websockify",
      args: ["--web=/usr/share/novnc", `0.0.0.0:${config.viewerPort}`, `127.0.0.1:${config.vncPort}`]
    }
  };
}

function defaultConfig() {
  if (process.platform !== "linux") throw new Error("The container browser service requires Linux.");
  if (typeof process.getuid !== "function" || process.getuid() === 0) {
    throw new Error("The container browser service refuses to run as root.");
  }
  if (process.env.HOME !== "/home/node" || process.env.DISPLAY !== ":99" ||
      process.env.XAUTHORITY !== "/tmp/prodex-display/Xauthority") {
    throw new Error("The container browser service environment is not isolated as expected.");
  }
  return {
    home: "/home/node",
    display: ":99",
    xauthority: "/tmp/prodex-display/Xauthority",
    profileDir: defaultChatGptProfileDir(),
    rfbauthPath: "/home/node/.vnc/passwd",
    viewerPasswordPath: "/home/node/.vnc/viewer-password",
    cdpPort: 9333,
    vncPort: 5900,
    viewerPort: 6080,
    // Debian's wrapper redirects shared memory to /tmp below its own 3.8 GB threshold.
    chromeCommand: process.env.PRODEX_CHROME || "/usr/lib/chromium/chromium"
  };
}

export function serviceEnvironment(config, environment = process.env) {
  return {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    ...(environment.LANG ? { LANG: environment.LANG } : {}),
    ...(environment.LC_ALL ? { LC_ALL: environment.LC_ALL } : {}),
    HOME: config.home ?? "/home/node",
    DISPLAY: config.display,
    XAUTHORITY: config.xauthority
  };
}

async function runOneShot(command, args, { input, env, signal } = {}) {
  signal?.throwIfAborted();
  const child = spawn(command, args, { env, signal, stdio: [input === undefined ? "ignore" : "pipe", "ignore", "ignore"] });
  const completion = new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.stdin?.once("error", (error) => resolve({ error }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (input !== undefined) child.stdin.end(input);
  let timer;
  const result = await Promise.race([completion, new Promise(resolve => { timer = setTimeout(resolve, 5_000); })]);
  clearTimeout(timer);
  if (result === undefined) {
    await terminateChild(child);
    throw new Error(`${command} timed out.`);
  }
  if (result.error || result.code !== 0) {
    await terminateChild(child);
    throw new Error(`${command} failed.`);
  }
}

async function prepareCredentials(config, { signal } = {}) {
  signal?.throwIfAborted();
  const displayDir = path.dirname(config.xauthority);
  const vncDir = path.dirname(config.rfbauthPath);
  await mkdir(displayDir, { recursive: true, mode: 0o700 });
  await chmod(displayDir, 0o700);
  await mkdir(vncDir, { recursive: true, mode: 0o700 });
  await chmod(vncDir, 0o700);

  const cookie = randomBytes(16).toString("hex");
  await runOneShot("xauth", ["-f", config.xauthority, "source", "-"], {
    input: `add ${config.display} MIT-MAGIC-COOKIE-1 ${cookie}\n`,
    env: serviceEnvironment(config), signal
  });
  await chmod(config.xauthority, 0o600);

  signal?.throwIfAborted();
  const password = await loadOrCreateVncPassword(config.viewerPasswordPath);
  await runOneShot("x11vnc", ["-storepasswd", config.rfbauthPath], {
    input: `${password}\n${password}\ny\n`,
    env: serviceEnvironment(config), signal
  });
  await chmod(config.rfbauthPath, 0o600);
}

function spawnService(_name, specification, config) {
  return spawn(specification.command, specification.args, {
    env: serviceEnvironment(config),
    stdio: "inherit"
  });
}

async function waitUntilReady(name, { child, config, signal }) {
  if (name === "xvfb") {
    const displayNumber = config.display.replace(/^:/, "").split(".", 1)[0];
    await pollUntilReady(name, child, () => access(`/tmp/.X11-unix/X${displayNumber}`), signal);
    return;
  }
  if (name === "chromium") {
    await pollUntilReady(name, child, () => readCdpVersion(config.cdpPort), signal);
    return;
  }
  if (name === "x11vnc") {
    await pollUntilReady(name, child, () => connectLocalPort(config.vncPort), signal);
    return;
  }
  await pollUntilReady(name, child, async () => {
    const response = await fetchWithTimeout(`http://127.0.0.1:${config.viewerPort}/vnc.html`, 1_000);
    if (!response.ok) throw new Error("noVNC is not ready.");
  }, signal);
}

async function pollUntilReady(name, child, probe, signal) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${name} exited before becoming ready.`);
    try {
      await probe();
      return;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`${name} did not become ready: ${errorMessage(lastError)}`);
}

function verifyBrowserProcess({ child, config }) {
  const matching = findMatchingBrowserProcesses(inspectBrowserProcesses(), {
    port: config.cdpPort,
    profileDir: config.profileDir
  });
  const main = assertLaunchedBrowserMainProcess(matching, child.pid);
  if (browserProcessHasFlag(main, "headless")) throw new Error("The launched browser is unexpectedly headless.");
}

function createStopWaiter() {
  let resolveSignal;
  const promise = new Promise((resolve) => { resolveSignal = resolve; });
  const handlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => resolveSignal(signal);
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  return {
    promise,
    dispose() {
      for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    }
  };
}

async function closeBrowser({ child, config }) {
  verifyBrowserProcess({ child, config });
  const version = await readCdpVersion(config.cdpPort);
  await sendBrowserClose(version.webSocketDebuggerUrl, config.cdpPort);
  await waitForChildExit(child, 5_000);
}

async function sendBrowserClose(socketUrl, port) {
  const parsed = new URL(socketUrl);
  if (parsed.protocol !== "ws:" || parsed.hostname !== "127.0.0.1" || Number(parsed.port) !== port) {
    throw new Error("CDP returned a non-local browser socket.");
  }
  const socket = new WebSocket(socketUrl);
  await new Promise((resolve, reject) => {
    let sent = false;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.on("error", () => {});
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => finish(new Error("Browser.close timed out.")), STOP_TIMEOUT_MS);
    socket.once("open", () => {
      sent = true;
      socket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
    });
    socket.on("message", (raw) => {
      try {
        const message = JSON.parse(String(raw));
        if (message.id === 1) finish(message.error ? new Error("Browser.close failed.") : undefined);
      } catch {
        finish(new Error("CDP returned an invalid Browser.close response."));
      }
    });
    socket.once("close", () => finish(sent ? undefined : new Error("CDP closed before Browser.close was sent.")));
    socket.once("error", (error) => finish(error));
  });
}

async function terminateChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForChildExit(child, STOP_TIMEOUT_MS, false)) return;
  child.kill("SIGKILL");
  if (!await waitForChildExit(child, STOP_TIMEOUT_MS, false)) {
    throw new Error("An owned service did not exit during bounded cleanup.");
  }
}

async function waitForChildExit(child, timeoutMs, throwOnTimeout = true) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  const exited = await new Promise(resolve => {
    const finish = (result) => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(result);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
  if (!exited && throwOnTimeout) throw new Error("Owned browser did not exit after Browser.close.");
  return exited;
}

async function readCdpVersion(port) {
  const response = await fetchWithTimeout(`http://127.0.0.1:${port}/json/version`, 1_000);
  if (!response.ok) throw new Error("Local CDP is unavailable.");
  const version = await response.json();
  if (typeof version?.webSocketDebuggerUrl !== "string") throw new Error("Local CDP metadata is incomplete.");
  const socket = new URL(version.webSocketDebuggerUrl);
  if (socket.protocol !== "ws:" || socket.hostname !== "127.0.0.1" || Number(socket.port) !== port) {
    throw new Error("Local CDP metadata is not loopback-only.");
  }
  return version;
}

function fetchWithTimeout(url, timeoutMs) {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
}

function connectLocalPort(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(1_000);
    socket.once("connect", () => { socket.destroy(); resolve(); });
    socket.once("timeout", () => { socket.destroy(); reject(new Error("Local port timed out.")); });
    socket.once("error", reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}

const defaultOperations = {
  prepareCredentials,
  spawnService,
  waitUntilReady,
  verifyBrowserProcess,
  recordLaunch: recordBrowserLoginLaunch,
  createStopWaiter,
  closeBrowser,
  terminateChild
};

export async function runContainerBrowserService({ config = defaultConfig(), operations = defaultOperations } = {}) {
  const plan = buildServiceLaunchPlan(config);
  const owned = [];
  let stopping = false;
  let browserVerified = false;
  let resolveFailure;
  let failure;
  const failurePromise = new Promise((resolve) => { resolveFailure = resolve; });
  const stopWaiter = operations.createStopWaiter();
  const controller = new AbortController();
  const shutdownError = new Error("Container shutdown requested.");
  const stopPromise = stopWaiter.promise.then(() => {
    controller.abort(shutdownError);
    return shutdownError;
  });

  const throwIfFailed = () => {
    if (failure) throw failure;
    controller.signal.throwIfAborted();
  };

  const own = (name) => {
    throwIfFailed();
    const child = operations.spawnService(name, plan[name], config);
    const fail = (detail) => {
      if (stopping || failure) return;
      failure = new Error(`${name} ${detail}`);
      controller.abort(failure);
      resolveFailure(failure);
    };
    child.once("error", (error) => fail(`failed: ${errorMessage(error)}`));
    child.once("exit", (code, signal) => fail(`exited (${signal ?? code ?? "unknown"}).`));
    owned.push({ name, child });
    return child;
  };
  const waitReady = async (name, child) => {
    await Promise.race([
      operations.waitUntilReady(name, { child, config, signal: controller.signal }),
      failurePromise.then((error) => { throw error; }),
      stopPromise.then((error) => { throw error; })
    ]);
  };
  let browser;
  try {
    await operations.prepareCredentials(config, { signal: controller.signal });
    throwIfFailed();
    const xvfb = own("xvfb");
    await waitReady("xvfb", xvfb);
    throwIfFailed();

    browser = own("chromium");
    await waitReady("chromium", browser);
    await operations.verifyBrowserProcess({ child: browser, config });
    throwIfFailed();
    browserVerified = true;
    await operations.recordLaunch({
      profile_dir: config.profileDir,
      port: config.cdpPort,
      headless: false,
      minimized: false
    });
    throwIfFailed();

    const vnc = own("x11vnc");
    await waitReady("x11vnc", vnc);
    throwIfFailed();
    const viewer = own("websockify");
    await waitReady("websockify", viewer);
    throwIfFailed();

    const serviceFailure = await Promise.race([
      failurePromise,
      stopWaiter.promise.then(() => undefined)
    ]);
    if (serviceFailure) throw serviceFailure;
  } catch (error) {
    if (failure) throw failure;
    if (!controller.signal.aborted) throw error;
  } finally {
    stopping = true;
    controller.abort(shutdownError);
    stopWaiter.dispose();
    if (browser && browserVerified) {
      try {
        await operations.closeBrowser({ child: browser, config });
      } catch {
        // The exact child handle is still terminated below.
      }
    }
    const cleanupErrors = [];
    for (const { name, child } of [...owned].reverse()) {
      try { await operations.terminateChild(child, name); }
      catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Container service cleanup failed.");
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runContainerBrowserService().catch((error) => {
    console.error(`container browser service failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
