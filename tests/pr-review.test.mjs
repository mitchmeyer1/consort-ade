import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  approvedFindings, commentableLines, groupFindings, isReviewFile, markPosted, parseReview, patchesToDiff,
  reviewCounts, reviewPayload, serializeReview, updateFinding,
} from '../src/shared/review.ts';

const sample = () => ({
  pr: 402, repo: 'aligned/aligned-mono', url: 'https://github.com/aligned/aligned-mono/pull/402', title: 'Member match trigram model',
  head: '489353ae489353ae489353ae489353ae489353ae', base: 'a95fdeab',
  findings: [
    { id: 'D1', kind: 'defect', severity: 'high', category: 'logic', title: 'Assigning a practice freezes a model pick', file: 'packages/core/src/services/utilization-ingestion.service.ts', line: 565,
      problem: 'p', exampleFlow: 'e', fix: 'f', ignoreIf: 'i', comment: 'utilization-ingestion.service.ts:565 — a model pick made with no practice is kept here.' },
    { id: 'D2', kind: 'defect', severity: 'medium', title: 'Output budget is a quarter of its sibling', file: 'packages/core/src/prompts.ts', line: 12, comment: 'Budget looks low.' },
    { id: 'T1', kind: 'item', category: 'tests', title: 'Nothing tests the rematch path', file: 'tests/standard/match.test.ts', line: 3, fields: { Costs: 'c', Suite: 'standard', Test: 't' }, comment: 'Add a rematch test.' },
    { id: 'C1', kind: 'item', category: 'comments', title: 'Docblock restates the code', file: 'packages/core/src/user.model.ts', line: 40, fields: { Trimmed: '// keep' } },
  ],
});

test('review files are recognised by suffix, ignoring line anchors', () => {
  assert.equal(isReviewFile('.consort/pr-review/pr-402.review.json'), true);
  assert.equal(isReviewFile('/abs/path/pr-402.review.json:12'), true);
  assert.equal(isReviewFile('.consort/pr-review/brief.md'), false);
  assert.equal(isReviewFile('package.json'), false);
});

test('parsing fills defaults and keeps every finding with a title', () => {
  const review = parseReview(JSON.stringify(sample()));
  assert.equal(review.version, 1);
  assert.equal(review.pr, 402);
  assert.deepEqual(review.findings.map((f) => f.status), ['pending', 'pending', 'pending', 'pending']);
  assert.equal(review.findings[0].kind, 'defect');
  assert.equal(review.findings[2].kind, 'item');
  assert.deepEqual(review.flows, []);
  assert.deepEqual(review.appendix, []);
});

test('parsing rejects what cannot be shown and drops malformed findings', () => {
  assert.throws(() => parseReview('not json'), /Not valid JSON/);
  assert.throws(() => parseReview('{"findings":[]}'), /pr/);
  assert.throws(() => parseReview('{"pr":1}'), /findings/);
  const review = parseReview(JSON.stringify({ pr: 1, findings: [{ title: 'general comment', comment: 'This belongs on the PR.' }, { file: 'a.ts', title: 'ok', severity: 'high' }, 'junk'] }));
  assert.equal(review.findings.length, 2);
  assert.equal(review.findings[0].file, undefined, 'a deliberately general comment needs no invented file');
  assert.equal(review.findings[1].kind, 'defect');
  assert.equal(review.findings[1].id, 'D2');
});

test('a finding marked commented without a posted record is only approved', () => {
  const raw = sample();
  raw.findings[0].status = 'commented';
  raw.findings[1].status = 'commented';
  raw.findings[1].posted = { url: 'https://github.com/x/pull/402#r1', at: '2026-09-21T00:00:00Z' };
  const review = parseReview(JSON.stringify(raw));
  assert.equal(review.findings[0].status, 'approved');
  assert.equal(review.findings[1].status, 'commented');
});

test('duplicate ids are made unique so buttons address one card each', () => {
  const raw = sample();
  raw.findings[1].id = 'D1';
  const review = parseReview(JSON.stringify(raw));
  assert.deepEqual(review.findings.map((f) => f.id), ['D1', 'D1-2', 'T1', 'C1']);
});

test('approving and ignoring are reversible; a posted comment is not', () => {
  let review = parseReview(JSON.stringify(sample()));
  review = updateFinding(review, 'D1', { status: 'approved' });
  review = updateFinding(review, 'D2', { status: 'ignored' });
  assert.deepEqual(approvedFindings(review).map((f) => f.id), ['D1']);
  review = updateFinding(review, 'D1', { status: 'pending' });
  assert.deepEqual(approvedFindings(review), []);
  review = updateFinding(review, 'T1', { status: 'approved', comment: 'Edited comment.' });
  assert.equal(review.findings[2].comment, 'Edited comment.');
  assert.throws(() => updateFinding(review, 'D1', { status: 'commented' }), /Post to GitHub/);
  assert.throws(() => updateFinding(review, 'nope', { status: 'approved' }), /No finding/);
  const posted = markPosted(review, ['T1'], { url: 'https://github.com/x/pull/402#pullrequestreview-1', at: 'now', reviewId: 1 });
  assert.equal(posted.findings[2].status, 'commented');
  assert.throws(() => updateFinding(posted, 'T1', { status: 'ignored' }), /already on GitHub/);
});

test('an approved finding with no comment text is not posted', () => {
  let review = parseReview(JSON.stringify(sample()));
  review = updateFinding(review, 'C1', { status: 'approved' });
  assert.deepEqual(approvedFindings(review), []);
});

test('findings group into severities then categories, in document order', () => {
  const review = parseReview(JSON.stringify(sample()));
  const groups = groupFindings(review.findings);
  assert.deepEqual(groups.defects.map((g) => [g.key, g.findings.length]), [['critical', 0], ['high', 1], ['medium', 1], ['low', 0]]);
  assert.deepEqual(groups.items.map((g) => [g.key, g.findings.length]), [['logic', 0], ['redundant', 0], ['style', 0], ['tests', 1], ['comments', 1]]);
  const counts = reviewCounts(review);
  assert.equal(counts.defects, 2);
  assert.equal(counts.items, 2);
  assert.equal(counts.severity.high, 1);
  assert.equal(counts.category.tests, 1);
});

test('commentable lines are the new-side lines each hunk shows', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts', 'index 1..2 100644', '--- a/src/a.ts', '+++ b/src/a.ts',
    '@@ -10,4 +10,5 @@ function f() {', ' ctx10', '-old11', '+new11', '+new12', ' ctx13', ' ctx14',
    '@@ -40,2 +41,2 @@', ' ctx41', '+new42', '\\ No newline at end of file',
    'diff --git a/gone.ts b/gone.ts', 'deleted file mode 100644', '--- a/gone.ts', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-a', '-b',
    'diff --git a/new.ts b/new.ts', 'new file mode 100644', '--- /dev/null', '+++ b/new.ts', '@@ -0,0 +1,2 @@', '+x', '+y', '',
  ].join('\n');
  const lines = commentableLines(diff);
  assert.deepEqual([...lines.get('src/a.ts')].sort((a, b) => a - b), [10, 11, 12, 13, 14, 41, 42]);
  assert.equal(lines.has('gone.ts'), false);
  assert.deepEqual([...lines.get('new.ts')], [1, 2]);
});

test('compare-API patches get the headers the parser needs', () => {
  const diff = patchesToDiff([{ filename: 'src/a.ts', patch: '@@ -1,1 +1,2 @@\n a\n+b' }, { filename: 'bin.png' }]);
  assert.deepEqual([...commentableLines(diff).get('src/a.ts')], [1, 2]);
  assert.equal(commentableLines(diff).has('bin.png'), false);
});

test('one review payload carries inline comments and lists the rest in its body', () => {
  let review = parseReview(JSON.stringify(sample()));
  for (const id of ['D1', 'D2', 'T1']) review = updateFinding(review, id, { status: 'approved' });
  const commentable = new Map([
    ['packages/core/src/services/utilization-ingestion.service.ts', new Set([560, 565])],
    ['tests/standard/match.test.ts', new Set([1, 2])],
  ]);
  const result = reviewPayload(review, approvedFindings(review), commentable);
  assert.equal(result.payload.commit_id, review.head);
  assert.equal(result.payload.event, 'COMMENT');
  assert.deepEqual(result.payload.comments, [{ path: 'packages/core/src/services/utilization-ingestion.service.ts', line: 565, side: 'RIGHT', body: review.findings[0].comment }]);
  assert.deepEqual(result.general.map((f) => f.id), ['D2', 'T1']);
  assert.match(result.payload.body, /\*\*packages\/core\/src\/prompts\.ts:12\*\* — Budget looks low\./);
  assert.match(result.payload.body, /\*\*tests\/standard\/match\.test\.ts:3\*\* — Add a rematch test\./);
  assert.equal(reviewPayload(review, [], commentable), null);
});

test('a finding with no applicable source line becomes a plain general PR comment', () => {
  const general = parseReview(JSON.stringify({ pr: 1, findings: [{ id: 'L1', kind: 'item', category: 'logic', title: 'Document the rollout limit', comment: 'Please document the rollout limitation before merging.', status: 'approved' }] }));
  const result = reviewPayload(general, approvedFindings(general), new Map());
  assert.deepEqual(result.inline, []);
  assert.deepEqual(result.general.map((f) => f.id), ['L1']);
  assert.equal(result.payload.body, 'Please document the rollout limitation before merging.');
  assert.deepEqual(result.payload.comments, []);
});

test('serialising round-trips through parsing', () => {
  const review = parseReview(JSON.stringify(sample()));
  assert.deepEqual(parseReview(serializeReview(review)), review);
});

test('drift marks only findings whose file changed since the commit they were checked at', async () => {
  const { driftBases, driftedFindings } = await import('../src/shared/review.ts');
  const raw = sample();
  raw.findings[1].head = 'bbbb';
  const review = parseReview(JSON.stringify(raw));
  const live = 'cccc';
  assert.deepEqual(driftBases(review, live).sort(), [review.head, 'bbbb'].sort());
  const changedBy = new Map([
    [review.head, new Set(['packages/core/src/services/utilization-ingestion.service.ts', 'packages/core/src/prompts.ts'])],
    ['bbbb', new Set(['tests/standard/match.test.ts'])],
  ]);
  assert.deepEqual([...driftedFindings(review, live, changedBy)], ['D1']);
  assert.deepEqual([...driftedFindings(review, review.head, changedBy)], [], 'nothing drifts when the PR has not moved');
  assert.deepEqual(driftBases(review, review.head), ['bbbb']);
});

test('a verdict is the last JSON object in the agent text, and only known verdicts count', async () => {
  const { parseVerdict } = await import('../src/shared/review.ts');
  const text = 'I looked at the file.\n{"verdict":"same"} was my first thought but\n{"verdict":"modified","line":570,"comment":"x.ts:570 — still kept.","reason":"The block moved five lines."}\n';
  assert.deepEqual(parseVerdict(text), { verdict: 'modified', line: 570, comment: 'x.ts:570 — still kept.', reason: 'The block moved five lines.' });
  assert.deepEqual(parseVerdict('{"verdict":"REMOVED","reason":"fixed","line":null}'), { verdict: 'removed', reason: 'fixed', comment: undefined, line: undefined });
  assert.throws(() => parseVerdict('no json here'), /no verdict/);
  assert.throws(() => parseVerdict('{"verdict":"maybe"}'), /unknown verdict/);
});

test('applying a verdict updates undecided findings and only annotates posted ones', async () => {
  const { applyVerdict, verdictSummary } = await import('../src/shared/review.ts');
  let review = parseReview(JSON.stringify(sample()));
  review = updateFinding(review, 'D2', { status: 'approved' });
  const at = '2026-09-21T17:00:00Z';
  const modified = applyVerdict(review, 'D1', { verdict: 'modified', line: 570, comment: 'new comment', reason: 'moved' }, 'cccc', at);
  const d1 = modified.findings[0];
  assert.equal(d1.comment, 'new comment');
  assert.equal(d1.line, 570);
  assert.equal(d1.head, 'cccc');
  assert.equal(d1.status, 'pending');
  assert.equal(d1.investigation.previousComment, review.findings[0].comment);
  assert.equal(d1.investigation.verdict, 'modified');

  const removed = applyVerdict(modified, 'D2', { verdict: 'removed', reason: 'fixed' }, 'cccc', at);
  assert.equal(removed.findings[1].status, 'dropped', 'a queued finding that no longer holds is dropped');
  assert.deepEqual(approvedFindings(removed), []);
  const back = applyVerdict(removed, 'D2', { verdict: 'same', reason: 'reverted' }, 'dddd', at);
  assert.equal(back.findings[1].status, 'pending', 'a dropped finding that holds again is undecided');

  const posted = markPosted(review, ['D1'], { url: 'https://github.com/x/pull/402#r1', at, reviewId: 1 });
  const stale = applyVerdict(posted, 'D1', { verdict: 'removed', reason: 'fixed', comment: 'ignored' }, 'cccc', at);
  assert.equal(stale.findings[0].status, 'commented', 'a posted comment stays posted');
  assert.equal(stale.findings[0].comment, review.findings[0].comment);
  assert.equal(stale.findings[0].investigation.verdict, 'removed');
  assert.match(verdictSummary(stale.findings[0], { verdict: 'removed', reason: '' }), /stale/);
  assert.match(verdictSummary(review.findings[1], { verdict: 'removed', reason: '' }), /dropped/);
  assert.match(verdictSummary(review.findings[1], { verdict: 'same', reason: '' }), /unchanged/);
  assert.throws(() => updateFinding(review, 'D1', { status: 'dropped' }), /re-investigation/);
});

test('investigation and head survive a round trip', async () => {
  const { applyVerdict } = await import('../src/shared/review.ts');
  const review = applyVerdict(parseReview(JSON.stringify(sample())), 'D1', { verdict: 'same', reason: 'still there' }, 'cccc', '2026-09-21T17:00:00Z');
  assert.deepEqual(parseReview(serializeReview(review)), review);
});

test('the suggested verdict follows the live findings', async () => {
  const { suggestedEvent, allDecided } = await import('../src/shared/review.ts');
  let review = parseReview(JSON.stringify(sample()));
  assert.equal(allDecided(review), false);
  assert.equal(suggestedEvent(review), 'COMMENT', 'undecided findings never suggest approval');
  for (const id of ['D1', 'D2', 'T1', 'C1']) review = updateFinding(review, id, { status: 'ignored' });
  assert.equal(allDecided(review), true);
  assert.equal(suggestedEvent(review), 'APPROVE');
  review = updateFinding(review, 'T1', { status: 'approved' });
  assert.equal(suggestedEvent(review), 'COMMENT');
  review = updateFinding(review, 'D1', { status: 'approved' });
  assert.equal(suggestedEvent(review), 'REQUEST_CHANGES', 'a queued high defect asks for changes');
});

test('a review payload carries the verdict and puts the body before listed comments', () => {
  let review = parseReview(JSON.stringify(sample()));
  review = updateFinding(review, 'D2', { status: 'approved' });
  const none = new Map();
  const result = reviewPayload(review, approvedFindings(review), none, { event: 'REQUEST_CHANGES', body: 'Two things before this merges.' });
  assert.equal(result.payload.event, 'REQUEST_CHANGES');
  assert.deepEqual(result.payload.comments, []);
  assert.equal(result.payload.body, 'Two things before this merges.\n\n**packages/core/src/prompts.ts:12** — Budget looks low.');
  assert.equal(reviewPayload(review, [], none, { event: 'COMMENT', body: '' }), null, 'an empty comment review is nothing');
  assert.equal(reviewPayload(review, [], none, { event: 'APPROVE', body: '' }).payload.event, 'APPROVE', 'an approval stands on its own');
});

test('a submission is recorded and marks the comments it carried as posted', async () => {
  const { recordSubmission, fallbackReviewBody, draftBodyPrompt } = await import('../src/shared/review.ts');
  let review = parseReview(JSON.stringify(sample()));
  review = updateFinding(review, 'D1', { status: 'approved' });
  review = updateFinding(review, 'D2', { status: 'ignored' });
  const sub = { at: '2026-09-21T18:00:00Z', event: 'REQUEST_CHANGES', url: 'https://github.com/x/pull/402#pullrequestreview-9', body: 'b', inline: ['D1'], reviewId: 9, drafted: true };
  const next = recordSubmission(review, sub);
  assert.equal(next.findings[0].status, 'commented');
  assert.equal(next.findings[0].posted.url, sub.url);
  assert.deepEqual(next.submissions, [sub]);
  assert.deepEqual(parseReview(serializeReview(next)).submissions, [sub]);
  const only = recordSubmission(next, { at: 'later', event: 'APPROVE', url: 'https://github.com/x/pull/402#pullrequestreview-10', body: 'lgtm', inline: [] });
  assert.equal(only.submissions.length, 2);
  assert.equal(only.findings[0].posted.url, sub.url, 'a review-only submission touches no finding');

  const body = fallbackReviewBody(review, 'REQUEST_CHANGES', approvedFindings(review));
  assert.match(body, /Left 1 comment \(1 defect\)/);
  assert.match(body, /Requesting changes/);
  assert.match(fallbackReviewBody(review, 'APPROVE', []), /Looks good to merge/);
  const prompt = draftBodyPrompt(review, 'APPROVE', approvedFindings(review));
  assert.match(prompt, /verdict is Approve/);
  assert.match(prompt, /D1 · high · packages\/core\/src\/services\/utilization-ingestion\.service\.ts:565/);
  assert.match(prompt, /Reply with only the body text/);
});
