import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whoseTurn } from '../src/shared/prTurn.ts';

const pr = (over = {}) => ({ author: { login: 'wnstck' }, reviewRequests: [], reviews: [], comments: [], commits: [], ...over });

test('a PR you neither wrote nor touched is not yours', () => {
  assert.deepEqual(whoseTurn(pr(), 'mitch'), { mine: false, role: null, turn: null, why: '' });
});

test('a pending review request is always your turn', () => {
  const t = whoseTurn(pr({ reviewRequests: [{ login: 'mitch' }], reviews: [{ author: { login: 'mitch' }, submittedAt: '2026-09-21T10:00:00Z', state: 'COMMENTED' }] }), 'mitch');
  assert.equal(t.turn, 'yours'); assert.equal(t.role, 'reviewer'); assert.equal(t.why, 'review requested');
});

test('as author with nobody acting yet, you wait on reviewers', () => {
  const t = whoseTurn(pr(), 'wnstck');
  assert.deepEqual(t, { mine: true, role: 'author', turn: 'theirs', why: 'waiting on reviewers' });
});

test('the last actor decides: their review makes it your turn, your comment makes it theirs', () => {
  const reviewed = pr({ reviews: [{ author: { login: 'mitch' }, submittedAt: '2026-09-21T10:00:00Z', state: 'CHANGES_REQUESTED' }] });
  assert.deepEqual(whoseTurn(reviewed, 'wnstck'), { mine: true, role: 'author', turn: 'yours', why: 'mitch changes requested' });
  const replied = pr({ reviews: reviewed.reviews, comments: [{ author: { login: 'wnstck' }, createdAt: '2026-09-21T11:00:00Z' }] });
  assert.deepEqual(whoseTurn(replied, 'wnstck'), { mine: true, role: 'author', turn: 'theirs', why: 'you commented last' });
  assert.deepEqual(whoseTurn(replied, 'mitch'), { mine: true, role: 'reviewer', turn: 'yours', why: 'wnstck commented' });
});

test('a push after your review hands the turn back to you', () => {
  const t = whoseTurn(pr({
    reviews: [{ author: { login: 'mitch' }, submittedAt: '2026-09-21T10:00:00Z', state: 'APPROVED' }],
    commits: [{ committedDate: '2026-09-21T12:00:00Z', authors: [{ login: 'wnstck' }] }],
  }), 'mitch');
  assert.deepEqual(t, { mine: true, role: 'reviewer', turn: 'yours', why: 'wnstck pushed' });
});

test('bots do not take turns', () => {
  const t = whoseTurn(pr({
    reviews: [{ author: { login: 'mitch' }, submittedAt: '2026-09-21T10:00:00Z', state: 'COMMENTED' }],
    comments: [{ author: { login: 'github-actions' }, createdAt: '2026-09-21T13:00:00Z' }, { author: { login: 'claude' }, createdAt: '2026-09-21T13:00:00Z' }],
  }), 'mitch');
  assert.equal(t.turn, 'theirs'); assert.equal(t.why, 'you commented last');
});
