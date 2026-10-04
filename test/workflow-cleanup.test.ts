import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkflowManager, workflowSummary, type WorkflowRecord, type StepDefinition } from '../pi-extension/subagents/workflows.ts';
import { TaskManager } from '../pi-extension/subagents/tasks.ts';
import { TaskStore } from '../pi-extension/subagents/store.ts';
import { RpcProcess } from '../pi-extension/subagents/rpc.ts';
import { git } from '../pi-extension/subagents/workspaces.ts';
import { loadout } from './fixtures/loadout.ts';
const fake = fileURLToPath(new URL('./fixtures/fake-rpc.mjs', import.meta.url));
async function until(fn: () => boolean) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('cleanup fixture timed out');
}
async function setup(command = 'true', steps: StepDefinition[] = [{ id: 'a', access: 'full', dependsOn: [], task: 'SCENARIO_HOLD' }]) {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-cleanup-')), repo = join(dir, 'repo'); mkdirSync(repo);
  await git(repo, 'init'); writeFileSync(join(repo, 'base.txt'), 'base'); await git(repo, 'add', '.'); await git(repo, 'commit', '-m', 'base');
  const tasks = new TaskManager(new TaskStore(join(dir, 'tasks')), { command: process.execPath, createRpc: l => new RpcProcess({ ...l, args: [fake] }, 3000, 1000) });
  const notifications: string[] = [];
  const workflows = new WorkflowManager(tasks, join(dir, 'workflows'), record => { notifications.push(record.state); });
  const r = workflows.launch({ context: 'none', loadout: loadout(repo), workspace: 'isolated', validationCommand: command,
    steps });
  await until(() => !!r.steps[0].taskId && tasks.get(r.steps[0].taskId!).activity !== 'starting RPC');
  return { dir, repo, tasks, workflows, r, notifications,
    async finish() { await tasks.message(r.steps[0].taskId!, 'done'); },
    async clean() { await workflows.shutdown(); await tasks.shutdown(); rmSync(dir, { recursive: true, force: true }); } };
}
test('terminal result and step refs survive removal, GC and explicit idempotent cleanup', async () => {
  const t = await setup();
  try {
    writeFileSync(join(t.r.steps[0].worktree!.path, 'output.txt'), 'durable'); await t.finish();
    await until(() => !!t.r.integration?.removed);
    assert.ok(t.r.steps[0].worktree!.removed); assert.equal(existsSync(t.r.integration!.path), false);
    await git(t.repo, 'reflog', 'expire', '--expire=now', '--all'); await git(t.repo, 'gc', '--prune=now');
    for (const tree of [t.r.integration!, t.r.steps[0].worktree!]) assert.equal(await git(t.repo, 'show', `${tree.revisionRef}:output.txt`), 'durable');
    assert.match(workflowSummary(t.r), /refs\/pi-workflows\/.*\/result/);
    await t.workflows.cleanup(t.r.id); await t.workflows.cleanup(t.r.id);
    const recovered = new WorkflowManager(t.tasks, join(t.dir, 'workflows'));
    try { await recovered.cleanup(t.r.id); assert.equal(recovered.get(t.r.id).integration!.removed, true); }
    finally { await recovered.shutdown(); }
  } finally { await t.clean(); }
});
for (const terminal of ['completed', 'cancelled'] as const) {
  test(`${terminal} cleanup does not notify again on explicit cleanup, unrelated progress or recovery`, async () => {
    const t = await setup();
    const drain = async () => { await (t.workflows as unknown as { pump?: Promise<void> }).pump; };
    try {
      if (terminal === 'completed') {
        await t.finish(); await until(() => !!t.r.integration?.removed);
      } else await t.workflows.cancel(t.r.id);
      await drain();
      const count = t.notifications.length;
      assert.ok(count > 0);
      await t.workflows.cleanup(t.r.id); await t.workflows.cleanup(t.r.id);
      assert.equal(t.notifications.length, count, 'explicit cleanup must be silent when already complete');
      const task = await t.tasks.launch({ task: 'SCENARIO_HOLD', access: 'full', context: 'none', loadout: loadout(t.repo) });
      await drain();
      await t.tasks.message(task.id, 'done');
      await until(() => task.stopped); await drain();
      assert.equal(t.notifications.length, count, 'unrelated task progress must not repeat terminal notifications');
      const recovered = new WorkflowManager(t.tasks, join(t.dir, 'workflows'), () => { t.notifications.push('recovered'); });
      try { await recovered.cleanup(t.r.id); assert.equal(t.notifications.length, count, 'recovered cleanup must also be silent'); }
      finally { await recovered.shutdown(); }
    } finally { await t.clean(); }
  });
}
test('cancel discards dirty child scene but keeps records and sessions', async () => {
  const t = await setup();
  try {
    const task = t.tasks.get(t.r.steps[0].taskId!), tree = t.r.steps[0].worktree!;
    writeFileSync(join(tree.path, 'discard.txt'), 'uncommitted'); await t.workflows.cancel(t.r.id);
    assert.equal(tree.removed, true); assert.equal(existsSync(tree.path), false);
    assert.equal(task.stopped, true); assert.equal(existsSync(task.sessionFile), true);
    assert.equal(existsSync(join(t.dir, 'workflows', `${t.r.id}.json`)), true);
  } finally { await t.clean(); }
});
test('cancel preserves captured successful siblings while discarding the unfinished sibling', async () => {
  const t = await setup('true', ['a', 'b'].map(id => ({ id, access: 'full', dependsOn: [], task: 'SCENARIO_HOLD' })));
  try {
    await until(() => !!t.r.steps[1].taskId && t.tasks.get(t.r.steps[1].taskId!).activity !== 'starting RPC');
    const successful = t.r.steps[0].worktree!, unfinished = t.r.steps[1].worktree!;
    writeFileSync(join(successful.path, 'accepted.txt'), 'keep');
    writeFileSync(join(unfinished.path, 'discard.txt'), 'discard');
    await t.finish(); await until(() => t.r.steps[0].state === 'completed');
    await t.workflows.cancel(t.r.id);
    assert.ok(successful.removed); assert.ok(unfinished.removed);
    assert.equal(await git(t.repo, 'show', `${successful.revisionRef}:accepted.txt`), 'keep');
    assert.equal(unfinished.revisionRef, undefined);
    assert.equal(await git(t.repo, 'status', '--porcelain'), '');
  } finally { await t.clean(); }
});

test('manual pause retains stopped scene and refuses explicit destructive cleanup', async () => {
  const t = await setup();
  try {
    t.workflows.pause(t.r.id); await t.finish(); await until(() => t.r.steps[0].state === 'completed');
    await assert.rejects(t.workflows.cleanup(t.r.id), /Only completed\/cancelled/);
    assert.equal(existsSync(t.r.steps[0].worktree!.path), true);
  } finally { await t.clean(); }
});
test('cleanup refuses live processes and unconfirmed recovered shutdown', async () => {
  const t = await setup();
  try {
    t.r.state = 'cancelled';
    await assert.rejects(t.workflows.cleanup(t.r.id), /shutdown/);
    assert.equal(existsSync(t.r.steps[0].worktree!.path), true);
    t.r.state = 'paused';
    await t.tasks.cancel(t.r.steps[0].taskId!);
    const task = t.tasks.get(t.r.steps[0].taskId!); task.stopped = false; t.r.state = 'cancelled';
    await assert.rejects(t.workflows.cleanup(t.r.id), /shutdown/);
    assert.equal(existsSync(t.r.steps[0].worktree!.path), true);
    task.stopped = true; await t.workflows.cleanup(t.r.id);
  } finally { await t.clean(); }
});
test('a failed preservation ref blocks every removal, explicit cleanup retries it', async () => {
  const t = await setup();
  try {
    const refdir = join(t.repo, '.git', 'refs', 'pi-workflows', t.r.id, 'steps'); mkdirSync(refdir, { recursive: true });
    const lock = join(refdir, 'a.lock'); writeFileSync(lock, 'locked'); await t.finish();
    await until(() => t.r.state === 'completed' && !!t.r.cleanupError);
    assert.equal(existsSync(t.r.steps[0].worktree!.path), true); assert.equal(existsSync(t.r.integration!.path), true);
    rmSync(lock); await t.workflows.cleanup(t.r.id);
    assert.equal(t.r.cleanupError, undefined); assert.equal(t.r.integration!.removed, true);
  } finally { await t.clean(); }
});
test('retry after validation failure uses a fresh session and removes retired result trees at completion', async () => {
  const t = await setup('echo log; false');
  try {
    writeFileSync(join(t.r.steps[0].worktree!.path, 'first.txt'), 'captured'); await t.finish();
    await until(() => t.r.state === 'paused' && !!t.r.integration && !t.r.validationPid);
    const oldTask = t.tasks.get(t.r.steps[0].taskId!), oldTree = t.r.steps[0].worktree!, oldResult = t.r.integration!;
    await t.workflows.retry(t.r.id, 'a', 'Redo SCENARIO_HOLD');
    assert.ok(oldTree.removed); assert.ok(oldTree.revisionRef);
    t.r.validationCommand = 'true'; t.workflows.resume(t.r.id);
    await until(() => !!t.r.steps[0].taskId && t.tasks.get(t.r.steps[0].taskId!).activity !== 'starting RPC');
    assert.notEqual(t.r.steps[0].taskId, oldTask.id);
    assert.notEqual(t.tasks.get(t.r.steps[0].taskId!).sessionFile, oldTask.sessionFile);
    assert.equal(existsSync(join(t.r.steps[0].worktree!.path, 'first.txt')), false);
    await t.finish(); await until(() => !!t.r.integration?.removed && !!oldResult.removed);
    assert.ok(oldResult.removed); assert.equal(existsSync(oldResult.path), false);
    assert.equal(existsSync(`${oldResult.path}.validation.log`), true);
    assert.equal(await git(t.repo, 'show', `${oldTree.revisionRef}:first.txt`), 'captured');
  } finally { await t.clean(); }
});

test('shutdown drains explicit cleanup outside the scheduler pump', async () => {
  const t = await setup();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let cleanup: Promise<void> | undefined, shutdown: Promise<void> | undefined;
  try {
    t.workflows.pause(t.r.id);
    await t.tasks.cancel(t.r.steps[0].taskId!);
    await until(() => t.r.steps[0].state === 'cancelled');
    const internals = t.workflows as unknown as { pump?: Promise<void>; performCleanup(record: WorkflowRecord): Promise<void> };
    await internals.pump;
    t.r.state = 'cancelled';
    // Hold the workspace-operation boundary without starting a scheduler run.
    internals.performCleanup = async () => { await gate; };
    cleanup = t.workflows.cleanup(t.r.id);
    let stopped = false;
    shutdown = t.workflows.shutdown().then(() => { stopped = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopped, false, 'shutdown must wait for explicit cleanup');
    release(); await cleanup; await shutdown;
    assert.equal(stopped, true);
  } finally { release(); await cleanup; await shutdown; await t.clean(); }
});

test('shutdown aborts validation without delivering late workflow notifications', async () => {
  const t = await setup('exec sleep 60');
  try {
    await t.finish();
    await until(() => !!t.r.validationPid);
    t.notifications.length = 0;
    await t.workflows.shutdown();
    assert.deepEqual(t.notifications, [], 'closed workflow owner must not notify the replacement session');
    assert.equal(t.r.validationPid, undefined);
  } finally { await t.clean(); }
});
