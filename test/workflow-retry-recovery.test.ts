import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkflowManager, type WorkflowRecord } from '../pi-extension/subagents/workflows.ts';
import { TaskManager } from '../pi-extension/subagents/tasks.ts';
import { TaskStore, atomicWrite } from '../pi-extension/subagents/store.ts';
import { RpcProcess } from '../pi-extension/subagents/rpc.ts';
import { git } from '../pi-extension/subagents/workspaces.ts';
import { loadout } from './fixtures/loadout.ts';
const fake = fileURLToPath(new URL('./fixtures/fake-rpc.mjs', import.meta.url));
async function until(fn: () => boolean) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('retry recovery fixture timed out');
}
function manager(dir: string) {
  return new TaskManager(new TaskStore(join(dir, 'tasks')), { command: process.execPath,
    createRpc: l => new RpcProcess({ ...l, args: [fake] }, 3000, 1000) });
}
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-retry-')), repo = join(dir, 'repo'); mkdirSync(repo);
  await git(repo, 'init'); writeFileSync(join(repo, 'base.txt'), 'base'); await git(repo, 'add', '.'); await git(repo, 'commit', '-m', 'base');
  const tasks = manager(dir), workflows = new WorkflowManager(tasks, join(dir, 'workflows'));
  const r = workflows.launch({ context: 'none', loadout: loadout(repo), workspace: 'isolated', validationCommand: 'true',
    steps: [{ id: 'a', task: 'SCENARIO_ERROR', access: 'full', dependsOn: [] }] });
  await until(() => r.state === 'paused' && r.steps[0].state === 'failed');
  // The pump may still be releasing its preparation guard after reconciliation.
  await new Promise(resolve => setTimeout(resolve, 20));
  return { dir, tasks, workflows, r, async clean() {
    await workflows.shutdown(); await tasks.shutdown(); rmSync(dir, { recursive: true, force: true });
  } };
}
function persist(dir: string, r: WorkflowRecord) { atomicWrite(join(dir, 'workflows', `${r.id}.json`), JSON.stringify(r)); }

test('fresh retry recovery ignores old tasks until a matching attempt exists, including startup failure', async () => {
  const t = await setup(); let restored: WorkflowManager | undefined;
  try {
    const oldId = t.r.steps[0].taskId!, oldAttempt = t.r.steps[0].attemptId;
    await t.workflows.retry(t.r.id, 'a', 'SCENARIO_HOLD');
    assert.notEqual(t.r.steps[0].attemptId, oldAttempt);
    assert.equal(t.r.steps[0].freshTask, true);
    await t.workflows.shutdown();
    restored = new WorkflowManager(t.tasks, join(t.dir, 'workflows'));
    const r = restored.get(t.r.id);
    assert.equal(r.steps[0].taskId, undefined); assert.equal(r.steps[0].state, 'pending');
    // Failure before synchronous task reservation must not attach the old tag.
    t.tasks.launch = async () => { throw new Error('startup failed before reservation'); };
    restored.resume(r.id); await until(() => r.steps[0].state === 'failed');
    assert.equal(r.steps[0].taskId, undefined); assert.equal(r.steps[0].freshTask, true);
    assert.equal(t.tasks.records.size, 1); assert.equal(t.tasks.get(oldId).workflow!.attemptId, oldAttempt);
  } finally { await restored?.shutdown(); await t.clean(); }
});

test('persisted current-attempt task is recovered after crash before taskId/freshTask were saved', async () => {
  const t = await setup(); let restored: WorkflowManager | undefined, recoveredTasks: TaskManager | undefined;
  try {
    const oldId = t.r.steps[0].taskId!;
    await t.workflows.retry(t.r.id, 'a', 'SCENARIO_HOLD'); t.workflows.resume(t.r.id);
    await until(() => !!t.r.steps[0].taskId && t.tasks.get(t.r.steps[0].taskId!).activity !== 'starting RPC');
    const currentId = t.r.steps[0].taskId!;
    assert.notEqual(currentId, oldId);
    await t.workflows.shutdown(); await t.tasks.shutdown();
    const disk = JSON.parse(readFileSync(join(t.dir, 'workflows', `${t.r.id}.json`), 'utf8')) as WorkflowRecord;
    delete disk.steps[0].taskId; disk.steps[0].freshTask = true; disk.steps[0].state = 'running'; disk.state = 'running'; persist(t.dir, disk);
    recoveredTasks = manager(t.dir); restored = new WorkflowManager(recoveredTasks, join(t.dir, 'workflows'));
    const step = restored.get(t.r.id).steps[0];
    assert.equal(step.taskId, currentId); assert.equal(step.state, 'failed');
    assert.equal(recoveredTasks.get(currentId).workflow!.attemptId, step.attemptId);
    // Retry must see the recovered child, discard its scene and allocate a new attempt.
    const attempt = step.attemptId;
    await restored.retry(t.r.id, 'a', 'inspect and redo');
    assert.equal(step.worktree, undefined); assert.equal(step.taskId, undefined); assert.notEqual(step.attemptId, attempt);
  } finally { await restored?.shutdown(); await recoveredTasks?.shutdown(); await t.clean(); }
});

test('legacy task tags recover normally but legacy fresh retry never reattaches its old task', async () => {
  const t = await setup(); let restored: WorkflowManager | undefined;
  try {
    await t.workflows.shutdown();
    const old = t.tasks.get(t.r.steps[0].taskId!); delete old.workflow!.attemptId; t.tasks.store.save(old);
    delete t.r.steps[0].attemptId; delete t.r.steps[0].taskId; persist(t.dir, t.r);
    restored = new WorkflowManager(t.tasks, join(t.dir, 'workflows'));
    assert.equal(restored.get(t.r.id).steps[0].taskId, old.id); await restored.shutdown();
    t.r.steps[0].freshTask = true; t.r.steps[0].state = 'pending'; persist(t.dir, t.r);
    restored = new WorkflowManager(t.tasks, join(t.dir, 'workflows'));
    assert.equal(restored.get(t.r.id).steps[0].taskId, undefined); assert.equal(restored.get(t.r.id).steps[0].state, 'pending');
  } finally { await restored?.shutdown(); await t.clean(); }
});

test('shutdown during isolated retry waits for removal and refuses requeue', async () => {
  const t = await setup();
  try {
    const tree = t.r.steps[0].worktree!, save = (t.workflows as any).save.bind(t.workflows);
    let closing: Promise<void> | undefined;
    (t.workflows as any).save = (r: WorkflowRecord) => {
      save(r);
      if (tree.removed && !closing) closing = t.workflows.shutdown();
    };
    await assert.rejects(t.workflows.retry(t.r.id, 'a', 'redo'), /shutting down/);
    assert.ok(closing); await closing;
    assert.equal(tree.removed, true); assert.equal(t.r.steps[0].state, 'failed');
    assert.equal(t.tasks.records.size, 1);
    assert.equal((t.workflows as any).workspaceRuns.size, 0);
  } finally { await t.clean(); }
});
