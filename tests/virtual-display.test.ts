import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  chmod: vi.fn(),
  connect: vi.fn(),
  homedir: vi.fn(),
  mkdir: vi.fn(),
  readFile: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  writeFile: vi.fn()
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: mocks.spawn, spawnSync: mocks.spawnSync };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    chmod: mocks.chmod,
    mkdir: mocks.mkdir,
    readFile: mocks.readFile,
    writeFile: mocks.writeFile
  };
});

vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>();
  return { ...actual, default: { ...actual.default, connect: mocks.connect } };
});

vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return { ...actual, default: actual.posix };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual.default, homedir: mocks.homedir } };
});

// Allocation concurrency is covered with real files in virtual-display-concurrency.test.ts.
vi.mock("../src/safe-file.js", () => ({
  withCrossProcessFileLock: async (_path: string, _options: unknown, fn: () => Promise<unknown>) => fn()
}));

const { ensureVirtualDisplay } = await import("../src/chatgpt-browser.js");
const nativePlatform = process.platform;

function setPlatformForTest(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform });
}

class FakeChild extends EventEmitter {
  readonly pid = 42001;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly unref = vi.fn();
  readonly kill = vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
    this.signalCode = signal;
    return true;
  });

  failSpawn(error: Error): void {
    queueMicrotask(() => {
      // A real ChildProcess throws an unhandled `error` event when production
      // forgets the listener. Keep RED hermetic while still delivering the
      // event as soon as the implementation subscribes to it.
      if (this.listenerCount("error") > 0) this.emit("error", error);
    });
  }
}

function socketThat(accepts: boolean): EventEmitter {
  const socket = new EventEmitter() as EventEmitter & {
    destroy: ReturnType<typeof vi.fn>;
    setTimeout: ReturnType<typeof vi.fn>;
  };
  socket.destroy = vi.fn();
  socket.setTimeout = vi.fn().mockReturnValue(socket);
  queueMicrotask(() => socket.emit(accepts ? "connect" : "error", accepts ? undefined : new Error("ECONNREFUSED")));
  return socket;
}

function isTcpConnect(options: unknown): options is { host: string; port: number } {
  return typeof options === "object" && options !== null && "port" in options;
}

function isAbstractConnect(options: unknown): options is { path: string } {
  return typeof options === "object" && options !== null && "path" in options;
}

async function settleVirtualDisplay(result: Promise<unknown>): Promise<void> {
  const settled = result.catch(() => undefined);
  await vi.runAllTimersAsync();
  await settled;
}

async function runVirtualDisplay<T>(result: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return result;
}

describe("virtual X display transport", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    setPlatformForTest("linux");
    mocks.homedir.mockReturnValue("/virtual-home");
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.chmod.mockResolvedValue(undefined);
    mocks.writeFile.mockResolvedValue(undefined);
    mocks.readFile.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    mocks.spawnSync.mockReturnValue({ status: 0, stdout: "", stderr: "" });
    mocks.spawn.mockImplementation(() => new FakeChild());
    mocks.connect.mockImplementation(() => socketThat(false));
  });

  afterEach(() => {
    setPlatformForTest(nativePlatform);
    vi.useRealTimers();
  });

  it("skips an occupied legacy TCP display without reading or overwriting its auth file", async () => {
    const firstAuth = "/virtual-home/.local/share/prodex/xvfb/Xauthority-71";
    const secondAuth = "/virtual-home/.local/share/prodex/xvfb/Xauthority-72";
    let secondAbstractProbes = 0;
    mocks.connect.mockImplementation((options: unknown) => {
      if (isTcpConnect(options)) return socketThat(options.port === 6071);
      if (isAbstractConnect(options) && options.path === "\0/tmp/.X11-unix/X72") {
        secondAbstractProbes += 1;
        return socketThat(secondAbstractProbes > 1);
      }
      return socketThat(false);
    });

    const result = await runVirtualDisplay(ensureVirtualDisplay({ displayNumber: 71 }));

    expect(result).toEqual({ displayNumber: 72, xauthority: secondAuth, startedNow: true });
    expect(mocks.readFile).not.toHaveBeenCalledWith(firstAuth);
    expect(mocks.writeFile).not.toHaveBeenCalledWith(firstAuth, expect.anything(), expect.anything());
    expect(mocks.spawn).toHaveBeenCalledWith(
      "Xvfb",
      expect.arrayContaining([":72", "-nolisten", "tcp", "unix", "-auth", secondAuth]),
      expect.anything()
    );
  });

  it("reuses an authenticated abstract-only display without launching another server", async () => {
    const xauthority = "/virtual-home/.local/share/prodex/xvfb/Xauthority-81";
    mocks.connect.mockImplementation((options: unknown) => {
      if (isTcpConnect(options)) return socketThat(false);
      return socketThat(isAbstractConnect(options) && options.path === "\0/tmp/.X11-unix/X81");
    });
    mocks.readFile.mockImplementation(async (filePath: string) => {
      if (filePath === xauthority) return Buffer.from("existing-authority");
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });

    const result = await runVirtualDisplay(ensureVirtualDisplay({ displayNumber: 81 }));

    expect(result).toEqual({ displayNumber: 81, xauthority, startedNow: false });
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("creates matching Unix-family auth and waits for only the abstract socket", async () => {
    const xauthority = "/virtual-home/.local/share/prodex/xvfb/Xauthority-91";
    let abstractProbes = 0;
    mocks.connect.mockImplementation((options: unknown) => {
      if (isTcpConnect(options)) return socketThat(false);
      abstractProbes += 1;
      return socketThat(isAbstractConnect(options) && options.path === "\0/tmp/.X11-unix/X91" && abstractProbes > 1);
    });

    const result = await runVirtualDisplay(ensureVirtualDisplay({ displayNumber: 91 }));

    expect(result).toEqual({ displayNumber: 91, xauthority, startedNow: true });
    expect(mocks.spawnSync).toHaveBeenCalledWith(
      "xauth",
      ["-f", xauthority, "add", ":91", ".", expect.any(String)],
      expect.objectContaining({ timeout: 10_000 })
    );
    expect(mocks.writeFile).toHaveBeenCalledWith(xauthority, "", { mode: 0o600 });
    expect(mocks.chmod).toHaveBeenCalledWith(xauthority, 0o600);
    expect(mocks.chmod).toHaveBeenCalledTimes(2);
    const postSpawnTcpProbes = mocks.connect.mock.calls
      .slice(2)
      .filter(([options]) => isTcpConnect(options));
    expect(postSpawnTcpProbes).toHaveLength(0);
  });

  it("reports an asynchronous spawn error and cleans up only the child it created", async () => {
    const child = new FakeChild();
    mocks.spawn.mockImplementation(() => {
      child.failSpawn(new Error("spawn Xvfb EACCES"));
      return child;
    });

    const pending = ensureVirtualDisplay({ displayNumber: 101 });
    const assertion = expect(pending).rejects.toThrow(/Xvfb.*spawn Xvfb EACCES/i);
    await settleVirtualDisplay(pending);
    await assertion;

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it("fails clearly before probing or creating state on unsupported platforms", async () => {
    const unsupportedPlatform = nativePlatform === "linux" ? "darwin" : nativePlatform;
    setPlatformForTest(unsupportedPlatform);
    mocks.connect.mockImplementation(() => socketThat(true));
    mocks.readFile.mockResolvedValue(Buffer.from("legacy-authority"));
    await expect(ensureVirtualDisplay({ displayNumber: 111 })).rejects.toThrow(/Linux.*only/i);
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.mkdir).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
