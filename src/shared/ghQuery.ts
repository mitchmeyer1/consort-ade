/**
 * The GraphQL the app asks GitHub for, written out by hand instead of left to `gh --json`.
 *
 * GitHub charges a GraphQL query for the nodes it *may* return, not the ones it does, and
 * `gh pr list --json reviews,comments,commits` asks every connection for its default 100. Thirty
 * PRs × four connections × 100 is twelve thousand nodes a poll — around 120 of the account's 5000
 * points an hour, every minute, before the issue list (another ~150) or the per-worktree PR query
 * join in. That is how a single open window spends the whole hourly budget in forty minutes and
 * blanks the chips with `API rate limit exceeded`.
 *
 * So every connection here is bounded to what the code downstream actually reads: `whoseTurn`
 * only ever looks at the newest act, and the issue list only wants a comment count. The shapes
 * the mappers return are the shapes `gh --json` returned, so `whoseTurn` and `mapIssue` are
 * untouched.
 */

/** open PRs the project page lists */
export const PR_PAGE = 30;
/** open issues the project page lists, showing 15 and expanding to the rest */
export const ISSUE_PAGE = 50;
/**
 * How far back a PR's history is read. `whoseTurn` sorts every act and keeps the last, so one
 * commit is all it can use; reviews and comments are tailed deep enough that "did I ever act
 * here" stays right on a busy PR without paying for a hundred.
 */
export const REVIEW_TAIL = 20;
export const COMMENT_TAIL = 20;
export const REQUEST_CAP = 10;
export const LABEL_CAP = 10;
export const ASSIGNEE_CAP = 10;
/** check runs folded into the CI chip; past this many the verdict cannot change */
export const CHECK_CAP = 40;

/** the head commit's rollup, the one extra thing a single PR is asked for */
const ROLLUP = `statusCheckRollup { contexts(first: ${CHECK_CAP}) { nodes {
        __typename
        ... on CheckRun { name status conclusion detailsUrl }
        ... on StatusContext { context state targetUrl }
      } } }`;

/** everything `whoseTurn` reads, at the smallest page that can answer it */
const turn = (extraCommitFields = "") => `
    author { login }
    reviewRequests(first: ${REQUEST_CAP}) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } } } }
    reviews(last: ${REVIEW_TAIL}) { nodes { author { login } state submittedAt } }
    comments(last: ${COMMENT_TAIL}) { nodes { author { login } createdAt } }
    commits(last: 1) { nodes { commit { committedDate authors(first: 2) { nodes { user { login } } } ${extraCommitFields} } } }`;

/** every reply carries the budget, free of charge, so the app can stop before GitHub has to say no */
const BUDGET = `rateLimit { cost remaining resetAt }`;

export const prListQuery = `query($owner: String!, $name: String!, $first: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: $first, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes {
      number title url state isDraft updatedAt reviewDecision headRefName${turn()}
    } }
  }
  ${BUDGET}
}`;

/** the PR for one worktree's branch, with the CI rollup the sidebar chip needs */
export const prByBranchQuery = `query($owner: String!, $name: String!, $branch: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(headRefName: $branch, first: 2, orderBy: { field: CREATED_AT, direction: DESC }) { nodes {
      number title url state isDraft updatedAt reviewDecision headRefName${turn(ROLLUP)}
    } }
  }
  ${BUDGET}
}`;

export const issueListQuery = `query($owner: String!, $name: String!, $first: Int!) {
  repository(owner: $owner, name: $name) {
    issues(states: OPEN, first: $first, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes {
      number title url state createdAt updatedAt
      author { login }
      labels(first: ${LABEL_CAP}) { nodes { name } }
      assignees(first: ${ASSIGNEE_CAP}) { nodes { login } }
      comments { totalCount }
    } }
  }
  ${BUDGET}
}`;

const nodesOf = (c: any): any[] => (Array.isArray(c?.nodes) ? c.nodes.filter(Boolean) : []);

/** a GraphQL pull request in the shape `gh pr view --json` handed back, so the rules above it do not change */
export function mapPr(n: any) {
  const head = nodesOf(n?.commits)[0]?.commit;
  return {
    number: n?.number, title: n?.title ?? "", url: n?.url ?? "", state: n?.state ?? "",
    isDraft: !!n?.isDraft, updatedAt: n?.updatedAt ?? "", reviewDecision: n?.reviewDecision ?? "",
    headRefName: n?.headRefName ?? "",
    author: n?.author ?? undefined,
    // a team review request has a slug where a user has a login; `whoseTurn` compares it to my login either way
    reviewRequests: nodesOf(n?.reviewRequests).map((r) => ({ login: r.requestedReviewer?.login ?? r.requestedReviewer?.slug ?? "" })),
    reviews: nodesOf(n?.reviews).map((r) => ({ author: r.author ?? undefined, state: r.state ?? "", submittedAt: r.submittedAt ?? "" })),
    comments: nodesOf(n?.comments).map((c) => ({ author: c.author ?? undefined, createdAt: c.createdAt ?? "" })),
    commits: nodesOf(n?.commits).map((c) => ({
      committedDate: c.commit?.committedDate ?? "",
      // a commit with no linked GitHub account has no login, and an act with no author is dropped downstream
      authors: nodesOf(c.commit?.authors).map((a) => ({ login: a.user?.login ?? "" })),
    })),
    statusCheckRollup: nodesOf(head?.statusCheckRollup?.contexts),
  };
}

/** a GraphQL issue in the shape `gh issue list --json` handed back */
export function mapIssueNode(n: any) {
  return {
    number: n?.number, title: n?.title ?? "", url: n?.url ?? "", state: n?.state ?? "",
    createdAt: n?.createdAt ?? "", updatedAt: n?.updatedAt ?? "", author: n?.author ?? undefined,
    labels: nodesOf(n?.labels), assignees: nodesOf(n?.assignees),
    comments: { totalCount: n?.comments?.totalCount ?? 0 },
  };
}

/**
 * Which of a branch's pull requests the chip means: the open one, else the most recent, matching
 * what `gh pr view` picked. A reopened branch can carry a closed PR and an open one at once.
 */
export function pickPr<T extends { state?: string }>(nodes: T[]): T | undefined {
  return nodes.find((p) => p?.state === "OPEN") ?? nodes.find(Boolean);
}
