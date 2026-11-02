import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * A repository's own review policy, kept at its root: rules with their severities, and suppressions.
 * Every Consort review reads both from the checkout it reviews, so each repository sets its own.
 */
export const REVIEW_RULES_FILE = ".ai-review-rules.md";
export const REVIEW_IGNORE_FILE = ".ai-review-ignore.md";

/** what a review prompt says about the policy files the checkout at `worktree` has */
export function reviewPolicyNote(worktree: string): string {
  const rules = existsSync(join(worktree, REVIEW_RULES_FILE))
    ? `The repository's own review rules are in ${REVIEW_RULES_FILE}: read them first; a rule's stated severity always wins.`
    : `The repository has no ${REVIEW_RULES_FILE}; judge by its existing conventions.`;
  const ignore = existsSync(join(worktree, REVIEW_IGNORE_FILE))
    ? ` Its suppressions are in ${REVIEW_IGNORE_FILE}: drop any finding one of them covers, matched by meaning rather than wording.`
    : "";
  return rules + ignore;
}

/** the note as a section of the pr-writeup review, whose readers share context through its brief */
export function reviewPolicySection(worktree: string): string {
  return `## The repository's review policy\n\n${reviewPolicyNote(worktree)} Put this in .consort/pr-review/brief.md so every reader applies it, and apply it again when you verify and settle severities.`;
}
