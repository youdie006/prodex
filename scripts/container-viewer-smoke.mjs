#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { defaultChatGptProfileDir } from "../dist/chatgpt-browser.js";
import { browserProcessHasFlag, findMatchingBrowserProcesses, inspectBrowserProcesses, isMainBrowserProcess } from "../dist/browser-process.js";

const FIXTURE = "http://127.0.0.1:39455/";
const VIEWER = "http://127.0.0.1:6080/vnc.html";
const MARKER = "prodex-container-synthetic-v1";

export function parseContainerViewerSmokeOptions(args) {
  for (const arg of args) {
    if (!["--seed", "--verify"].includes(arg)) throw new Error(`unknown option or unexpected argument: ${arg}`);
  }
  if (args.length !== 1) throw new Error("Choose exactly one of --seed or --verify.");
  return { mode: args[0].slice(2) };
}

export function assertSafePageTargets(targets) {
  if (!Array.isArray(targets) || targets.some(target => target.type === "page" &&
      !["about:blank", FIXTURE, "chrome://sandbox/"].includes(target.url))) {
    throw new Error("Refusing to mutate an existing page outside this account-free fixture.");
  }
}

export function buildMarkerExpression(mode) {
  assert.ok(["seed", "verify"].includes(mode));
  return `(() => { if (location.href !== ${JSON.stringify(FIXTURE)}) throw new Error("Wrong fixture");
    ${mode === "seed" ? `localStorage.clear(); localStorage.setItem("prodex-smoke", ${JSON.stringify(MARKER)});` : ""}
    return localStorage.getItem("prodex-smoke"); })()`;
}

export function buildDocumentReadyExpression(url) {
  return `location.href === ${JSON.stringify(url)} && document.readyState === "complete"`;
}

async function json(resource) {
  const response = await fetch(`http://127.0.0.1:9333/json/${resource}`, { signal: AbortSignal.timeout(2_000) });
  assert.ok(response.ok, "Local CDP metadata unavailable");
  return response.json();
}

async function request(url, method, params = {}) {
  const parsed = new URL(url);
  assert.ok(parsed.protocol === "ws:" && parsed.hostname === "127.0.0.1" && parsed.port === "9333" &&
    !parsed.username && !parsed.password && !parsed.search && /^\/devtools\/(browser|page)\//.test(parsed.pathname));
  const socket = new WebSocket(url);
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`${method} timed out`)), 12_000);
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error ? reject(error) : resolve(result);
      };
      socket.once("error", error => finish(error));
      socket.once("close", () => finish(new Error(`${method} connection closed`)));
      socket.once("open", () => socket.send(JSON.stringify({ id: 1, method, params })));
      socket.on("message", raw => {
        let reply;
        try { reply = JSON.parse(String(raw)); } catch { return; }
        if (reply.id === 1) finish(reply.error ? new Error(`${method} failed`) : undefined, reply.result);
      });
    });
  } finally {
    socket.removeAllListeners();
    socket.on("error", () => {});
    if (socket.readyState !== WebSocket.CLOSED) {
      const closed = new Promise(resolve => socket.once("close", resolve));
      socket.terminate();
      await closed;
    }
  }
}

async function evaluate(page, expression) {
  const reply = await request(page.webSocketDebuggerUrl, "Runtime.evaluate", {
    expression, returnByValue: true, awaitPromise: true
  });
  assert.ok(!reply.exceptionDetails, "Synthetic page evaluation failed");
  return reply.result?.value;
}

async function waitFor(check) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const result = await check();
    if (result) return result;
    await delay(100);
  }
  throw new Error("Synthetic page did not become ready");
}

function ownedMain() {
  const mains = findMatchingBrowserProcesses(inspectBrowserProcesses(), {
    port: 9333, profileDir: defaultChatGptProfileDir()
  }).filter(isMainBrowserProcess);
  assert.equal(mains.length, 1, "Expected one dedicated browser main process");
  assert.ok(!browserProcessHasFlag(mains[0], "headless"));
  return mains[0].processId;
}

async function run({ mode }) {
  assert.equal(process.platform, "linux");
  assert.equal(process.env.HOME, "/home/node");
  assert.equal(process.env.DISPLAY, ":99");
  assertSafePageTargets(await json("list"));
  const pid = ownedMain();
  const browser = (await json("version")).webSocketDebuggerUrl;
  const targets = [];
  const fixture = createServer((req, res) => {
    if (req.url !== "/") { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    res.end('<!doctype html><html><head><title>ProDex synthetic display</title></head><body style="margin:0;background:#f5f6f8;font:24px sans-serif"><header style="padding:40px;background:#35a37b;color:white">ProDex synthetic display</header><main style="padding:40px"><div style="background:#cd375f;width:240px;height:160px"></div><p>Local account-free verification</p><input aria-label="Synthetic input" value="Container display ready"></main></body></html>');
  });
  let screenshot;
  let sandbox;
  let viewer;
  try {
    await new Promise((resolve, reject) => {
      fixture.once("error", reject);
      fixture.listen(39455, "127.0.0.1", resolve);
    });
    const createPage = async (url, background = false) => {
      const { targetId } = await request(browser, "Target.createTarget", { url, background });
      targets.push(targetId);
      return waitFor(async () => (await json("list")).find(page => page.id === targetId && page.url === url));
    };
    const sandboxPage = await createPage("chrome://sandbox/");
    sandbox = await waitFor(async () => {
      const text = await evaluate(sandboxPage, "document.body?.innerText ?? ''");
      return /Seccomp-BPF sandbox\s+Yes/.test(text) && /PID namespaces\s+Yes/.test(text) &&
        /Network namespaces\s+Yes/.test(text) ? "namespace+seccomp" : false;
    });
    const page = await createPage(FIXTURE);
    await waitFor(() => evaluate(page, buildDocumentReadyExpression(FIXTURE)));
    assert.equal(await evaluate(page, buildMarkerExpression(mode)), MARKER, "Persistent synthetic marker missing");
    await request(page.webSocketDebuggerUrl, "Page.bringToFront");
    const shot = await request(page.webSocketDebuggerUrl, "Page.captureScreenshot", { format: "png" });
    const proofDir = await mkdtemp("/tmp/prodex-viewer-proof-");
    screenshot = `${proofDir}/fixture.png`;
    await writeFile(screenshot, Buffer.from(shot.data, "base64"), { mode: 0o600, flag: "wx" });

    // A background local tab views the active fixture through the real VNC path.
    const observer = await createPage(VIEWER, true);
    await waitFor(() => evaluate(observer, buildDocumentReadyExpression(VIEWER)));
    await request(page.webSocketDebuggerUrl, "Page.bringToFront");
    const password = (await readFile("/home/node/.vnc/viewer-password", "utf8")).trim();
    assert.match(password, /^[A-Za-z0-9_-]{8}$/);
    viewer = await evaluate(observer, `(async () => {
      const { default: RFB } = await import('/core/rfb.js');
      document.body.replaceChildren();
      const holder = document.createElement('div');
      holder.style.cssText = 'width:1440px;height:900px';
      document.body.append(holder);
      const rfb = new RFB(holder, 'ws://127.0.0.1:6080/websockify', { credentials: { password: ${JSON.stringify(password)} } });
      const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('connect timeout')), 4000);
          rfb.addEventListener('connect', () => { clearTimeout(timer); resolve(); }, { once: true });
          rfb.addEventListener('securityfailure', () => { clearTimeout(timer); reject(new Error('authentication failed')); }, { once: true });
        });
        let pixels = false;
        for (let i = 0; i < 30 && !pixels; i++) {
          const canvas = holder.querySelector('canvas');
          if (canvas?.width && canvas?.height) {
            const data = canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
            const colors = new Set();
            for (let p = 0; p < data.length; p += 4096) colors.add(data[p]+','+data[p+1]+','+data[p+2]);
            pixels = colors.size > 3;
          }
          if (!pixels) await pause(100);
        }
        if (!pixels) throw new Error('blank viewer frame');
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('disconnect timeout')), 2000);
          rfb.addEventListener('disconnect', () => { clearTimeout(timer); resolve(); }, { once: true });
          rfb.disconnect();
        });
        return 'authenticated+pixels+disconnect';
      } finally { rfb.disconnect(); }
    })()`);
    assert.equal(viewer, "authenticated+pixels+disconnect");
    assert.equal(ownedMain(), pid, "Viewer disconnect replaced the browser");
    assert.equal((await json("version")).webSocketDebuggerUrl, browser);
    assert.equal(await evaluate(page, buildMarkerExpression("verify")), MARKER);
  } finally {
    const errors = [];
    for (const targetId of targets.reverse()) {
      try { assert.ok((await request(browser, "Target.closeTarget", { targetId })).success); }
      catch (error) { errors.push(error); }
    }
    fixture.closeAllConnections();
    if (fixture.listening) await new Promise(resolve => fixture.close(resolve));
    if (errors.length) throw new AggregateError(errors, "Synthetic target cleanup failed");
  }
  console.log(`container_viewer_smoke=ok mode=${mode} marker=ok sandbox=${sandbox} viewer=${viewer} same_browser=ok cleanup=ok screenshot=${screenshot}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await run(parseContainerViewerSmokeOptions(process.argv.slice(2))); }
  catch (error) { console.error(`container viewer smoke failed: ${error.message}`); process.exitCode = 1; }
}
