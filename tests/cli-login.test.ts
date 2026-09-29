import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { buildLoginOpenCommand, runLoginCommand, type LoginDeps } from "../src/cli-login.js";
import { runCli } from "../src/cli.js";

const target = { context: "local", dockerEndpoint: "unix:///var/run/docker.sock", id: "a".repeat(64), name: "prodex-browser-browser-1", imageId: `sha256:${"b".repeat(64)}`,
  running: true, viewerUrl: "http://127.0.0.1:39333/" };
const ready = { ready: true, reachable: true, blocker: null, mode: "headed" as const };
const waiting = { ready: false, reachable: true, blocker: "login_required", mode: "headed" as const };
function setup() {
  const service = { status: vi.fn(async () => ready), readPassword: vi.fn(async () => "AbC_123-"), ensureTab: vi.fn(async () => {}) };
  const viewer = { launchUrl: `http://127.0.0.1:12345/#${"c".repeat(64)}`, close: vi.fn(async () => {}), completed: Promise.resolve("ready" as const) };
  const deps = { discover: vi.fn(async () => target), createContainer: vi.fn(() => service),
    startViewer: vi.fn(async () => viewer), open: vi.fn(async () => {}), env: {}, signals: new EventEmitter() } satisfies LoginDeps;
  const io = { stdout: vi.fn(), stderr: vi.fn() };
  return { service, viewer, deps, io };
}

describe("guided container login", () => {
  it("is reachable through the packaged top-level login help route", async () => {
    const stdout = vi.fn();
    expect(await runCli(["login", "--help"], { cwd: process.cwd(), stdout, stderr: vi.fn() })).toBe(0);
    expect(stdout.mock.calls.flat().join()).toContain("prodex login");
  });
  it("returns ready without opening a viewer or reading credentials", async () => {
    const { service, deps, io } = setup();
    expect(await runLoginCommand([], io, deps)).toBe(0);
    expect(deps.startViewer).not.toHaveBeenCalled();
    expect(deps.open).not.toHaveBeenCalled();
    expect(service.readPassword).not.toHaveBeenCalled();
    expect(io.stdout.mock.calls.flat().join()).toContain("READY");
  });
  it("help performs no discovery and rejects unknown/duplicate flags", async () => {
    const { deps, io } = setup();
    expect(await runLoginCommand(["--help"], io, deps)).toBe(0);
    expect(deps.discover).not.toHaveBeenCalled();
    await expect(runLoginCommand(["--port", "9333"], io, deps)).rejects.toThrow(/Unknown/);
    await expect(runLoginCommand(["--context", "one", "--context", "two"], io, deps)).rejects.toThrow(/once/);
    await expect(runLoginCommand(["--timeout-ms", "99999999"], io, deps)).rejects.toThrow(/timeout|1200000/);
  });
  it("check reports an auth blocker without opening, starting or reading a password", async () => {
    const { service, deps, io } = setup();
    service.status.mockResolvedValue(waiting as typeof ready);
    expect(await runLoginCommand(["--check"], io, deps)).toBe(2);
    expect(deps.startViewer).not.toHaveBeenCalled();
    expect(service.readPassword).not.toHaveBeenCalled();
  });
  it("requires SSH callers to explicitly choose the remote computer's screen", async () => {
    const { service, deps, io } = setup();
    service.status.mockResolvedValue(waiting as typeof ready);
    deps.env = { SSH_CONNECTION: "synthetic" } as typeof deps.env;
    await expect(runLoginCommand([], io, deps)).rejects.toThrow(/SSH|viewer computer/);
    expect(deps.startViewer).not.toHaveBeenCalled();
  });
  it("opens exactly once with private credential callbacks and always closes", async () => {
    const { service, viewer, deps, io } = setup();
    service.status.mockResolvedValueOnce(waiting as typeof ready);
    expect(await runLoginCommand(["--local-screen"], io, deps)).toBe(0);
    expect(deps.startViewer).toHaveBeenCalledWith(expect.objectContaining({ upstreamUrl: target.viewerUrl, readPassword: service.readPassword }));
    expect(deps.open).toHaveBeenCalledExactlyOnceWith(viewer.launchUrl);
    expect(viewer.close).toHaveBeenCalledOnce();
    expect(service.readPassword).not.toHaveBeenCalled();
    expect(JSON.stringify([io.stdout.mock.calls, io.stderr.mock.calls])).not.toContain(viewer.launchUrl);
    expect(deps.signals.listenerCount("SIGINT")).toBe(0);
  });
  it("reports opener failure without exposing launch token and closes the bridge", async () => {
    const { service, viewer, deps, io } = setup();
    service.status.mockResolvedValue(waiting as typeof ready);
    deps.open.mockRejectedValue(new Error(viewer.launchUrl));
    await expect(runLoginCommand([], io, deps)).rejects.toThrow(/^Could not open/);
    expect(viewer.close).toHaveBeenCalledOnce();
    expect(deps.signals.listenerCount("SIGTERM")).toBe(0);
  });
  it("cancels only the temporary viewer and removes signal handlers", async () => {
    const { service, viewer, deps, io } = setup();
    service.status.mockResolvedValue(waiting as typeof ready);
    viewer.completed = new Promise(() => {});
    deps.open.mockImplementation(async () => { queueMicrotask(() => deps.signals.emit("SIGTERM")); });
    expect(await runLoginCommand([], io, deps)).toBe(143);
    expect(viewer.close).toHaveBeenCalledOnce();
    expect(deps.signals.listenerCount("SIGTERM")).toBe(0);
  });
  it("does not call an authenticated wait completion proof of current readiness", async () => {
    const { service, deps, io } = setup();
    service.status.mockResolvedValue(waiting as typeof ready);
    expect(await runLoginCommand([], io, deps)).toBe(2);
    expect(io.stdout.mock.calls.flat().join()).not.toContain("READY");
  });
  it("opens at most one missing tab, never while login redirects are active", async () => {
    const { service, deps, io } = setup();
    service.status.mockResolvedValueOnce({ ...waiting, blocker: "chatgpt_page_missing" } as typeof ready);
    await runLoginCommand([], io, deps);
    expect(service.ensureTab).toHaveBeenCalledOnce();
    service.ensureTab.mockClear();
    service.status.mockResolvedValueOnce(waiting as typeof ready);
    await runLoginCommand([], io, deps);
    expect(service.ensureTab).not.toHaveBeenCalled();
  });
  it("refuses stopped, inaccessible, headless or unknown-mode services without fallback", async () => {
    for (const state of [ { ...waiting, reachable: false }, { ...waiting, mode: "headless" }, { ...waiting, mode: "unknown" } ]) {
      const { service, deps, io } = setup();
      service.status.mockResolvedValue(state as typeof ready);
      await expect(runLoginCommand([], io, deps)).rejects.toThrow(/browser|mode|reachable/i);
      expect(deps.startViewer).not.toHaveBeenCalled();
    }
    const { deps, io } = setup();
    deps.discover.mockResolvedValue({ ...target, running: false });
    await expect(runLoginCommand([], io, deps)).rejects.toThrow(/stopped/i);
  });
});

describe("local screen opening", () => {
  const url = `http://127.0.0.1:12345/#${"e".repeat(64)}`;
  it("uses the current machine's opener and never invokes a shell", () => {
    expect(buildLoginOpenCommand(url, "darwin", {})).toEqual({ command: "open", args: [url] });
    expect(buildLoginOpenCommand(url, "linux", { DISPLAY: ":0" })).toEqual({ command: "xdg-open", args: [url] });
    expect(buildLoginOpenCommand(url, "win32", {}).command).toBe("powershell.exe");
    expect(buildLoginOpenCommand(url, "linux", { WSL_DISTRO_NAME: "Ubuntu" }).command).toMatch(/powershell\.exe$/);
  });
  it("refuses nonlocal or command-bearing URLs and absent Linux displays", () => {
    for(const value of ["https://example.org/", "http://127.0.0.1:12345/'evil", "http://127.0.0.1:12345/#'$(evil)"])
      expect(() => buildLoginOpenCommand(value, "win32", {})).toThrow(/URL/);
    expect(() => buildLoginOpenCommand(url, "linux", {})).toThrow(/display|desktop/i);
  });
});
