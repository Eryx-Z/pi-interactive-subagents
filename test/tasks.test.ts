import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { TaskStore, uniqueName, addLog } from "../pi-extension/subagents/store.ts";
import { TaskManager, childLaunch } from "../pi-extension/subagents/tasks.ts";
import { RpcProcess } from "../pi-extension/subagents/rpc.ts";
import { parseAgent, validateLoadout, resolveLoadout, discoverAgents, type Loadout } from "../pi-extension/subagents/agents.ts";

const fake = fileURLToPath(new URL('./fixtures/fake-rpc.mjs', import.meta.url));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(fn: () => boolean) { for (let i = 0; i < 200; i++) { if (fn()) return; await sleep(10); } throw new Error('timed out waiting for fake task'); }
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'tasks-'));
  const events: string[] = [];
  const create = () => new TaskManager(new TaskStore(dir), { command: process.execPath, createRpc: l => new RpcProcess({ ...l, args: [fake] }, 1000, 25), notify: (r, kind) => events.push(`${r.id}:${kind}:${r.state}`) });
  const manager = create();
  const loadout: Loadout = { version: 1, agent: 'worker', tools: ['read', 'ask_question'], extensions: [], model: 'fake/test', thinking: 'off', prompt: 'role', promptMode: 'append', cwd: dir, agentDir: dir };
  return { dir, manager, loadout, events, create, async clean() { await manager.shutdown(); rmSync(dir, { recursive: true, force: true }); } };
}

test('parallel tasks reserve explicit names, stream progress and settle exactly once', async () => {
  const t = setup();
  try {
    const [a, b] = await Promise.all(['a', 'b'].map(s => t.manager.launch({ name: 'same', task: s, ownership: s, context: 'none', loadout: t.loadout })));
    assert.equal(a.name, 'same'); assert.equal(b.name, 'same-2');
    await until(() => a.stopped && b.stopped);
    assert.equal(a.state, 'completed'); assert.match(a.output, /finished/);
    assert.ok(a.log.some(l => l.includes('src/auth.ts')));
    assert.equal(t.events.filter(e => e.includes(':result:')).length, 2);
  } finally { await t.clean(); }
});
test('question blocks completion; answer is correlated and duplicate/stale answers are rejected', async () => {
  const t = setup();
  try {
    const r = await t.manager.launch({ task: 'SCENARIO_QUESTION', ownership: 'src/a', context: 'none', loadout: t.loadout });
    await until(() => r.state === 'waiting');
    await sleep(50); assert.equal(r.stopped, false); assert.equal(r.questions[0].id, 'q-1');
    await assert.rejects(t.manager.message(r.id, 'not an answer'), /question ID/);
    assert.throws(() => t.manager.answer(r.id, 'wrong', 'x'), /no longer/);
    t.manager.answer(r.id, 'q-1', 'Use interface A');
    assert.throws(() => t.manager.answer(r.id, 'q-1', 'duplicate'), /no longer/);
    await until(() => r.stopped);
    assert.equal(r.state, 'completed'); assert.equal(r.questions.length, 0);
  } finally { await t.clean(); }
});
test('supplemental messages are queued, not reported as execution; cancel stops waiting and running children', async () => {
  const t = setup();
  try {
    const r = await t.manager.launch({ task: 'SCENARIO_HOLD', ownership: 'a', context: 'none', loadout: t.loadout });
    await t.manager.message(r.id, 'new instruction');
    assert.ok(r.log.some(l => l.includes('not yet proven executed')));
    const q = await t.manager.launch({ task: 'SCENARIO_QUESTION', ownership: 'b', context: 'none', loadout: t.loadout });
    await until(() => q.state === 'waiting');
    await t.manager.cancel(q.id); assert.equal(q.state, 'cancelled'); assert.equal(q.stopped, true);
  } finally { await t.clean(); }
});
test('provider error and unexpected exit become failed, not successful completion', async () => {
  const t = setup();
  try {
    for (const scenario of ['SCENARIO_ERROR', 'SCENARIO_DIE']) {
      const r = await t.manager.launch({ task: scenario, ownership: scenario, context: 'none', loadout: t.loadout });
      await until(() => r.stopped); assert.equal(r.state, 'failed'); assert.ok(r.error);
    }
  } finally { await t.clean(); }
});
test('completed tasks persist and continue; concurrent continuations exclude a second writer', async () => {
  const t = setup();
  let restored: TaskManager | undefined;
  try {
    const r = await t.manager.launch({ task: 'initial', ownership: 'a', context: 'none', loadout: t.loadout });
    await until(() => r.stopped); await t.manager.shutdown();
    restored = t.create();
    const first = restored.continue(r.id, 'SCENARIO_HOLD');
    await assert.rejects(restored.continue(r.id, 'duplicate'), /already running/);
    const resumed = await first;
    assert.equal(resumed.run, 2); assert.equal(resumed.name, r.name);
    await restored.shutdown(); assert.equal(resumed.state, 'cancelled'); assert.equal(resumed.stopped, true);
    await assert.rejects(restored.continue(r.id, 'late'), /shutting down/);
  } finally { await restored?.shutdown(); await t.clean(); }
});
test('stale live records and lockfiles never auto-resume orphan writers', async () => {
  const t = setup();
  try {
    const r = await t.manager.launch({ task: 'initial', ownership: 'a', context: 'none', loadout: t.loadout });
    await until(() => r.stopped);
    r.state = 'running'; r.stopped = false; t.manager.store.save(r);
    const loaded = t.manager.store.load()[0];
    assert.equal(loaded.state, 'failed'); assert.equal(loaded.stopped, false);
    assert.throws(() => t.manager.store.validateForContinue(loaded), /not confirmed/);
    const release = t.manager.store.lock(r.id);
    assert.throws(() => t.manager.store.lock(r.id), /locked/); release();
  } finally { await t.clean(); }
});
test('loadouts default deny, reject malformed snapshots/nested tools and snapshot absolute extension paths', () => {
  const t = setup();
  try {
    const file = join(t.dir, 'different-filename.md');
    const agent = parseAgent('---\nname: named-role\ntools:\nmodel: fake/test\n---\nRole', file);
    assert.deepEqual(agent.tools, []);
    const l = resolveLoadout(agent, t.dir, 'fake/test', 'off', t.dir);
    assert.deepEqual(l.tools, ['ask_question']);
    assert.throws(() => validateLoadout({}), /Invalid/);
    assert.throws(() => parseAgent('---\nname: bad\ntools: subagent\n---\n', file), /nested/);
    const launch = childLaunch({ id: 'example', sessionFile: '/tmp/session.jsonl', loadout: l } as any, t.dir, 'pi');
    assert.ok(launch.args.includes('--no-extensions')); assert.ok(launch.args.includes('--no-context-files')); assert.equal(launch.cwd, t.dir);
    assert.equal(launch.args[launch.args.indexOf('--tools') + 1], 'ask_question');
    assert.throws(() => uniqueName('a\nb', []), /control/);
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});
test('stale settled events cannot close a task while a supplementary instruction is running', async () => {
  const t = setup();
  try {
    const r = await t.manager.launch({ task: 'SCENARIO_HOLD', ownership: 'a', context: 'none', loadout: t.loadout });
    await t.manager.message(r.id, 'finish this supplementary work');
    await sleep(30);
    assert.equal(r.stopped, false);
    assert.equal(t.events.filter(e => e.includes(':result:')).length, 0);
    await until(() => r.stopped);
    assert.equal(r.state, 'completed');
    assert.match(r.output, /supplementary work/);
    assert.equal(t.events.filter(e => e.includes(':result:')).length, 1);
  } finally { await t.clean(); }
});
test('failed supplementary prompt does not strand a running writer', async () => {
  const t = setup();
  try {
    const r = await t.manager.launch({ task: 'SCENARIO_HOLD', ownership: 'a', context: 'none', loadout: t.loadout });
    await assert.rejects(t.manager.message(r.id, 'SCENARIO_REJECT_MESSAGE'), /rejected/);
    assert.equal(r.state, 'failed');
    assert.equal(r.stopped, true);
    assert.match(r.error!, /Supplement failed/);
  } finally { await t.clean(); }
});
test('logs and output remain bounded during long tool streams', () => {
  const record = { log: [] } as any;
  for (let i = 0; i < 1000; i++) addLog(record, 'x'.repeat(10000));
  assert.equal(record.log.length, 100); assert.ok(record.log[0].length < 1100);
});
