import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recentChats, recentWorktrees } from '../src/shared/conversationOrder.ts';

const chat = (id, worktreeId, ts) => ({ id, worktreeId, messages: ts ? [{ role: 'user', ts }] : [] });
test('Root stays first; other workspaces use their most recently chatted-with conversation', () => {
  const worktrees = [{ id: 'old' }, { id: 'root', root: true }, { id: 'new' }, { id: 'empty' }];
  const chats = [chat('a', 'old', 10), chat('b', 'new', 5), chat('c', 'new', 20)];
  assert.deepEqual(recentWorktrees(worktrees, chats).map(w => w.id), ['root', 'new', 'old', 'empty']);
  assert.equal(worktrees[0].id, 'old');
});
test('chats sort by user activity, including queued submissions, without jumping on assistant output', () => {
  const chats = [chat('old', 'wt', 10), chat('new', 'wt', 20), chat('queued', 'wt', 1), chat('empty', 'wt')];
  chats[0].messages.push({ role: 'assistant', ts: 100 }, { role: 'system', ts: 200 });
  chats[2].lastChattedAt = 30;
  assert.deepEqual(recentChats(chats).map(c => c.id), ['queued', 'new', 'old', 'empty']);
  assert.equal(chats[0].id, 'old');
  chats[1].messages.push({ role: 'user', ts: 40 });
  assert.equal(recentChats(chats)[0].id, 'new');
});
test('equal timestamps and empty conversations retain their existing order', () => {
  const chats = [chat('a', 'one', 10), chat('b', 'two', 10), chat('c', 'three')];
  assert.deepEqual(recentChats(chats).map(c => c.id), ['a', 'b', 'c']);
  assert.deepEqual(recentWorktrees([{id:'two'}, {id:'one'}, {id:'three'}], chats).map(w => w.id), ['two', 'one', 'three']);
});
