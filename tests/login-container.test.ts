import { describe, expect, it, vi } from "vitest";
import { discoverLoginContainer, createLoginContainer, type DockerRunner } from "../src/login-container.js";

const id = "a".repeat(64);
function inspect(overrides: Record<string, unknown> = {}) {
  return { Id: id, Name: "/prodex-browser-browser-1", Image: `sha256:${"b".repeat(64)}`,
    Config: { Labels: { "com.docker.compose.project": "prodex-browser", "com.docker.compose.service": "browser" } },
    State: { Running: true, Paused: false, Restarting: false },
    NetworkSettings: { Ports: { "6080/tcp": [{ HostIp: "127.0.0.1", HostPort: "39333" }] } }, ...overrides };
}
function docker(records = [inspect()], contexts = [{ Name: "local", DockerEndpoint: "unix:///var/run/docker.sock" }]) {
  return vi.fn<DockerRunner>(async args => {
    if (args[0] === "context" && args[1] === "ls") return contexts.map(x => JSON.stringify(x)).join("\n");
    if (args.includes("context") && args.includes("inspect")) return JSON.stringify([{ Endpoints: { docker: { Host: contexts[0].DockerEndpoint } } }]);
    if (args.includes("inspect")) return JSON.stringify(records);
    if (args.includes("exec")) return JSON.stringify({ ready: true, reachable: true, blocker: null, mode: "headed" });
    throw new Error("unexpected synthetic Docker command");
  });
}

describe("local login container selection", () => {
  it("discovers one local service and derives its actual published viewer", async () => {
    const run = docker();
    const target = await discoverLoginContainer({}, run, {});
    expect(target).toMatchObject({ context: "local", id, viewerUrl: "http://127.0.0.1:39333/", running: true });
    expect(run.mock.calls.every(([a]) => !a.includes("exec"))).toBe(true);
  });
  it("refuses a remote explicit context before container or password access", async () => {
    const run = docker([], [{ Name: "remote", DockerEndpoint: "ssh://private.example" }]);
    await expect(discoverLoginContainer({ context: "remote" }, run, {})).rejects.toThrow(/viewer computer|local Docker/i);
    expect(run.mock.calls.every(([a]) => !a.includes("exec") && !a.includes("container"))).toBe(true);
  });
  it("rejects a remote Windows named pipe but accepts a local Docker Desktop pipe", async () => {
    const remote = docker([], [{ Name: "remote", DockerEndpoint: "npipe:////other-host/pipe/docker_engine" }]);
    await expect(discoverLoginContainer({ context: "remote" }, remote, {})).rejects.toThrow(/local Docker/);
    const local = docker([inspect()], [{ Name: "desktop", DockerEndpoint: "npipe:////./pipe/docker_engine" }]);
    expect((await discoverLoginContainer({ context: "desktop" }, local, {})).running).toBe(true);
  });
  it("does not silently switch away from an environment-selected Docker endpoint", async () => {
    const run = docker();
    await expect(discoverLoginContainer({}, run, { DOCKER_HOST: "tcp://127.0.0.1:9999" })).rejects.toThrow(/explicit.*context/i);
    expect(run).not.toHaveBeenCalled();
  });
  it("rejects unmanaged containers and non-loopback viewer ports", async () => {
    await expect(discoverLoginContainer({}, docker([inspect({ Config: { Labels: {} } })]), {})).rejects.toThrow(/managed|ProDex/i);
    const ports = { Ports: { "6080/tcp": [{ HostIp: "0.0.0.0", HostPort: "39333" }] } };
    await expect(discoverLoginContainer({}, docker([inspect({ NetworkSettings: ports })]), {})).rejects.toThrow(/loopback/i);
  });
  it("rejects ambiguous distinct containers and deduplicates context aliases", async () => {
    const contexts = [{ Name: "one", DockerEndpoint: "unix:///one" }, { Name: "two", DockerEndpoint: "unix:///one" }];
    const duplicate = docker([inspect()], contexts);
    expect((await discoverLoginContainer({}, duplicate, {})).id).toBe(id);
    const distinct = docker([inspect()], contexts);
    distinct.mockImplementation(async args => {
      if (args[0] === "context") return contexts.map(x => JSON.stringify(x)).join("\n");
      return JSON.stringify([inspect({ Id: args[1] === "one" ? id : "c".repeat(64) })]);
    });
    await expect(discoverLoginContainer({}, distinct, {})).rejects.toThrow(/multiple|ambiguous/i);
  });
  it("rejects unsafe names before invoking Docker", async () => {
    const run = docker();
    await expect(discoverLoginContainer({ context: "--host" }, run, {})).rejects.toThrow(/name/i);
    expect(run).not.toHaveBeenCalled();
  });
  it("never starts or replaces a stopped service during discovery", async () => {
    const run = docker([inspect({ State: { Running: false, Paused: false, Restarting: false } })]);
    await expect(discoverLoginContainer({}, run, {})).rejects.toThrow(/stopped/i);
    expect(run.mock.calls.every(([a]) => !a.includes("start") && !a.includes("restart"))).toBe(true);
  });
  it("explains a stopped service when Docker has removed its live port bindings", async () => {
    const run = docker([inspect({ State: { Running: false }, NetworkSettings: { Ports: { "6080/tcp": null } } })]);
    await expect(discoverLoginContainer({}, run, {})).rejects.toThrow(/stopped/i);
  });
});

describe("pinned container operations", () => {
  it("pins immutable ID for exec and allowlists status", async () => {
    const run = docker();
    const target = await discoverLoginContainer({}, run, {});
    run.mockClear();
    const client = createLoginContainer(target, run);
    expect(await client.status()).toEqual({ ready: true, reachable: true, blocker: null, mode: "headed" });
    expect(run.mock.calls.find(([a]) => a.includes("exec"))?.[0]).toContain(id);
    expect(run.mock.calls.every(([a]) => !a.includes(target.name))).toBe(true);
  });
  it("never reads the password during a status check", async () => {
    const run = docker();
    const client = createLoginContainer(await discoverLoginContainer({}, run, {}), run);
    await client.status();
    expect(run.mock.calls.flat(2).join(" ")).not.toContain("viewer-password");
  });
  it("validates private viewer password inside the container and redacts failures", async () => {
    const run = docker();
    const target = await discoverLoginContainer({}, run, {});
    run.mockImplementation(async args => args.includes("context") ? JSON.stringify([{ Endpoints: { docker: { Host: target.dockerEndpoint } } }])
      : args.includes("exec") ? "AbC_123-" : JSON.stringify([inspect()]));
    expect(await createLoginContainer(target, run).readPassword()).toBe("AbC_123-");
    const expression = run.mock.calls.find(([a]) => a.includes("exec"))?.[0].at(-1);
    expect(expression).toContain("O_NOFOLLOW");
    expect(expression).toContain("nlink");
    expect(expression).not.toContain("AbC_123-");
    run.mockRejectedValue(new Error("AbC_123- private environment"));
    await expect(createLoginContainer(target, run).readPassword()).rejects.toThrow(/^The selected Docker context is unavailable/);
  });
  it("refuses a replaced container before credential access", async () => {
    const run = docker();
    const target = await discoverLoginContainer({}, run, {});
    run.mockImplementation(async args => args.includes("context") ? JSON.stringify([{ Endpoints: { docker: { Host: target.dockerEndpoint } } }])
      : JSON.stringify([inspect({ Id: "d".repeat(64) })]));
    await expect(createLoginContainer(target, run).readPassword()).rejects.toThrow(/identity/i);
  });
  it("refuses a Docker context endpoint change before accessing the container", async () => {
    const run = docker();
    const target = await discoverLoginContainer({}, run, {});
    run.mockClear();
    run.mockImplementation(async args => args.includes("context")
      ? JSON.stringify([{ Endpoints: { docker: { Host: "ssh://another-machine" } } }])
      : JSON.stringify([inspect()]));
    await expect(createLoginContainer(target, run).readPassword()).rejects.toThrow(/local Docker|endpoint|context.*changed/i);
    expect(run.mock.calls.every(([args]) => !args.includes("exec") && !args.includes("container"))).toBe(true);
  });
});
