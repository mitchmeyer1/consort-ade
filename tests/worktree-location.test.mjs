import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { addWorktree } from '../src/main/git.ts';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
test('new worktrees live inside the project and remain ignored across branches', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'consort-location-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(root, 'code.txt'), 'initial');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initial');
  const exclude = join(root, '.git', 'info', 'exclude');
  await writeFile(exclude, '# existing rule\nlocal-only');
  const first = await addWorktree(root, 'feature-one', 'feature/one', 'main');
  assert.equal(first, join(root, '.consort-worktrees', 'feature-one'));
  assert.equal(git(first, 'branch', '--show-current'), 'feature/one');
  assert.equal(git(root, 'check-ignore', '.consort-worktrees/feature-one'), '.consort-worktrees/feature-one');
  assert.equal(git(root, 'status', '--porcelain'), '');
  git(root, 'branch', 'existing');
  const second = await addWorktree(root, 'feature-two', 'existing', 'main');
  assert.equal(git(second, 'branch', '--show-current'), 'existing');
  assert.equal(await readFile(exclude, 'utf8'), '# existing rule\nlocal-only\n/.consort-worktrees/\n');
  git(root, 'switch', '-c', 'another-root-branch');
  assert.equal(git(root, 'status', '--porcelain'), '');
  for (const name of ['', '.', '..', '../escape', join(root, 'outside')]) {
    await assert.rejects(addWorktree(root, name, 'invalid', 'main'), /inside .consort-worktrees/);
  }
});
