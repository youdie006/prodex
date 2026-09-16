import { pathToFileURL } from "node:url";

export async function checkContainerBrowserHealth({ fetchImpl = fetch, timeoutMs = 2_000 } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  const cdp = await fetchImpl("http://127.0.0.1:9333/json/version", { signal });
  if (!cdp.ok) throw new Error("Local CDP is unavailable.");
  const version = await cdp.json();
  if (typeof version?.webSocketDebuggerUrl !== "string") throw new Error("Local CDP metadata is incomplete.");
  const socket = new URL(version.webSocketDebuggerUrl);
  if (socket.protocol !== "ws:" || socket.hostname !== "127.0.0.1" || Number(socket.port) !== 9333) {
    throw new Error("Local CDP is not bound to the expected loopback endpoint.");
  }

  const viewer = await fetchImpl("http://127.0.0.1:6080/vnc.html", { signal });
  if (!viewer.ok) throw new Error("Local noVNC viewer is unavailable.");
  return true;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  checkContainerBrowserHealth().catch((error) => {
    console.error(error instanceof Error ? error.message : "Container browser health check failed.");
    process.exitCode = 1;
  });
}
