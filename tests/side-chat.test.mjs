import { test } from 'node:test';
import assert from 'node:assert/strict';
import { elapsed, sideChatPrompt } from '../src/shared/sideChat.ts';

const snapshot = (over = {}) => ({
  name: 'PR #402 review', provider: 'claude', model: 'claude-opus-5', phase: 'executing', steps: 5,
  running: true, elapsedMs: 72 * 60_000, toolCalls: 214, failedTools: 3, queued: 0,
  digest: 'USER:\nReview PR 402\n\nASSISTANT:\n[tool Task: review src/api]', files: ['.consort/notes/plan.md'], gitStatus: ' M src/api.ts',
  ...over,
});

test('durations read in hours for the long jobs this is meant for', () => {
  assert.equal(elapsed(45_000), '45s');
  assert.equal(elapsed(45 * 60_000), '45m');
  assert.equal(elapsed(72 * 60_000), '1h 12m');
  assert.equal(elapsed(3 * 3_600_000), '3h 0m');
});

test('the prompt carries the job state the user is checking in on', () => {
  const p = sideChatPrompt(snapshot(), 'what percent done is this job?');
  assert.match(p, /Job: PR #402 review/);
  assert.match(p, /Status: running now · phase executing of 5/);
  assert.match(p, /Time on this run: 1h 12m/);
  assert.match(p, /Tool calls so far: 214 \(3 failed\)/);
  assert.match(p, /\.consort\/notes\/plan\.md/);
  assert.match(p, /M src\/api\.ts/);
  assert.match(p, /\[tool Task: review src\/api\]/);
  assert.match(p, /what percent done is this job\?$/);
});

test('the observer is told to stay read-only and not to guess a number', () => {
  const p = sideChatPrompt(snapshot(), 'status?');
  assert.match(p, /read-only/i);
  assert.match(p, /never edit, create or delete files/i);
  assert.match(p, /rather than inventing one/i);
});

test('an idle job, an error and no files all read cleanly', () => {
  const p = sideChatPrompt(snapshot({ running: false, steps: undefined, files: [], gitStatus: '', error: 'rate limited', elapsedMs: undefined, failedTools: 0, queued: 2 }), 'what happened?');
  assert.match(p, /Status: not running · phase executing$/m);
  assert.match(p, /Queued messages waiting: 2/);
  assert.match(p, /Last run error: rate limited/);
  assert.match(p, /has not written any files/);
  assert.match(p, /\(clean\)/);
  assert.doesNotMatch(p, /Time on this run/);
  assert.match(p, /Tool calls so far: 214$/m);
});

test('earlier side questions come along, so follow-ups make sense', () => {
  const p = sideChatPrompt(snapshot(), 'and now?', [
    { id: '1', role: 'user', text: 'how far along?', ts: 1 },
    { id: '2', role: 'assistant', text: 'about 60%', ts: 2 },
  ]);
  assert.match(p, /You were asked: how far along\?/);
  assert.match(p, /You answered: about 60%/);
});

test('a job with hundreds of files only sends the newest', () => {
  const files = Array.from({ length: 120 }, (_, i) => `.consort/out/file-${i}.md`);
  const p = sideChatPrompt(snapshot({ files }), 'status?');
  assert.match(p, /file-0\.md/);
  assert.match(p, /file-39\.md/);
  assert.doesNotMatch(p, /file-40\.md/);
});

test('a job in a ship worktree tells the observer the pipeline stage, apart from the turn phase bar', () => {
  const p = sideChatPrompt(snapshot({ ship: '- Stages: Grilling ✓ → Spec\'d ✓ → [Implementing ← you are here] → …\n- Stage now: Implementing (3 of 8) · step inside it: test session' }), 'what step are we on?');
  assert.match(p, /## The \/ship pipeline this job belongs to/);
  assert.match(p, /Stage now: Implementing \(3 of 8\) · step inside it: test session/);
  assert.doesNotMatch(sideChatPrompt(snapshot(), 'status?'), /ship pipeline/);
});
