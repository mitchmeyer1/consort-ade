import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { addWorktree, removeWorktree } from '../src/main/git.ts';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const exists = (p) => access(p).then(() => true, () => false);

test('removing a worktree works for a real checkout and for a folder git never registered', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'consort-remove-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(root, 'code.txt'), 'initial');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initial');

  // a registered worktree with local edits: removed through git, force included
  const real = await addWorktree(root, 'feature-one', 'feature/one', 'main');
  await writeFile(join(real, 'code.txt'), 'edited');
  await removeWorktree(root, real);
  assert.equal(await exists(real), false);
  assert.equal(git(root, 'worktree', 'list').split('\n').length, 1);

  // a folder from a creation that failed part-way: not a worktree, so git refuses, and it is deleted outright instead
  const stray = join(root, '.consort-worktrees', 'half-made');
  await mkdir(join(stray, '.husky'), { recursive: true });
  await removeWorktree(root, stray);
  assert.equal(await exists(stray), false);

  // a path that is gone already is not an error either
  await removeWorktree(root, stray);
});

test('git errors carry git\'s own reason, not just the command line', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'consort-remove-err-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // not a repository at all: git cannot even list worktrees, so nothing is deleted and the error is git's own words
  await mkdir(join(root, 'thing'));
  await assert.rejects(removeWorktree(root, join(root, 'thing')), /git worktree remove: fatal: not a git repository/);
  assert.equal(await exists(join(root, 'thing')), true, 'the folder is untouched');
});
