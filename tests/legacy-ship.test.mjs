import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateLegacyShip } from '../src/shared/legacyShip.ts';

const wt = (id, extra = {}) => ({ id, projectId: 'p', name: id, title: id, path: `/repo/${id}`, branch: 'main', archived: false, ...extra });
const chat = (id, worktreeId, extra = {}) => ({ id, worktreeId, name: id, provider: 'claude', keyId: 'k', model: 'm', phase: 'waiting', autoApprove: false, running: false, messages: [], ...extra });

test('chats on the old shared /ship worktree come back as ordinary chats', () => {
  const worktrees = [wt('board', { ship: true, scratch: true })];
  const chats = [chat('a', 'board', { ship: { action: 'build' } }), chat('b', 'board', { ship: { action: 'review', turns: 3 } })];
  assert.equal(migrateLegacyShip(worktrees, chats), 2);
  assert.equal('ship' in worktrees[0], false);
  assert.equal(worktrees[0].scratch, true);
  assert.deepEqual(chats.map((c) => 'ship' in c), [false, false]);
  assert.equal(chats[0].messages.length, 0);
});

test('feature worktrees and their ship chats are left alone', () => {
  const feature = { ticket: 'T-1', slug: 'thing', stage: 'build' };
  const worktrees = [wt('f', { ship: feature }), wt('plain')];
  const chats = [chat('a', 'f', { ship: { action: 'build' } }), chat('b', 'plain')];
  assert.equal(migrateLegacyShip(worktrees, chats), 0);
  assert.equal(worktrees[0].ship, feature);
  assert.deepEqual(chats[0].ship, { action: 'build' });
});

test('running it again changes nothing', () => {
  const worktrees = [wt('board', { ship: true })];
  const chats = [chat('a', 'board', { ship: { action: 'build' } })];
  migrateLegacyShip(worktrees, chats);
  assert.equal(migrateLegacyShip(worktrees, chats), 0);
});
