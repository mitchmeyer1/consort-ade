import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  completeFeatureItems, FEATURE_CLEAR_MARKER, FEATURE_DONE_MARKER, FEATURE_MARKER, FEATURE_NOW_MARKER, FEATURE_PROMPT,
  featureComplete, featureStages, featureSummary, focusFeatureItem, parseFeature, startFeature,
} from '../src/shared/featureProgress.ts';

const T = 1_000_000;
const state = (stages) => stages.map((s) => s.state);

test('a feature line is a title and at least two items, numbering and checkboxes stripped', () => {
  assert.deepEqual(parseFeature('Roster sync | 1. Schema | [ ] Cron job | [x] Admin page'), { title: 'Roster sync', items: ['Schema', 'Cron job', 'Admin page'] });
  assert.equal(parseFeature('Roster sync | only one'), null);
  assert.equal(parseFeature(' | a | b'), null);
});

test('the markers match the way the agent is told to write them and strip cleanly', () => {
  const text = 'Big job.\n[feature: HRIS plan | schema | cron | admin]\n[feature-done: 1]\nWorking.\n[feature-now:3]\n[feature-clear]\nBye.';
  assert.deepEqual([...text.matchAll(FEATURE_MARKER)].map((m) => m[1].trim()), ['HRIS plan | schema | cron | admin']);
  assert.deepEqual([...text.matchAll(FEATURE_DONE_MARKER)].map((m) => m[1].trim()), ['1']);
  assert.deepEqual([...text.matchAll(FEATURE_NOW_MARKER)].map((m) => m[1]), ['3']);
  assert.equal(text.replace(FEATURE_MARKER, '').replace(FEATURE_DONE_MARKER, '').replace(FEATURE_NOW_MARKER, '').replace(FEATURE_CLEAR_MARKER, '').includes('['), false);
  assert.match(FEATURE_PROMPT, /\[feature: short title \| item \| item/);
  assert.match(FEATURE_PROMPT, /Do not declare one for a self-contained task/);
});

test('items tick by number, in any order, and the card shows what is done and what is live', () => {
  let f = startFeature(parseFeature('Plan | one | two | three | four'), undefined, T);
  assert.deepEqual(state(featureStages({ feature: f, running: true })), ['active', 'pending', 'pending', 'pending']);
  f = completeFeatureItems(f, '3, 1', T + 5);
  assert.deepEqual(state(featureStages({ feature: f, running: true })), ['done', 'active', 'done', 'pending']);
  assert.deepEqual(state(featureStages({ feature: f, running: false })), ['done', 'pending', 'done', 'pending']);
  f = focusFeatureItem(f, 4);
  assert.deepEqual(state(featureStages({ feature: f, running: true })), ['done', 'pending', 'done', 'active']);
  assert.equal(completeFeatureItems(f, '9, x').items.filter((i) => i.doneAt).length, 2, 'unknown numbers are ignored');
  assert.equal(featureComplete(f), false);
  assert.equal(featureComplete(completeFeatureItems(f, '2 4', T + 9)), true);
});

test('redeclaring the feature keeps the ticks of items that carry over by name', () => {
  const first = completeFeatureItems(startFeature(parseFeature('Plan | Schema | Cron | Admin'), undefined, T), '1', T + 1);
  const next = startFeature(parseFeature('Plan v2 | schema | Cron | Admin | Docs'), first, T + 2);
  assert.deepEqual(next.items.map((i) => i.doneAt !== undefined), [true, false, false, false]);
  assert.equal(next.title, 'Plan v2');
});

test('the per-turn reminder lists every item with its state and how to update it', () => {
  const f = completeFeatureItems(startFeature(parseFeature('Plan | Schema | Cron'), undefined, T), '1', T);
  const text = featureSummary(f);
  assert.match(text, /Plan \(1\/2 done\)/);
  assert.match(text, /1\. \[x\] Schema\n2\. \[ \] Cron/);
  assert.match(text, /\[feature-done: N\]/);
  assert.equal(featureStages({ feature: undefined, running: true }), null);
});
