import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ensureRootWorktree, isRootWorktree } from '../src/main/rootWorktree.ts';

const project = { id: 'project', name: 'Example', path: '/example', defaultBase: 'main' };
test('reopening Root reuses its ID, retains chat associations, and unarchives it', () => {
  const worktrees = [];
  const root = ensureRootWorktree(worktrees, project, 'main');
  const chat = { worktreeId: root.id };
  root.archived = true;
  const reopened = ensureRootWorktree(worktrees, project, 'feature');
  assert.equal(worktrees.length, 1);
  assert.equal(reopened.id, chat.worktreeId);
  assert.equal(reopened.branch, 'feature');
  assert.equal(reopened.archived, false);
  assert.equal(reopened.title, 'Root');
  const restored = JSON.parse(JSON.stringify(worktrees));
  assert.equal(ensureRootWorktree(restored, project, 'main').id, chat.worktreeId);
});
test('root protection also recognizes unmarked entries pointing to the project directory', () => {
  const root = ensureRootWorktree([], project, 'main');
  assert.equal(isRootWorktree({ ...root, root: undefined }, project), true);
  assert.equal(isRootWorktree({ ...root, root: undefined, path: '/example-wt/feature' }, project), false);
});
test('opening Root leaves Git branches, worktrees, HEAD, and uncommitted files unchanged', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'consort-root-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  await writeFile(join(dir, 'file.txt'), 'original');
  git('add', '.');
  git('commit', '-m', 'initial');
  await writeFile(join(dir, 'file.txt'), 'in progress');
  const snapshot = () => [git('worktree', 'list', '--porcelain'), git('show-ref'), git('status', '--porcelain'), git('diff')];
  const before = snapshot();
  const root = ensureRootWorktree([], { ...project, path: dir }, 'main');
  assert.equal(root.path, dir);
  assert.deepEqual(snapshot(), before);
});
