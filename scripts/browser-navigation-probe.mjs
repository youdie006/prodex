import { createNavigationDiagnostics } from "./browser-navigation-diagnostics.mjs";

function probeUrl(value) {
  const url = new URL(value);
  const publicRoot = url.href === "https://chatgpt.com/";
  const localFixture = url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || (!publicRoot && !localFixture)) {
    throw new Error("navigation probe requires a loopback fixture or the public ChatGPT root");
  }
  return url.href;
}

function boundedMilliseconds(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 30_000) {
    throw new Error(`${label} must be an integer from 1 to 30000`);
  }
  return value;
}

function terminalOutcome(snapshot) {
  if (snapshot.correlation === "mismatch" || snapshot.truncated) return "uncorrelated";
  if (snapshot.transportFailure) return "network_error";
  if (snapshot.correlation !== "confirmed") return undefined;
  if (snapshot.httpStatus >= 400) return "http_error";
  const finalResponse = snapshot.responses.at(-1);
  if (snapshot.httpStatus !== null && finalResponse?.kind === "response" && finalResponse.challenge) return "protection";
  if (snapshot.httpStatus !== null && snapshot.documentLoaded) return "response";
  return undefined;
}

// The caller owns a dedicated CDP session and closes it after this bounded probe.
// Only the returned allowlisted diagnostics are suitable for persistence.
export async function runNavigationProbe(session, options) {
  const url = probeUrl(options.url);
  const timeoutMs = boundedMilliseconds(options.timeoutMs ?? 5_000, "timeoutMs");
  const observationMs = boundedMilliseconds(options.observationMs ?? 3_000, "observationMs");
  const started = performance.now();
  let phase = "subscribe";
  let collector;
  let unsubscribe;
  let wake = () => {};
  let navigationCommands = 0;

  const report = (outcome, errorCode = null) => ({
    schemaVersion: 1,
    outcome,
    phase: errorCode ? phase : "complete",
    failedPhase: errorCode ? phase : null,
    elapsedMs: Math.max(0, Math.round(performance.now() - started)),
    navigationCommands,
    diagnostics: collector?.snapshot() ?? null,
    error: errorCode ? { code: errorCode } : null
  });
  const command = async (method, params = {}) => {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => session.send(method, params)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error("probe command timed out"), { code: "PROBE_TIMEOUT" })), timeoutMs);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    unsubscribe = session.subscribe(event => {
      collector?.record(event);
      wake();
    });
    phase = "page_enable";
    await command("Page.enable");
    phase = "lifecycle_enable";
    await command("Page.setLifecycleEventsEnabled", { enabled: true });
    phase = "frame_tree";
    const tree = await command("Page.getFrameTree");
    const frameId = tree?.frameTree?.frame?.id;
    if (typeof frameId !== "string" || !frameId) return report("protocol_error", "missing_main_frame");
    phase = "network_enable";
    await command("Network.enable");
    collector = createNavigationDiagnostics({ frameId, targetUrl: url });
    phase = "navigate";
    navigationCommands++;
    const navigation = await command("Page.navigate", { url, frameId });
    collector.bindNavigation(navigation);
    const initialOutcome = terminalOutcome(collector.snapshot());
    if (initialOutcome) return report(initialOutcome);
    if (navigation?.errorText || navigation?.isDownload) return report("network_error", "navigation_failed");
    phase = "observe";
    const outcome = await new Promise(resolve => {
      const timer = setTimeout(() => {
        wake = () => {};
        resolve(undefined);
      }, observationMs);
      wake = () => {
        const current = terminalOutcome(collector.snapshot());
        if (!current) return;
        clearTimeout(timer);
        wake = () => {};
        resolve(current);
      };
      wake();
    });
    return outcome ? report(outcome) : report("timeout", "observation_timeout");
  } catch (error) {
    return error?.code === "PROBE_TIMEOUT" || error?.code === "CDP_TIMEOUT"
      ? report("timeout", "command_timeout")
      : report("protocol_error", "command_failed");
  } finally {
    wake = () => {};
    unsubscribe?.();
  }
}
