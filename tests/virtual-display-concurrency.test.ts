import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ home: "", ready: false, spawn: vi.fn(), spawnSync: vi.fn() }));

vi.mock("node:os", async (original) => {
  const actual = await original<typeof import("node:os")>();
  return { ...actual, default: { ...actual.default, homedir: () => state.home } };
});
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: state.spawn, spawnSync: state.spawnSync };
});
vi.mock("node:net", async (original) => {
  const actual = await original<typeof import("node:net")>();
  return {
    ...actual,
    default: {
      ...actual.default,
      connect: (options: { path?: string }) => {
        const socket = Object.assign(new EventEmitter(), { destroy: vi.fn(), setTimeout: vi.fn() });
        const ready = Boolean(options.path && state.ready);
        queueMicrotask(() => socket.emit(ready ? "connect" : "error", new Error("fixture only")));
        return socket;
      }
    }
  };
});

import { ensureVirtualDisplay } from "../src/chatgpt-browser.js";

it.skipIf(process.platform !== "linux")("serializes display allocation and preserves the first authority cookie", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "prodex-display-reservation-"));
  state.home = home;
  state.ready = false;
  state.spawnSync.mockImplementation((command: string, args: string[]) => {
    if (command === "xauth") writeFileSync(args[1], args[5]);
    return { status: 0, stdout: "", stderr: "" };
  });
  state.spawn.mockImplementation(() => {
    state.ready = true;
    return Object.assign(new EventEmitter(), { unref: vi.fn(), kill: vi.fn(), exitCode: null, signalCode: null });
  });
  try {
    const results = await Promise.all(Array.from({ length: 5 }, () => ensureVirtualDisplay({ displayNumber: 99 })));
    expect(state.spawn).toHaveBeenCalledTimes(1);
    expect(results.filter((result) => result.startedNow)).toHaveLength(1);
    expect(new Set(results.map((result) => result.xauthority)).size).toBe(1);
    const authCalls = state.spawnSync.mock.calls.filter(([command]) => command === "xauth");
    expect(authCalls).toHaveLength(1);
    expect(await readFile(results[0].xauthority, "utf8")).toBe(authCalls[0][1][5]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
