import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capture, git, initialize, prepare, remove, retain, type Worktree } from '../pi-extension/subagents/workspaces.ts';

async function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'worktree-retention-'));
  const repo = join(directory, 'repo');
  mkdirSync(repo);
  await git(repo, 'init');
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'base');
  const isolation = await initialize(repo, join(directory, 'workflow'));
  const tree: Worktree = { path: join(isolation.directory, 'step') };
  await prepare(isolation, tree, []);
  return { directory, repo, isolation, tree, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
const ref = 'refs/pi-workflows/12345678-1234-1234-1234-123456789abc/steps/step';

test('retained captured output survives dirty removal and immediate GC and restores exact committed content', async () => {
  const t = await setup();
  try {
    writeFileSync(join(t.tree.path, 'base.txt'), 'captured\n');
    writeFileSync(join(t.tree.path, 'output.txt'), 'successful output\n');
    const revision = await capture(t.tree);
    await retain(t.repo, ref, revision);
    writeFileSync(join(t.tree.path, 'base.txt'), 'discard this tracked change\n');
    writeFileSync(join(t.tree.path, 'uncommitted.txt'), 'discard this untracked file\n');
    writeFileSync(`${t.tree.path}.validation.log`, 'keep diagnostic log\n');
    await remove(t.isolation, t.tree);
    assert.equal(existsSync(t.tree.path), false);
    assert.equal(readFileSync(`${t.tree.path}.validation.log`, 'utf8'), 'keep diagnostic log\n');
    await git(t.repo, 'reflog', 'expire', '--expire=now', '--all');
    await git(t.repo, 'gc', '--prune=now');
    assert.equal(await git(t.repo, 'rev-parse', ref), revision);
    const restored = join(t.directory, 'restored');
    await git(t.repo, 'worktree', 'add', '--detach', restored, ref);
    assert.equal(await git(restored, 'rev-parse', 'HEAD'), revision);
    assert.equal(readFileSync(join(restored, 'base.txt'), 'utf8'), 'captured\n');
    assert.equal(readFileSync(join(restored, 'output.txt'), 'utf8'), 'successful output\n');
    assert.equal(existsSync(join(restored, 'uncommitted.txt')), false);
    assert.equal(await git(restored, 'status', '--porcelain'), '');
    assert.equal(readFileSync(join(t.repo, 'base.txt'), 'utf8'), 'base\n');
  } finally { t.cleanup(); }
});

test('retain validates commit before updating a durable ref', async () => {
  const t = await setup();
  try {
    await retain(t.repo, ref, t.isolation.base);
    const blob = await git(t.repo, 'rev-parse', 'HEAD:base.txt');
    await assert.rejects(retain(t.repo, ref, blob));
    await assert.rejects(retain(t.repo, ref, 'missing-revision'));
    assert.equal(await git(t.repo, 'rev-parse', ref), t.isolation.base);
    await assert.rejects(retain(t.repo, 'HEAD', t.isolation.base));
  } finally { t.cleanup(); }
});

test('removal discards failed dirty state without creating any retained refs', async () => {
  const t = await setup();
  try {
    writeFileSync(join(t.tree.path, 'base.txt'), 'failed\n');
    writeFileSync(join(t.tree.path, 'failed-output.txt'), 'not captured\n');
    await remove(t.isolation, t.tree);
    assert.equal(existsSync(t.tree.path), false);
    assert.equal(await git(t.repo, 'for-each-ref', '--format=%(refname)', 'refs/pi-workflows'), '');
    assert.equal(await git(t.repo, 'rev-parse', 'HEAD'), t.isolation.base);
  } finally { t.cleanup(); }
});

test('removal discards unresolved merge conflicts without capturing them', async () => {
  const t = await setup();
  try {
    writeFileSync(join(t.repo, 'base.txt'), 'source change\n');
    await git(t.repo, 'commit', '-am', 'source');
    writeFileSync(join(t.tree.path, 'base.txt'), 'failed change\n');
    await git(t.tree.path, 'commit', '-am', 'failed');
    await assert.rejects(git(t.tree.path, 'merge', '--no-edit', await git(t.repo, 'rev-parse', 'HEAD')));
    assert.match(await git(t.tree.path, 'status', '--porcelain'), /UU base.txt/);
    await remove(t.isolation, t.tree);
    assert.equal(existsSync(t.tree.path), false);
    assert.equal(await git(t.repo, 'for-each-ref', '--format=%(refname)', 'refs/pi-workflows'), '');
    assert.equal(readFileSync(join(t.repo, 'base.txt'), 'utf8'), 'source change\n');
  } finally { t.cleanup(); }
});

test('removal is idempotent and targets only an absent worktree registration, not broad pruning', async () => {
  const t = await setup();
  try {
    const unrelated = join(t.directory, 'unrelated');
    await git(t.repo, 'worktree', 'add', '--detach', unrelated, t.isolation.base);
    rmSync(unrelated, { recursive: true });
    rmSync(t.tree.path, { recursive: true });
    await remove(t.isolation, t.tree);
    await remove(t.isolation, t.tree);
    const registered = await git(t.repo, 'worktree', 'list', '--porcelain');
    assert.ok(registered.includes(`worktree ${unrelated}\n`));
    assert.ok(!registered.includes(`worktree ${t.tree.path}\n`));
  } finally { t.cleanup(); }
});

test('removal refuses source, out-of-bounds registered worktrees, and unrelated directories/repos', async () => {
  const t = await setup();
  try {
    await assert.rejects(remove(t.isolation, { path: t.repo }), /unmanaged/);
    // Even an incorrectly supplied storage directory must not permit deleting the source.
    await assert.rejects(remove({ ...t.isolation, directory: t.directory }, { path: t.repo }), /unmanaged/);
    const outside = join(t.directory, 'outside');
    await git(t.repo, 'worktree', 'add', '--detach', outside, t.isolation.base);
    await assert.rejects(remove(t.isolation, { path: outside }), /unmanaged/);
    const unrelated = join(t.isolation.directory, 'unregistered');
    mkdirSync(unrelated);
    writeFileSync(join(unrelated, 'keep.txt'), 'keep\n');
    await assert.rejects(remove(t.isolation, { path: unrelated }), /unregistered/);
    await git(unrelated, 'init');
    await assert.rejects(remove(t.isolation, { path: unrelated }), /unregistered/);
    assert.equal(readFileSync(join(unrelated, 'keep.txt'), 'utf8'), 'keep\n');
    assert.equal(existsSync(outside), true);
    assert.equal(existsSync(t.repo), true);
    // A managed registration whose directory has been replaced by another repo is not ours.
    rmSync(t.tree.path, { recursive: true });
    mkdirSync(t.tree.path);
    await git(t.tree.path, 'init');
    await assert.rejects(remove(t.isolation, t.tree), /Unexpected worktree/);
    assert.equal(existsSync(join(t.tree.path, '.git')), true);
  } finally { t.cleanup(); }
});

test('removal refuses symlink escapes, branch-switched trees and locked trees', async () => {
  const t = await setup();
  try {
    const outside = join(t.directory, 'outside');
    await git(t.repo, 'worktree', 'add', '--detach', outside, t.isolation.base);
    const alias = join(t.isolation.directory, 'alias');
    symlinkSync(outside, alias, 'dir');
    await assert.rejects(remove(t.isolation, { path: alias }), /unmanaged/);
    await git(t.tree.path, 'switch', '-c', 'user-branch');
    writeFileSync(join(t.tree.path, 'keep.txt'), 'user changes\n');
    await assert.rejects(remove(t.isolation, t.tree), /detached/);
    assert.equal(readFileSync(join(t.tree.path, 'keep.txt'), 'utf8'), 'user changes\n');
    assert.equal(await git(t.repo, 'rev-parse', 'refs/heads/user-branch'), t.isolation.base);
    await git(t.tree.path, 'switch', '--detach');
    await git(t.repo, 'worktree', 'lock', '--reason', 'user lock', t.tree.path);
    await assert.rejects(remove(t.isolation, t.tree), /unlocked/);
    assert.equal(existsSync(t.tree.path), true);
    await git(t.repo, 'worktree', 'unlock', t.tree.path);
    await remove(t.isolation, t.tree);
    assert.equal(existsSync(t.tree.path), false);
  } finally { t.cleanup(); }
});
