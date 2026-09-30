import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planReminder } from '../src/shared/processContext.ts';

test('a resumed turn is told which plan step it was on, and not to redeclare the plan', () => {
  const plan = { steps: [{ label: 'read the store', doneAt: 1 }, { label: 'add the field', startedAt: 2 }, { label: 'run the tests' }], current: 1, ts: 1 };
  const text = planReminder(plan);
  assert.match(text, /1\. \[x\] read the store/);
  assert.match(text, /2\. \[>\] add the field/);
  assert.match(text, /3\. \[ \] run the tests/);
  assert.match(text, /Continue from step 2 \(add the field\)/);
  assert.match(text, /\[plan: read the store \| add the field \| run the tests\]/);
  assert.match(text, /\[step:2\]/);
  assert.equal(planReminder(undefined), '');
  assert.equal(planReminder({ steps: [{ label: 'a', doneAt: 1 }], current: 0, ts: 1 }), '', 'a finished plan needs no reminder');
});
