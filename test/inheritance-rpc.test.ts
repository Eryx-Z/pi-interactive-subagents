import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcProcess } from "../pi-extension/subagents/rpc.ts";
import type { TaskRecord } from "../pi-extension/subagents/store.ts";

const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
const parentEntry = fileURLToPath(new URL("../pi-extension/subagents/index.ts", import.meta.url));
const provider = fileURLToPath(new URL("./fixtures/inherited-tools.ts", import.meta.url));
async function until<T>(read: () => T | undefined): Promise<T> {
  for (let i = 0; i < 500; i++) { const value = read(); if (value !== undefined) return value; await new Promise(r => setTimeout(r, 20)); }
  throw new Error("Timed out waiting for deterministic RPC fixture");
}

test("real parent dispatch reloads tools and file/directory symlink skills for every context, models and questions", { timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "inheritance-rpc-"));
  const skillPaths = ["visible", "hidden"].map(name => {
    const path = join(dir, `${name}.md`);
    writeFileSync(path, `---\nname: ${name}\ndescription: ${name} inherited skill\ndisable-model-invocation: ${name === "hidden"}\n---\n${name} instructions`);
    return path;
  });
  // Original path spelling must survive both file and differently named directory symlinks.
  for (const name of ["shared-file", "file-alias", "shared-dir"]) mkdirSync(join(dir, name));
  writeFileSync(join(dir, "shared-file", "SKILL.md"), "---\ndescription: File symlink skill\n---\nFile skill");
  symlinkSync(join(dir, "shared-file", "SKILL.md"), join(dir, "file-alias", "SKILL.md"));
  writeFileSync(join(dir, "shared-dir", "SKILL.md"), "---\ndescription: Directory symlink skill\n---\nDirectory skill");
  symlinkSync(join(dir, "shared-dir"), join(dir, "dir-alias"), "dir");
  skillPaths.push(join(dir, "file-alias", "SKILL.md"), join(dir, "dir-alias", "SKILL.md"));
  const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: dir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
  for (const key of Object.keys(env)) if (key.startsWith("PI_RPC_SUBAGENT_") || key.startsWith("PI_SUBAGENT_")) delete env[key];
  const rpc = new RpcProcess({ command: process.execPath, cwd: dir, env, args: [cli, "--mode", "rpc", "--session", join(dir, "parent.jsonl"),
    "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-approve",
    "--tools", "read,custom_search,startup_tool,spawn_agent,ask_question,subagent,subagent_control",
    "--model", "inherited-fixture/default", "--thinking", "off", ...skillPaths.flatMap(p => ["--skill", p]), "-e", provider, "-e", parentEntry] });
  const errors: unknown[] = [];
  rpc.on("event", event => { if (event.type === "extension_error") errors.push(event); });
  try {
    const state = await rpc.request("get_state");
    const recordDir = join(dir, "rpc-subagents", state.sessionId);
    const records = () => existsSync(recordDir) ? readdirSync(recordDir).filter(f => /^[a-f0-9-]{36}\.json$/.test(f)).map(f => JSON.parse(readFileSync(join(recordDir, f), "utf8")) as TaskRecord) : [];
    for (const context of ["none", "partial", "full"] as const) {
      await rpc.request("prompt", { streamingBehavior: "followUp", message: `DISPATCH ${JSON.stringify({ task: "EXERCISE", access: "full", ...(context === "partial" ? {} : { context }),
        ...(context === "partial" ? { contextText: "selected explicit background", model: "inherited-fixture/override" } : {}) })}` });
      const record = await until(() => records().find(r => r.context === context && r.stopped));
      assert.equal(record.state, "completed", record.error);
      assert.equal(record.name, context);
      assert.equal(record.loadout.model, `inherited-fixture/${context === "partial" ? "override" : "default"}`);
      assert.deepEqual([...record.loadout.tools].sort(), ["ask_question", "custom_search", "read", "startup_tool"]);
      assert.deepEqual(record.loadout.extensions, [provider]);
      assert.deepEqual(record.loadout.skills.map(s => s.name).sort(), ["dir-alias", "file-alias", "hidden", "visible"]);
      assert.equal(record.loadout.skills.find(s => s.name === "hidden")?.disableModelInvocation, true);
      const fileSkill = record.loadout.skills.find(s => s.name === "file-alias")!;
      assert.equal(fileSkill.loadPath, join(dir, "file-alias", "SKILL.md"));
      assert.equal(fileSkill.filePath, join(dir, "shared-file", "SKILL.md"));
      assert.equal(fileSkill.baseDir, join(dir, "file-alias"));
      const directorySkill = record.loadout.skills.find(s => s.name === "dir-alias")!;
      assert.equal(directorySkill.loadPath, join(dir, "dir-alias", "SKILL.md"));
      assert.equal(directorySkill.baseDir, join(dir, "shared-dir"));
      const entries = readFileSync(record.sessionFile, "utf8").trim().split("\n").map(s => JSON.parse(s));
      const results = entries.filter(e => e.type === "message" && e.message.role === "toolResult" && ["read", "custom_search", "startup_tool"].includes(e.message.toolName));
      assert.ok(results.length >= 3);
      for (const name of ["read", "custom_search", "startup_tool"]) {
        assert.ok(results.some(e => e.message.toolName === name && !e.message.isError && e.message.content[0].text === `${name}: inherited execution`), `${name} did not execute inherited implementation`);
      }
      const output = JSON.parse(record.output);
      assert.deepEqual(output.tools.sort(), ["ask_question", "custom_search", "read", "startup_tool"]);
      assert.match(output.systemPrompt, /visible inherited skill/);
      assert.doesNotMatch(output.systemPrompt, /hidden inherited skill/); // Still available as an explicit skill.
      const users = entries.filter(e => e.type === "message" && e.message.role === "user");
      assert.equal(users.length > 1, context === "full");
      if (context === "partial") assert.match(JSON.stringify(users), /Selected parent context:\\nselected explicit background/);
      if (context === "full") assert.match(JSON.stringify(entries), /frozen reference snapshot/);
    }
    await rpc.request("prompt", { streamingBehavior: "followUp", message: 'DISPATCH {"task":"ASK","access":"full","context":"none","name":"question"}' });
    const waiting = await until(() => records().find(r => r.name === "question" && r.state === "waiting"));
    assert.equal(waiting.questions.length, 1);
    assert.equal(waiting.stopped, false);
    // Exercise the real parent control tool through the deterministic model.
    await rpc.request("prompt", { streamingBehavior: "followUp", message: `CONTROL ${JSON.stringify({ action: "answer", id: waiting.id, questionId: waiting.questions[0].id, message: "Use A" })}` });
    const answered = await until(() => records().find(r => r.id === waiting.id && r.stopped));
    assert.equal(answered.state, "completed", answered.error);
    assert.match(answered.output, /Use A/);
    assert.deepEqual(errors, []);
  } finally { await rpc.stop(); rmSync(dir, { recursive: true, force: true }); }
});
