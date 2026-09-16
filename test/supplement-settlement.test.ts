import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskManager } from '../pi-extension/subagents/tasks.ts';
import { TaskStore } from '../pi-extension/subagents/store.ts';
import { loadout } from './fixtures/loadout.ts';

const tick = () => new Promise(resolve => setTimeout(resolve, 10));
for (const supplement of ['handled', 'queued', 'started']) test(`supplement after settlement: ${supplement}`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'supplement-settlement-'));
  const rpc = new EventEmitter() as any;
  const notices: string[] = [];
  const idle = { isStreaming: false, isCompacting: false, pendingMessageCount: 0 };
  let state = idle, hold = false, reply: ((state: typeof idle) => void) | undefined;
  rpc.request = async (type: string, fields: any) => {
    if (type === 'get_commands') return { commands: [{ name: 'rpc-subagent-preflight' }] };
    if (type === 'get_state') {
      if (hold) { hold = false; return new Promise(resolve => { reply = resolve; }); }
      return state;
    }
    if (type === 'prompt' && fields.message !== '/rpc-subagent-preflight') {
      if (!fields.message.startsWith('Supplementary parent')) rpc.emit('event', { type: 'agent_start' });
      else if (supplement === 'queued') state = { ...idle, pendingMessageCount: 1 };
      else if (supplement === 'started') {
        state = { ...idle, isStreaming: true };
        rpc.emit('event', { type: 'agent_start' });
      }
    }
  };
  rpc.stop = async () => {};
  const manager = new TaskManager(new TaskStore(dir), { command: 'unused', createRpc: () => rpc, notify: r => notices.push(r.state) });
  try {
    const record = await manager.launch({ task: 'test', access: "full", context: 'none', loadout: loadout(dir) });
    rpc.emit('event', { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'old result' }], stopReason: 'stop' } });
    hold = true;
    rpc.emit('event', { type: 'agent_settled' });
    assert.ok(reply);
    await manager.message(record.id, 'supplement');
    reply!(idle); // Old idle reply must not settle the new submission.
    await tick();
    if (supplement !== 'handled') {
      assert.equal(record.stopped, false);
      assert.deepEqual(notices, []);
      state = idle;
      rpc.emit('event', { type: 'agent_start' });
      rpc.emit('event', { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'new result' }], stopReason: 'stop' } });
      rpc.emit('event', { type: 'agent_settled' });
      await tick();
    }
    assert.equal(record.stopped, true);
    assert.equal(record.state, supplement === 'handled' ? 'failed' : 'completed');
    if (supplement === 'handled') assert.match(record.error!, /no agent run started/);
    else assert.equal(record.output, 'new result');
    assert.deepEqual(notices, [record.state]);
    manager.store.lock(record.id)();
  } finally { await manager.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
