import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import {
  buildDockerExecArgs,
  buildMcpServerArgs,
  buildProArgs,
  parseClientArgs,
  parseStatus,
  parseViewerUrl,
  isRemoteDockerHost,
  remoteContext,
  buildStatusReadArgs,
  buildPasswordReadArgs,
  freezeTarget,
  selectClipboard,
  runStreaming,
  runMcpRelay,
  copyViewerPassword,
  writeClipboard
} from "../scripts/container-client.mjs";

const target = { context: "lab", container: "browser-2" };

describe("container client arguments", () => {
  it("selects an explicit Docker context and container without shell interpolation", () => {
    expect(parseClientArgs(["--context", "lab", "--container", "browser-2", "mcp"])).toEqual({
      ...target, command: "mcp", rest: []
    });
    expect(buildDockerExecArgs(target, ["node", "/app/dist/cli.js", "mcp", "--cwd", "/home/node/bridge"])).toEqual([
      "--context", "lab", "exec", "-i", "--workdir", "/app", "-e", "PRODEX_NO_AUTO_LOGIN=1",
      "browser-2", "node", "/app/dist/cli.js", "mcp", "--cwd", "/home/node/bridge"
    ]);
  });

  it("uses the installed default container and rejects unsafe names, duplicates, and unknown flags", () => {
    expect(parseClientArgs(["status"])).toEqual({ context: undefined, container: "prodex-browser-browser-1", command: "status", rest: [] });
    for (const args of [
      ["--context", "--help", "status"], ["--container", "-bad", "status"],
      ["--context", "name;echo", "status"], ["--container", "bad/name", "status"],
      ["--context", "a", "--context", "b", "status"], ["--unknown", "status"],
      ["status", "extra"], ["viewer", "--unknown"]
    ]) expect(() => parseClientArgs(args)).toThrow();
  });

  it("passes selection and continuation through the ask CLI, defaulting to Pro only when unselected", () => {
    expect(buildProArgs(["--", "hello"])).toEqual([
      "node", "/app/dist/cli.js", "pro", "browser", "ask", "--cwd", "/home/node/bridge", "--no-auto-login", "--effort", "Pro", "--", "hello"
    ]);
    expect(buildProArgs(["--effort", "높음", "--continue-task", "task_1", "--", "next"])).toEqual([
      "node", "/app/dist/cli.js", "pro", "browser", "ask", "--cwd", "/home/node/bridge", "--no-auto-login",
      "--effort", "높음", "--continue-task", "task_1", "--", "next"
    ]);
    expect(buildProArgs(["--model", "Pro", "--stdin"])).not.toContain("--effort");
    expect(buildProArgs(["--pro-mode", "확장", "prompt"])).not.toContain("--effort");
    for (const args of [
      ["--auto-login", "prompt"], ["--cwd", "/tmp/other", "prompt"],
      ["--source-cli", "/tmp/other.js", "prompt"], ["--port", "9222", "prompt"]
    ]) expect(() => buildProArgs(args)).toThrow(/unavailable|fixed/i);
    expect(buildProArgs(["--", "--auto-login"])).toContain("--auto-login");
  });

  it("pins the active Docker context before subsequent inspect and exec calls", () => {
    expect(freezeTarget({ context: undefined, container: "browser-2" }, "colima", {})).toEqual({
      context: "colima", contextLabel: "colima", container: "browser-2"
    });
    expect(freezeTarget({ context: "lab", container: "browser-2" }, "colima", {})).toEqual({
      context: "lab", contextLabel: "lab", container: "browser-2"
    });
    expect(freezeTarget({ context: undefined, container: "browser-2" }, undefined, { DOCKER_HOST: "ssh://server" })).toEqual({
      context: undefined, contextLabel: "DOCKER_HOST", container: "browser-2"
    });
    expect(() => freezeTarget({ context: undefined, container: "browser-2" }, "unknown context!", {})).toThrow(/context/i);
  });
});

// Measured 2026-11-01 in the WSL container's results: 20 of the consults since
// 2026-10-10 were sent with no model selected, and so ran on whatever model
// another session had left selected in the shared browser. The MCP server runs
// inside the container, so the env block of the client's MCP entry never
// reached it, and the bridge there saves no defaults.
describe("browser defaults for the MCP server in the container", () => {
  const server = ["node", "/app/dist/cli.js", "mcp", "--cwd", "/home/node/bridge"];
  const base = ["--context", "lab", "exec", "-i", "--workdir", "/app", "-e", "PRODEX_NO_AUTO_LOGIN=1"];

  it("asks for Pro when the client names no model, as the pro command does", () => {
    expect(buildMcpServerArgs(target, {})).toEqual([...base, "-e", "PRODEX_DEFAULT_MODEL=Pro", "browser-2", ...server]);
  });

  it("passes the client's own defaults on instead", () => {
    expect(buildMcpServerArgs(target, { PRODEX_DEFAULT_MODEL: " Thinking ", PRODEX_DEFAULT_PROJECT: "Codex", HOME: "/home/x" })).toEqual([
      ...base, "-e", "PRODEX_DEFAULT_MODEL=Thinking", "-e", "PRODEX_DEFAULT_PROJECT=Codex", "browser-2", ...server
    ]);
    // An effort is its own selection, so Pro is not added next to it.
    expect(buildMcpServerArgs(target, { PRODEX_DEFAULT_EFFORT: "높음" })).toEqual([...base, "-e", "PRODEX_DEFAULT_EFFORT=높음", "browser-2", ...server]);
    // A Pro mode only refines Pro.
    expect(buildMcpServerArgs(target, { PRODEX_DEFAULT_PRO_MODE: "확장" })).toEqual([
      ...base, "-e", "PRODEX_DEFAULT_PRO_MODE=확장", "-e", "PRODEX_DEFAULT_MODEL=Pro", "browser-2", ...server
    ]);
  });

  it("ignores blank values and values that are not one line", () => {
    expect(buildMcpServerArgs(target, { PRODEX_DEFAULT_MODEL: "  ", PRODEX_DEFAULT_PROJECT: "a\nb" })).toEqual([
      ...base, "-e", "PRODEX_DEFAULT_MODEL=Pro", "browser-2", ...server
    ]);
  });
});

describe("safe status and viewer", () => {
  const inspect = {
    Name: "/browser-2", Image: `sha256:${"a".repeat(64)}`,
    Config: { Image: "prodex-browser:experimental", Env: ["SECRET=private"] },
    State: { Running: true, Health: { Status: "healthy" } },
    NetworkSettings: { Ports: { "6080/tcp": [{ HostIp: "127.0.0.1", HostPort: "39333" }] } }
  };

  it("projects only safe status fields and refuses stopped targets", () => {
    const runtime = { version: "0.40.18", browser_mode: "headed", browser_reachable: true,
      ready: false, blocker: "login_required", url: "https://private", title: "private title" };
    const result = parseStatus(target, inspect, runtime);
    expect(result).toMatchObject({ context: "lab", container: "browser-2", image: "prodex-browser:experimental",
      image_id: `sha256:${"a".repeat(64)}`, version: "0.40.18", running: true, health: "healthy", browser_mode: "headed", ready: false,
      blocker: "login_required" });
    expect(JSON.stringify(result)).not.toMatch(/SECRET|private|title|url/i);
    expect(() => parseStatus(target, { ...inspect, State: { Running: false } }, runtime)).toThrow(/not running.*start it manually/i);
    expect(() => parseStatus({ context: undefined, container: "browser-2" }, inspect, runtime)).toThrow(/context/i);
  });

  it("uses the selected loopback mapping and rejects unsafe and remote mappings", () => {
    const url = parseViewerUrl(inspect, { context: "lab", container: "browser-2", remote: false });
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:39333\/vnc\.html\?/);
    expect(url).toContain("path=websockify");
    expect(() => parseViewerUrl(inspect, { context: "lab", container: "browser-2", remote: true })).toThrow(/forwarded-port/i);
    expect(parseViewerUrl(inspect, { context: "lab", container: "browser-2", remote: true, forwardedPort: 39334 }))
      .toContain(":39334/vnc.html");
    const publicInspect = structuredClone(inspect);
    publicInspect.NetworkSettings.Ports["6080/tcp"].push({ HostIp: "0.0.0.0", HostPort: "39333" });
    expect(() => parseViewerUrl(publicInspect, { context: "lab", container: "browser-2", remote: false })).toThrow(/loopback/i);
  });

  it("classifies Docker endpoints conservatively before constructing a viewer URL", () => {
    expect(isRemoteDockerHost("unix:///var/run/docker.sock")).toBe(false);
    expect(isRemoteDockerHost("npipe:////./pipe/docker_engine")).toBe(false);
    expect(isRemoteDockerHost("tcp://127.0.0.1:2375")).toBe(true);
    expect(isRemoteDockerHost("tcp://localhost:2375")).toBe(true);
    expect(isRemoteDockerHost("ssh://operator@example.org")).toBe(true);
    expect(isRemoteDockerHost("tcp://192.0.2.10:2375")).toBe(true);
    expect(isRemoteDockerHost(undefined)).toBe(true);
  });

  it("does not confuse a context named DOCKER_HOST with the environment endpoint", async () => {
    const env = { DOCKER_HOST: "unix:///var/run/docker.sock" };
    const selected = freezeTarget({ context: "DOCKER_HOST", container: "browser-2" }, undefined, env);
    const runDocker = vi.fn(async () => JSON.stringify([{ Endpoints: { docker: { Host: "ssh://operator@example.org" } } }]));
    expect(await remoteContext(selected, env, runDocker)).toBe(true);
    expect(runDocker).toHaveBeenCalledExactlyOnceWith(selected, ["context", "inspect", "DOCKER_HOST"]);
  });

  it("uses the environment endpoint only when no named context is selected", async () => {
    const env = { DOCKER_HOST: "ssh://operator@example.org" };
    const selected = freezeTarget({ context: undefined, container: "browser-2" }, undefined, env);
    const runDocker = vi.fn();
    expect(await remoteContext(selected, env, runDocker)).toBe(true);
    expect(runDocker).not.toHaveBeenCalled();
  });

  it("derives browser mode from the matching process identity, never environment flags", () => {
    const expression = buildStatusReadArgs(target).at(-1) as string;
    expect(expression).toContain("findMatchingBrowserProcesses");
    expect(expression).toContain("defaultChatGptProfileDir");
    expect(expression).toContain("browserProcessHasFlag");
    expect(expression).not.toContain("PRODEX_HEADLESS");
    expect(expression).toContain("browser_mode = 'unknown'");
  });

  it("reads only the fixed saved password path with a read-only verifier", () => {
    const args = buildPasswordReadArgs(target);
    expect(args.slice(0, 10)).toEqual(["--context", "lab", "exec", "--workdir", "/app", "-e",
      "PRODEX_NO_AUTO_LOGIN=1", "browser-2", "node", "--input-type=module"]);
    expect(args).toContain("-e");
    const expression = args.at(-1) as string;
    expect(expression).toContain("/home/node/.vnc/viewer-password");
    expect(expression).toContain("O_NOFOLLOW");
    expect(expression).toContain("s.nlink !== 1");
    expect(expression).not.toMatch(/loadOrCreate|writeFile|createWriteStream|ABCDEFGH/);
  });

  it("requires both terminal ends before any password read", async () => {
    const readPassword = vi.fn(async () => "ABCDEFGH");
    await expect(copyViewerPassword({ stdinTty: true, stdoutTty: false, readPassword, writeClipboard: vi.fn() }))
      .rejects.toThrow(/TTY/i);
    expect(readPassword).not.toHaveBeenCalled();
  });

  it("copies a verified secret without including it in output or subprocess arguments", async () => {
    const password = "AbC_123-";
    const writeClipboard = vi.fn(async (_plan, value) => { expect(value).toBe(password); });
    const output = vi.fn();
    await copyViewerPassword({ stdinTty: true, stdoutTty: true, readPassword: async () => password,
      writeClipboard, output, platform: "darwin", env: {} });
    expect(writeClipboard.mock.calls[0][0]).toEqual({ command: "pbcopy", args: [], foreground: false });
    expect(JSON.stringify(writeClipboard.mock.calls[0][0])).not.toContain(password);
    expect(JSON.stringify(output.mock.calls)).not.toContain(password);
    expect(() => selectClipboard("linux", {})).toThrow(/clipboard/i);
    expect(selectClipboard("linux", { WSL_DISTRO_NAME: "Ubuntu" })).toEqual({ command: "clip.exe", args: [], foreground: false });
    expect(selectClipboard("linux", { WAYLAND_DISPLAY: "wayland-0" })).toMatchObject({ command: "wl-copy", foreground: true });
    expect(selectClipboard("linux", { DISPLAY: ":0" })).toMatchObject({ command: "xclip", foreground: true });
  });

  it("bounds a stalled clipboard utility with TERM then KILL, without exposing the secret", async () => {
    vi.useFakeTimers();
    try {
      const parent = new EventEmitter();
      const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; kill: ReturnType<typeof vi.fn> };
      child.stdin = new PassThrough();
      child.kill = vi.fn((signal: string) => { if (signal === "SIGKILL") child.emit("close", null, "SIGKILL"); return true; });
      const spawn = vi.fn(() => child);
      const running = writeClipboard({ command: "pbcopy", args: [], foreground: false }, "AbC_123-",
        { parent, spawn, timeoutMs: 5, killGraceMs: 5 });
      const result = expect(running).rejects.toThrow(/timed out|failed/i);
      await vi.advanceTimersByTimeAsync(11);
      await result;
      expect(child.kill.mock.calls.map(call => call[0])).toEqual(["SIGTERM", "SIGKILL"]);
      expect(spawn.mock.calls[0][1]).toEqual([]);
      expect(JSON.stringify(spawn.mock.calls)).not.toContain("AbC_123-");
      expect(parent.listenerCount("SIGTERM")).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});

describe("streaming process lifecycle", () => {
  it("pipes non-TTY stdin and terminates only its owned child on SIGTERM", async () => {
    const parent = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: { isTTY: boolean } };
    parent.stdin = new PassThrough();
    parent.stdout = { isTTY: false };
    const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; kill: ReturnType<typeof vi.fn> };
    child.stdin = new PassThrough();
    child.kill = vi.fn(() => { child.emit("close", null, "SIGTERM"); return true; });
    const spawn = vi.fn(() => child);
    const running = runStreaming(["exec", "-i", "browser", "node"], { parent, spawn });
    expect(spawn).toHaveBeenCalledWith("docker", ["exec", "-i", "browser", "node"],
      expect.objectContaining({ shell: false, stdio: ["pipe", "inherit", "inherit"] }));
    parent.stdin.write("request\n");
    expect(child.stdin.read()?.toString()).toBe("request\n");
    parent.emit("SIGTERM");
    await expect(running).resolves.toBe(143);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(parent.listenerCount("SIGTERM")).toBe(0);
  });

  it("reports child spawn failure without leaving process signal handlers", async () => {
    const parent = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: { isTTY: boolean } };
    parent.stdin = new PassThrough();
    parent.stdout = { isTTY: false };
    const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; kill: ReturnType<typeof vi.fn> };
    child.stdin = new PassThrough();
    child.kill = vi.fn();
    const running = runStreaming(["exec"], { parent, spawn: () => { queueMicrotask(() => child.emit("error", new Error("ENOENT"))); return child; } });
    await expect(running).rejects.toThrow(/Docker.*start|ENOENT/i);
    expect(parent.listenerCount("SIGTERM")).toBe(0);
  });

  it("terminates an already-started Docker helper when it emits an error", async () => {
    const parent = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: { isTTY: boolean } };
    parent.stdin = new PassThrough();
    parent.stdout = { isTTY: false };
    const child = new EventEmitter() as EventEmitter & { pid: number; stdin: PassThrough; kill: ReturnType<typeof vi.fn> };
    child.pid = 123;
    child.stdin = new PassThrough();
    child.kill = vi.fn(() => { child.emit("close", null, "SIGTERM"); return true; });
    const running = runStreaming(["exec"], { parent, spawn: () => child });
    child.emit("error", new Error("transport failed"));
    await expect(running).rejects.toThrow(/Docker helper/i);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(parent.listenerCount("SIGTERM")).toBe(0);
  });

  it("closes an MCP child after piped input closes without killing unrelated processes", async () => {
    const parent = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: { isTTY: boolean } };
    parent.stdin = new PassThrough();
    parent.stdout = { isTTY: false };
    const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; kill: ReturnType<typeof vi.fn> };
    child.stdin = new PassThrough();
    child.kill = vi.fn();
    const running = runStreaming(["exec", "-i"], { parent, spawn: () => child, closeInputStopsChild: true });
    child.stdin.resume();
    const inputEnded = new Promise<void>(resolve => child.stdin.once("end", resolve));
    parent.stdin.end("last request\n");
    await inputEnded;
    child.emit("close", 0, null);
    await expect(running).resolves.toBe(0);
    expect(child.kill).not.toHaveBeenCalled();
    expect(parent.listenerCount("SIGINT")).toBe(0);
  });
});

// Measured 2026-11-01: swapping the WSL browser container ended every
// `container-client.mjs mcp` process with its `docker exec`, so each of the
// Claude Code sessions using it lost the prodex tools until someone typed
// /mcp in it. The relay now outlives the container: it reconnects, replays the
// client's handshake to the new server, and fails only what was in flight.
type Message = Record<string, unknown>;

function lineReader(stream: PassThrough): () => Message[] {
  const messages: Message[] = [];
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk.toString();
    for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
      messages.push(JSON.parse(buffer.slice(0, index)));
      buffer = buffer.slice(index + 1);
    }
  });
  return () => messages;
}

function fakeMcpChild() {
  const child = new EventEmitter() as EventEmitter & { pid: number; stdin: PassThrough; stdout: PassThrough; kill: ReturnType<typeof vi.fn> };
  child.pid = 4321;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.kill = vi.fn((signal: string) => { queueMicrotask(() => child.emit("close", null, signal)); return true; });
  const received = lineReader(child.stdin);
  return Object.assign(child, {
    received,
    answer: (message: Message) => child.stdout.write(`${JSON.stringify(message)}\n`),
    exit: (code: number) => child.emit("close", code, null)
  });
}

function fakeMcpParent() {
  const parent = new EventEmitter() as EventEmitter & { stdin: PassThrough & { isTTY?: boolean }; stdout: PassThrough };
  parent.stdin = new PassThrough();
  parent.stdout = new PassThrough();
  const received = lineReader(parent.stdout);
  return Object.assign(parent, { received, send: (message: Message) => parent.stdin.write(`${JSON.stringify(message)}\n`) });
}

const settle = () => new Promise(resolve => setTimeout(resolve, 5));
const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "claude-code", version: "2" } } };
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };
const serverInfo = { protocolVersion: "2024-11-05", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "prodex", version: "0.40.18" } };

function startRelay(options: Record<string, unknown> = {}) {
  const parent = fakeMcpParent();
  const children: ReturnType<typeof fakeMcpChild>[] = [];
  const spawn = vi.fn(() => { const child = fakeMcpChild(); children.push(child); return child; });
  const running = runMcpRelay(["exec", "-i", "browser", "node"], { parent, spawn, retryDelaysMs: [0], log: () => {}, ...options });
  return { parent, children, spawn, running };
}

async function connected() {
  const relay = startRelay();
  relay.parent.send(initialize);
  await settle();
  relay.children[0].answer({ jsonrpc: "2.0", id: 1, result: serverInfo });
  relay.parent.send(initialized);
  await settle();
  return relay;
}

describe("MCP relay across container restarts", () => {
  it("passes messages both ways unchanged while the container runs", async () => {
    const { parent, children, spawn, running } = await connected();
    expect(spawn).toHaveBeenCalledWith("docker", ["exec", "-i", "browser", "node"], expect.objectContaining({ shell: false, stdio: ["pipe", "pipe", "inherit"] }));
    expect(children[0].received()).toEqual([initialize, initialized]);
    expect(parent.received()).toEqual([{ jsonrpc: "2.0", id: 1, result: serverInfo }]);
    parent.stdin.end();
    await settle();
    children[0].exit(0);
    await expect(running).resolves.toBe(0);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("reconnects to the restarted container, replays the handshake and fails only the call in flight", async () => {
    const { parent, children, spawn, running } = await connected();
    parent.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "pro_consult", arguments: { prompt: "x" } } });
    await settle();
    children[0].exit(137);
    await settle();

    expect(parent.received()[1]).toMatchObject({ jsonrpc: "2.0", id: 2, error: { code: -32000, message: expect.stringMatching(/restarted[\s\S]*pro_recover/) } });
    expect(spawn).toHaveBeenCalledTimes(2);
    const [replay] = children[1].received();
    expect(replay).toMatchObject({ jsonrpc: "2.0", method: "initialize", params: initialize.params });
    expect(replay.id).not.toBe(1);

    children[1].answer({ jsonrpc: "2.0", id: replay.id, result: serverInfo });
    await settle();
    expect(children[1].received().slice(1)).toEqual([initialized]);
    // The replayed answer stays inside the relay; the client is told to fetch
    // the tools again, since the new server may be a newer build.
    expect(parent.received().slice(2)).toEqual([{ jsonrpc: "2.0", method: "notifications/tools/list_changed" }]);

    parent.send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    await settle();
    expect(children[1].received().at(-1)).toEqual({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    children[1].answer({ jsonrpc: "2.0", id: 3, result: { tools: [] } });
    await settle();
    expect(parent.received().at(-1)).toEqual({ jsonrpc: "2.0", id: 3, result: { tools: [] } });

    parent.stdin.end();
    await settle();
    children[1].exit(0);
    await expect(running).resolves.toBe(0);
  });

  it("keeps trying while the container is down and holds the client's requests until it is back", async () => {
    const { parent, children, spawn, running } = await connected();
    children[0].exit(137);
    await settle();
    parent.send({ jsonrpc: "2.0", id: 4, method: "tools/list" });
    // `docker exec` into a container that is not running yet exits at once.
    children[1].exit(1);
    await settle();
    expect(spawn).toHaveBeenCalledTimes(3);
    expect(children[1].received().map(message => message.method)).toEqual(["initialize"]);

    const [replay] = children[2].received();
    children[2].answer({ jsonrpc: "2.0", id: replay.id, result: serverInfo });
    await settle();
    expect(children[2].received().slice(1)).toEqual([initialized, { jsonrpc: "2.0", id: 4, method: "tools/list" }]);

    parent.emit("SIGTERM");
    await expect(running).resolves.toBe(143);
    expect(children[2].kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("answers a request with an error when the container stays away too long", async () => {
    const { parent, children, running } = await (async () => {
      const relay = startRelay({ queueTimeoutMs: 30 });
      relay.parent.send(initialize);
      await settle();
      relay.children[0].answer({ jsonrpc: "2.0", id: 1, result: serverInfo });
      await settle();
      return relay;
    })();
    children[0].exit(137);
    await settle();
    parent.send({ jsonrpc: "2.0", id: 5, method: "tools/list" });
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(parent.received().at(-1)).toMatchObject({ jsonrpc: "2.0", id: 5, error: { code: -32000, message: expect.stringMatching(/not reachable/) } });
    parent.emit("SIGTERM");
    await expect(running).resolves.toBe(143);
  });

  it("sends an unanswered initialize again instead of failing it", async () => {
    const { parent, children, running } = startRelay();
    parent.send(initialize);
    await settle();
    children[0].exit(137);
    await settle();
    expect(children[1].received()).toEqual([initialize]);
    expect(parent.received()).toEqual([]);
    children[1].answer({ jsonrpc: "2.0", id: 1, result: serverInfo });
    await settle();
    expect(parent.received()).toEqual([{ jsonrpc: "2.0", id: 1, result: serverInfo }]);
    parent.stdin.end();
    await settle();
    children[1].exit(0);
    await expect(running).resolves.toBe(0);
  });

  it("stops reconnecting once the client closes its input", async () => {
    const { parent, children, spawn, running } = await connected();
    children[0].exit(137);
    await settle();
    parent.stdin.end();
    await settle();
    children[1].exit(1);
    await expect(running).resolves.toBe(0);
    expect(spawn).toHaveBeenCalledTimes(2);
  });
});
