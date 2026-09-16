import { EventEmitter } from "node:events";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  buildServiceLaunchPlan,
  generateVncPassword,
  loadOrCreateVncPassword,
  runContainerBrowserService,
  serviceEnvironment
} from "../containers/browser/service.mjs";
import { checkContainerBrowserHealth } from "../containers/browser/health.mjs";

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor(readonly pid: number) {
    super();
  }
}

const config = {
  display: ":99",
  xauthority: "/tmp/prodex-display/Xauthority",
  profileDir: "/home/node/.prodex/chatgpt-profile",
  rfbauthPath: "/home/node/.vnc/passwd",
  cdpPort: 9333,
  vncPort: 5900,
  viewerPort: 6080,
  chromeCommand: "/usr/bin/chromium"
};

describe("container browser service launch plan", () => {
  it("passes only display and locale settings to browser and display children", () => {
    expect(serviceEnvironment(config, {
      LANG: "C.UTF-8", LC_ALL: "C.UTF-8", HOME: "/host/home",
      OPENAI_API_KEY: "synthetic-secret", PRODEX_TOKEN: "synthetic-token",
      NODE_OPTIONS: "--require=/host/injection.js", PATH: "/host/bin"
    })).toEqual({
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      LANG: "C.UTF-8", LC_ALL: "C.UTF-8", HOME: "/home/node",
      DISPLAY: config.display, XAUTHORITY: config.xauthority
    });
  });
  it("keeps control on loopback and makes only the web viewer reachable through Docker", () => {
    const plan = buildServiceLaunchPlan(config);

    expect(plan.xvfb).toEqual({
      command: "Xvfb",
      args: [":99", "-screen", "0", "1440x900x24", "-nolisten", "tcp", "-auth", config.xauthority]
    });
    expect(plan.chromium.command).toBe("/usr/bin/chromium");
    expect(plan.chromium.args).toContain("--remote-debugging-address=127.0.0.1");
    expect(plan.chromium.args).toContain("--remote-debugging-port=9333");
    expect(plan.chromium.args).toContain(`--user-data-dir=${config.profileDir}`);
    expect(plan.chromium.args.at(-1)).toBe("about:blank");
    expect(plan.chromium.args.join(" ")).not.toMatch(/headless|no-sandbox|disable-setuid-sandbox|AutomationControlled|password-store|keychain/i);
    expect(plan.x11vnc.args).toEqual([
      "-display", ":99",
      "-auth", config.xauthority,
      "-rfbauth", config.rfbauthPath,
      "-rfbport", "5900",
      "-localhost",
      "-forever",
      "-shared"
    ]);
    expect(plan.websockify).toEqual({
      command: "websockify",
      args: ["--web=/usr/share/novnc", "0.0.0.0:6080", "127.0.0.1:5900"]
    });
  });

  it("reuses the private viewer password instead of replacing it at each restart", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-viewer-test-"));
    try {
      const file = path.join(root, "password");
      const first = await loadOrCreateVncPassword(file);
      expect(first).toMatch(/^[A-Za-z0-9_-]{8}$/);
      expect(await loadOrCreateVncPassword(file)).toBe(first);
      expect(await readFile(file, "utf8")).toBe(`${first}\n`);
      if (process.platform !== "win32") {
        await chmod(file, 0o644);
        await expect(loadOrCreateVncPassword(file)).rejects.toThrow(/private/);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates an eight-character password without exposing it in service arguments", () => {
    const password = generateVncPassword(() => Buffer.from([0, 1, 2, 3, 4, 5, 62, 63]));
    const plan = buildServiceLaunchPlan(config);

    expect(password).toBe("ABCDEF-_");
    expect(password).toHaveLength(8);
    expect(JSON.stringify(plan)).not.toContain(password);
  });
});

describe("container browser service lifecycle", () => {
  it("records the verified headed browser and closes it before terminating owned children", async () => {
    const events: string[] = [];
    let pid = 100;
    const children = new Map<string, FakeChild>();
    const operations = {
      prepareCredentials: vi.fn(async () => events.push("prepare")),
      spawnService: vi.fn((name: string) => {
        events.push(`spawn:${name}`);
        const child = new FakeChild(++pid);
        children.set(name, child);
        return child;
      }),
      waitUntilReady: vi.fn(async (name: string) => events.push(`ready:${name}`)),
      verifyBrowserProcess: vi.fn(async ({ child }: { child: FakeChild }) => {
        events.push(`verify:${child.pid}`);
      }),
      recordLaunch: vi.fn(async (record: unknown) => {
        events.push("record");
        expect(record).toEqual({
          profile_dir: config.profileDir,
          port: 9333,
          headless: false,
          minimized: false
        });
      }),
      createStopWaiter: vi.fn(() => ({ promise: new Promise(resolve => setTimeout(() => resolve("SIGTERM"), 0)), dispose: vi.fn() })),
      closeBrowser: vi.fn(async () => events.push("close-browser")),
      terminateChild: vi.fn(async (_child: FakeChild, name: string) => events.push(`terminate:${name}`))
    };

    await runContainerBrowserService({ config, operations });

    expect(events).toEqual([
      "prepare",
      "spawn:xvfb", "ready:xvfb",
      "spawn:chromium", "ready:chromium", "verify:102", "record",
      "spawn:x11vnc", "ready:x11vnc",
      "spawn:websockify", "ready:websockify",
      "close-browser",
      "terminate:websockify", "terminate:x11vnc", "terminate:chromium", "terminate:xvfb"
    ]);
    expect(children.size).toBe(4);
  });

  it("does not spawn anything after a shutdown requested during preparation", async () => {
    const operations = {
      prepareCredentials: vi.fn(async () => undefined),
      spawnService: vi.fn(),
      waitUntilReady: vi.fn(),
      verifyBrowserProcess: vi.fn(),
      recordLaunch: vi.fn(),
      createStopWaiter: vi.fn(() => ({ promise: Promise.resolve("SIGTERM"), dispose: vi.fn() })),
      closeBrowser: vi.fn(),
      terminateChild: vi.fn()
    };
    await runContainerBrowserService({ config, operations });
    expect(operations.spawnService).not.toHaveBeenCalled();
  });

  it("attempts cleanup of every child even when one termination fails", async () => {
    const terminated: string[] = [];
    let pid = 600;
    const operations = {
      prepareCredentials: vi.fn(async () => undefined),
      spawnService: vi.fn(() => new FakeChild(++pid)),
      waitUntilReady: vi.fn(async (name: string) => { if (name === "chromium") throw new Error("startup failed"); }),
      verifyBrowserProcess: vi.fn(),
      recordLaunch: vi.fn(),
      createStopWaiter: vi.fn(() => ({ promise: new Promise(() => undefined), dispose: vi.fn() })),
      closeBrowser: vi.fn(),
      terminateChild: vi.fn(async (_child: FakeChild, name: string) => {
        terminated.push(name);
        if (name === "chromium") throw new Error("termination failed");
      })
    };
    await expect(runContainerBrowserService({ config, operations })).rejects.toThrow(/cleanup/);
    expect(terminated).toEqual(["chromium", "xvfb"]);
  });

  it("fails closed without metadata or later services when browser startup fails", async () => {
    const events: string[] = [];
    let pid = 200;
    const operations = {
      prepareCredentials: vi.fn(async () => undefined),
      spawnService: vi.fn((name: string) => {
        events.push(`spawn:${name}`);
        return new FakeChild(++pid);
      }),
      waitUntilReady: vi.fn(async (name: string) => {
        if (name === "chromium") throw new Error("CDP unavailable");
      }),
      verifyBrowserProcess: vi.fn(),
      recordLaunch: vi.fn(),
      createStopWaiter: vi.fn(() => ({ promise: new Promise(() => undefined), dispose: vi.fn() })),
      closeBrowser: vi.fn(),
      terminateChild: vi.fn(async (_child: FakeChild, name: string) => events.push(`terminate:${name}`))
    };

    await expect(runContainerBrowserService({ config, operations })).rejects.toThrow("CDP unavailable");

    expect(events).toEqual([
      "spawn:xvfb", "spawn:chromium", "terminate:chromium", "terminate:xvfb"
    ]);
    expect(operations.verifyBrowserProcess).not.toHaveBeenCalled();
    expect(operations.recordLaunch).not.toHaveBeenCalled();
    expect(operations.closeBrowser).not.toHaveBeenCalled();
  });

  it("does not persist metadata or start viewers when Chromium exits during identity verification", async () => {
    const spawned: string[] = [];
    let pid = 250;
    const operations = {
      prepareCredentials: vi.fn(async () => undefined),
      spawnService: vi.fn((name: string) => {
        spawned.push(name);
        return new FakeChild(++pid);
      }),
      waitUntilReady: vi.fn(async () => undefined),
      verifyBrowserProcess: vi.fn(async ({ child }: { child: FakeChild }) => {
        child.emit("exit", 1, null);
      }),
      recordLaunch: vi.fn(),
      createStopWaiter: vi.fn(() => ({ promise: new Promise(() => undefined), dispose: vi.fn() })),
      closeBrowser: vi.fn(),
      terminateChild: vi.fn(async () => undefined)
    };

    await expect(runContainerBrowserService({ config, operations })).rejects.toThrow("chromium exited");

    expect(spawned).toEqual(["xvfb", "chromium"]);
    expect(operations.recordLaunch).not.toHaveBeenCalled();
  });

  it("treats an owned service exit as fatal and runs the same bounded cleanup", async () => {
    const events: string[] = [];
    let pid = 300;
    const children = new Map<string, FakeChild>();
    const operations = {
      prepareCredentials: vi.fn(async () => undefined),
      spawnService: vi.fn((name: string) => {
        const child = new FakeChild(++pid);
        children.set(name, child);
        return child;
      }),
      waitUntilReady: vi.fn(async () => undefined),
      verifyBrowserProcess: vi.fn(async () => undefined),
      recordLaunch: vi.fn(async () => undefined),
      createStopWaiter: vi.fn(() => ({ promise: new Promise(() => undefined), dispose: vi.fn() })),
      closeBrowser: vi.fn(async () => events.push("close-browser")),
      terminateChild: vi.fn(async (_child: FakeChild, name: string) => events.push(`terminate:${name}`))
    };

    const running = runContainerBrowserService({ config, operations });
    await vi.waitFor(() => expect(children.size).toBe(4));
    children.get("x11vnc")!.emit("exit", 1, null);

    await expect(running).rejects.toThrow("x11vnc exited");
    expect(events).toEqual([
      "close-browser",
      "terminate:websockify", "terminate:x11vnc", "terminate:chromium", "terminate:xvfb"
    ]);
  });
});

describe("container browser health", () => {
  it("checks only local CDP and the local noVNC web endpoint", async () => {
    const requested: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL) => {
      requested.push(String(input));
      return {
        ok: true,
        json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/test" })
      };
    });

    await checkContainerBrowserHealth({ fetchImpl, timeoutMs: 50 });

    expect(requested).toEqual([
      "http://127.0.0.1:9333/json/version",
      "http://127.0.0.1:6080/vnc.html"
    ]);
    expect(requested.join(" ")).not.toMatch(/chatgpt|auth|login/i);
  });

  it("fails when either local endpoint is unavailable", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/test" }) })
      .mockResolvedValueOnce({ ok: false, status: 503 });

    await expect(checkContainerBrowserHealth({ fetchImpl, timeoutMs: 50 })).rejects.toThrow("noVNC");
  });
});
