import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { commitWorktree, pushWorktree } from '../src/main/git.ts';

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
