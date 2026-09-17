import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkflowManager, type StepDefinition } from '../pi-extension/subagents/workflows.ts';
import { TaskManager } from '../pi-extension/subagents/tasks.ts';
import { TaskStore } from '../pi-extension/subagents/store.ts';
import { RpcProcess } from '../pi-extension/subagents/rpc.ts';
import { git } from '../pi-extension/subagents/workspaces.ts';
import { loadout } from './fixtures/loadout.ts';
const fake = fileURLToPath(new URL('./fixtures/fake-rpc.mjs', import.meta.url));
const step = (id: string, dependsOn: string[] = []): StepDefinition => ({ id, access: 'full', dependsOn, task: 'SCENARIO_HOLD' });
async function until(fn: () => boolean) { for (let i = 0; i < 1500; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('workflow timed out'); }
async function setup(maxConcurrent = 8) {
  const dir = mkdtempSync(join(tmpdir(), 'isolated-workflow-')), repo = join(dir, 'repo'); mkdirSync(repo);
  await git(repo, 'init'); writeFileSync(join(repo, 'base.txt'), 'base\n'); await git(repo, 'add', '.'); await git(repo, 'commit', '-m', 'base');
  const tasks = new TaskManager(new TaskStore(join(dir, 'tasks')), { maxConcurrent, command: process.execPath, createRpc: l => new RpcProcess({ ...l, args: [fake] }, 1000, 250) });
  const workflows = new WorkflowManager(tasks, join(dir, 'workflows'));
  return { dir, repo, tasks, workflows,
    launch: (steps: StepDefinition[], validationCommand = 'test -f base.txt') => workflows.launch({ context: 'none', loadout: loadout(repo), workspace: 'isolated', validationCommand, steps }),
    async ready(s: { taskId?: string }) { await until(() => !!s.taskId && tasks.get(s.taskId).activity !== 'starting RPC'); },
    async finish(s: { taskId?: string }) { await tasks.message(s.taskId!, 'done'); },
    async clean() { await workflows.shutdown(); await tasks.shutdown(); rmSync(dir, { recursive: true, force: true }); } };
}
test('isolated writers overlap; dependency code propagates; final validation leaves source untouched', async () => {
  const t = await setup();
  try {
    const base = await git(t.repo, 'rev-parse', 'HEAD');
    const r = t.launch([step('a'), step('b'), step('join', ['a', 'b'])], 'test -f a.txt && test -f b.txt && test -f joined.txt');
    await Promise.all(r.steps.slice(0, 2).map(s => t.ready(s)));
    assert.deepEqual(r.steps.map(s => s.state), ['running', 'running', 'pending']);
    for (const s of r.steps.slice(0, 2)) { writeFileSync(join(t.tasks.get(s.taskId!).loadout.cwd, `${s.id}.txt`), s.id); await t.finish(s); }
    await t.ready(r.steps[2]);
    const cwd = t.tasks.get(r.steps[2].taskId!).loadout.cwd;
    assert.equal(readFileSync(join(cwd, 'a.txt'), 'utf8'), 'a'); assert.equal(readFileSync(join(cwd, 'b.txt'), 'utf8'), 'b');
    writeFileSync(join(cwd, 'joined.txt'), 'joined'); await t.finish(r.steps[2]);
    await until(() => r.state === 'completed');
    assert.equal(r.validated, true); assert.ok(r.integration?.output);
    assert.equal(await git(t.repo, 'rev-parse', 'HEAD'), base); assert.equal(await git(t.repo, 'status', '--porcelain'), '');
    assert.equal(readFileSync(join(r.integration!.path, 'joined.txt'), 'utf8'), 'joined');
  } finally { await t.clean(); }
});
test('conflicting final integration pauses, preserves conflicts, and resumes after explicit resolution', async () => {
  const t = await setup();
  try {
    const r = t.launch([step('a'), step('b')]); await Promise.all(r.steps.map(s => t.ready(s)));
    for (const s of r.steps) { writeFileSync(join(s.worktree!.path, 'base.txt'), `${s.id}\n`); await t.finish(s); }
    await until(() => r.state === 'paused');
    assert.ok(r.integration); assert.match(await git(r.integration.path, 'status', '--porcelain'), /UU base.txt/);
    assert.equal(readFileSync(join(t.repo, 'base.txt'), 'utf8'), 'base\n');
    writeFileSync(join(r.integration.path, 'base.txt'), 'resolved\n'); await git(r.integration.path, 'add', '.'); await git(r.integration.path, 'commit', '-m', 'resolve');
    t.workflows.resume(r.id); await until(() => r.state === 'completed'); assert.equal(r.validated, true);
  } finally { await t.clean(); }
});
test('dependency merge conflict prevents downstream launch until explicit repair/retry', async () => {
  const t = await setup();
  try {
    const r = t.launch([step('a'), step('b'), step('join', ['a', 'b'])]); await Promise.all(r.steps.slice(0, 2).map(s => t.ready(s)));
    for (const s of r.steps.slice(0, 2)) { writeFileSync(join(s.worktree!.path, 'base.txt'), `${s.id}\n`); await t.finish(s); }
    await until(() => r.state === 'paused'); const downstream = r.steps[2]; assert.equal(downstream.state, 'failed'); assert.equal(downstream.taskId, undefined);
    writeFileSync(join(downstream.worktree!.path, 'base.txt'), 'resolved\n'); await git(downstream.worktree!.path, 'add', '.'); await git(downstream.worktree!.path, 'commit', '-m', 'resolve');
    await t.workflows.retry(r.id, 'join', 'Continue with resolved inputs'); t.workflows.resume(r.id); await t.ready(downstream); await t.finish(downstream);
    // Integrating all steps in declaration order would conflict before reaching the
    // downstream resolution. Integration must use DAG leaves, whose ancestry includes the inputs.
    await until(() => r.state === 'completed');
  } finally { await t.clean(); }
});
test('dirty source is rejected before any child starts', async () => {
  const t = await setup();
  try { writeFileSync(join(t.repo, 'untracked'), 'keep'); const r = t.launch([step('a')]); await until(() => r.state === 'paused'); assert.match(r.error!, /clean/); assert.equal(t.tasks.records.size, 0); assert.equal(readFileSync(join(t.repo, 'untracked'), 'utf8'), 'keep'); }
  finally { await t.clean(); }
});
test('validation failure pauses; explicit resume reruns validation', async () => {
  const t = await setup();
  try {
    const r = t.launch([step('a')], 'echo validation-output; test -f ../approved'); await t.ready(r.steps[0]); await t.finish(r.steps[0]); await until(() => r.state === 'paused');
    assert.equal(r.validated, undefined); assert.match(readFileSync(`${r.integration!.path}.validation.log`, 'utf8'), /validation-output/);
    writeFileSync(join(r.isolation!.directory, 'approved'), 'yes'); t.workflows.resume(r.id); await until(() => r.state === 'completed');
  } finally { await t.clean(); }
});
test('global capacity includes independent tasks and multiple workflows', async () => {
  const t = await setup(1);
  try {
    const standalone = await t.tasks.launch({ task: 'SCENARIO_HOLD', context: 'none', access: 'read-only', loadout: loadout(t.repo) });
    const a = t.launch([step('a')]), b = t.launch([step('b')]);
    await assert.rejects(t.tasks.launch({ task: 'extra', context: 'none', access: 'full', loadout: loadout(t.repo) }), /concurrency/);
    await t.tasks.message(standalone.id, 'done'); await t.ready(a.steps[0]); assert.equal(b.steps[0].state, 'pending');
    await t.finish(a.steps[0]); await t.ready(b.steps[0]); await t.finish(b.steps[0]); await until(() => a.state === 'completed' && b.state === 'completed');
  } finally { await t.clean(); }
});
test('successful siblings are captured while paused so a failed step can be retried', async () => {
  const t = await setup();
  try {
    const r = t.launch([step('good'), { ...step('bad'), task: 'SCENARIO_ERROR' }]);
    await t.ready(r.steps[0]); await until(() => r.state === 'paused'); await t.finish(r.steps[0]);
    await until(() => r.steps[0].state === 'completed' && r.steps[1].state === 'failed');
    await t.workflows.retry(r.id, 'bad', 'Fix it'); t.workflows.resume(r.id); await until(() => r.state === 'completed');
    assert.ok(r.steps[0].worktree?.output);
  } finally { await t.clean(); }
});
test('long validation does not block other workflows and cancel waits for termination', async () => {
  const t = await setup();
  try {
    const a = t.launch([step('a')], 'exec sleep 60'); await t.ready(a.steps[0]); await t.finish(a.steps[0]);
    await until(() => !!a.validationPid);
    const b = t.launch([step('b')]); await t.ready(b.steps[0]); await t.finish(b.steps[0]); await until(() => b.state === 'completed');
    await t.workflows.cancel(a.id); assert.equal(a.state, 'cancelled'); assert.equal(a.validationPid, undefined); assert.notEqual(a.validated, true);
  } finally { await t.clean(); }
});
test('restart preserves integrated revisions and requires explicit resume', async () => {
  const t = await setup();
  try {
    const r = t.launch([step('a')]); await t.ready(r.steps[0]); t.workflows.pause(r.id); await t.finish(r.steps[0]); await until(() => r.steps[0].state === 'completed');
    await t.workflows.shutdown();
    const recovered = new WorkflowManager(t.tasks, join(t.dir, 'workflows'));
    try { const loaded = recovered.get(r.id); assert.equal(loaded.state, 'paused'); assert.equal(loaded.steps[0].state, 'completed'); assert.ok(loaded.steps[0].worktree?.output); recovered.resume(r.id); await until(() => loaded.state === 'completed'); }
    finally { await recovered.shutdown(); }
  } finally { await t.clean(); }
});
