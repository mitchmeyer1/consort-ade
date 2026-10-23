import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EVIDENCE_TURN_MS, EVIDENCE_CHECK_MS, TurnTimeoutError, resumeEvidenceTurn, staleEvidenceTimeout } from '../src/cli/evidenceRetry.ts';
import { ProblemError } from '../src/shared/headless.ts';

const timeout = () => new TurnTimeoutError({ where: '', what: 'The agent exceeded 90 minutes on one turn and was stopped' });

test('large evidence turns allow 90 minutes and independent verification allows 30', () => {
  assert.equal(EVIDENCE_TURN_MS, 90 * 60_000);
  assert.equal(EVIDENCE_CHECK_MS, 30 * 60_000);
});

test('a timed out evidence turn resumes saved work without asking the owner', async () => {
  const guidance = [], notices = [];
  const result = await resumeEvidenceTurn('Gathering evidence', async text => {
    guidance.push(text);
    if (guidance.length === 1) throw timeout();
    return 'completed evidence';
  }, async text => { notices.push(text); });
  assert.equal(result, 'completed evidence');
  assert.equal(guidance.length, 2);
  assert.match(guidance[1], /reuse valid completed checks/);
  assert.match(notices[0], /No action needed/);
});

test('repeated timeouts have a bounded budget and an actionable question', async () => {
  let attempts = 0, notices = 0;
  await assert.rejects(resumeEvidenceTurn('Checking evidence', async () => { attempts++; throw timeout(); }, async () => { notices++; }), error => {
    assert.ok(error instanceof ProblemError);
    assert.match(error.problem.ask, /'retry'.*'pause'/);
    assert.doesNotMatch(error.problem.ask, /key|credential/);
    return true;
  });
  assert.equal(attempts, 3);
  assert.equal(notices, 2);
});

test('missing credentials and failed checks are not treated as timeouts', async () => {
  const failure = new ProblemError({ where: 'evidence', what: 'Missing required API key' });
  let attempts = 0;
  await assert.rejects(resumeEvidenceTurn('Gathering evidence', async () => { attempts++; throw failure; }, async () => assert.fail('no retry notice')), error => error === failure);
  assert.equal(attempts, 1);
});

test('restart recovers the obsolete timeout question but preserves actual questions', () => {
  assert.equal(staleEvidenceTimeout(['Evidence blocked. PR not handed off · The agent exceeded 15 minutes on one turn and was stopped · If a key is missing: add it']), true);
  assert.equal(staleEvidenceTimeout(['Evidence blocked. PR not handed off · Missing API key']), false);
  assert.equal(staleEvidenceTimeout(['Implementation: The agent exceeded 15 minutes on one turn and was stopped']), false);
  assert.equal(staleEvidenceTimeout(['Evidence blocked. PR not handed off · The agent exceeded 15 minutes on one turn and was stopped', 'Which environment?']), false);
});

test('network publication retry does not run evidence capture or verification again', async () => {
  const { retryEvidencePublication } = await import('../src/cli/evidenceRetry.ts');
  let calls = 0;
  const messages = [], waits = [];
  const result = await retryEvidencePublication(async () => {
    if (++calls < 3) throw new TypeError('fetch failed');
    return { prComment: true, ticketComment: true };
  }, async text => messages.push(text), async ms => waits.push(ms));
  assert.deepEqual(result, { prComment: true, ticketComment: true });
  assert.equal(calls, 3);
  assert.match(messages[0], /Evidence passed verification.*No action needed/);
  assert.deepEqual(waits, [15000, 30000]);
});

test('publication retries transport and temporary HTTP errors, but not auth or validation failures', async () => {
  const { transientEvidencePublication, retryEvidencePublication, staleEvidenceNetworkQuestion } = await import('../src/cli/evidenceRetry.ts');
  for (const message of ['fetch failed', 'ClickUp attachment: 503 unavailable', 'ClickUp attachment: 429 limit', 'HTTP 502']) assert.equal(transientEvidencePublication(new Error(message)), true);
  for (const message of ['ClickUp attachment: 401 Unauthorized', 'ClickUp attachment: 403 denied', 'Evidence image is missing']) {
    assert.equal(transientEvidencePublication(new Error(message)), false);
    await assert.rejects(retryEvidencePublication(async () => { throw new Error(message); }, async () => assert.fail('no retry'), async () => assert.fail('no wait')), { message });
  }
  assert.equal(staleEvidenceNetworkQuestion(['Evidence blocked. PR not handed off\n• Evidence was not accepted\n• fetch failed\n• Last seen: all checks passed']), true);
  assert.equal(staleEvidenceNetworkQuestion(['Evidence blocked. PR not handed off\n• Evidence check did not pass\n• missing key']), false);
});
