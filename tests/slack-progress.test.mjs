import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slackProgress, slackStatus, STATUS_TAIL } from '../src/shared/headless.ts';

const task = (over = {}) => ({ status: 'working', envReadyAt: 1, reviewsDone: 0, feature: { stage: 'Implementing', built: false }, ...over });

test('the tracker ticks finished steps, bolds the current one, and shows build tickets with a bar', () => {
  assert.equal(slackProgress(task(), { done: 10, total: 18 }), '✓ Env · ✓ Grill · ▶ *Build 10/18* ▰▰▰▰▰▰▱▱▱▱ · ○ Test · ○ Review · ○ Evidence · ○ PR');
  assert.equal(slackProgress(task({ envReadyAt: undefined, feature: { stage: 'Grilling' } })), '▶ *Env* · ○ Grill · ○ Build · ○ Test · ○ Review · ○ Evidence · ○ PR');
  assert.equal(slackProgress(task(), undefined).split(' · ')[2], '▶ *Build*', 'no tickets yet: no count');
});

test('reviews fold into one step and count rounds; a finished task is all ticks', () => {
  assert.equal(slackProgress(task({ reviewsDone: 1, feature: { stage: 'In Review', built: true } })), '✓ Env · ✓ Grill · ✓ Build · ✓ Test · ▶ *Review 2/3* · ○ Evidence · ○ PR');
  assert.equal(slackProgress(task({ status: 'monitoring', reviewsDone: 3, feature: { stage: 'In Review', built: true, evidenceAt: 1 } })), '✓ Env · ✓ Grill · ✓ Build · ✓ Test · ✓ Review · ✓ Evidence · ▶ *PR*');
  assert.equal(slackProgress(task({ status: 'ready', feature: { stage: 'In Review', built: true } })), '✓ Env · ✓ Grill · ✓ Build · ✓ Test · ✓ Review · ✓ Evidence · ✓ PR');
});

test('the tracker sits under STATUS, and re-wrapping a post keeps exactly one', () => {
  const links = { ticket: 'https://t/1', progress: '✓ Env · ▶ *Grill*' };
  const once = slackStatus('✅ Working on it', 'RUNNING', links);
  assert.match(once, /\n\nSTATUS: RUNNING\n✓ Env · ▶ \*Grill\*$/);
  assert.ok(STATUS_TAIL.test(once));
  const again = slackStatus(once, 'WAITING', { ticket: 'https://t/1', progress: '✓ Env · ✓ Grill · ▶ *Build*' });
  assert.match(again, /\n\nSTATUS: WAITING\n✓ Env · ✓ Grill · ▶ \*Build\*$/);
  assert.equal(again.match(/STATUS:/g).length, 1);
  assert.match(slackStatus(once), /STATUS: RUNNING\n✓ Env · ▶ \*Grill\*$/, 'kept when re-wrapped without links');
});
