import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allDecided, fixPrompt, parseReview, recordFixRequest, reviewSummary, serializeReview, updateFinding } from '../src/shared/review.ts';

const review = () => parseReview(JSON.stringify({
  pr: 265, repo: 'o/r', url: 'u', title: 'Ghissue', head: 'abc', base: 'def', reviewedAt: 't',
  findings: [
    { id: 'D1', kind: 'defect', severity: 'low', title: 'Vendor outage still 500s only for real accounts', file: 'packages/core/src/services/portal-sign-in.service.ts', line: 71, problem: 'The send is unguarded.', exampleFlow: 'Twilio is down.', fix: 'Catch, log, return 200.', ignoreIf: 'never' },
    { id: 'T1', kind: 'item', category: 'tests', title: 'No test covers the cooldown', file: 'packages/core/test/sign-in.test.ts', fields: { Gap: 'cooldown untested', Test: 'add one' } },
  ],
}));

test('the fix prompt carries the finding as written and the working rules', () => {
  const r = review();
  const p = fixPrompt(r, r.findings[0]);
  assert.match(p, /^Fix D1 from the PR 265 review \(Ghissue\) locally, in this worktree\./);
  assert.match(p, /File: packages\/core\/src\/services\/portal-sign-in\.service\.ts:71/);
  assert.match(p, /Problem: The send is unguarded\./);
  assert.match(p, /Suggested fix: Catch, log, return 200\./);
  assert.doesNotMatch(p, /never/);
  assert.match(p, /Do not commit, and do not edit the review file/);
  const item = fixPrompt(r, r.findings[1]);
  assert.match(item, /Gap: cooldown untested/);
  assert.match(item, /Test: add one/);
});

test("the user's own direction rides along and outranks the suggested fix", () => {
  const r = review();
  const p = fixPrompt(r, r.findings[0], '  Use the existing throttle; do not touch the response shape.  ');
  assert.match(p, /Suggested fix: Catch, log, return 200\.\n\nDirection from Mitch, which takes precedence over the suggested fix where they differ:\nUse the existing throttle; do not touch the response shape\.\n\nMake the smallest change/);
  assert.equal(fixPrompt(r, r.findings[0], '   '), fixPrompt(r, r.findings[0]));
  assert.doesNotMatch(fixPrompt(r, r.findings[0]), /Direction from Mitch/);
});

test('a fix request is recorded on its finding and survives a round trip', () => {
  const next = recordFixRequest(review(), 'D1', 'chat-9', '2026-09-21T17:00:00Z');
  assert.deepEqual(next.findings[0].fixRequest, { chatId: 'chat-9', at: '2026-09-21T17:00:00Z' });
  assert.equal(next.findings[1].fixRequest, undefined);
  const again = parseReview(serializeReview(next));
  assert.deepEqual(again.findings[0].fixRequest, { chatId: 'chat-9', at: '2026-09-21T17:00:00Z' });
  assert.equal(again.findings[0].status, 'fixing');
  assert.throws(() => recordFixRequest(review(), 'D9', 'c', 't'), /No finding D9/);
});

test('fixing locally decides the finding: it leaves the undecided count, and undo brings it back', () => {
  const r = review();
  const one = recordFixRequest(r, 'D1', 'chat-9', 't');
  assert.equal(one.findings[0].status, 'fixing');
  assert.equal(allDecided(one), false, 'T1 is still undecided');
  const both = recordFixRequest(one, 'T1', 'chat-9', 't');
  assert.equal(allDecided(both), true);
  assert.equal(reviewSummary(both).pending, 0);
  assert.equal(reviewSummary(both).fixing, 2);
  const undone = updateFinding(both, 'D1', { status: 'pending' });
  assert.equal(undone.findings[0].status, 'pending');
  assert.deepEqual(undone.findings[0].fixRequest, { chatId: 'chat-9', at: 't' }, 'the link to the chat stays');
  assert.throws(() => updateFinding(r, 'D1', { status: 'fixing' }), /Use Fix locally/);
});

test('a queued or posted comment keeps its standing when the fix is also made locally', () => {
  const queued = updateFinding(review(), 'D1', { status: 'approved', comment: 'c' });
  assert.equal(recordFixRequest(queued, 'D1', 'chat-9', 't').findings[0].status, 'approved');
  const ignored = updateFinding(review(), 'D1', { status: 'ignored' });
  assert.equal(recordFixRequest(ignored, 'D1', 'chat-9', 't').findings[0].status, 'fixing', 'ignored was a pass; fixing it is the stronger decision');
});
