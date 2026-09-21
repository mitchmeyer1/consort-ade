/** Whose move a pull request is waiting on, the same rule for the project page list and the worktree's own PR. */
export type PrTurn = { mine: boolean; role: "author" | "reviewer" | null; turn: "yours" | "theirs" | null; why: string };

/** the fields of a `gh pr list/view --json` payload the rule reads */
export const TURN_FIELDS = "author,reviewRequests,reviews,comments,commits";

// ponytail: "turn" = who acted last (review/comment/commit), with a pending review request always yours
export function whoseTurn(p: any, me: string): PrTurn {
  const isAuthor = p.author?.login === me;
  const requested = (p.reviewRequests ?? []).some((r: any) => r.login === me);
  const acts: { who: string; at: string; what: string }[] = [
    ...(p.reviews ?? []).map((r: any) => ({ who: r.author?.login, at: r.submittedAt, what: `${(r.state ?? "reviewed").toLowerCase().replace("_", " ")}` })),
    ...(p.comments ?? []).map((c: any) => ({ who: c.author?.login, at: c.createdAt, what: "commented" })),
    ...(p.commits ?? []).flatMap((c: any) => (c.authors ?? []).map((a: any) => ({ who: a.login, at: c.committedDate, what: "pushed" }))),
  ].filter((a) => a.who && a.at && a.who !== "github-actions" && a.who !== "claude").sort((a, b) => a.at.localeCompare(b.at));
  const iActed = acts.some((a) => a.who === me);
  const role = isAuthor ? "author" : requested || iActed ? "reviewer" : null;
  if (!role) return { mine: false, role, turn: null, why: "" };
  if (requested) return { mine: true, role, turn: "yours" as const, why: "review requested" };
  const last = acts[acts.length - 1];
  if (!last) return { mine: true, role, turn: isAuthor ? ("theirs" as const) : ("yours" as const), why: isAuthor ? "waiting on reviewers" : "not reviewed yet" };
  if (last.who === me) return { mine: true, role, turn: "theirs" as const, why: `you ${last.what} last` };
  return { mine: true, role, turn: "yours" as const, why: `${last.who} ${last.what}` };
}
