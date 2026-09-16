import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcProcess } from "../pi-extension/subagents/rpc.ts";
import { TaskManager, childLaunch } from "../pi-extension/subagents/tasks.ts";
import { seedSession } from "../pi-extension/subagents/context.ts";
import { loadout as makeLoadout } from "./fixtures/loadout.ts";
import { TaskStore } from "../pi-extension/subagents/store.ts";
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
  const loadout = makeLoadout(dir, "anthropic/claude-sonnet-4-6");
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

test("real child inheritance failures stop before any model task, including builtin fallback and skill drift", { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rpc-child-mismatch-"));
  const missingProvider = join(dir, "empty-extension.ts");
  writeFileSync(missingProvider, "export default function () {}\n");
  const skillPath = join(dir, "skill.md");
  writeFileSync(skillPath, "---\nname: changed\ndescription: Changed on disk\n---\nSkill instructions");
  const manager = new TaskManager(new TaskStore(dir), {
    command: process.execPath, baseArgs: [cli],
    createRpc: launch => new RpcProcess({ ...launch, env: { ...launch.env, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" } }),
  });
  try {
    for (const scenario of ["schema", "fallback", "skill", "model"] as const) {
      const loadout = makeLoadout(dir, "anthropic/claude-sonnet-4-6");
      if (scenario === "schema") loadout.toolMetadata[0].description = "Different from runtime";
      if (scenario === "fallback") {
        loadout.toolMetadata[0].source = "extension"; loadout.toolMetadata[0].path = missingProvider; loadout.extensions = [missingProvider];
      }
      if (scenario === "skill") loadout.skills = [{ name: "changed", description: "Original parent metadata", filePath: skillPath, baseDir: dir, disableModelInvocation: false }];
      if (scenario === "model") loadout.model = "unregistered-provider/missing-model";
      await assert.rejects(manager.launch({ name: scenario, task: "Never send this to a provider", access: "full", context: "none", loadout }));
      const record = manager.get(scenario);
      assert.equal(record.state, "failed"); assert.equal(record.stopped, scenario !== "model");
      assert.match(record.error!, scenario === "skill" ? /skill inventory\/metadata mismatch/ : scenario === "model" ? /model|Model/ : /schema\/provenance mismatch/);
      // Pi removes empty session files during graceful disposal.
      const transcript = existsSync(record.sessionFile) ? readFileSync(record.sessionFile, "utf8") : "";
      const messages = transcript.split("\n").filter(Boolean).map(s => JSON.parse(s)).filter(e => e.type === "message");
      assert.equal(messages.length, 0, "Preflight failure must not submit the task to a model");
      assert.equal(transcript.includes("Never send this"), false);
    }
  } finally { await manager.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
