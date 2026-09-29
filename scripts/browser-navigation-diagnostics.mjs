const CONTENT_TYPES = new Set(["text/html", "application/xhtml+xml", "text/plain", "application/json"]);
const NETWORK_ERRORS = new Set([
  "net::ERR_ABORTED",
  "net::ERR_ADDRESS_UNREACHABLE",
  "net::ERR_CONNECTION_CLOSED",
  "net::ERR_CONNECTION_FAILED",
  "net::ERR_CONNECTION_REFUSED",
  "net::ERR_CONNECTION_RESET",
  "net::ERR_CONNECTION_TIMED_OUT",
  "net::ERR_DNS_TIMED_OUT",
  "net::ERR_NAME_NOT_RESOLVED",
  "net::ERR_NETWORK_CHANGED",
  "net::ERR_PROXY_CONNECTION_FAILED",
  "net::ERR_TIMED_OUT"
]);

function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function withoutFragment(url) {
  if (typeof url !== "string") return null;
  const fragment = url.indexOf("#");
  return fragment < 0 ? url : url.slice(0, fragment);
}

function httpStatus(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
}

function header(headers, name) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return null;
  for (const key in headers) {
    if (Object.hasOwn(headers, key) && key.toLowerCase() === name) {
      return typeof headers[key] === "string" ? headers[key] : null;
    }
  }
  return null;
}

function contentType(response) {
  const raw = typeof response.mimeType === "string" ? response.mimeType : header(response.headers, "content-type");
  if (typeof raw !== "string") return null;
  const mime = raw.split(";", 1)[0].trim().toLowerCase();
  return CONTENT_TYPES.has(mime) ? mime : null;
}

export function createNavigationDiagnostics({ frameId, targetUrl, now = () => performance.now(), maxEvents = 64 }) {
  const target = withoutFragment(targetUrl);
  const limit = Number.isSafeInteger(maxEvents) && maxEvents >= 0 ? Math.min(maxEvents, 256) : 64;
  function readClock() {
    try {
      const value = now();
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }
  const startedAt = readClock();
  const responses = [];
  let tracked = null;
  let navigation = null;
  let latestFinalStatus = null;
  let transportFailure = null;
  let truncated = false;
  let documentLoaded = false;
  let lastAtMs = 0;

  function atMs() {
    const value = readClock();
    if (startedAt !== null && value !== null) lastAtMs = Math.max(lastAtMs, value - startedAt);
    return lastAtMs;
  }

  function appendResponse(value, kind) {
    latestFinalStatus = null;
    const status = httpStatus(value?.status);
    if (status === null) return;
    const item = {
      atMs: atMs(),
      status,
      kind,
      contentType: contentType(value),
      challenge: header(value.headers, "cf-mitigated") === "challenge"
    };
    if (kind === "response") latestFinalStatus = status;
    if (limit === 0) {
      truncated = true;
      return;
    }
    if (responses.length === limit) {
      responses.shift();
      truncated = true;
    }
    responses.push(item);
  }

  function matchesTracked(params) {
    return tracked !== null && params?.requestId === tracked.requestId &&
      (params.loaderId === undefined || params.loaderId === tracked.loaderId) &&
      (params.frameId === undefined || params.frameId === frameId);
  }

  function record(event) {
    try {
      if (!event || typeof event !== "object" || !event.params || typeof event.params !== "object") return;
      const { method, params } = event;
      if (method === "Network.requestWillBeSent") {
        if (params.type !== "Document" || params.frameId !== frameId ||
            !nonempty(params.requestId) || !nonempty(params.loaderId) ||
            !nonempty(params.request?.url)) return;
        if (tracked === null) {
          if (params.redirectResponse !== undefined || withoutFragment(params.request.url) !== target ||
              (navigation?.frameId === frameId && params.loaderId !== navigation.loaderId)) return;
          tracked = { requestId: params.requestId, loaderId: params.loaderId };
          return;
        }
        if (matchesTracked(params) && params.redirectResponse) appendResponse(params.redirectResponse, "redirect");
        return;
      }
      if (method === "Network.responseReceived") {
        if (params.type === "Document" && tracked !== null && params.loaderId === tracked.loaderId &&
            matchesTracked(params)) appendResponse(params.response, "response");
        return;
      }
      if (method === "Network.loadingFailed") {
        if (!matchesTracked(params) || (params.type !== undefined && params.type !== "Document") || transportFailure) return;
        transportFailure = {
          atMs: atMs(),
          code: NETWORK_ERRORS.has(params.errorText) ? params.errorText : "net::ERR_UNKNOWN",
          canceled: params.canceled === true
        };
        return;
      }
      if (method === "Page.lifecycleEvent" && tracked !== null && params.name === "load" &&
          params.frameId === frameId && params.loaderId === tracked.loaderId) {
        documentLoaded = true;
      }
    } catch {
      // CDP events are observational input; malformed values must not interrupt navigation.
    }
  }

  function bindNavigation(result) {
    if (navigation !== null) return;
    try {
      if (!nonempty(result?.frameId) || !nonempty(result?.loaderId) ||
          (nonempty(result?.errorText) && result.errorText !== "net::ERR_HTTP_RESPONSE_CODE_FAILURE")) return;
      navigation = { frameId: result.frameId, loaderId: result.loaderId };
    } catch {
      // An incomplete or malformed reply cannot confirm the observed request.
    }
  }

  function snapshot() {
    const correlation = tracked === null ? "unobserved" :
      navigation === null ? "provisional" :
        navigation.frameId !== frameId || navigation.loaderId !== tracked.loaderId ? "mismatch" :
          truncated ? "provisional" : "confirmed";
    return {
      httpStatus: correlation === "confirmed" && transportFailure === null ? latestFinalStatus : null,
      correlation,
      responses: responses.map((item) => ({ ...item })),
      transportFailure: transportFailure === null ? null : { ...transportFailure },
      truncated,
      documentLoaded
    };
  }

  return { record, bindNavigation, snapshot };
}
