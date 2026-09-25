import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvedBy, whoseTurn } from '../src/shared/prTurn.ts';

const pr = (over = {}) => ({ author: { login: 'wnstck' }, reviewRequests: [], reviews: [], comments: [], commits: [], ...over });

test('a PR you neither wrote nor touched is not yours', () => {
  assert.deepEqual(whoseTurn(pr(), 'mitch'), { mine: false, role: null, turn: null, why: '', approved: false });
});

test('a pending review request is always your turn', () => {
  const t = whoseTurn(pr({ reviewRequests: [{ login: 'mitch' }], reviews: [{ author: { login: 'mitch' }, submittedAt: '2026-09-21T10:00:00Z', state: 'COMMENTED' }] }), 'mitch');
  assert.equal(t.turn, 'yours'); assert.equal(t.role, 'reviewer'); assert.equal(t.why, 'review requested');
});

test('as author with nobody acting yet, you wait on reviewers', () => {
  const t = whoseTurn(pr(), 'wnstck');
  assert.deepEqual(t, { mine: true, role: 'author', turn: 'theirs', why: 'waiting on reviewers', approved: false });
});

test('the last actor decides: their review makes it your turn, your comment makes it theirs', () => {
  const reviewed = pr({ reviews: [{ author: { login: 'mitch' }, submittedAt: '2026-09-21T10:00:00Z', state: 'CHANGES_REQUESTED' }] });
  assert.deepEqual(whoseTurn(reviewed, 'wnstck'), { mine: true, role: 'author', turn: 'yours', why: 'mitch changes requested', approved: false });
  const replied = pr({ reviews: reviewed.reviews, comments: [{ author: { login: 'wnstck' }, createdAt: '2026-09-21T11:00:00Z' }] });
  assert.deepEqual(whoseTurn(replied, 'wnstck'), { mine: true, role: 'author', turn: 'theirs', why: 'you commented last', approved: false });
  assert.deepEqual(whoseTurn(replied, 'mitch'), { mine: true, role: 'reviewer', turn: 'yours', why: 'wnstck commented', approved: false });
});

test('a push after your review hands the turn back to you', () => {
  const t = whoseTurn(pr({
    reviews: [{ author: { login: 'mitch' }, submittedAt: '2026-09-21T10:00:00Z', state: 'APPROVED' }],
    commits: [{ committedDate: '2026-09-21T12:00:00Z', authors: [{ login: 'wnstck' }] }],
  }), 'mitch');
  assert.deepEqual(t, { mine: true, role: 'reviewer', turn: 'yours', why: 'wnstck pushed', approved: true });
});

test('bots do not take turns', () => {
  const t = whoseTurn(pr({
    reviews: [{ author: { login: 'mitch' }, submittedAt: '2026-09-21T10:00:00Z', state: 'COMMENTED' }],
    comments: [{ author: { login: 'github-actions' }, createdAt: '2026-09-21T13:00:00Z' }, { author: { login: 'claude' }, createdAt: '2026-09-21T13:00:00Z' }],
  }), 'mitch');
  assert.equal(t.turn, 'theirs'); assert.equal(t.why, 'you commented last');
});

test('your approval shows as long as your latest verdict is still an approval', () => {
  const at = (h) => `2026-09-21T${String(h).padStart(2, '0')}:00:00Z`;
  const review = (login, state, h) => ({ author: { login }, submittedAt: at(h), state });
  const approvedThenPushed = pr({ reviews: [review('mitch', 'APPROVED', 9)], commits: [{ committedDate: at(10), authors: [{ login: 'wnstck' }] }] });
  const t = whoseTurn(approvedThenPushed, 'mitch');
  assert.equal(t.turn, 'yours', 'their push hands the turn back');
  assert.equal(t.approved, true, 'but the approval still stands');
  assert.equal(approvedBy(pr({ reviews: [review('mitch', 'APPROVED', 9), review('mitch', 'COMMENTED', 11)] }), 'mitch'), true, 'a later comment does not withdraw it');
  assert.equal(approvedBy(pr({ reviews: [review('mitch', 'APPROVED', 9), review('mitch', 'CHANGES_REQUESTED', 11)] }), 'mitch'), false, 'a later change request does');
  assert.equal(approvedBy(pr({ reviews: [review('mitch', 'APPROVED', 9), review('mitch', 'DISMISSED', 11)] }), 'mitch'), false, 'so does a dismissal');
  assert.equal(approvedBy(pr({ reviews: [review('someone', 'APPROVED', 9)] }), 'mitch'), false, 'only your own review counts');
  assert.equal(whoseTurn(approvedThenPushed, 'other').approved, false);
});
