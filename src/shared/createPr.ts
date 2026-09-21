import type { WorktreeStatus } from "./types";

/** what the Create PR dialog sends: the branch is the worktree's own, the base its project's */
export type PrDraft = { title: string; body: string; draft: boolean };

/**
 * `origin/main` is how the project stores its base and how git names the tracking ref, but
 * GitHub wants the bare branch. A base with no remote prefix (a local-only ref) is used as-is.
 */
export const prBaseBranch = (base: string) => base.replace(/^origin\//, "");

/**
 * Whether the page should offer to open a PR: a real branch with no PR yet. A merged or closed
 * PR still counts as the branch's PR — GitHub would refuse a second one on the same head anyway,
 * and the badge already tells that story. The base branch itself never gets a PR to itself.
 */
export function canCreatePr(st: WorktreeStatus | null | undefined): st is WorktreeStatus {
  if (!st || st.pr) return false;
  if (!st.branch || st.branch === "?" || st.branch === "(detached)") return false;
  return st.branch !== prBaseBranch(st.base);
}

/**
 * Why the button is disabled, or nothing when a PR can be opened right now. HEAD already in the
 * base means there is nothing to compare, and GitHub would reject the PR with the same message.
 */
export function prBlockedBy(st: WorktreeStatus): string | undefined {
  if (st.inBase) return "Nothing to open a PR for: this branch adds no commits on top of " + st.base + ".";
  return undefined;
}

/** a starting title: the last commit's subject, else the branch name made readable */
export function suggestedPrTitle(st: Pick<WorktreeStatus, "branch" | "last">) {
  const subject = st.last?.subject.trim();
  if (subject) return subject;
  return st.branch.split("/").pop()!.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** the `gh pr create` argument list; head is passed explicitly so a stale upstream cannot redirect it */
export function prCreateArgs(o: PrDraft & { base: string; head: string }) {
  const title = o.title.trim();
  if (!title) throw new Error("Enter a PR title.");
  const args = ["pr", "create", "--title", title, "--body", o.body.trim(), "--base", prBaseBranch(o.base), "--head", o.head];
  if (o.draft) args.push("--draft");
  return args;
}

/** the PR URL `gh pr create` prints on its last line; stderr carries progress lines we skip */
export function prUrlIn(output: string) {
  return /https:\/\/\S+\/pull\/\d+/.exec(output)?.[0];
}

/** what the generator reads: the branch's commits and its diff against the base, already trimmed */
export type PrSummaryInput = { branch: string; base: string; commits: string; stat: string; patch: string };

/** the one-shot prompt behind the dialog's Generate button; the model answers title, blank line, bullets */
export function prSuggestionPrompt(i: PrSummaryInput) {
  return [
    `Write a pull request title and description for branch ${i.branch} against ${prBaseBranch(i.base)}.`,
    'Format: one title line in sentence case (max 70 chars, no trailing period), a blank line, then 2 to 6 bullets, each starting with "- ", each ONE concise sentence about what changed or why. No headings, no other text.',
    "", "Commits:", i.commits.trim() || "(none listed)", "", "Files changed:", i.stat.trim() || "(none)", "", "Diff:", i.patch,
  ].join("\n");
}

/**
 * The model's answer as title and body. The first non-empty line is the title, stripped of the
 * markdown or quoting a model sometimes adds; whatever follows the first blank line is the body.
 * A one-line answer is a title with no body, and a body without bullets is kept as written.
 */
export function parsePrSuggestion(text: string): { title: string; body: string } {
  const lines = text.replace(/\r/g, "").split("\n");
  const first = lines.findIndex((l) => l.trim());
  if (first < 0) return { title: "", body: "" };
  const title = lines[first].trim().replace(/^(#+\s*|title:\s*|\*\*|"|')+/i, "").replace(/(\*\*|"|'|\.)+$/g, "").trim();
  const body = lines.slice(first + 1).join("\n").trim().replace(/^description:\s*/i, "").replace(/^[*•]\s+/gm, "- ").trim();
  return { title, body };
}
