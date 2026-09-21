import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickReviewFile, prNumberOf, reviewSummary } from '../src/shared/review.ts';

const finding = (id, status) => ({ id, kind: 'defect', title: id, status });
const review = (findings, submissions = []) => ({ version: 1, repo: 'o/r', pr: 449, url: 'https://x/pull/449', title: 'Env badge', head: 'abc', base: 'main', reviewedAt: '2026-09-21T15:00:00Z', flows: [], findings, appendix: [], wellBuilt: [], orderOfWork: [], submissions });

test('the summary counts findings by where they stand', () => {
  const s = reviewSummary(review([finding('D1', 'pending'), finding('D2', 'approved'), finding('L1', 'commented'), finding('S1', 'ignored'), finding('S2', 'dropped'), finding('T1', 'fixing')], [{ at: 't', event: 'COMMENT', url: 'u', body: '', inline: [] }]));
  assert.equal(s.pr, 449);
  assert.equal(s.total, 6);
  assert.equal(s.fixing, 1);
  assert.equal(s.pending, 1);
  assert.equal(s.queued, 1);
  assert.equal(s.commented, 1);
  assert.equal(s.ignored, 2);
  assert.equal(s.submitted, 1);
});

test("the PR's own file wins over a newer one for another PR", () => {
  const files = [{ name: 'pr-450.review.json', mtime: 20 }, { name: 'pr-449.review.json', mtime: 10 }, { name: 'brief.md', mtime: 30 }];
  assert.equal(pickReviewFile(files, 449), 'pr-449.review.json');
  assert.equal(pickReviewFile(files, 451), 'pr-450.review.json');
  assert.equal(pickReviewFile(files), 'pr-450.review.json');
  assert.equal(pickReviewFile([{ name: 'review.md', mtime: 1 }]), undefined);
});

test('a review chat carries its PR number in its name', () => {
  assert.equal(prNumberOf('PR #449 wnstck'), 449);
  assert.equal(prNumberOf('PR write-up · Env badge'), undefined);
});
