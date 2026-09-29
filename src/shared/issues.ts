/** GitHub issues: the list on the project page, the worktree that solves one, and the opening prompt */

export type IssueInfo = {
  number: number; title: string; author: string; state: "OPEN" | "CLOSED"; url: string;
  labels: string[]; assignees: string[]; comments: number; createdAt: string; updatedAt: string;
};
/** a full issue for the opening prompt: the list fields plus body and discussion */
export type IssueDetail = IssueInfo & { body: string; discussion: { author: string; at: string; body: string }[] };
/** the issue a worktree is linked to, carried on its status like the PR is */
export type IssueLink = { number: number; title: string; state: "OPEN" | "CLOSED"; url: string };

/** the branch and folder a "Branch and solve" worktree gets; the branch name is the link back to the issue */
import { withBranchPrefix } from "./ship.ts";

/** the branch Branch and solve makes for an issue, under the prefix from Settings when there is one */
export const issueBranch = (n: number, prefix?: string) => withBranchPrefix(prefix, `issue/${n}`);
export const issueFolder = (n: number) => `issue-${n}`;
/** the issue a branch was made for, or undefined when the branch is not an issue branch */
export function issueNumberOf(branch: string | undefined) {
  const m = /(?:^|\/)issue\/(\d+)$/.exec(branch ?? "");
  return m ? Number(m[1]) : undefined;
}
export const issueChatName = (issue: { number: number }) => `Issue #${issue.number}`;

/** how many rows the project page shows before "show all" */
export const ISSUE_ROWS = 15;

const BODY_CAP = 12_000;
const COMMENT_CAP = 1_500;
const COMMENTS_MAX = 12;
const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…[${s.length - n} more characters trimmed]` : s);

/**
 * The prompt that opens an issue chat: understand the issue, pitch a plan, ask what is not obvious,
 * and stop. Nothing here asks for code; the user takes it from the plan.
 */
export function issueBriefPrompt(issue: IssueDetail, opts: { repo: string; worktreePath: string; branch: string }) {
  const meta = [
    `opened by @${issue.author || "unknown"}`,
    issue.labels.length ? `labels: ${issue.labels.join(", ")}` : "",
    issue.assignees.length ? `assigned to ${issue.assignees.map((a) => `@${a}`).join(", ")}` : "",
    issue.state === "CLOSED" ? "currently closed" : "",
  ].filter(Boolean).join(" · ");
  const discussion = issue.discussion.slice(-COMMENTS_MAX).map((c) => `### @${c.author || "unknown"} · ${c.at}\n${cap(c.body.trim(), COMMENT_CAP)}`).join("\n\n");
  return `You are picking up GitHub issue #${issue.number} in ${opts.repo}: "${issue.title}" (${issue.url}), ${meta}.
This worktree at ${opts.worktreePath} is on branch ${opts.branch}, created for this issue.

## Issue

${cap(issue.body.trim() || "(no description)", BODY_CAP)}
${discussion ? `\n## Discussion (${issue.discussion.length} comment${issue.discussion.length === 1 ? "" : "s"}${issue.discussion.length > COMMENTS_MAX ? `, last ${COMMENTS_MAX} shown` : ""})\n\n${discussion}\n` : ""}
## What to do now

This turn is analysis and a plan only. Do not write or edit code, do not create files, and do not commit or push. You may read the codebase, search it, and run read-only commands so the plan is grounded in the real code.

1. Read the parts of the repository the issue touches, enough to know where the change lands and what it affects.
2. Reply with a brief, concise summary of the issue in your own words: what is wrong or missing, who it affects, and why it matters. Two or three sentences.
3. Then give a numbered plan to solve it: the files or modules that change, what changes in each, anything risky or ambiguous, and how you will verify the result (tests to add or run, what to check by hand).
4. If the issue leaves business or product questions open that the code cannot answer (expected behavior in edge cases, scope, priority, who the change is for, whether something is a bug or intended), list them as explicit questions for Mitch. Do not guess at the answers or silently pick one. Skip this section when nothing is genuinely unclear.

End by asking whether to proceed with the plan. Do not start implementing until told to.`;
}
