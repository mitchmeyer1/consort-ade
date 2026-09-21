import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHECK_CAP, ISSUE_PAGE, PR_PAGE, issueListQuery, mapIssueNode, mapPr, pickPr, prByBranchQuery, prListQuery,
} from '../src/shared/ghQuery.ts';
import { whoseTurn } from '../src/shared/prTurn.ts';

/**
 * What GitHub charges a query for: the nodes it may return, nested pages multiplying. This is
 * the same arithmetic the API bills by, and the reason these queries exist at all — gh's
 * `--json reviews,comments,commits` asks 100 of each, per PR.
 */
function nodeBudget(query, pages = {}) {
  let q = query.replace(/orderBy:\s*\{[^}]*\}/g, 'orderBy: X');
  for (const [name, n] of Object.entries(pages)) q = q.replaceAll(`$${name}`, String(n));
  const re = /([A-Za-z_]\w*)\s*(\([^{}]*\))?\s*\{|\}/g;
  const stack = [1];
  let total = 0, m;
  while ((m = re.exec(q))) {
    if (m[0] === '}') { if (stack.length > 1) stack.pop(); continue; }
    const page = /\b(?:first|last):\s*(\d+)/.exec(m[2] ?? '');
    const size = stack[stack.length - 1] * (page ? +page[1] : 1);
    if (page) total += size;
    stack.push(size);
  }
  return total;
}

test('the node budget of the sizes we chose is what we think it is', () => {
  // a self-check of the meter before it is used as a limit: two levels multiply
  assert.equal(nodeBudget('q { a(first: 3) { nodes { b(last: 4) { nodes { c } } } } }'), 3 + 12);
  assert.equal(nodeBudget('q { a { b } }'), 0, 'a plain field costs no nodes');
});

test('every polled query stays far under what gh --json used to ask for', () => {
  // gh's defaults: 30 PRs x (reviews + comments + commits + reviewRequests) x 100 = 12,000 nodes,
  // around 120 points of an hourly 5000, every minute the project page is open
  assert.ok(nodeBudget(prListQuery, { first: PR_PAGE }) < 2000, 'the PR list');
  assert.ok(nodeBudget(issueListQuery, { first: ISSUE_PAGE }) < 1500, 'the issue list');
  assert.ok(nodeBudget(prByBranchQuery) < 400, "one worktree's PR");
});

test('no connection is left unbounded, which is how the cost got away from us', () => {
  for (const [name, q] of Object.entries({ prListQuery, issueListQuery, prByBranchQuery })) {
    // every `nodes {` must sit inside a connection that named a page size
    const connections = q.match(/[A-Za-z_]\w*\s*(\([^{}]*(\{[^}]*\})?[^{}]*\))?\s*\{\s*nodes/g) ?? [];
    assert.ok(connections.length, `${name} selects nodes somewhere`);
    for (const c of connections) assert.match(c, /\b(first|last):/, `${name}: unbounded connection ${c.trim()}`);
  }
});

test('every query asks what the budget is, since that is free and stops us guessing', () => {
  for (const q of [prListQuery, issueListQuery, prByBranchQuery]) assert.match(q, /rateLimit \{ cost remaining resetAt \}/);
});

const prNode = {
  number: 449, title: 'Admin subdomain env', url: 'https://github.com/o/r/pull/449', state: 'OPEN',
  isDraft: false, updatedAt: '2026-09-20T10:00:00Z', reviewDecision: 'REVIEW_REQUIRED', headRefName: 'admin-env',
  author: { login: 'mitch' },
  reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'dana' } }, { requestedReviewer: { __typename: 'Team', slug: 'platform' } }, null] },
  reviews: { nodes: [{ author: { login: 'dana' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-09-19T09:00:00Z' }] },
  comments: { nodes: [{ author: { login: 'mitch' }, createdAt: '2026-09-19T10:00:00Z' }] },
  commits: { nodes: [{ commit: {
    committedDate: '2026-09-20T09:00:00Z',
    authors: { nodes: [{ user: { login: 'mitch' } }, { user: null }] },
    statusCheckRollup: { contexts: { nodes: [
      { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://ci/build' },
      { __typename: 'StatusContext', context: 'vercel', state: 'FAILURE', targetUrl: 'https://ci/vercel' },
    ] } },
  } }] },
};

test('a GraphQL pull request arrives in the shape the turn rule already reads', () => {
  const p = mapPr(prNode);
  assert.deepEqual(p.reviewRequests, [{ login: 'dana' }, { login: 'platform' }], 'a team request keeps its slug where a login goes');
  assert.deepEqual(p.commits, [{ committedDate: '2026-09-20T09:00:00Z', authors: [{ login: 'mitch' }, { login: '' }] }]);
  assert.equal(p.draft, undefined, 'the gh spelling is isDraft, and the caller reads that');
  assert.equal(p.isDraft, false);

  // the rule itself, unchanged, still reaches the same verdict on the mapped payload
  assert.deepEqual(whoseTurn(p, 'mitch'), { mine: true, role: 'author', turn: 'theirs', why: 'you pushed last' });
  assert.equal(whoseTurn(p, 'dana').turn, 'yours', 'a pending request to me is my turn');
  assert.equal(whoseTurn(p, 'someone-else').role, null);
});

test('the head commit carries the checks, flattened the way the CI chip expects', () => {
  const checks = mapPr(prNode).statusCheckRollup;
  assert.equal(checks.length, 2);
  assert.equal(checks[0].name, 'build');
  assert.equal(checks[1].context, 'vercel', 'a commit status keeps its own spelling; normalizeCheck reads both');
  assert.ok(CHECK_CAP >= 20, 'enough checks that the verdict cannot change past the cap');
});

test('a PR with nothing on it maps without throwing', () => {
  const p = mapPr({ number: 7, state: 'MERGED' });
  assert.deepEqual([p.reviews, p.comments, p.commits, p.reviewRequests, p.statusCheckRollup], [[], [], [], [], []]);
  assert.deepEqual(whoseTurn(p, 'mitch'), { mine: false, role: null, turn: null, why: '' });
  assert.equal(mapPr(undefined).number, undefined);
});

test('the branch PR is the open one, else the most recent', () => {
  assert.equal(pickPr([{ state: 'CLOSED', number: 1 }, { state: 'OPEN', number: 2 }])?.number, 2);
  assert.equal(pickPr([{ state: 'CLOSED', number: 3 }, { state: 'MERGED', number: 1 }])?.number, 3, 'CREATED_AT desc, so the first is newest');
  assert.equal(pickPr([]), undefined);
});

test('an issue arrives with its comment count, not its comments', () => {
  const i = mapIssueNode({
    number: 12, title: 'Flaky CI', url: 'https://github.com/o/r/issues/12', state: 'OPEN',
    createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z', author: { login: 'dana' },
    labels: { nodes: [{ name: 'bug' }] }, assignees: { nodes: [{ login: 'mitch' }] }, comments: { totalCount: 14 },
  });
  assert.deepEqual(i.labels, [{ name: 'bug' }]);
  assert.deepEqual(i.assignees, [{ login: 'mitch' }]);
  assert.equal(i.comments.totalCount, 14, 'the count without a single body fetched');
  assert.equal(mapIssueNode({}).comments.totalCount, 0);
});
