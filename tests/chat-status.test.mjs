import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatStatus } from '../src/shared/chatStatus.ts';
import { recoverBenignCodexFailure } from '../src/shared/codexDiagnostics.ts';

const chat = (overrides = {}) => ({ phase: 'planning', running: false, messages: [], ...overrides });
test('new chats have no attention dot', () => {
  assert.equal(chatStatus(chat({ phase: 'waiting' })), null);
});
test('running chats are blue, even after an early complete marker', () => {
  assert.equal(chatStatus(chat({ running: true, phase: 'complete' })), 'running');
});
test('only permission requests override a running chat', () => {
  assert.equal(chatStatus(chat({ running: true, permissions: [{ id: 'permission' }] })), 'attention');
  assert.equal(chatStatus(chat({ running: true, phase: 'waiting', messages: [{}] })), 'running');
  assert.equal(chatStatus(chat({ running: true, error: 'failed' })), 'running');
});
test('waiting and errors need attention after the process stops', () => {
  assert.equal(chatStatus(chat({ phase: 'waiting', messages: [{}] })), 'attention');
  assert.equal(chatStatus(chat({ error: 'failed' })), 'attention');
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

test('all waiting states stay blue while running', () => {
  assert.equal(chatStatus(chat({ phase: 'waiting', running: true, assessingPrompt: true, messages: [{}] })), 'running');
  assert.equal(chatStatus(chat({ phase: 'waiting', running: true, assessingPrompt: false, messages: [{}] })), 'running');
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

test('persisted Codex skill-budget failures recover as unread completions', () => {
  const completed = chat({
    provider: 'codex', phase: 'complete', error: 'Skill descriptions were shortened to fit the skills context budget.',
    interrupted: true, unreadCompletion: false, queuePaused: true,
  });
  assert.equal(recoverBenignCodexFailure(completed), true);
  assert.equal(completed.error, undefined);
  assert.equal(completed.interrupted, undefined);
  assert.equal(completed.unreadCompletion, true);
  assert.equal(completed.queuePaused, false);
  assert.equal(chatStatus(completed), 'complete');
});
