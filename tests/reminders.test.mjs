import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REMINDER_CHOICES, reminderDue, reminderLabel, tomorrowMorning } from '../src/shared/reminders.ts';

const NOON = new Date(2026, 8, 17, 12, 0, 0).getTime();

test('the menu offers now through tomorrow morning', () => {
  assert.deepEqual(REMINDER_CHOICES.map((c) => c.id), ['now', '30m', '1h', '3h', '6h', 'tomorrow']);
  const due = Object.fromEntries(REMINDER_CHOICES.map((c) => [c.id, c.due(NOON)]));
  assert.equal(due.now, NOON);
  assert.equal(due['30m'], NOON + 30 * 60_000);
  assert.equal(due['1h'], NOON + 3_600_000);
  assert.equal(due['3h'], NOON + 3 * 3_600_000);
  assert.equal(due['6h'], NOON + 6 * 3_600_000);
});

test('tomorrow means 9am the next day, however late it is now', () => {
  for (const hour of [0, 8, 12, 23]) {
    const now = new Date(2026, 8, 17, hour, 30).getTime();
    const at = new Date(tomorrowMorning(now));
    assert.equal(at.getDate(), 18);
    assert.equal(at.getHours(), 9);
    assert.equal(at.getMinutes(), 0);
    assert.ok(at.getTime() > now);
  }
});

test('tomorrow rolls over a month boundary', () => {
  const at = new Date(tomorrowMorning(new Date(2026, 8, 30, 22, 0).getTime()));
  assert.equal(at.getMonth(), 9);
  assert.equal(at.getDate(), 1);
});

test('a reminder is due from its time onward, and never without one', () => {
  assert.equal(reminderDue(NOON, NOON), true, 'due exactly on time');
  assert.equal(reminderDue(NOON, NOON + 1), true);
  assert.equal(reminderDue(NOON + 1, NOON), false);
  assert.equal(reminderDue(undefined, NOON), false);
});

test('the tooltip counts down before the time and counts up after it', () => {
  assert.match(reminderLabel(NOON + 30 * 60_000, NOON), /^Reminder in 30m · /);
  assert.match(reminderLabel(NOON + 3 * 3_600_000, NOON), /^Reminder at /);
  assert.match(reminderLabel(tomorrowMorning(NOON), NOON), /^Reminder at tomorrow at /);
  assert.equal(reminderLabel(NOON, NOON), 'Reminder · just now');
  assert.equal(reminderLabel(NOON - 45 * 60_000, NOON), 'Reminder · 45m ago');
  assert.equal(reminderLabel(NOON - 3 * 3_600_000, NOON), 'Reminder · 3h ago');
  assert.equal(reminderLabel(NOON - 50 * 3_600_000, NOON), 'Reminder · 2d ago');
});
