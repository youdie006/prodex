import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const CONTAINER_ID = /^[a-f0-9]{64}$/;
export type DockerRunner = (args: string[]) => Promise<string>;
export interface LoginContainerTarget {
  context: string;
  dockerEndpoint: string;
  id: string;
  name: string;
  imageId: string;
  viewerUrl: string;
  running: boolean;
}
export interface LoginContainerStatus {
  ready: boolean;
  reachable: boolean;
  blocker: string | null;
  mode: "headed" | "headless" | "unknown";
}

export const runLoginDocker: DockerRunner = async args => {
  try {
    const result = await exec("docker", args, { timeout: 8_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
      windowsHide: true });
    return result.stdout.trim();
  } catch {
    throw new Error("Docker is unavailable. Start Docker Desktop or your existing local Docker/Colima runtime, then run prodex login again.");
  }
};

function safeName(value: string): string {
  if (!SAFE_NAME.test(value)) throw new Error("A Docker context/container needs a valid name.");
  return value;
}
function localEndpoint(value: unknown): boolean {
  return typeof value === "string" && !/[\x00-\x1f\x7f]/.test(value) &&
    (value.startsWith("unix:///") || /^npipe:\/\/\/\/\.\/pipe\/[A-Za-z0-9_.-]+$/.test(value));
}
async function readEndpoint(context: string, run: DockerRunner): Promise<string> {
  let records;
  try { records = JSON.parse(await run(["--context", context, "context", "inspect", context])); }
  catch { throw new Error("The selected Docker context is unavailable. No login was opened."); }
  if (!Array.isArray(records) || records.length !== 1 || !localEndpoint(records[0]?.Endpoints?.docker?.Host)) {
    throw new Error("Run prodex login on the viewer computer using a local Docker context. Remote Docker login is not selected automatically.");
  }
  return records[0].Endpoints.docker.Host;
}
function parseInspect(raw: string, context: string, dockerEndpoint: string, expectedId?: string): LoginContainerTarget {
  const records = JSON.parse(raw);
  if (!Array.isArray(records) || records.length !== 1) throw new Error("ProDex container identity is ambiguous.");
  const r = records[0];
  if (!CONTAINER_ID.test(r?.Id ?? "") || (expectedId && r.Id !== expectedId)) throw new Error("ProDex container identity changed.");
  if (r.Config?.Labels?.["com.docker.compose.project"] !== "prodex-browser" ||
      r.Config?.Labels?.["com.docker.compose.service"] !== "browser") {
    throw new Error("The selected container is not a managed ProDex browser service.");
  }
  if (r.State?.Paused || r.State?.Restarting) throw new Error("The ProDex service is paused or restarting. Wait until it is available.");
  if (r.State?.Running !== true) throw new Error("The existing ProDex browser service is stopped. Start that service first; no replacement or new profile was created.");
  const ports = r.NetworkSettings?.Ports?.["6080/tcp"];
  if (!Array.isArray(ports) || ports.length !== 1 || !["127.0.0.1", "::1"].includes(ports[0]?.HostIp) ||
      !/^[0-9]{1,5}$/.test(ports[0]?.HostPort ?? "") || Number(ports[0].HostPort) < 1 || Number(ports[0].HostPort) > 65535) {
    throw new Error("The ProDex viewer must have one loopback-only published port. No login was opened.");
  }
  if (typeof r.Name !== "string" || !r.Name.startsWith("/")) throw new Error("ProDex container name is invalid.");
  if (!/^sha256:[a-f0-9]{64}$/.test(r.Image ?? "")) throw new Error("ProDex image identity is invalid.");
  return { context, dockerEndpoint, id: r.Id, name: safeName(r.Name.slice(1)), imageId: r.Image,
    viewerUrl: `http://${ports[0].HostIp === "::1" ? "[::1]" : "127.0.0.1"}:${ports[0].HostPort}/`,
    running: r.State?.Running === true };
}

export async function discoverLoginContainer(
  options: { context?: string; container?: string }, run: DockerRunner = runLoginDocker,
  env: NodeJS.ProcessEnv = process.env
): Promise<LoginContainerTarget> {
  const name = safeName(options.container ?? "prodex-browser-browser-1");
  const selected = options.context ?? env.DOCKER_CONTEXT;
  if (!selected && env.DOCKER_HOST) throw new Error("Use an explicit --context for this login; DOCKER_HOST may refer to another computer.");
  if (selected) {
    const context = safeName(selected);
    const endpoint = await readEndpoint(context, run);
    return parseInspect(await run(["--context", context, "container", "inspect", name]), context, endpoint);
  }
  const raw = await run(["context", "ls", "--format", "{{json .}}"]);
  const contexts = raw.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  if (contexts.length > 16) throw new Error("Many Docker contexts are configured. Select the intended local service with --context.");
  const found = new Map<string, LoginContainerTarget>();
  for (const entry of contexts) {
    if (!localEndpoint(entry.DockerEndpoint)) continue;
    const context = safeName(entry.Name);
    let inspected: string;
    try { inspected = await run(["--context", context, "container", "inspect", name]); }
    catch { continue; }
    const target = parseInspect(inspected, context, entry.DockerEndpoint);
    const identity = `${target.dockerEndpoint}\0${target.id}`;
    if (!found.has(identity)) found.set(identity, target);
  }
  if (found.size > 1) throw new Error("Multiple ProDex services were found. Select the intended local account with --context; no browser was opened.");
  const target = found.values().next().value;
  if (!target) throw new Error("No existing local ProDex browser service was found. Start your installed Docker/Colima runtime and check your ProDex setup; no profile was created.");
  return target;
}

const STATUS = `import { getChatGptBrowserStatus, defaultChatGptProfileDir } from '/app/dist/chatgpt-browser.js';
import { inspectBrowserProcesses, findMatchingBrowserProcesses, isMainBrowserProcess, browserProcessHasFlag } from '/app/dist/browser-process.js';
let mode='unknown';
try { const p=findMatchingBrowserProcesses(inspectBrowserProcesses(), {port:9333,profileDir:defaultChatGptProfileDir()}).filter(isMainBrowserProcess);
if(p.length===1) mode=browserProcessHasFlag(p[0],'headless')?'headless':'headed'; } catch {}
try { const s=await getChatGptBrowserStatus({timeoutMs:3000});
const ready=s.reachable===true&&s.loggedInLikely===true&&s.hasComposer===true&&!s.blocker;
console.log(JSON.stringify({ready,reachable:s.reachable===true,mode,blocker:ready?null:s.blocker?.code??'not_ready'}));
} catch { console.log(JSON.stringify({ready:false,reachable:false,mode,blocker:'status_unavailable'})); }`;

const PASSWORD = `import { open } from 'node:fs/promises'; import { constants } from 'node:fs';
const f=await open('/home/node/.vnc/viewer-password',constants.O_RDONLY|(constants.O_NOFOLLOW??0));
try {const s=await f.stat(); if(!s.isFile()||s.nlink!==1||s.size>9||(s.mode&0o077)!==0||s.uid!==process.getuid())throw new Error('Invalid password file');
const value=await f.readFile('utf8'); if(!/^[A-Za-z0-9_-]{8}\\n?$/.test(value))throw new Error('Invalid password file');
process.stdout.write(value.trim());}finally{await f.close();}`;

const ENSURE_TAB = `import { getChatGptBrowserStatus, openChatGptTab } from '/app/dist/chatgpt-browser.js';
import { withBrowserSendLock } from '/app/dist/browser-send-lock.js';
await withBrowserSendLock(0,()=>{},async()=>{const s=await getChatGptBrowserStatus({timeoutMs:3000});
if(s.reachable&&s.blocker?.code==='chatgpt_page_missing') {if(!await openChatGptTab(9333,'https://chatgpt.com/'))throw new Error('Tab unavailable');}});`;

export function createLoginContainer(target: LoginContainerTarget, run: DockerRunner = runLoginDocker) {
  const checked = async (): Promise<void> => {
    if (await readEndpoint(target.context, run) !== target.dockerEndpoint) {
      throw new Error("The selected Docker context endpoint changed. Run login again; no credential was read.");
    }
    let raw: string;
    try { raw = await run(["--context", target.context, "container", "inspect", target.id]); }
    catch { throw new Error("The selected ProDex container is unavailable. No replacement was started."); }
    const current = parseInspect(raw, target.context, target.dockerEndpoint, target.id);
    if (current.viewerUrl !== target.viewerUrl || current.imageId !== target.imageId) throw new Error("ProDex container identity or viewer changed. Run login again.");
    if (!current.running) throw new Error("The ProDex browser service is stopped. Start the existing service, then run login again.");
  };
  const evaluate = async (expression: string): Promise<string> => {
    await checked();
    try { return await run(["--context", target.context, "exec", "--workdir", "/app", "-e", "PRODEX_NO_AUTO_LOGIN=1", target.id,
      "node", "--input-type=module", "-e", expression]); }
    catch { throw new Error("The selected ProDex container operation failed. Its profile was not changed."); }
  };
  return {
    async status(): Promise<LoginContainerStatus> {
      let s;
      try { s = JSON.parse(await evaluate(STATUS)); } catch { return { ready: false, reachable: false, mode: "unknown", blocker: "status_unavailable" }; }
      const reachable = s.reachable === true;
      const ready = reachable && s.ready === true && s.blocker === null;
      return { ready, reachable, mode: ["headed", "headless"].includes(s.mode) ? s.mode : "unknown",
        blocker: ready ? null : typeof s.blocker === "string" && /^[a-z][a-z0-9_]{0,80}$/.test(s.blocker) ? s.blocker : "status_unavailable" };
    },
    async readPassword(): Promise<string> {
      const value = await evaluate(PASSWORD);
      if (!/^[A-Za-z0-9_-]{8}$/.test(value)) throw new Error("The saved ProDex viewer credential is invalid. It was not reset.");
      return value;
    },
    async ensureTab(): Promise<void> { await evaluate(ENSURE_TAB); }
  };
}
