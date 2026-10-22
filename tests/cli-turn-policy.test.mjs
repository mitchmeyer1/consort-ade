import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexEffort, isEffortLevel, roleEffort } from '../src/shared/cliTurnPolicy.ts';

test('effort follows the role unless the scanner sets it', () => {
  assert.equal(roleEffort('reader'), 'low');
  assert.equal(roleEffort('frontier'), 'high');
  for (const role of ['planning', 'implementation', 'coordination']) assert.equal(roleEffort(role), 'medium');
  assert.equal(roleEffort('planning', { planning: 'xhigh' }), 'xhigh');
  assert.equal(roleEffort('reader', { planning: 'xhigh' }), 'low');
});

test('Codex runs xhigh where Claude runs max; other levels pass through', () => {
  assert.equal(codexEffort('max'), 'xhigh');
  assert.equal(codexEffort('low'), 'low');
  assert.ok(isEffortLevel('xhigh'));
  assert.ok(!isEffortLevel('extreme'));
});
