import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIRST_BACKOFF, GhBudget, MAX_BACKOFF, RESERVE, isRateLimit } from '../src/shared/ghLimit.ts';

test('the wordings GitHub actually uses count as a rate limit, and ordinary failures do not', () => {
  assert.equal(isRateLimit('GraphQL: API rate limit already exceeded for user ID 5130046.'), true);
  assert.equal(isRateLimit({ stderr: 'GraphQL: API rate limit already exceeded for user ID 5130046.\n' }), true);
  assert.equal(isRateLimit({ message: 'HTTP 403: API rate limit exceeded' }), true);
  assert.equal(isRateLimit({ stdout: '{"errors":[{"type":"RATE_LIMIT","code":"graphql_rate_limit"}]}' }), true);
  assert.equal(isRateLimit({ stderr: 'You have exceeded a secondary rate limit' }), true);
  // the everyday failures that must not stop us asking
  assert.equal(isRateLimit({ stderr: 'no pull requests found for branch "main"' }), false);
  assert.equal(isRateLimit({ stderr: 'could not resolve to a Repository' }), false);
  assert.equal(isRateLimit(new Error('connect ETIMEDOUT')), false);
  assert.equal(isRateLimit(undefined), false);
});

test('a rate limit opens a backoff that doubles, and a success closes it', () => {
  const b = new GhBudget();
  const t0 = 1_000_000;
  assert.equal(b.blocked(t0), false, 'a fresh budget lets calls through');
  assert.equal(b.resetsAt(t0), 0);

  assert.equal(b.note({ stderr: 'API rate limit already exceeded' }, t0), true);
  assert.equal(b.blocked(t0), true);
  assert.equal(b.resetsAt(t0), t0 + FIRST_BACKOFF);
  assert.equal(b.blocked(t0 + FIRST_BACKOFF), false, 'the backoff lifts on its own');

  // still limited when we try again: wait twice as long
  const t1 = t0 + FIRST_BACKOFF;
  b.note({ stderr: 'API rate limit already exceeded' }, t1);
  assert.equal(b.resetsAt(t1), t1 + FIRST_BACKOFF * 2);

  b.ok();
  assert.equal(b.blocked(t1), false, 'a call that got through reopens the budget');
  b.note({ stderr: 'API rate limit already exceeded' }, t1);
  assert.equal(b.resetsAt(t1), t1 + FIRST_BACKOFF, 'and resets the doubling');
});

test('a failure that is not a rate limit never blocks the budget', () => {
  const b = new GhBudget();
  assert.equal(b.note(new Error('gh: command not found'), 5), false);
  assert.equal(b.blocked(5), false);
});

test('the backoff stops doubling at the ceiling', () => {
  const b = new GhBudget();
  let t = 0;
  for (let i = 0; i < 20; i++) { b.note({ stderr: 'API rate limit already exceeded' }, t); t = b.resetsAt(t); }
  b.note({ stderr: 'API rate limit already exceeded' }, t);
  assert.equal(b.resetsAt(t) - t, MAX_BACKOFF);
});

test('the budget a reply reports stops us at the reserve, before GitHub has to refuse', () => {
  const b = new GhBudget();
  const t0 = 1_000_000;
  const resetAt = new Date(t0 + 20 * 60_000).toISOString();

  b.saw({ remaining: 4200, resetAt, cost: 16 }, t0);
  assert.equal(b.blocked(t0), false, 'plenty left: keep polling');
  assert.equal(b.remaining(), 4200);

  b.saw({ remaining: RESERVE - 1, resetAt }, t0);
  assert.equal(b.blocked(t0), true, 'the reserve is kept for gh outside the app');
  assert.equal(b.resetsAt(t0), Date.parse(resetAt), "and we wait for GitHub's own refill, not a guess");
  assert.equal(b.blocked(Date.parse(resetAt)), false, 'the hold lifts exactly when the hour turns');

  // a query can succeed and still report the budget nearly gone: that success must not reopen it
  b.ok();
  assert.equal(b.blocked(t0), true);
  b.saw({ remaining: 5000, resetAt }, t0);
  assert.equal(b.blocked(t0), false, 'a refilled budget reopens it');
});

test('a reply with no budget in it, or a reset already past, changes nothing', () => {
  const b = new GhBudget();
  b.saw(undefined, 10);
  b.saw({}, 10);
  b.saw({ remaining: null, resetAt: null }, 10);
  assert.equal(b.blocked(10), false);
  assert.equal(b.remaining(), undefined);
  b.saw({ remaining: 0, resetAt: new Date(5).toISOString() }, 10);
  assert.equal(b.blocked(10), false, 'a reset in the past is no reason to wait');
});

test('the guessed backoff and the reported refill hold independently, the longer one winning', () => {
  const b = new GhBudget();
  const t0 = 2_000_000;
  const refill = t0 + 40 * 60_000;
  b.saw({ remaining: 0, resetAt: new Date(refill).toISOString() }, t0);
  b.note({ stderr: 'API rate limit already exceeded' }, t0);
  assert.equal(b.resetsAt(t0), refill, 'a one-minute backoff cannot shorten a forty-minute wait');
  assert.equal(b.blocked(refill - 1), true);
});
