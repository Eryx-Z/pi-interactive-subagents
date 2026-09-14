import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcProcess } from "../pi-extension/subagents/rpc.ts";
import { childLaunch } from "../pi-extension/subagents/tasks.ts";
import { seedSession } from "../pi-extension/subagents/context.ts";
import type { Loadout } from "../pi-extension/subagents/agents.ts";
import type { TaskRecord } from "../pi-extension/subagents/store.ts";

// Real installed Pi protocol/extension loader, but ONLY command prompts: no provider call.
const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
const parentEntry = fileURLToPath(new URL("../pi-extension/subagents/index.ts", import.meta.url));
function env(dir: string): NodeJS.ProcessEnv {
  const value = { ...process.env, PI_CODING_AGENT_DIR: dir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
  for (const key of Object.keys(value)) if (key.startsWith("PI_RPC_SUBAGENT_") || key.startsWith("PI_SUBAGENT_")) delete (value as NodeJS.ProcessEnv)[key];
  return value;
}

test("real Pi RPC loads parent commands and shuts down without a model request", { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rpc-host-"));
  const rpc = new RpcProcess({ command: process.execPath, args: [cli, "--mode", "rpc", "--session", join(dir, "parent.jsonl"), "--no-extensions", "--no-skills", "--no-context-files", "--no-approve", "-e", parentEntry], cwd: dir, env: env(dir) });
  const errors: unknown[] = [];
  rpc.on("event", event => { if (event.type === "extension_error") errors.push(event); });
  try {
    const commands = await rpc.request("get_commands");
    assert.ok(commands.commands.some((c: { name: string }) => c.name === "subagents"));
    await rpc.request("prompt", { message: "/subagents" }); // no tasks: notification only
    assert.deepEqual(errors, []);
    const state = await rpc.request("get_state");
    assert.equal(state.isStreaming, false);
    assert.equal(state.messageCount, 0);
  } finally { await rpc.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("real Pi child preflight validates selected model and tools without invoking provider", { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rpc-child-host-"));
  const sessionFile = join(dir, "child.jsonl");
  seedSession(sessionFile, dir, "none");
  const loadout: Loadout = { version: 1, agent: "scout", tools: ["read", "ask_question"], extensions: [], model: "anthropic/claude-sonnet-4-6", thinking: "off", prompt: "Read only", promptMode: "append", cwd: dir, agentDir: dir };
  const launch = childLaunch({ id: "test", sessionFile, loadout } as TaskRecord, dir, process.execPath, [cli]);
  launch.env = { ...launch.env, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
  const rpc = new RpcProcess(launch);
  const errors: unknown[] = [];
  rpc.on("event", event => { if (event.type === "extension_error") errors.push(event); });
  try {
    const commands = await rpc.request("get_commands");
    assert.ok(commands.commands.some((c: { name: string }) => c.name === "rpc-subagent-preflight"));
    assert.ok(!commands.commands.some((c: { name: string }) => c.name === "subagents"));
    await rpc.request("prompt", { message: "/rpc-subagent-preflight" });
    assert.deepEqual(errors, []);
    assert.equal((await rpc.request("get_state")).messageCount, 0);
  } finally { await rpc.stop(); rmSync(dir, { recursive: true, force: true }); }
});
