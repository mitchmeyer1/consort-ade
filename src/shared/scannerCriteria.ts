import type { Job } from "../cli/state.ts";

/** What a scanner picks up, in a few words: its filters, the reviewer it reviews for, or the Sentry projects it reads. */
export function scannerCriteria(j: Job): string {
  if (j.source === "review") return j.reviewer ? `PRs for @${j.reviewer}` : "assigned PRs";
  if (j.source === "sentry" && j.sentry) return [`project ${j.sentry.projects.join(", ")}`, j.sentry.environments.length ? `env ${j.sentry.environments.join(", ")}` : "", j.sentry.query].filter(Boolean).join("; ");
  const f = j.filters ?? {};
  const parts = [f.tags?.length ? `tag ${f.tags.join(", ")}` : "", f.statuses?.length ? `status ${f.statuses.join(", ")}` : "", f.assignees?.length ? `assignee ${f.assignees.join(", ")}` : "",
    f.nameIncludes?.length ? `name has ${f.nameIncludes.join(", ")}` : "", f.nameExcludes?.length ? `name without ${f.nameExcludes.join(", ")}` : ""].filter(Boolean);
  return parts.join("; ") || "everything";
}
