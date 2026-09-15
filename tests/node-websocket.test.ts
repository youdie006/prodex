import { createServer, type Server } from "node:http";

import { expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

import { getChatGptBrowserStatus } from "../src/chatgpt-browser.js";

it("uses the ws fallback when Node does not provide a global WebSocket", async () => {
  const methods: string[] = [];
  const sockets = new Set<WebSocket>();
  const server = createServer((request, response) => {
    if (request.url !== "/json/list") {
      response.writeHead(404).end();
      return;
    }

    const address = server.address();
    if (!address || typeof address === "string") {
      response.writeHead(500).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify([
        {
          id: "page-1",
          type: "page",
          title: "ChatGPT",
          url: "https://chatgpt.com/",
          webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/devtools/page/page-1`
        }
      ])
    );
  });
  const webSocketServer = new WebSocketServer({ server });
  webSocketServer.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString("utf8")) as {
        id: number;
        method: string;
        params?: { expression?: string };
      };
      methods.push(request.method);
      const value =
        request.method === "Runtime.evaluate"
          ? request.params?.expression === "document.visibilityState"
            ? "visible"
            : {
                title: "ChatGPT",
                url: "https://chatgpt.com/",
                visibilityState: "visible",
                textSample: "New chat\nProjects",
                blockerTextSample: "",
                blockerScanTextSample: "",
                visibleButtonLabels: [],
                hasComposer: true,
                generating: false,
                awaitingResponseChoice: false,
                modelHints: ["Pro"]
              }
          : undefined;
      socket.send(JSON.stringify({ id: request.id, result: { result: { value } } }));
    });
  });

  const globalWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  Reflect.deleteProperty(globalThis, "WebSocket");

  try {
    await listen(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP test server");

    await expect(getChatGptBrowserStatus({ port: address.port, timeoutMs: 1_000 })).resolves.toMatchObject({
      reachable: true,
      loggedInLikely: true,
      hasComposer: true,
      visibilityState: "visible",
      url: "https://chatgpt.com/",
      title: "ChatGPT",
      modelHints: ["Pro"]
    });
    expect(methods.filter((method) => method === "Runtime.enable")).toHaveLength(2);
    expect(methods.filter((method) => method === "Runtime.evaluate")).toHaveLength(2);
    await waitFor(() => sockets.size === 0);
  } finally {
    if (globalWebSocket) Object.defineProperty(globalThis, "WebSocket", globalWebSocket);
    else Reflect.deleteProperty(globalThis, "WebSocket");
    for (const socket of sockets) socket.terminate();
    await closeWebSocketServer(webSocketServer);
    await closeServer(server);
  }
});

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for CDP sockets to close");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
