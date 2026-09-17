import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatStatus } from '../src/shared/chatStatus.ts';

const chat = (overrides = {}) => ({ phase: 'planning', running: false, messages: [], ...overrides });
test('new chats have no attention dot', () => {
  assert.equal(chatStatus(chat({ phase: 'waiting' })), null);
});
test('running chats are blue, even after an early complete marker', () => {
  assert.equal(chatStatus(chat({ running: true, phase: 'complete' })), 'running');
});
test('permissions, waiting and errors override running or unread completion', () => {
  for (const state of [{ permissions: [{ id: 'permission' }] }, { phase: 'waiting', messages: [{}] }, { error: 'failed' }]) {
    assert.equal(chatStatus(chat({ running: true, unreadCompletion: true, ...state })), 'attention');
  }
});
test('completed chats stay green only until acknowledged', () => {
  const completed = chat({ phase: 'complete', unreadCompletion: true });
  assert.equal(chatStatus(completed), 'complete');
  completed.unreadCompletion = false;
  assert.equal(chatStatus(completed), null);
});
test('resolving the last permission restores running status', () => {
  const pending = chat({ running: true, permissions: [{ id: 'permission' }] });
  assert.equal(chatStatus(pending), 'attention');
  pending.permissions = [];
  assert.equal(chatStatus(pending), 'running');
});

test('initial waiting assessment is running, while a user-input wait still needs attention', () => {
  assert.equal(chatStatus(chat({ phase: 'waiting', running: true, assessingPrompt: true, messages: [{}] })), 'running');
  assert.equal(chatStatus(chat({ phase: 'waiting', running: true, assessingPrompt: false, messages: [{}] })), 'attention');
});
