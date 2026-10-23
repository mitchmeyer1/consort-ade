import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexEffort, isEffortLevel, parseBuildEffort, roleEffort, turnMoved } from '../src/shared/cliTurnPolicy.ts';

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

test('the planner\'s build effort applies to the build roles unless the scanner pins one', () => {
  assert.equal(roleEffort('implementation', {}, 'xhigh'), 'xhigh');
  assert.equal(roleEffort('coordination', {}, 'high'), 'high');
  assert.equal(roleEffort('reader', {}, 'xhigh'), 'low');
  assert.equal(roleEffort('frontier', {}, 'low'), 'high');
  assert.equal(roleEffort('planning', {}, 'xhigh'), 'medium');
  assert.equal(roleEffort('implementation', { implementation: 'low' }, 'xhigh'), 'low');
  assert.equal(roleEffort('implementation', {}, undefined), 'medium');
});

test('parseBuildEffort reads the marker with or without a reason and ignores unknown levels', () => {
  assert.deepEqual(parseBuildEffort('spec done [build-effort: high — touches billing and the warehouse sync]'), { level: 'high', reason: 'touches billing and the warehouse sync' });
  assert.deepEqual(parseBuildEffort('[build-effort: XHIGH]'), { level: 'xhigh' });
  assert.deepEqual(parseBuildEffort('[build-effort: medium - routine CRUD]'), { level: 'medium', reason: 'routine CRUD' });
  assert.equal(parseBuildEffort('[build-effort: extreme — no]'), undefined);
  assert.equal(parseBuildEffort('no marker here'), undefined);
});

test('a turn that only repeats its markers is not progress, so the stuck guard can fire', () => {
  const built = { stage: "Spec'd", prs: ['https://github.com/a/b/pull/1'], built: true, spec: '.consort/spec.md' };
  assert.equal(turnMoved(built, { ...built, prs: [...built.prs] }, false), false);
  assert.equal(turnMoved(built, { ...built }, true), true);
  assert.equal(turnMoved(built, { ...built, stage: 'Ready to Test' }, false), true);
  assert.equal(turnMoved({ ...built, built: false }, built, false), true);
  assert.equal(turnMoved(built, { ...built, prs: [...built.prs, 'https://github.com/a/b/pull/2'] }, false), true);
  assert.equal(turnMoved(built, { ...built, report: '.consort/report.md', tests: { pass: 3, total: 3 } }, false), true);
});
