/** Whose move a pull request is waiting on, the same rule for the project page list and the worktree's own PR. */
export type PrTurn = {
  mine: boolean; role: "author" | "reviewer" | null; turn: "yours" | "theirs" | null; why: string;
  /** your latest verdict on the PR is an approval (a later change request or dismissal cancels it; plain comments do not) */
  approved: boolean;
};

/** whether `me` currently approves the PR, judged by the last review of mine that carried a verdict */
export function approvedBy(p: any, me: string): boolean {
  const mine = (p.reviews ?? [])
    .filter((r: any) => r.author?.login === me && /^(APPROVED|CHANGES_REQUESTED|DISMISSED)$/.test(r.state ?? "") && r.submittedAt)
    .sort((a: any, b: any) => String(a.submittedAt).localeCompare(String(b.submittedAt)));
  return mine.length > 0 && mine[mine.length - 1].state === "APPROVED";
}

// the payload shape is whatever `mapPr` in ghQuery.ts produces, which is the shape gh's
// `--json author,reviewRequests,reviews,comments,commits` used to hand back
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
  const approved = approvedBy(p, me);
  if (!role) return { mine: false, role, turn: null, why: "", approved };
  if (requested) return { mine: true, role, turn: "yours" as const, why: "review requested", approved };
  const last = acts[acts.length - 1];
  if (!last) return { mine: true, role, turn: isAuthor ? ("theirs" as const) : ("yours" as const), why: isAuthor ? "waiting on reviewers" : "not reviewed yet", approved };
  if (last.who === me) return { mine: true, role, turn: "theirs" as const, why: `you ${last.what} last`, approved };
  return { mine: true, role, turn: "yours" as const, why: `${last.who} ${last.what}`, approved };
}
