import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { openChatGptBrowser } from '/app/dist/chatgpt-browser.js';
import { inspectBrowserProcesses, findMatchingBrowserProcesses, assertLaunchedBrowserMainProcess, browserProcessHasFlag, browserProcessFlagValue } from '/app/dist/browser-process.js';
import { withCdpSession } from '/app/scripts/browser-launch-smoke.mjs';

// Disposable, network-disabled container only. This is not a production launcher.
assert.equal(process.platform, 'linux');
assert.equal(process.getuid(), 1000);
assert.ok(Object.values(networkInterfaces()).flat().every(address => address.internal));
for (const name of ['DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY']) assert.equal(process.env[name], undefined);
assert.equal(process.env.PRODEX_CHROME, '/opt/prodex-ozone/chrome');
const port = 9334;
const profileDir = '/tmp/prodex-ozone-render-profile';
await mkdir(profileDir, { mode: 0o700 });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const matching = () => findMatchingBrowserProcesses(inspectBrowserProcesses(), { port, profileDir });
async function until(fn, label) {
  const deadline = Date.now() + 20000;
  let last;
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await sleep(200);
  }
  throw new Error(`${label} timed out: ${last?.message ?? 'condition not met'}`);
}
const html = '<!doctype html><title>Ozone local rendering</title><style>body{margin:20px;background:white;color:black;font:24px sans-serif}canvas{display:block;margin:20px 0}input,button{font:20px sans-serif}</style><h1>Ozone local rendering</h1><canvas id="paint" width="320" height="160"></canvas><input id="keyboard"><button id="mouse">Local fixture</button>';
const runs = [];
for (const stage of ['initial', 'restart']) {
  assert.equal(matching().length, 0);
  const launch = openChatGptBrowser({ port, profileDir, headless: false, url: 'about:blank' });
  let browserSocket;
  try {
    const version = await until(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (!response.ok) return false;
      return response.json();
    }, 'CDP readiness');
    const main = assertLaunchedBrowserMainProcess(matching(), launch.processId);
    assert.equal(browserProcessHasFlag(main, 'headless'), false);
    assert.equal(browserProcessHasFlag(main, 'no-sandbox'), false);
    assert.equal(browserProcessFlagValue(main, 'ozone-platform'), 'headless');
    assert.equal(main.executablePath, '/opt/prodex-cft154/chrome');
    const env = (await readFile(`/proc/${main.processId}/environ`, 'utf8')).split('\0');
    const displayEnvironment = Object.fromEntries(['DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY'].map(key => [key, env.find(item => item.startsWith(`${key}=`))?.slice(key.length + 1) ?? null]));
    assert.ok(Object.values(displayEnvironment).every(value => value === null));
    const processes = execFileSync('ps', ['-eo', 'comm='], { encoding: 'utf8' }).split('\n').map(value => value.trim());
    assert.equal(processes.some(value => /^(Xvfb|Xorg|Xwayland|weston)$/.test(value)), false);
    const unixSockets = await readFile('/proc/net/unix', 'utf8');
    assert.equal(/X11-unix|wayland-\d/.test(unixSockets), false);
    const security = await readFile(`/proc/${main.processId}/status`, 'utf8');
    assert.match(security, /NoNewPrivs:\s+1/);
    assert.match(security, /CapEff:\s+0000000000000000/);
    const binarySha256 = createHash('sha256').update(await readFile(main.executablePath)).digest('hex');
    browserSocket = version.webSocketDebuggerUrl;
    const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
    const page = pages.find(target => target.type === 'page' && target.url === 'about:blank');
    assert.ok(page);
    const rendered = await withCdpSession(page.webSocketDebuggerUrl, async send => {
      await send('Runtime.enable');
      await send('Page.navigate', { url: `data:text/html,${encodeURIComponent(html)}` });
      await until(async () => (await send('Runtime.evaluate', { expression: 'document.title === "Ozone local rendering" && !!document.querySelector("#paint")', returnByValue: true })).result?.value === true, 'local fixture');
      const evaluation = await send('Runtime.evaluate', { expression: `(() => {
        const ctx=document.querySelector('#paint').getContext('2d');
        ctx.fillStyle='#d62d20';ctx.fillRect(0,0,160,160);
        ctx.fillStyle='#008744';ctx.fillRect(160,0,160,160);
        return {innerWidth,innerHeight,outerWidth,outerHeight,screenWidth:screen.width,screenHeight:screen.height,devicePixelRatio,visibility:document.visibilityState,pixels:[...ctx.getImageData(40,40,1,1).data,...ctx.getImageData(240,40,1,1).data]};
      })()`, returnByValue: true });
      assert.ifError(evaluation.exceptionDetails);
      const observation = evaluation.result.value;
      assert.deepEqual(observation.pixels, [214,45,32,255,0,135,68,255]);
      const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const png = Buffer.from(screenshot.data, 'base64');
      assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      return { observation, screenshotBytes: png.length, screenshotSha256: createHash('sha256').update(png).digest('hex'), screenshot: screenshot.data };
    });
    runs.push({ stage, mainPid: main.processId, executable: main.executablePath, binarySha256, commandLine: main.commandLine, browser: version.Browser, displayEnvironment, externalDisplayServer: false, displaySocketPresent: false, noNewPrivileges: true, effectiveCapabilities: '0', browserHeadlessSwitch: false, ozonePlatform: 'headless', ...rendered });
  } finally {
    if (browserSocket) await withCdpSession(browserSocket, send => send('Browser.close'));
    await until(() => matching().length === 0, 'owned browser exit');
  }
}
console.log(JSON.stringify({ schemaVersion: 1, arch: process.arch, runs, cleanup: true, publicAdmission: 'not_tested', proResponse: 'not_tested' }));
