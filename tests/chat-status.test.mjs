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

test('a reminder shows only while the chat has nothing else to report', () => {
  const past = Date.now() - 1000;
  assert.equal(chatStatus(chat({ remindAt: past })), 'reminder');
  // anything the chat itself is reporting outranks a mark you set yourself
  assert.equal(chatStatus(chat({ remindAt: past, running: true })), 'running');
  assert.equal(chatStatus(chat({ remindAt: past, unreadCompletion: true })), 'complete');
  assert.equal(chatStatus(chat({ remindAt: past, error: 'failed' })), 'attention');
});
test('a reminder outlives acknowledging the completion, and clearing it drops the dot', () => {
  const reminded = chat({ remindAt: Date.now() - 1000, phase: 'complete', unreadCompletion: true });
  reminded.unreadCompletion = false;
  assert.equal(chatStatus(reminded), 'reminder');
  reminded.remindAt = undefined;
  assert.equal(chatStatus(reminded), null);
});
test('a reminder set for later shows as scheduled until its time comes', () => {
  const now = Date.now();
  const later = chat({ remindAt: now + 30 * 60_000 });
  assert.equal(chatStatus(later, now), 'scheduled');
  assert.equal(chatStatus(later, now + 29 * 60_000), 'scheduled');
  assert.equal(chatStatus(later, now + 30 * 60_000), 'reminder');
});
