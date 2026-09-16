import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkflowManager, validateSteps, type StepDefinition } from '../pi-extension/subagents/workflows.ts';
import { TaskManager } from '../pi-extension/subagents/tasks.ts';
import { TaskStore } from '../pi-extension/subagents/store.ts';
import { RpcProcess } from '../pi-extension/subagents/rpc.ts';
import { loadout } from './fixtures/loadout.ts';
const fake = fileURLToPath(new URL('./fixtures/fake-rpc.mjs', import.meta.url));
const step = (id: string, access: 'full' | 'read-only' = 'read-only', dependsOn: string[] = [], task = id): StepDefinition => ({ id, access, dependsOn, task });
async function until(fn: () => boolean) { for (let i = 0; i < 400; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('workflow timed out'); }
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'workflows-'));
  const tasks = new TaskManager(new TaskStore(dir), { command: process.execPath, createRpc: l => new RpcProcess({ ...l, args: [fake] }, 1000, 250) });
  const workflows = new WorkflowManager(tasks, join(dir, 'workflows'));
  return { dir, tasks, workflows, launch: (steps: StepDefinition[]) => workflows.launch({ context: 'none', loadout: loadout(dir), steps }),
    async clean() { await workflows.shutdown(); await tasks.shutdown(); rmSync(dir, { recursive: true, force: true }); } };
}
test('DAG validation rejects cycles, unknown dependencies, duplicate IDs and invalid access', () => {
  assert.throws(() => validateSteps([step('a', 'full', ['b']), step('b', 'full', ['a'])]), /Cyclic/);
  assert.throws(() => validateSteps([step('a', 'full', ['missing'])]), /Unknown/);
  assert.throws(() => validateSteps([step('a'), step('a')]), /unique/);
  assert.throws(() => validateSteps([{ ...step('a'), access: 'write' as any }]), /access/);
  assert.throws(() => validateSteps([]), /1–64/);
});
test('readers run concurrently; writer waits, then downstream receives only direct reports', async () => {
  const t = setup();
  try {
    const r = t.launch([step('a', 'read-only', [], 'SCENARIO_HOLD'), step('b', 'read-only', [], 'SCENARIO_HOLD'), step('writer', 'full', ['a', 'b']), step('review', 'read-only', ['writer'])]);
    await until(() => r.steps.slice(0, 2).every(s => !!s.taskId && t.tasks.get(s.taskId).activity !== 'starting RPC'));
    assert.deepEqual(r.steps.map(s => s.state), ['running', 'running', 'pending', 'pending']);
    await Promise.all(r.steps.slice(0, 2).map(s => t.tasks.message(s.taskId!, `report-${s.id}`)));
    await until(() => r.state === 'completed');
    const writer = t.tasks.get(r.steps[2].taskId!);
    assert.match(writer.task, /Step a .*\n/s); assert.match(writer.task, /report-b/);
    assert.equal(writer.access, 'full');
    const review = t.tasks.get(r.steps[3].taskId!);
    assert.match(review.task, /Direct dependency results .*\nStep writer/s);
    assert.equal(review.context, 'none');
    assert.equal(JSON.parse(readFileSync(join(t.dir, 'workflows', `${r.id}.json`), 'utf8')).state, 'completed');
  } finally { await t.clean(); }
});
test('full access excludes independent siblings; context is frozen at workflow creation', async () => {
  const t = setup();
  try {
    const input = { context: 'partial' as const, contextText: 'original context', loadout: loadout(t.dir),
      steps: [step('writer', 'full', [], 'SCENARIO_HOLD'), step('reader')] };
    const r = t.workflows.launch(input); input.contextText = 'later context'; input.steps[1].task = 'later task';
    await until(() => !!r.steps[0].taskId && t.tasks.get(r.steps[0].taskId!).log.some(l => l.includes('src/auth.ts')));
    assert.equal(r.steps[1].state, 'pending'); assert.equal(t.tasks.records.size, 1);
    await t.tasks.message(r.steps[0].taskId!, 'writer report');
    await until(() => r.state === 'completed');
    assert.equal(r.contextText, 'original context'); assert.equal(t.tasks.get(r.steps[1].taskId!).task, 'reader');
  } finally { await t.clean(); }
});
test('failure pauses; explicit continuation reuses session; updates only touch unstarted steps', async () => {
  const t = setup();
  try {
    const r = t.launch([step('a', 'full', [], 'SCENARIO_ERROR'), step('b', 'read-only', ['a'])]);
    await until(() => r.state === 'paused');
    assert.equal(r.steps[1].state, 'pending');
    assert.throws(() => t.workflows.resume(r.id), /retry/);
    assert.throws(() => t.workflows.update(r.id, [step('a')]), /already started/);
    t.workflows.update(r.id, [step('b', 'read-only', ['a'], 'verify repaired work'), step('c', 'read-only', ['b'])]);
    const id = r.steps[0].taskId!;
    await assert.rejects(t.tasks.continue(id, 'bypass'), /workflow_control/);
    await t.workflows.retry(r.id, 'a', 'fixed', 'read-only');
    await until(() => r.steps[0].state === 'completed');
    assert.equal(r.state, 'paused'); assert.equal(t.tasks.get(id).run, 2); assert.equal(t.tasks.get(id).access, 'read-only');
    t.workflows.resume(r.id); await until(() => r.state === 'completed');
    t.workflows.pause(r.id);
    await assert.rejects(t.workflows.retry(r.id, 'a', 'rewrite'), /dependent step/);
  } finally { await t.clean(); }
});
test('pause preserves active work, cancel stops it and never dispatches pending children', async () => {
  const t = setup();
  try {
    const r = t.launch([step('a', 'full', [], 'SCENARIO_HOLD'), step('b', 'read-only', ['a'])]);
    await until(() => !!r.steps[0].taskId && t.tasks.get(r.steps[0].taskId!).log.some(l => l.includes('src/auth.ts')));
    t.workflows.pause(r.id); assert.equal(r.steps[0].state, 'running');
    await t.workflows.cancel(r.id);
    assert.equal(r.state, 'cancelled'); assert.equal(r.steps[1].state, 'cancelled');
    assert.equal(t.tasks.get(r.steps[0].taskId!).stopped, true);
  } finally { await t.clean(); }
});
test('restart remains paused, reconciles missing task linkage, and blocks orphan writers', async () => {
  const t = setup(); let restored: WorkflowManager | undefined;
  try {
    const r = t.launch([step('a', 'full', [], 'SCENARIO_HOLD'), step('b', 'read-only', ['a'])]);
    await until(() => !!r.steps[0].taskId && t.tasks.isLive(r.steps[0].taskId!));
    const id = r.steps[0].taskId!;
    await t.workflows.shutdown(); await t.tasks.shutdown();
    const task = t.tasks.get(id); task.stopped = false; t.tasks.store.save(task);
    const disk = JSON.parse(readFileSync(join(t.dir, 'workflows', `${r.id}.json`), 'utf8'));
    delete disk.steps[0].taskId;
    const { atomicWrite } = await import('../pi-extension/subagents/store.ts');
    atomicWrite(join(t.dir, 'workflows', `${r.id}.json`), JSON.stringify(disk));
    const tasks = new TaskManager(new TaskStore(t.dir), { command: process.execPath });
    restored = new WorkflowManager(tasks, join(t.dir, 'workflows'));
    const recovered = restored.get(r.id);
    assert.equal(recovered.state, 'paused'); assert.equal(recovered.steps[0].taskId, id);
    assert.throws(() => restored!.resume(r.id), /Unconfirmed/);
    await assert.rejects(restored.retry(r.id, 'a', 'try again'), /shutdown/);
    assert.equal(tasks.records.size, 1);
    await tasks.shutdown();
  } finally { await restored?.shutdown(); await t.clean(); }
});
