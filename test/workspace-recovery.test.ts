import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, renameSync, unlinkSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, initialize, prepare, capture, validate, type Worktree } from '../pi-extension/subagents/workspaces.ts';
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'worktree-git-')), repo = join(dir, 'repo'); mkdirSync(repo);
  await git(repo, 'init'); mkdirSync(join(repo, 'sub')); writeFileSync(join(repo, 'sub', 'file'), 'original'); writeFileSync(join(repo, 'delete'), 'delete');
  await git(repo, 'add', '.'); await git(repo, 'commit', '-m', 'base');
  return { dir, repo, isolation: await initialize(join(repo, 'sub'), join(dir, 'trees')), clean: () => rmSync(dir, { recursive: true, force: true }) };
}
test('captures rename/delete/binary/untracked changes and preserves nested cwd', async () => {
  const t = await setup();
  try {
    const tree: Worktree = { path: join(t.dir, 'trees', 'writer') }; assert.equal(await prepare(t.isolation, tree, []), join(tree.path, 'sub'));
    renameSync(join(tree.path, 'sub', 'file'), join(tree.path, 'sub', 'renamed')); unlinkSync(join(tree.path, 'delete')); writeFileSync(join(tree.path, 'binary'), Buffer.from([0, 1, 2, 255]));
    await capture(tree);
    const result: Worktree = { path: join(t.dir, 'trees', 'result') }; await prepare(t.isolation, result, [tree.output!]);
    assert.deepEqual(readFileSync(join(result.path, 'binary')), Buffer.from([0, 1, 2, 255])); assert.equal(readFileSync(join(result.path, 'sub', 'renamed'), 'utf8'), 'original');
    assert.match(await git(result.path, 'ls-files'), /renamed/); assert.doesNotMatch(await git(result.path, 'ls-files'), /delete/);
  } finally { t.clean(); }
});
test('symlink cwd is canonicalized; storage symlink inside source is rejected', async () => {
  const t = await setup();
  try {
    symlinkSync(join(t.repo, 'sub'), join(t.dir, 'alias')); const iso = await initialize(join(t.dir, 'alias'), join(t.dir, 'other')); assert.equal(iso.relativeCwd, 'sub');
    symlinkSync(t.repo, join(t.dir, 'inside')); await assert.rejects(initialize(t.repo, join(t.dir, 'inside', 'workspaces')), /outside/);
  } finally { t.clean(); }
});
test('validation cancellation terminates the process and preserves its log', async () => {
  const t = await setup();
  try {
    const tree: Worktree = { path: join(t.dir, 'trees', 'validate') }; await prepare(t.isolation, tree, []);
    const controller = new AbortController();
    const run = validate(tree, tree.path, 'echo started; exec sleep 60', controller.signal, () => setTimeout(() => controller.abort(), 50));
    await assert.rejects(run, /failed\/stopped/); assert.match(readFileSync(`${tree.path}.validation.log`, 'utf8'), /started/);
  } finally { t.clean(); }
});
test('validation cannot silently change the candidate tree', async () => {
  const t = await setup();
  try {
    const tree: Worktree = { path: join(t.dir, 'trees', 'validate') }; await prepare(t.isolation, tree, []);
    await assert.rejects(validate(tree, tree.path, 'echo changed > delete', new AbortController().signal), /clean/);
  } finally { t.clean(); }
});
