import { describe, expect, it, vi } from "vitest";

import { runNavigationProbe } from "../scripts/browser-navigation-probe.mjs";

const url = "http://127.0.0.1:4242/start";
const acknowledgement = { frameId: "main", loaderId: "navigation" };

function harness(navigate?: (emit: (event: object) => void) => Promise<object>) {
  const listeners = new Set<(event: object) => void>();
  const emit = (event: object) => listeners.forEach(listener => listener(event));
  const send = vi.fn(async (method: string) => {
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
    if (method === "Page.navigate") {
      if (navigate) return navigate(emit);
      emit(request());
      emit(response(200));
      emit(loaded());
      return acknowledgement;
    }
    return {};
  });
  const subscribe = vi.fn((listener: (event: object) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  return { send, subscribe, listeners };
}

function request() {
  return {
    method: "Network.requestWillBeSent",
    params: { type: "Document", frameId: "main", loaderId: "navigation", requestId: "request", request: { url } }
  };
}

function response(status: number) {
  return {
    method: "Network.responseReceived",
    params: {
      type: "Document", frameId: "main", loaderId: "navigation", requestId: "request",
      response: { url, status, headers: { "Content-Type": "text/html; charset=utf-8" } }
    }
  };
}

function loaded() {
  return { method: "Page.lifecycleEvent", params: { frameId: "main", loaderId: "navigation", name: "load" } };
}

const options = { url, timeoutMs: 100, observationMs: 25 };

describe("bounded navigation probe", () => {
  it("subscribes before one navigation and reports the matched loaded document", async () => {
    const session = harness();
    const result = await runNavigationProbe(session, options);
    expect(result).toMatchObject({ outcome: "response", phase: "complete", failedPhase: null, navigationCommands: 1 });
    expect(result.diagnostics).toMatchObject({ httpStatus: 200, correlation: "confirmed", documentLoaded: true });
    expect(session.send.mock.calls.map(call => call[0])).toEqual([
      "Page.enable", "Page.setLifecycleEventsEnabled", "Page.getFrameTree", "Network.enable", "Page.navigate"
    ]);
    expect(session.listeners.size).toBe(0);
  });

  it("preserves an observed refusal when the navigation acknowledgement times out", async () => {
    const session = harness(async emit => {
      emit(request());
      emit(response(403));
      return new Promise(() => {});
    });
    const result = await runNavigationProbe(session, { ...options, timeoutMs: 15 });
    expect(result).toMatchObject({ outcome: "timeout", failedPhase: "navigate", navigationCommands: 1, error: { code: "command_timeout" } });
    expect(result.diagnostics).toMatchObject({ httpStatus: null, correlation: "provisional", responses: [{ status: 403 }] });
    expect(session.send.mock.calls.filter(call => call[0] === "Page.navigate")).toHaveLength(1);
    expect(session.listeners.size).toBe(0);
  });

  it("stops at HTTP refusal without waiting for a usable DOM or retrying", async () => {
    const session = harness(async emit => {
      emit(request());
      emit(response(403));
      return acknowledgement;
    });
    const result = await runNavigationProbe(session, options);
    expect(result).toMatchObject({ outcome: "http_error", failedPhase: null });
    expect(result.diagnostics).toMatchObject({ httpStatus: 403, correlation: "confirmed", documentLoaded: false });
    expect(session.send.mock.calls.some(call => call[0].startsWith("Runtime."))).toBe(false);
  });

  it("keeps HTTP failure separate from a matching Page.navigate HTTP errorText", async () => {
    const session = harness(async emit => {
      emit(request());
      emit(response(500));
      return { ...acknowledgement, errorText: "net::ERR_HTTP_RESPONSE_CODE_FAILURE" };
    });
    expect(await runNavigationProbe(session, options)).toMatchObject({ outcome: "http_error", diagnostics: { httpStatus: 500 } });
  });

  it("does not call a challenge response successful even when its HTTP status is 200", async () => {
    const session = harness(async emit => {
      emit(request());
      const event = response(200);
      event.params.response.headers["cf-mitigated"] = "challenge";
      emit(event);
      emit(loaded());
      return acknowledgement;
    });
    expect(await runNavigationProbe(session, options)).toMatchObject({ outcome: "protection", diagnostics: { httpStatus: 200 } });
  });

  it("does not mistake redirect metadata for a final protection response", async () => {
    const session = harness(async emit => {
      emit(request());
      const redirect = request();
      redirect.params.request.url = `${url}?redirected=1`;
      Object.assign(redirect.params, { redirectResponse: { status: 307, headers: { "cf-mitigated": "challenge" } } });
      emit(redirect);
      return acknowledgement;
    });
    const result = await runNavigationProbe(session, options);
    expect(result).toMatchObject({ outcome: "timeout", failedPhase: "observe", diagnostics: { httpStatus: null } });
    expect(result.diagnostics.responses).toMatchObject([{ status: 307, kind: "redirect", challenge: true }]);
  });

  it("recognizes a transport-owned command timeout without retaining its raw message", async () => {
    const session = harness(async () => {
      throw Object.assign(new Error("PRIVATE timeout details"), { code: "CDP_TIMEOUT" });
    });
    const result = await runNavigationProbe(session, options);
    expect(result).toMatchObject({ outcome: "timeout", failedPhase: "navigate", error: { code: "command_timeout" } });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });

  it("reports the exact failing setup phase without leaking the protocol error", async () => {
    const session = harness();
    session.send.mockImplementation(async method => {
      if (method === "Page.getFrameTree") throw new Error("https://secret.example/?token=PRIVATE cookie=PRIVATE");
      return {};
    });
    const result = await runNavigationProbe(session, options);
    expect(result).toMatchObject({ outcome: "protocol_error", failedPhase: "frame_tree", navigationCommands: 0, error: { code: "command_failed" } });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(session.listeners.size).toBe(0);
  });

  it("preserves partial response evidence if a later lifecycle wait expires", async () => {
    const session = harness(async emit => {
      emit(request());
      emit(response(200));
      return acknowledgement;
    });
    const result = await runNavigationProbe(session, options);
    expect(result).toMatchObject({ outcome: "timeout", failedPhase: "observe", error: { code: "observation_timeout" } });
    expect(result.diagnostics).toMatchObject({ httpStatus: 200, documentLoaded: false });
  });

  it("does not report success for an acknowledged navigation without network evidence", async () => {
    const session = harness(async () => acknowledgement);
    const result = await runNavigationProbe(session, options);
    expect(result).toMatchObject({ outcome: "timeout", failedPhase: "observe", diagnostics: { httpStatus: null } });
  });

  it("does not certify a response when the acknowledgement identifies another loader", async () => {
    const session = harness(async emit => {
      emit(request());
      emit(response(200));
      emit(loaded());
      return { ...acknowledgement, loaderId: "other" };
    });
    expect(await runNavigationProbe(session, options)).toMatchObject({ outcome: "uncorrelated", diagnostics: { httpStatus: null, correlation: "mismatch" } });
  });

  it("ends a matching network failure without claiming an HTTP status", async () => {
    const session = harness(async emit => {
      emit(request());
      emit({ method: "Network.loadingFailed", params: { requestId: "request", type: "Document", errorText: "net::ERR_CONNECTION_RESET", canceled: false } });
      return acknowledgement;
    });
    expect(await runNavigationProbe(session, options)).toMatchObject({ outcome: "network_error", diagnostics: { httpStatus: null } });
  });

  it.each([
    { timeoutMs: 0 }, { timeoutMs: Infinity }, { timeoutMs: 30_001 },
    { observationMs: -1 }, { observationMs: 30_001 },
    { url: "https://chatgpt.com/backend-api/private" },
    { url: "https://user:password@chatgpt.com/" }, { url: "file:///tmp/private" }
  ])("rejects invalid or out-of-scope options before any command: %j", async change => {
    const session = harness();
    await expect(runNavigationProbe(session, { ...options, ...change })).rejects.toThrow();
    expect(session.send).not.toHaveBeenCalled();
    expect(session.subscribe).not.toHaveBeenCalled();
  });
});
