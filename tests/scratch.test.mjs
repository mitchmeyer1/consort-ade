import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isScratch, scratchChats, scratchWorktree } from '../src/shared/scratch.ts';
import { recentWorktrees } from '../src/shared/conversationOrder.ts';

const wt = (id, extra = {}) => ({ id, projectId: 'p', name: id, title: id, path: `/repo/${id}`, branch: 'main', archived: false, ...extra });
const chat = (id, worktreeId) => ({ id, worktreeId, name: id, provider: 'claude', keyId: 'k', model: 'm', phase: 'waiting', autoApprove: false, running: false, messages: [] });

test('a scratch worktree has no project, no branch, and is flagged for the sidebar', () => {
  const w = scratchWorktree('c1', '/data/chats/c1', 'Grocery plan');
  assert.deepEqual(w, { id: 'c1', projectId: '', name: 'Grocery plan', title: 'Grocery plan', path: '/data/chats/c1', branch: '', archived: false, scratch: true });
  assert.equal(isScratch(w), true);
  assert.equal(isScratch(wt('feature')), false);
  assert.equal(isScratch(undefined), false);
});

test('the CHATS section lists only chats on scratch worktrees', () => {
  const state = {
    worktrees: [wt('feature'), scratchWorktree('s1', '/data/chats/s1'), scratchWorktree('s2', '/data/chats/s2')],
    chats: [chat('a', 'feature'), chat('b', 's1'), chat('c', 's2'), chat('d', 'missing')],
  };
  assert.deepEqual(scratchChats(state).map((c) => c.id), ['b', 'c']);
  assert.deepEqual(scratchChats({ worktrees: [wt('feature')], chats: [chat('a', 'feature')] }), []);
});

test('scratch worktrees never surface in a project list', () => {
  const project = [wt('feature'), wt('root', { root: true })];
  const listed = recentWorktrees(project.filter((w) => w.projectId === 'p'), []);
  assert.deepEqual(listed.map((w) => w.id), ['root', 'feature']);
  assert.equal(scratchWorktree('s1', '/x').projectId, '');
});
