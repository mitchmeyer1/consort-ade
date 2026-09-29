import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issueBranch, issueBriefPrompt, issueChatName, issueFolder, issueNumberOf } from '../src/shared/issues.ts';

test('an issue branch names the issue and the folder stays flat', () => {
  assert.equal(issueBranch(42), 'issue/42');
  assert.equal(issueFolder(42), 'issue-42');
  assert.equal(issueChatName({ number: 42 }), 'Issue #42');
});

test('the branch is the link back to the issue', () => {
  assert.equal(issueNumberOf('issue/42'), 42);
  assert.equal(issueNumberOf('issue/42-login-bug'), undefined);
  // a branch prefix from Settings sits in front of the issue path
  assert.equal(issueNumberOf('mm/issue/42'), 42);
  assert.equal(issueNumberOf('feature/issue-42'), undefined);
  assert.equal(issueNumberOf('main'), undefined);
  assert.equal(issueNumberOf(undefined), undefined);
});

const issue = {
  number: 7, title: 'Login page loops on expired token', author: 'ada', state: 'OPEN', url: 'https://github.com/o/r/issues/7',
  labels: ['bug', 'auth'], assignees: [], comments: 1, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z',
  body: 'After the session expires the page redirects forever.',
  discussion: [{ author: 'bob', at: '2026-09-02T00:00:00Z', body: 'Reproduced on Safari.' }],
};
const opts = { repo: 'o/r', worktreePath: '/tmp/wt/issue-7', branch: 'issue/7' };

test('the opening prompt carries the issue and asks for a plan, not code', () => {
  const p = issueBriefPrompt(issue, opts);
  assert.match(p, /issue #7 in o\/r: "Login page loops on expired token" \(https:\/\/github.com\/o\/r\/issues\/7\)/);
  assert.match(p, /opened by @ada · labels: bug, auth/);
  assert.match(p, /branch issue\/7/);
  assert.match(p, /After the session expires/);
  assert.match(p, /## Discussion \(1 comment\)/);
  assert.match(p, /@bob .*\nReproduced on Safari\./);
  assert.match(p, /Do not write or edit code/);
  assert.match(p, /brief, concise summary/);
  assert.match(p, /numbered plan/);
  assert.match(p, /questions for Mitch/);
  assert.match(p, /Do not start implementing until told to\.$/);
});

test('an empty issue still reads sensibly', () => {
  const p = issueBriefPrompt({ ...issue, body: '   ', discussion: [], labels: [], author: '' }, opts);
  assert.match(p, /opened by @unknown\./);
  assert.match(p, /\(no description\)/);
  assert.doesNotMatch(p, /## Discussion/);
  assert.doesNotMatch(p, /labels:/);
});

test('long bodies and busy threads are trimmed so the prompt stays bounded', () => {
  const long = 'x'.repeat(20_000);
  const chatty = Array.from({ length: 30 }, (_, i) => ({ author: `u${i}`, at: 'now', body: `comment ${i}` }));
  const p = issueBriefPrompt({ ...issue, body: long, discussion: chatty }, opts);
  assert.match(p, /8000 more characters trimmed/);
  assert.match(p, /## Discussion \(30 comments, last 12 shown\)/);
  assert.doesNotMatch(p, /comment 17\b/);
  assert.match(p, /comment 29\b/);
  assert.ok(p.length < 16_000);
});
