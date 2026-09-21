import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkState, ciLabel, ciTitle, normalizeCheck, summarizeChecks } from '../src/shared/ci.ts';

test('check runs and commit statuses both fold into pass, fail, or pending', () => {
  assert.equal(checkState({ status: 'completed', conclusion: 'success' }), 'pass');
  assert.equal(checkState({ status: 'completed', conclusion: 'failure' }), 'fail');
  assert.equal(checkState({ status: 'completed', conclusion: 'timed_out' }), 'fail');
  assert.equal(checkState({ status: 'completed', conclusion: 'action_required' }), 'fail');
  assert.equal(checkState({ status: 'completed', conclusion: 'skipped' }), 'pass');
  assert.equal(checkState({ status: 'completed', conclusion: 'neutral' }), 'pass');
  assert.equal(checkState({ status: 'in_progress', conclusion: null }), 'pending');
  assert.equal(checkState({ status: 'queued' }), 'pending');
  assert.equal(checkState({ state: 'error' }), 'fail');
  assert.equal(checkState({ state: 'pending' }), 'pending');
  assert.equal(checkState({ state: 'SUCCESS' }), 'pass');
});

test('gh rollup items, REST check runs, and REST statuses normalize to one shape', () => {
  assert.deepEqual(normalizeCheck({ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://x/runs/1' }), { name: 'test', state: 'fail', url: 'https://x/runs/1' });
  assert.deepEqual(normalizeCheck({ __typename: 'StatusContext', context: 'ci/lint', state: 'SUCCESS', targetUrl: 'https://x/lint' }), { name: 'ci/lint', state: 'pass', url: 'https://x/lint' });
  assert.deepEqual(normalizeCheck({ name: 'build', status: 'queued', conclusion: null, html_url: 'https://x/runs/2' }), { name: 'build', state: 'pending', url: 'https://x/runs/2' });
  assert.deepEqual(normalizeCheck({ context: 'deploy', state: 'pending', target_url: '' }), { name: 'deploy', state: 'pending', url: undefined });
  assert.equal(normalizeCheck({ status: 'completed' }), undefined);
  assert.equal(normalizeCheck(null), undefined);
});

test('a failing check makes the commit fail and the click goes to that run', () => {
  const ci = summarizeChecks([
    { name: 'lint', status: 'completed', conclusion: 'success', html_url: 'https://x/lint' },
    { name: 'test', status: 'completed', conclusion: 'failure', html_url: 'https://x/test' },
    { name: 'build', status: 'in_progress', conclusion: null, html_url: 'https://x/build' },
    { context: 'deploy', state: 'error', target_url: 'https://x/deploy' },
  ], 'https://x/pull/1/checks');
  assert.equal(ci.state, 'fail');
  assert.equal(ci.total, 4);
  assert.equal(ci.failed, 2);
  assert.equal(ci.pending, 1);
  assert.deepEqual(ci.failing, ['test', 'deploy']);
  assert.equal(ci.url, 'https://x/test');
  assert.equal(ciLabel(ci), '✗ CI 2');
  assert.equal(ciTitle(ci), '2 of 4 checks failing: test, deploy');
});

test('anything still running keeps the commit pending', () => {
  const ci = summarizeChecks([
    { name: 'lint', status: 'completed', conclusion: 'success', html_url: 'https://x/lint' },
    { name: 'test', status: 'queued', conclusion: null },
  ], 'https://x/pull/1/checks');
  assert.equal(ci.state, 'pending');
  assert.equal(ci.url, 'https://x/pull/1/checks');
  assert.equal(ciLabel(ci), '◌ CI');
  assert.equal(ciTitle(ci), '1 of 2 checks still running');
});

test('all green passes, and without a checks page the first run is the link', () => {
  const ci = summarizeChecks([
    { name: 'lint', status: 'completed', conclusion: 'success', html_url: 'https://x/lint' },
    { name: 'docs', status: 'completed', conclusion: 'skipped', html_url: 'https://x/docs' },
  ]);
  assert.equal(ci.state, 'pass');
  assert.equal(ci.url, 'https://x/lint');
  assert.equal(ciLabel(ci), '✓ CI');
  assert.equal(ciTitle(ci), 'All 2 checks passed');
  assert.equal(ciTitle(summarizeChecks([{ name: 'only', conclusion: 'success' }])), 'The check passed');
});

test('a re-run replaces the earlier attempt with the same name', () => {
  const ci = summarizeChecks([
    { name: 'test', status: 'completed', conclusion: 'failure' },
    { name: 'test', status: 'completed', conclusion: 'success' },
  ]);
  assert.equal(ci.state, 'pass');
  assert.equal(ci.total, 1);
});

test('no checks means no CI to report', () => {
  assert.equal(summarizeChecks([]), undefined);
  assert.equal(summarizeChecks([{}, null]), undefined);
});
