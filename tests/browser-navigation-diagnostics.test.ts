import { describe, expect, it } from "vitest";

import { createNavigationDiagnostics } from "../scripts/browser-navigation-diagnostics.mjs";

const targetUrl = "https://chatgpt.com/?from=smoke";
const frameId = "main-frame";
const loaderId = "current-loader";
const requestId = "document-request";

function collector(options: Record<string, unknown> = {}) {
  let time = 0;
  return createNavigationDiagnostics({ frameId, targetUrl, now: () => ++time, ...options });
}

function request(params: Record<string, unknown> = {}) {
  return {
    method: "Network.requestWillBeSent",
    params: {
      frameId,
      loaderId,
      requestId,
      type: "Document",
      request: { url: targetUrl },
      ...params
    }
  };
}

function response(status: unknown, params: Record<string, unknown> = {}) {
  return {
    method: "Network.responseReceived",
    params: {
      loaderId,
      requestId,
      type: "Document",
      response: { status, mimeType: "text/html" },
      ...params
    }
  };
}

function load(params: Record<string, unknown> = {}) {
  return { method: "Page.lifecycleEvent", params: { frameId, loaderId, name: "load", ...params } };
}

const navigation = { frameId, loaderId };

describe("bounded navigation diagnostics", () => {
  it("starts unobserved with the stable, privacy-safe snapshot shape", () => {
    const trace = collector();
    expect(trace.snapshot()).toEqual({
      httpStatus: null,
      correlation: "unobserved",
      responses: [],
      transportFailure: null,
      truncated: false,
      documentLoaded: false
    });
  });

  it("attributes only the tracked main-frame Document response and confirms an event-before-ack navigation", () => {
    const trace = collector();
    trace.record(response(499));
    trace.record(request({ request: { url: `${targetUrl}#section` } }));
    trace.record(response(403, { response: { status: 403, mimeType: "text/html", headers: { "cf-mitigated": "challenge" } } }));
    expect(trace.snapshot()).toMatchObject({ correlation: "provisional", httpStatus: null });
    trace.bindNavigation(navigation);
    expect(trace.snapshot()).toEqual({
      httpStatus: 403,
      correlation: "confirmed",
      responses: [{ atMs: 1, status: 403, kind: "response", contentType: "text/html", challenge: true }],
      transportFailure: null,
      truncated: false,
      documentLoaded: false
    });
  });

  it("accepts the navigation reply before events and ignores a different loader", () => {
    const trace = collector();
    trace.bindNavigation(navigation);
    trace.record(request({ loaderId: "prior-loader", requestId: "prior-request" }));
    trace.record(request());
    trace.record(response(500, { loaderId: "prior-loader", requestId: "prior-request" }));
    trace.record(response(200));
    expect(trace.snapshot()).toMatchObject({
      correlation: "confirmed",
      httpStatus: 200,
      responses: [{ status: 200, kind: "response" }]
    });
  });

  it("requires the tracked loader on responseReceived, even when the request ID matches", () => {
    const trace = collector();
    trace.record(request());
    trace.bindNavigation(navigation);
    trace.record(response(403, { loaderId: undefined }));
    trace.record(response(404, { loaderId: "prior-loader" }));
    trace.record(response(405, { frameId: "child-frame" }));
    expect(trace.snapshot()).toMatchObject({ httpStatus: null, responses: [] });
    trace.record(response(200));
    expect(trace.snapshot()).toMatchObject({ httpStatus: 200, responses: [{ status: 200 }] });
  });

  it("never lets a same-URL child Document overwrite the main-frame response", () => {
    const trace = collector();
    trace.record(request({ frameId: "child-frame", requestId: "child-request" }));
    trace.record(request());
    trace.bindNavigation(navigation);
    trace.record(response(403, { requestId: "child-request" }));
    trace.record(response(200));
    expect(trace.snapshot()).toMatchObject({ httpStatus: 200, responses: [{ status: 200 }] });
  });

  it("follows same-request query redirects but uses the final response for httpStatus", () => {
    const trace = collector();
    trace.record(request());
    trace.record(request({
      request: { url: "https://chatgpt.com/?from=redirected" },
      redirectResponse: { status: 302, mimeType: "text/html" }
    }));
    trace.bindNavigation(navigation);
    expect(trace.snapshot()).toMatchObject({
      httpStatus: null,
      responses: [{ status: 302, kind: "redirect" }]
    });
    trace.record(response(403));
    expect(trace.snapshot()).toMatchObject({
      httpStatus: 403,
      responses: [{ status: 302, kind: "redirect" }, { status: 403, kind: "response" }]
    });
  });

  it("does not accept a different query as the initial target", () => {
    const trace = collector();
    trace.record(request({ request: { url: "https://chatgpt.com/?from=elsewhere" } }));
    trace.bindNavigation(navigation);
    trace.record(response(200));
    expect(trace.snapshot()).toMatchObject({ correlation: "unobserved", httpStatus: null, responses: [] });
  });

  it("withholds status when the navigation reply mismatches the observed loader", () => {
    const trace = collector();
    trace.record(request());
    trace.record(response(403));
    trace.bindNavigation({ frameId, loaderId: "other-loader" });
    expect(trace.snapshot()).toMatchObject({ correlation: "mismatch", httpStatus: null, responses: [{ status: 403 }] });
  });

  it("keeps a missing or incomplete reply provisional", () => {
    const trace = collector();
    trace.record(request());
    trace.record(response(200));
    trace.bindNavigation({ frameId });
    expect(trace.snapshot()).toMatchObject({ correlation: "provisional", httpStatus: null });
  });

  it("confirms only the matching HTTP response code failure reply", () => {
    const httpFailure = collector();
    httpFailure.record(request());
    httpFailure.record(response(500));
    httpFailure.bindNavigation({ ...navigation, errorText: "net::ERR_HTTP_RESPONSE_CODE_FAILURE" });
    expect(httpFailure.snapshot()).toMatchObject({ correlation: "confirmed", httpStatus: 500 });

    const otherFailure = collector();
    otherFailure.record(request());
    otherFailure.record(response(500));
    otherFailure.bindNavigation({ ...navigation, errorText: "net::ERR_CONNECTION_RESET" });
    expect(otherFailure.snapshot()).toMatchObject({ correlation: "provisional", httpStatus: null, responses: [{ status: 500 }] });
  });

  it("rejects malformed and non-HTTP statuses without throwing", () => {
    const trace = collector();
    for (const event of [null, undefined, {}, { method: "Network.requestWillBeSent", params: null },
      request({ type: "XHR" }), request({ loaderId: "" })]) {
      expect(() => trace.record(event)).not.toThrow();
    }
    trace.record(request());
    for (const status of [NaN, Infinity, 99, 600, 200.5, "200"]) trace.record(response(status));
    trace.bindNavigation(navigation);
    expect(trace.snapshot()).toMatchObject({ correlation: "confirmed", httpStatus: null, responses: [] });
  });

  it("does not certify an earlier status after a malformed later final response", () => {
    const trace = collector();
    trace.record(request());
    trace.bindNavigation(navigation);
    trace.record(response(403));
    trace.record(response("200"));
    expect(trace.snapshot()).toMatchObject({
      correlation: "confirmed",
      httpStatus: null,
      responses: [{ status: 403 }]
    });
  });

  it("does not certify a response whose metadata throws during sanitization", () => {
    const trace = collector();
    trace.record(request());
    trace.bindNavigation(navigation);
    const malformed = {
      status: 403,
      get mimeType() { throw new Error("private metadata"); }
    };
    expect(() => trace.record(response(403, { response: malformed }))).not.toThrow();
    expect(trace.snapshot()).toMatchObject({ httpStatus: null, responses: [] });
  });

  it("records only a tracked, sanitized network failure", () => {
    const trace = collector();
    trace.record(request());
    trace.bindNavigation(navigation);
    trace.record({ method: "Network.loadingFailed", params: { requestId: "other", errorText: "net::ERR_TIMED_OUT" } });
    trace.record({ method: "Network.loadingFailed", params: { requestId, loaderId, type: "Document", errorText: "net::ERR_CONNECTION_RESET", canceled: true } });
    expect(trace.snapshot()).toMatchObject({
      httpStatus: null,
      transportFailure: { atMs: 1, code: "net::ERR_CONNECTION_RESET", canceled: true }
    });
  });

  it("reports elapsed nondecreasing milliseconds from collector creation", () => {
    let time = 1_000;
    const trace = createNavigationDiagnostics({ frameId, targetUrl, now: () => time });
    trace.record(request());
    trace.bindNavigation(navigation);
    time = 1_025;
    trace.record(response(200));
    time = 1_020;
    trace.record(response(201));
    expect(trace.snapshot().responses.map(item => item.atMs)).toEqual([25, 25]);
  });

  it("never exposes URLs, IDs, headers, or arbitrary failure strings", () => {
    const secret = "PRIVATE_SENTINEL_927";
    const trace = collector();
    trace.record(request());
    trace.bindNavigation(navigation);
    trace.record(response(403, {
      response: {
        status: 403,
        mimeType: `text/${secret}`,
        headers: { "content-type": `text/${secret}`, "set-cookie": secret, "cf-mitigated": `challenge-${secret}` },
        url: `${targetUrl}${secret}`,
        body: secret
      }
    }));
    trace.record({ method: "Network.loadingFailed", params: { requestId, errorText: secret, canceled: secret } });
    const snapshot = trace.snapshot();
    expect(snapshot.responses[0]).toMatchObject({ contentType: null, challenge: false });
    expect(snapshot.transportFailure).toMatchObject({ code: "net::ERR_UNKNOWN", canceled: false });
    const encoded = JSON.stringify(snapshot);
    for (const value of [secret, targetUrl, frameId, loaderId, requestId]) expect(encoded).not.toContain(value);
  });

  it("bounds response history and does not certify status after truncation", () => {
    const trace = collector({ maxEvents: 2 });
    trace.record(request());
    trace.bindNavigation(navigation);
    trace.record(response(301));
    trace.record(response(302));
    trace.record(response(200));
    expect(trace.snapshot()).toMatchObject({
      correlation: "provisional",
      httpStatus: null,
      truncated: true,
      responses: [{ status: 302 }, { status: 200 }]
    });
  });

  it("returns defensive snapshot copies", () => {
    const trace = collector();
    trace.record(request());
    trace.record(response(403));
    trace.record({ method: "Network.loadingFailed", params: { requestId, errorText: "net::ERR_TIMED_OUT" } });
    const snapshot = trace.snapshot();
    snapshot.responses[0].status = 200;
    snapshot.responses.push({ atMs: 999, status: 201, kind: "response", contentType: null, challenge: false });
    snapshot.transportFailure!.code = "mutated";
    expect(trace.snapshot()).toMatchObject({
      responses: [{ status: 403 }],
      transportFailure: { code: "net::ERR_TIMED_OUT" }
    });
  });

  it("sets documentLoaded only for the tracked frame and loader after its request", () => {
    const trace = collector();
    trace.record(load());
    trace.record(request());
    trace.record(load({ frameId: "child-frame" }));
    trace.record(load({ loaderId: "prior-loader" }));
    trace.record(load({ name: "DOMContentLoaded" }));
    expect(trace.snapshot().documentLoaded).toBe(false);
    trace.record(load());
    expect(trace.snapshot().documentLoaded).toBe(true);
  });
});
