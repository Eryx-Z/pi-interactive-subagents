import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { RpcProcess } from "../pi-extension/subagents/rpc.ts";
import { TaskManager, childLaunch } from "../pi-extension/subagents/tasks.ts";
import { seedSession } from "../pi-extension/subagents/context.ts";
import { loadout as makeLoadout } from "./fixtures/loadout.ts";
import { TaskStore } from "../pi-extension/subagents/store.ts";
import type { TaskRecord } from "../pi-extension/subagents/store.ts";

// Real installed Pi protocol/extension loader. Model-backed coverage uses a local deterministic provider only.
const packageDir = getPackageDir();
const cli = join(packageDir, JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).bin.pi);
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

test("real parent delegates builtin read with full and read-only access and completes both tasks", { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rpc-builtin-host-"));
  const provider = fileURLToPath(new URL("./fixtures/builtin-provider.ts", import.meta.url));
  writeFileSync(join(dir, "fixture-input.txt"), "builtin inheritance verified");
  const skills = ["removed", "kept"].map(name => {
    const path = join(dir, `${name}.md`);
    writeFileSync(path, `---\nname: ${name}\ndescription: ${name} skill\n---\nInstructions`);
    return path;
  });
  const lateSkills = join(dir, "late-skills.ts");
  writeFileSync(lateSkills, `export default function (pi) {
    pi.on("before_agent_start", event => {
      event.systemPromptOptions.skills = event.systemPromptOptions.skills.filter(skill => skill.name !== "removed");
    });
  }`);
  const rpc = new RpcProcess({ command: process.execPath, cwd: dir, env: env(dir), args: [cli, "--mode", "rpc", "--session", join(dir, "parent.jsonl"),
    "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-approve",
    "--tools", "read,write,edit,bash,subagent,subagent_control", "--model", "builtin-fixture/test", "--thinking", "off",
    ...skills.flatMap(path => ["--skill", path]), "-e", provider, "-e", parentEntry, "-e", lateSkills] });
  const errors: unknown[] = [];
  rpc.on("event", event => { if (event.type === "extension_error") errors.push(event); });
  try {
    const state = await rpc.request("get_state");
    const recordDir = join(dir, "rpc-subagents", state.sessionId);
    for (const access of ["full", "read-only"] as const) {
      await rpc.request("prompt", { streamingBehavior: "followUp", message: `DISPATCH ${JSON.stringify({ name: access, task: "READ_BUILTIN", access, context: "none" })}` });
      let record: TaskRecord | undefined;
      for (let i = 0; i < 500; i++) {
        if (existsSync(recordDir)) record = readdirSync(recordDir).filter(f => /^[a-f0-9-]{36}\.json$/.test(f))
          .map(f => JSON.parse(readFileSync(join(recordDir, f), "utf8")) as TaskRecord).find(r => r.name === access && r.stopped);
        if (record) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.ok(record, `Task ${access} did not settle`);
      assert.equal(record.state, "completed", record.error);
      assert.deepEqual([...record.loadout.tools].sort(), access === "full" ? ["ask_question", "bash", "edit", "read", "write"] : ["ask_question", "read"]);
      assert.deepEqual(record.loadout.extensions, []);
      assert.deepEqual(record.loadout.providerExtensions, [provider]);
      assert.deepEqual(record.loadout.skills.map(skill => skill.name), ["kept"], "Dispatch must freeze the final skills after later hooks replace the array");
      assert.ok(record.loadout.toolMetadata.every(t => t.source === "builtin" && t.path === `<builtin:${t.name}>`));
      assert.match(record.output, /builtin inheritance verified/);
      const messages = readFileSync(record.sessionFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
      assert.ok(messages.some(e => e.message?.role === "toolResult" && e.message.toolName === "read" && !e.message.isError));
    }
    assert.deepEqual(errors, []);
  } finally { await rpc.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("real child rejects concurrent nested question calls without corrupting task state", { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rpc-nested-question-"));
  const provider = fileURLToPath(new URL("./fixtures/builtin-provider.ts", import.meta.url));
  const probe = join(dir, "nested-probe.ts");
  writeFileSync(probe, `import { Type } from "typebox";
    export default function (pi) {
      pi.registerTool({ name: "nested_probe", label: "Probe", description: "Try concurrent nested questions", parameters: Type.Object({}),
        async execute(_id, _params, _signal, _update, ctx) {
          const results = await Promise.all(["One?", "Two?"].map(question => ctx.executeTool("ask_question", { question })));
          if (!results.every(result => result.isError)) throw new Error("Nested questions unexpectedly callable");
          return { content: [{ type: "text", text: "Both nested questions rejected: " + JSON.stringify(results) }] };
        }
      });
    }`);
  const rpc = new RpcProcess({ command: process.execPath, cwd: dir, env: env(dir), args: [cli, "--mode", "rpc", "--session", join(dir, "parent.jsonl"),
    "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-approve",
    "--tools", "read,nested_probe,subagent,subagent_control", "--model", "builtin-fixture/test", "--thinking", "off",
    "-e", provider, "-e", probe, "-e", parentEntry] });
  try {
    const state = await rpc.request("get_state");
    const recordDir = join(dir, "rpc-subagents", state.sessionId);
    await rpc.request("prompt", { message: `DISPATCH ${JSON.stringify({ name: "nested-questions", task: "NESTED_ASK", access: "full", context: "none" })}` });
    let record: TaskRecord | undefined;
    for (let i = 0; i < 500; i++) {
      if (existsSync(recordDir)) record = readdirSync(recordDir).filter(f => /^[a-f0-9-]{36}\.json$/.test(f))
        .map(f => JSON.parse(readFileSync(join(recordDir, f), "utf8")) as TaskRecord).find(r => r.name === "nested-questions" && r.stopped);
      if (record) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(record, "Nested question task did not settle");
    assert.equal(record.state, "completed", record.error);
    assert.match(record.output, /Both nested questions rejected/);
    assert.equal(record.questions.length, 0);
    const messages = readFileSync(record.sessionFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.ok(messages.some(e => e.message?.role === "toolResult" && e.message.toolName === "nested_probe" && !e.message.isError));
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
