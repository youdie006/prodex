#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const root = await mkdtemp(path.join(tmpdir(), "prodex-container-mcp-smoke-"));
const connections = [];
try {
  for (const name of ["first", "second"]) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli, "mcp", "--cwd", root],
      cwd: root,
      stderr: "pipe",
      env: {
        ...process.env,
        PRODEX_BRIDGES_REGISTRY: path.join(root, "registry.json"),
        PRODEX_SEND_LOCK_FILE: path.join(root, "browser.lock"),
        PRODEX_LAST_LOGIN_FILE: path.join(root, "last-login.json"),
        PRODEX_NO_AUTO_LOGIN: "1"
      }
    });
    const client = new Client({ name: `prodex-container-${name}`, version: "1.0.0" });
    const connection = { client, transport, pid: undefined };
    connections.push(connection);
    transport.stderr?.on("data", () => {});
    await client.connect(transport, { timeout: 10_000 });
    connection.pid = transport.pid;
    assert.ok(Number.isInteger(connection.pid) && connection.pid > 0);
    const { tools } = await client.listTools({}, { timeout: 5_000 });
    assert.ok(tools.some(tool => tool.name === "pro_consult"));
    assert.ok(tools.some(tool => tool.name === "pro_recover"));
  }
  assert.notEqual(connections[0].pid, connections[1].pid);
  const [a, b] = connections.map(connection => connection.client);
  const taskA = await call(a, "bridge_create_task", { title: "Container A", prompt: "synthetic-context-A" });
  const taskB = await call(b, "bridge_create_task", { title: "Container B", prompt: "synthetic-context-B" });
  assert.notEqual(taskA.task.id, taskB.task.id);
  assert.equal((await call(a, "bridge_get_task", { task_id: taskA.task.id })).task.prompt, "synthetic-context-A");
  assert.equal((await call(b, "bridge_get_task", { task_id: taskB.task.id })).task.prompt, "synthetic-context-B");

  // Both transports contend for one synthetic task; precisely one may own it.
  const claims = await Promise.allSettled([
    call(a, "bridge_claim_task", { task_id: taskA.task.id, claimed_by: "container-A" }),
    call(b, "bridge_claim_task", { task_id: taskA.task.id, claimed_by: "container-B" })
  ]);
  assert.equal(claims.filter(result => result.status === "fulfilled").length, 1);
  await a.close();
  assert.equal((await call(b, "bridge_get_task", { task_id: taskB.task.id })).task.prompt, "synthetic-context-B");
} finally {
  let failure;
  for (const connection of connections) {
    try {
      await connection.client.close();
      await connection.transport.close();
      const pid = connection.pid ?? connection.transport.pid;
      if (pid) await waitForExit(pid);
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
  await rm(root, { recursive: true, force: true });
}
console.log("container_mcp_smoke=ok independent_processes=2 task_identity=ok claim_exclusion=ok client_disconnect=ok browser_prompts_sent=0 cleanup=ok");

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 5_000 });
  if (result.isError) throw new Error(`Synthetic ${name} failed`);
  const text = result.content.find(item => item.type === "text")?.text;
  assert.equal(typeof text, "string");
  return JSON.parse(text);
}

async function waitForExit(pid) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === "ESRCH") return; throw error; }
    await delay(50);
  }
  throw new Error("Synthetic MCP child did not exit; temporary state retained");
}
