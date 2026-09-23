import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_MARKS, hasRollup, rollupLabel, rollupStatus } from '../src/shared/statusRollup.ts';

const chat = (overrides = {}) => ({ phase: 'planning', running: false, messages: [], ...overrides });
const procs = (over = {}) => ({ running: new Set(), failed: new Set(), done: new Set(), ...over });

test('a collapsed project counts each chat mark among its children', () => {
  const r = rollupStatus([
    chat({ running: true }),
    chat({ running: true }),
    chat({ error: 'boom' }),
    chat({ phase: 'complete', unreadCompletion: true }),
    chat({ phase: 'complete' }),
  ], [], procs());
  assert.deepEqual(r.chats, { running: 2, attention: 1, complete: 1 });
  assert.equal(hasRollup(r), true);
});

test('quiet children leave nothing to bubble up', () => {
  const r = rollupStatus([chat(), chat({ phase: 'complete' })], ['wt1'], procs());
  assert.deepEqual(r.chats, {});
  assert.equal(r.running, false);
  assert.equal(hasRollup(r), false);
});

test('process dots fold across every child scope with the row precedence', () => {
  const ids = ['wt1', 'wt2', 'wt3'];
  assert.equal(rollupStatus([], ids, procs({ done: new Set(['wt3']) })).done, true);
  const mixed = rollupStatus([], ids, procs({ running: new Set(['wt1']), done: new Set(['wt3']) }));
  assert.equal(mixed.running, true);
  assert.equal(mixed.done, false, 'a finished mark hides while something still runs');
  const failed = rollupStatus([], ids, procs({ failed: new Set(['wt2']), done: new Set(['wt3']) }));
  assert.equal(failed.failed, true);
  assert.equal(failed.done, false);
  assert.equal(rollupStatus([], ids, procs({ running: new Set(['other']) })).running, false, 'scopes outside the project do not count');
});

test('reminders split into due and scheduled by the clock', () => {
  const now = 1_000_000;
  const r = rollupStatus([chat({ remindAt: now - 1 }), chat({ remindAt: now + 1 })], [], procs(), now);
  assert.deepEqual(r.chats, { reminder: 1, scheduled: 1 });
});

test('labels read naturally for one or many', () => {
  assert.equal(rollupLabel('attention', 1), '1 chat needs attention');
  assert.equal(rollupLabel('attention', 2), '2 chats need attention');
  assert.equal(rollupLabel('running', 3), '3 chats running');
  assert.equal(rollupLabel('complete', 1), '1 chat finished');
  assert.equal(rollupLabel('reminder', 2), '2 reminders due');
  assert.equal(rollupLabel('scheduled', 1), '1 reminder scheduled');
  assert.deepEqual(CHAT_MARKS, ['attention', 'running', 'complete', 'reminder', 'scheduled']);
});
