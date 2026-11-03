import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appReviewPrompt, prepareAppReview, OVERVIEW_PROMPT, SLICE_PROMPT, FINAL_PROMPT } from '../src/shared/reviewSteps.ts';

const t = { repo: 'a/b', pr: 7, url: 'https://github.com/a/b/pull/7', title: 'T', author: 'x', head: 'abcdef1234', base: 'main' };

test('the app review runs the CLI three steps with reviewers on the delegate model', () => {
  const wt = mkdtempSync(join(tmpdir(), 'app-review-'));
  const p = appReviewPrompt(t, wt, 'claude-opus-5-5');
  assert.match(p, /You run steps 1 and 3 yourself/);
  assert.match(p, /on `claude-opus-5-5`: pass that model on every agent call/);
  assert.match(p, /Write \.consort\/pr-review\/agents\/<id>\.json: a JSON array/);
  assert.match(p, /Do not dispatch agents yourself/);
  assert.match(p, /\.consort\/pr-review\/pr-7\.review\.json/);
  assert.match(p, /"status": "pending"/);
  assert.doesNotMatch(p, /\[review-findings\]|\[review-final\]|swarm\.json|"article"/);
});

test('the CLI prompts still use the CLI review folder', () => {
  const wt = mkdtempSync(join(tmpdir(), 'cli-review-'));
  for (const p of [OVERVIEW_PROMPT(t, wt), SLICE_PROMPT(t, wt, { id: 's1', title: 'A', files: ['f.ts'] }), FINAL_PROMPT(t, wt, 2)]) {
    assert.match(p, /\.consort\/review\//);
    assert.doesNotMatch(p, /pr-review/);
  }
  assert.match(OVERVIEW_PROMPT(t, wt), /"article"/);
});

test('a new PR head starts fresh and carries the last findings as previous.json; the same head resumes', () => {
  const wt = mkdtempSync(join(tmpdir(), 'app-review-'));
  const dir = join(wt, '.consort', 'pr-review');
  prepareAppReview(wt, 7, 'aaa1111');
  writeFileSync(join(dir, 'plan.json'), '{}');
  writeFileSync(join(dir, 'agents', 's1.json'), '[]');
  prepareAppReview(wt, 7, 'aaa1111');
  assert.ok(existsSync(join(dir, 'plan.json')), 'same head keeps its work');
  writeFileSync(join(dir, 'pr-7.review.json'), JSON.stringify({ pr: 7, findings: [{ id: 'F1', title: 'x' }] }));
  prepareAppReview(wt, 7, 'bbb2222');
  assert.ok(!existsSync(join(dir, 'plan.json')) && !existsSync(join(dir, 'agents', 's1.json')), 'new head starts fresh');
  assert.ok(existsSync(join(dir, 'round-aaa1111', 'plan.json')));
  assert.equal(JSON.parse(readFileSync(join(dir, 'previous.json'), 'utf8'))[0].id, 'F1');
  assert.match(appReviewPrompt({ ...t, round: 2 }, wt, 'opus'), /previous\.json/);
});
