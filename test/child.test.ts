import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bridge from "../pi-extension/subagents/child.ts";
import entry from "../pi-extension/subagents/index.ts";

test('child question tool awaits RPC UI answer, respects abort and enforces sequential execution', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'child-'));
  const previous = process.env.PI_RPC_SUBAGENT_LOADOUT;
  const path = join(dir, 'loadout.json');
  writeFileSync(path, JSON.stringify({ version: 1, agent: 'test', tools: ['read', 'ask_question'], extensions: [], model: 'fake/test', thinking: 'off', prompt: '', promptMode: 'append', cwd: dir, agentDir: dir }));
  process.env.PI_RPC_SUBAGENT_LOADOUT = path;
  try {
    const tools: any[] = [], handlers: Record<string, any> = {}, commands: Record<string, any> = {};
    let active: string[] = [];
    bridge({ registerTool: (t: any) => tools.push(t), registerCommand: (name: string, c: any) => commands[name] = c,
      on: (name: string, h: any) => handlers[name] = h, getAllTools: () => [{name: 'read'}, {name: 'ask_question'}],
      setActiveTools: (t: string[]) => active = t, getActiveTools: () => active,
    } as any);
    const q = tools[0]; assert.equal(q.executionMode, 'sequential');
    let answer!: (value: string) => void;
    let completed = false;
    const pending = q.execute('tool-q', { question: 'Which?' }, undefined, undefined, {
      mode: 'rpc', ui: { input: () => new Promise<string>(r => answer = r) },
    }).then((r: any) => { completed = true; return r; });
    await new Promise(r => setTimeout(r, 10)); assert.equal(completed, false);
    answer('Choice A'); assert.equal((await pending).content[0].text, 'Choice A');
    await assert.rejects(q.execute('q', {question: 'Which?'}, AbortSignal.abort(), undefined, {mode: 'rpc', ui: { input: async () => undefined }}), /cancelled/);
    assert.equal(handlers.tool_call({toolName: 'subagent'}).block, true);
    await commands['rpc-subagent-preflight'].handler('', {model: {provider: 'fake', id: 'test'}});
    assert.deepEqual(active, ['read', 'ask_question']);
    await assert.rejects(commands['rpc-subagent-preflight'].handler('', {model: {provider: 'other', id: 'model'}}), /not selected/);
  } finally {
    if (previous === undefined) delete process.env.PI_RPC_SUBAGENT_LOADOUT; else process.env.PI_RPC_SUBAGENT_LOADOUT = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
test('parent extension exposes discoverable control/UI; cannot register spawning in a child', () => {
  const tools: any[] = [], commands: string[] = [], events: string[] = [];
  const api = { on: (name: string) => events.push(name), registerTool: (t: any) => tools.push(t), registerCommand: (name: string) => commands.push(name), registerMessageRenderer() {} } as any;
  entry(api);
  assert.deepEqual(tools.map(t => t.name), ['subagent', 'subagents_list', 'subagent_control']);
  assert.ok(commands.includes('subagents')); assert.ok(events.includes('session_shutdown'));
  assert.equal(tools[0].parameters.properties.contextText.type, 'string');
  const previous = process.env.PI_RPC_SUBAGENT_CHILD;
  process.env.PI_RPC_SUBAGENT_CHILD = '1';
  try { entry({} as any); }
  finally { if (previous === undefined) delete process.env.PI_RPC_SUBAGENT_CHILD; else process.env.PI_RPC_SUBAGENT_CHILD = previous; }
});
