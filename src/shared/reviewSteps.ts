/**
 * The three steps of a Consort PR review, shared by the CLI review scanner (src/cli/reviewJob.ts) and the
 * desktop app's PR review (appReviewPrompt below), so both split the work across models the same way:
 * the frontier model (Fable or Astra) reads the repository and plans the areas, one reviewer per area
 * runs on Opus or Sol, and the frontier model verifies the findings.
 */
// value imports carry the extension: tests load this module straight into Node, which resolves relative imports literally
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ARTICLE_RULES } from "./prArticle.ts";
import { reviewPolicyNote } from "./reviewPolicy.ts";

export type ReviewTarget = { repo: string; pr: number; url: string; title: string; author: string; head: string; base: string; /** 1 for the first review, +1 each time the author asks again */ round?: number };
export type ReviewSlice = { id: string; title: string; files: string[]; related?: string[]; focus?: string };

/** where the CLI review keeps its working files */
const CLI_DIR = ".consort/review";
/** where the desktop app's review keeps its working files, next to the review file it renders */
export const APP_DIR = ".consort/pr-review";

export const OVERVIEW_PROMPT = (t: ReviewTarget, wt: string, dir = CLI_DIR, app = false) => `## Review step 1 of 3: understand the repository and plan the review

You lead an automatic review of PR #${t.pr} "${t.title}" by @${t.author} into ${t.base}. The PR head is checked out in this worktree. Do not change source files; write only under ${dir}/.
${reviewPolicyNote(wt)}

1. Learn how this repository is built: its layout and layering, where each kind of code lives, naming, data access, error handling, config and secrets, background jobs, tests, and how existing features are organised so they scale. Read the docs and the existing modules closest to what the PR touches.
2. Read the change: \`git diff origin/${t.base}...HEAD --stat\`, then the diff itself.
3. Write ${dir}/OVERVIEW.md: a 2-3 sentence TL;DR of what the PR does; the conventions and rules that apply to it; where it could break at scale; the risky areas.
4. Write ${dir}/plan.json: {"tldr": "<2-3 sentences>", ${app ? "" : `"emoji": "<one emoji that pictures what this PR changes, e.g. 🚀 for a deploy fix, 🧭 for navigation; never 🔎>", "title": "<2-5 plain words naming the change>", `}"slices": [{"id": "s1", "title": "<area>", "files": ["<changed files in this area>"], "related": ["<callers, similar existing modules, schemas to compare against>"], "focus": "<what to check here>"}]${app ? "" : `, "article": {"category", "headline", "body", "diagram", "caption", "flows"}`}}. 1 to 10 slices proportional to scope (one for a small change), together covering every changed file, each small enough for one reviewer to crawl thoroughly. Group by area of the code, not by commit.
${app ? "" : `${ARTICLE_RULES}\n`}Reply with one line when both files are written.`;

export const SLICE_PROMPT = (t: ReviewTarget, wt: string, slice: ReviewSlice, dir = CLI_DIR) => `## Review one area of PR #${t.pr} "${t.title}"

Read ${dir}/OVERVIEW.md first. ${reviewPolicyNote(wt)}
Your area: ${slice.title}
Changed files: ${slice.files.join(", ")}
${slice.related?.length ? `Compare against: ${slice.related.join(", ")}\n` : ""}${slice.focus ? `Focus: ${slice.focus}\n` : ""}
Crawl: read each changed file in full, the code that calls it, and the existing code that does the same kind of thing, so you judge it against how this repository already works. The diff is \`git diff origin/${t.base}...HEAD -- <file>\`.
Flag, with evidence:
- correctness bugs and broken flows;
- what will not scale: unbounded queries or loops, N+1 queries, missing pagination or indexes, heavy work per request, memory growth, missing limits or timeouts;
- convention breaks: code in the wrong layer or folder, naming that differs from its neighbours, a new pattern where a shared helper or existing pattern exists, duplicated logic, organisation that will not hold as the feature grows;
- security and secrets handling, missing tests for new behaviour, and every violation of .ai-review-rules.md at the rule's severity.
Do not flag what a linter or formatter catches, or taste with no consequence. Point each finding at a changed line at the PR head when you can.
Severity: critical = breaks production, data or security; high = a real bug, or a scaling or convention problem that must be fixed before merge; medium = should be fixed; low = worth a mention.
Reply with [review-findings] followed by a \`\`\`json array: [{"severity", "category": "logic|redundant|style|tests|comments|scaling", "title": "<the consequence, one line>", "file", "line", "problem", "fix", "comment": "<the GitHub comment to post: plain, direct, 1-4 sentences, with the fix>"}]. An empty array when you find nothing.`;

export const FINAL_PROMPT = (t: ReviewTarget, wt: string, reviewers: number, dir = CLI_DIR) => `## Review step 3 of 3: verify and settle the findings

${reviewers} reviewers' raw findings for PR #${t.pr} are in ${dir}/swarm.json. ${reviewPolicyNote(wt)}
${existsSync(join(wt, dir, "previous.json")) ? `This is round ${t.round ?? 2}: the author changed the PR after an earlier review. The earlier findings are in ${dir}/previous.json. Check each one at the new head first: drop it if it is fixed; if it is not, keep it with its title starting "Still open: ".
` : ""}For each finding, open the file at that line and check it is real at the PR head. Drop false positives and anything a linter catches; merge duplicates; move file/line to a changed line where you can; settle the severity (a rule in .ai-review-rules.md wins; otherwise critical = breaks production, data or security; high = a real bug or a scaling or convention problem that must be fixed before merge; medium = should fix; low = worth a mention); tighten each comment so it is ready to post.
Reply with [review-final] followed by a \`\`\`json object: {"summary": "<1-2 plain sentences: the work this PR does>", "flows": ["<1 to 4 entries, one sentence each: a user or system flow this PR changes and what now happens in it>"], "headline": "<one-line verdict>", "findings": [same shape as the raw findings]}.`;

/**
 * The desktop app's PR review as one chat turn that runs the CLI review's three steps. The chat runs on the
 * frontier model and does steps 1 and 3 itself; step 2 is one reviewer agent per area on `delegate`
 * (Opus or Sol), each of which writes its findings to a file and dispatches no agents of its own. Every step
 * saves to .consort/pr-review/, so an interrupted review resumes where it stopped.
 */
export function appReviewPrompt(t: ReviewTarget, wt: string, delegate: string): string {
  const dir = APP_DIR;
  const area: ReviewSlice = { id: "<id>", title: "<title>", files: ["<files>"], related: ["<related>"], focus: "<focus>" };
  const slice = SLICE_PROMPT(t, wt, area, dir)
    .replace("Reply with [review-findings] followed by a ```json array:", `Write ${dir}/agents/<id>.json: a JSON array`)
    .replace("An empty array when you find nothing.", "An empty array when you find nothing. Then reply with one line: the number of findings. Do not dispatch agents yourself.");
  const final = FINAL_PROMPT(t, wt, 0, dir)
    .replace(/^## Review step 3 of 3: verify and settle the findings\n\n0 reviewers' raw findings for PR #\d+ are in [^ ]+swarm\.json\./, `The reviewers' raw findings are the files in ${dir}/agents/.`)
    .replace(/Reply with \[review-final\][\s\S]*$/, "");
  return `You lead Consort's review of PR #${t.pr} "${t.title}" by @${t.author} into ${t.base}, at head ${t.head.slice(0, 7)}, in ${wt}. It runs in three steps, the same way Consort's automatic CLI review does. Do not change source files and do not post to GitHub; write only under ${dir}/. Keep the user informed in chat with one short line when each step starts and ends.

## Models
You run steps 1 and 3 yourself. Step 2 is the reviewer agents' work on \`${delegate}\`: pass that model on every agent call. Never review an area yourself; a failed agent is dispatched again, not taken over.

## Resuming
Before step 1, look in ${dir}/: when plan.json exists, skip step 1; when agents/<id>.json exists for an area, do not dispatch that area again.

## Step 1 of 3: understand the repository and plan the review
${OVERVIEW_PROMPT(t, wt, dir, true).replace(/^## Review step 1 of 3[^\n]*\n\n[^\n]*\n/, "").replace(/\nReply with one line when both files are written\.$/, "")}

## Step 2 of 3: one reviewer per area
Dispatch one agent per slice in plan.json on \`${delegate}\`, every slice in one message, with \`run_in_background: false\`: a turn that ends while agents are still running loses their results. Each assignment is the text below with the slice's values filled in for <id>, <title>, <files>, <related> and <focus>; leave out the "Compare against" or "Focus" line when the slice has none. Do not read the diff yourself while they run.

<assignment>
${slice}
</assignment>

## Step 3 of 3: verify and settle the findings
${final.trim()}

## The review file
Write ${dir}/pr-${t.pr}.review.json:
{"version": 1, "repo": "${t.repo}", "pr": ${t.pr}, "url": "${t.url}", "title": ${JSON.stringify(t.title)}, "head": "${t.head}", "base": "${t.base}", "reviewedAt": "<ISO time now>", "whatItDoes": "<1-2 plain sentences: the work this PR does>", "headline": "<one-line verdict>", "method": "Consort review: frontier overview, ${delegate} reviewer per area, frontier verification", "flows": [], "appendix": [], "wellBuilt": [], "orderOfWork": [], "submissions": [], "findings": [{"id": "F1", "kind": "defect", "severity", "category", "title", "file", "line", "problem", "fix", "comment", "status": "pending"}]}
Consort renders that file and lets the user approve or ignore each finding and post the approved ones, so do not post comments yourself. Print a short summary in chat: the finding counts by severity and the Critical and High titles. End with a clickable Markdown link to the review file using its absolute path.`;
}

/**
 * Ready .consort/pr-review/ for the app review of `head`. Work saved for the same head stays, so an
 * interrupted review resumes. Work from another head moves to a round folder, and the last review
 * file's findings become previous.json, so step 3 first checks whether the earlier findings were fixed.
 */
export function prepareAppReview(wt: string, pr: number, head: string): void {
  const dir = join(wt, APP_DIR);
  mkdirSync(join(dir, "agents"), { recursive: true });
  const headFile = join(dir, "head");
  const saved = existsSync(headFile) ? readFileSync(headFile, "utf8").trim() : "";
  if (saved === head) return;
  const work = [...["OVERVIEW.md", "plan.json", "previous.json"].filter((f) => existsSync(join(dir, f))), ...readdirSync(join(dir, "agents")).filter((f) => f.endsWith(".json")).map((f) => join("agents", f))];
  if (work.length) {
    const round = join(dir, `round-${saved.slice(0, 7) || Date.now()}`);
    mkdirSync(join(round, "agents"), { recursive: true });
    for (const f of work) renameSync(join(dir, f), join(round, f));
  }
  const review = join(dir, `pr-${pr}.review.json`);
  try {
    const findings = JSON.parse(readFileSync(review, "utf8"))?.findings;
    if (Array.isArray(findings) && findings.length) writeFileSync(join(dir, "previous.json"), JSON.stringify(findings, null, 2));
  } catch { /* no earlier review */ }
  writeFileSync(headFile, head);
}
