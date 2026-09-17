import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { commitWorktree, pushWorktree, commitAndPushRoot } from '../src/main/git.ts';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'consort-checkout-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'root'), source = join(dir, 'source');
  git(dir, 'init', '-b', 'main', root);
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(root, 'code.txt'), 'original');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initial');
  git(root, 'worktree', 'add', '-b', 'feature', source);
  return { root, source };
}

test('commit touches only its worktree branch and index, preserving dirty siblings and root', async (t) => {
  const { root, source } = await fixture(t);
  const sibling = join(root, '..', 'sibling');
  git(root, 'worktree', 'add', '-b', 'other', sibling);
  const main = git(root, 'rev-parse', 'main');
  await writeFile(join(root, 'code.txt'), 'root staged');
  git(root, 'add', '.');
  await writeFile(join(sibling, 'code.txt'), 'sibling staged');
  git(sibling, 'add', '.');
  const rootIndex = git(root, 'diff', '--cached');
  const siblingIndex = git(sibling, 'diff', '--cached');
  await writeFile(join(source, 'code.txt'), 'feature');
  await writeFile(join(source, 'new.txt'), 'new');
  const commit = await commitWorktree(source, 'feature', 'Independent commit');
  assert.equal(commit, git(source, 'rev-parse', 'feature'));
  assert.equal(git(source, 'status', '--porcelain'), '');
  assert.equal(git(root, 'rev-parse', 'main'), main);
  assert.equal(git(sibling, 'rev-parse', 'other'), main);
  assert.equal(git(root, 'diff', '--cached'), rootIndex);
  assert.equal(git(sibling, 'diff', '--cached'), siblingIndex);
});
test('rejects stale branch, missing message, and clean worktree', async (t) => {
  const { source } = await fixture(t);
  await assert.rejects(commitWorktree(source, 'main', 'wrong'), /branch changed/);
  await assert.rejects(commitWorktree(source, 'feature', '  '), /commit message/);
  await assert.rejects(commitWorktree(source, 'feature', 'empty'), /No changes/);
});
test('push targets the worktree branch even when its upstream points to main', async (t) => {
  const { root, source } = await fixture(t);
  const remote = join(root, '..', 'remote.git');
  git(root, 'init', '--bare', remote);
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-u', 'origin', 'main');
  const main = git(remote, 'rev-parse', 'main');
  git(source, 'branch', '--set-upstream-to=origin/main');
  await writeFile(join(source, 'code.txt'), 'feature');
  const commit = await commitWorktree(source, 'feature', 'Feature');
  await pushWorktree(source, 'feature');
  assert.equal(git(remote, 'rev-parse', 'feature'), commit);
  assert.equal(git(remote, 'rev-parse', 'main'), main);
  assert.equal(git(source, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/feature');
});
test('failed commit keeps changes and does not advance branch', async (t) => {
  const { root, source } = await fixture(t);
  const before = git(source, 'rev-parse', 'HEAD');
  await writeFile(join(source, 'code.txt'), 'feature');
  await writeFile(join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  await assert.rejects(commitWorktree(source, 'feature', 'blocked'));
  assert.equal(git(source, 'rev-parse', 'HEAD'), before);
  assert.equal(await readFile(join(source, 'code.txt'), 'utf8'), 'feature');
});

test('root commit and push includes new files without touching linked worktree changes', async (t) => {
  const { root, source } = await fixture(t);
  const remote = join(root, '..', 'remote.git');
  git(root, 'init', '--bare', remote);
  git(root, 'remote', 'add', 'origin', remote);
  await writeFile(join(root, 'code.txt'), 'root update');
  await writeFile(join(root, 'new.txt'), 'new root file');
  await writeFile(join(source, 'code.txt'), 'work in progress');
  const sourceHead = git(source, 'rev-parse', 'HEAD');
  await commitAndPushRoot(root, 'main', 'Update root');
  assert.equal(git(remote, 'rev-parse', 'main'), git(root, 'rev-parse', 'HEAD'));
  assert.equal(git(root, 'status', '--porcelain'), '');
  assert.equal(git(remote, 'show', 'main:new.txt'), 'new root file');
  assert.equal(git(source, 'rev-parse', 'HEAD'), sourceHead);
  assert.equal(await readFile(join(source, 'code.txt'), 'utf8'), 'work in progress');
});
test('root push failure preserves commit and retry pushes without another commit', async (t) => {
  const { root } = await fixture(t);
  await writeFile(join(root, 'code.txt'), 'root update');
  await assert.rejects(commitAndPushRoot(root, 'main', 'Saved locally'), /Push failed.*local commit is saved/s);
  const saved = git(root, 'rev-parse', 'HEAD');
  assert.equal(git(root, 'log', '-1', '--format=%s'), 'Saved locally');
  const remote = join(root, '..', 'remote.git');
  git(root, 'init', '--bare', remote);
  git(root, 'remote', 'add', 'origin', remote);
  await commitAndPushRoot(root, 'main', '');
  assert.equal(git(remote, 'rev-parse', 'main'), saved);
  assert.equal(git(root, 'rev-parse', 'HEAD'), saved);
});
test('root commit and push rejects stale branches, empty messages, and detached HEAD', async (t) => {
  const { root } = await fixture(t);
  await writeFile(join(root, 'code.txt'), 'root update');
  const before = git(root, 'rev-parse', 'HEAD');
  await assert.rejects(commitAndPushRoot(root, 'other', 'Update'), /branch changed/);
  await assert.rejects(commitAndPushRoot(root, 'main', ' '), /commit message/);
  git(root, 'switch', '--detach');
  await assert.rejects(commitAndPushRoot(root, 'main', 'Update'), /detached/);
  assert.equal(git(root, 'rev-parse', 'HEAD'), before);
});
