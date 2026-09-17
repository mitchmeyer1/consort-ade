import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { rootBranches, switchRootBranch } from '../src/main/git.ts';

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


test('lists branches, marks occupied branches, and switches root without changing siblings', async (t) => {
  const { root, source } = await fixture(t);
  git(root, 'branch', 'other');
  const choices = await rootBranches(root);
  assert.equal(choices.current, 'main');
  assert.equal(choices.branches.find((b) => b.name === 'feature').occupied, await realpath(source));
  await assert.rejects(switchRootBranch(root, 'main', 'refs/heads/feature'), /checked out/);
  await writeFile(join(source, 'code.txt'), 'sibling work');
  const result = await switchRootBranch(root, 'main', 'refs/heads/other');
  assert.equal(result.branch, 'other');
  assert.equal(await readFile(join(source, 'code.txt'), 'utf8'), 'sibling work');
  assert.equal(git(source, 'branch', '--show-current'), 'feature');
});
test('rejects dirty root, stale state, and missing branches without changing files', async (t) => {
  const { root } = await fixture(t);
  git(root, 'branch', 'other');
  await writeFile(join(root, 'code.txt'), 'unsaved');
  await assert.rejects(switchRootBranch(root, 'main', 'refs/heads/other'), /Commit or stash/);
  assert.equal(await readFile(join(root, 'code.txt'), 'utf8'), 'unsaved');
  await assert.rejects(switchRootBranch(root, 'wrong', 'refs/heads/other'), /branch changed/);
  await assert.rejects(switchRootBranch(root, 'main', 'refs/heads/missing'), /no longer exists/);
  assert.equal(git(root, 'branch', '--show-current'), 'main');
});
test('checks out remote-only branches with tracking and supports detached root', async (t) => {
  const { root } = await fixture(t);
  const remote = join(root, '..', 'remote.git');
  git(root, 'init', '--bare', remote);
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', 'origin', 'main:remote-only');
  git(root, 'fetch', 'origin');
  assert.ok((await rootBranches(root)).branches.some((b) => b.ref === 'refs/remotes/origin/remote-only'));
  await switchRootBranch(root, 'main', 'refs/remotes/origin/remote-only');
  assert.equal(git(root, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/remote-only');
  git(root, 'switch', '--detach');
  assert.equal((await rootBranches(root)).current, null);
  await switchRootBranch(root, null, 'refs/heads/main');
  assert.equal(git(root, 'branch', '--show-current'), 'main');
});

test('lists local branches once and preserves their upstream when switching', async (t) => {
  const { root } = await fixture(t);
  const remote = join(root, '..', 'remote.git');
  git(root, 'init', '--bare', remote);
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-u', 'origin', 'main');
  git(root, 'branch', 'main-2');
  git(root, 'push', '-u', 'origin', 'main-2');
  const choices = await rootBranches(root);
  assert.deepEqual(choices.branches.filter((b) => b.name.includes('main')).map((b) => b.name), ['main', 'main-2']);
  await switchRootBranch(root, 'main', 'refs/heads/main-2');
  assert.equal(git(root, 'branch', '--show-current'), 'main-2');
  assert.equal(git(root, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/main-2');
  git(root, 'branch', '-m', 'main-2', 'renamed');
  const renamed = await rootBranches(root);
  assert.ok(renamed.branches.some((b) => b.name === 'renamed'));
  assert.ok(!renamed.branches.some((b) => b.ref === 'refs/remotes/origin/main-2'));
});
