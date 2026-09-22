import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateQuickActions } from '../src/shared/quickActions.ts';

const project = (id) => ({ id, name: id, path: `/${id}`, defaultBase: 'origin/main' });
const wt = (id, projectId, quickActions) => ({ id, projectId, name: id, title: id, path: `/${projectId}/${id}`, branch: id, archived: false, ...(quickActions ? { quickActions } : {}) });

test('worktree actions move to their project, deduplicated, keeping a pin from any copy', () => {
  const projects = [project('ade'), project('other')];
  const build = { id: 'a1', title: 'BUILD', command: 'pnpm package:mac' };
  const worktrees = [
    wt('root', 'ade', [build, { id: 'a2', title: 'TEST', command: 'pnpm test' }]),
    wt('feature', 'ade', [{ ...build, id: 'a3', pinned: true }]),
    wt('main', 'other', [{ id: 'b1', title: 'BUILD', command: 'make' }]),
    wt('plain', 'ade'),
  ];
  const moved = migrateQuickActions(projects, worktrees);
  assert.equal(moved, 3);
  assert.deepEqual(projects[0].quickActions.map((a) => [a.title, a.command, !!a.pinned]), [['BUILD', 'pnpm package:mac', true], ['TEST', 'pnpm test', false]]);
  assert.deepEqual(projects[1].quickActions.map((a) => a.title), ['BUILD']);
  for (const w of worktrees) assert.equal('quickActions' in w, false);
});

test('a worktree whose project is gone just drops its actions; a second load is a no-op', () => {
  const projects = [project('ade')];
  const worktrees = [wt('orphan', 'missing', [{ id: 'x', title: 'X', command: 'x' }])];
  assert.equal(migrateQuickActions(projects, worktrees), 0);
  assert.equal(projects[0].quickActions, undefined);
  assert.equal(migrateQuickActions(projects, worktrees), 0);
});
