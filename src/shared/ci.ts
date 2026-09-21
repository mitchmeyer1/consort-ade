/** Where the pushed commit stands with CI: every check run and commit status GitHub reports for it, folded into one state. */

export type CiState = "pass" | "fail" | "pending";
export type CiCheck = { name: string; state: CiState; url?: string };
export type CiInfo = {
  state: CiState;
  /** checks GitHub knows for the commit, after de-duplicating re-runs by name */
  total: number;
  failed: number;
  pending: number;
  /** names of the failing checks, in the order GitHub listed them */
  failing: string[];
  /** where a click should go: the first failing run, else the checks page or first run */
  url?: string;
};

/** GitHub speaks two dialects: check runs (status + conclusion) and commit statuses (state). Both land here. */
export function checkState(raw: { status?: string | null; conclusion?: string | null; state?: string | null }): CiState {
  const word = String(raw.conclusion || raw.state || raw.status || "").toUpperCase();
  if (/FAIL|ERROR|CANCEL|TIMED_OUT|ACTION_REQUIRED/.test(word)) return "fail";
  if (/SUCCESS|NEUTRAL|SKIPPED|COMPLETED/.test(word)) return "pass";
  return "pending";
}

/** one shape from `gh pr view --json statusCheckRollup`, `/commits/:sha/check-runs`, and `/commits/:sha/status` items */
export function normalizeCheck(raw: any): CiCheck | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const name = String(raw.name ?? raw.context ?? raw.workflowName ?? "").trim();
  if (!name) return undefined;
  // a check run that is still queued has a null conclusion; its status carries the truth
  const state = raw.conclusion || raw.state ? checkState(raw) : checkState({ status: raw.status });
  const url = raw.detailsUrl ?? raw.details_url ?? raw.html_url ?? raw.targetUrl ?? raw.target_url ?? undefined;
  return { name, state, url: typeof url === "string" && url ? url : undefined };
}

/** Fold checks into one verdict. Re-runs share a name; the last one listed wins, matching what GitHub shows. */
export function summarizeChecks(raws: unknown[], fallbackUrl?: string): CiInfo | undefined {
  const byName = new Map<string, CiCheck>();
  for (const raw of raws) {
    const check = normalizeCheck(raw);
    if (check) byName.set(check.name, check);
  }
  const checks = [...byName.values()];
  if (!checks.length) return undefined;
  const failing = checks.filter((c) => c.state === "fail");
  const pending = checks.filter((c) => c.state === "pending").length;
  const state: CiState = failing.length ? "fail" : pending ? "pending" : "pass";
  return {
    state, total: checks.length, failed: failing.length, pending, failing: failing.map((c) => c.name),
    url: failing[0]?.url ?? fallbackUrl ?? checks[0]?.url,
  };
}

/** the badge text: a glyph, "CI", and a count only when something is wrong */
export function ciLabel(ci: CiInfo) {
  if (ci.state === "fail") return `✗ CI ${ci.failed}`;
  if (ci.state === "pending") return "◌ CI";
  return "✓ CI";
}

/** the hover text: what happened and, when failing, to which checks */
export function ciTitle(ci: CiInfo) {
  const n = ci.total === 1 ? "1 check" : `${ci.total} checks`;
  if (ci.state === "fail") return `${ci.failed} of ${n} failing: ${ci.failing.join(", ")}`;
  if (ci.state === "pending") return `${ci.pending} of ${n} still running`;
  return ci.total === 1 ? "The check passed" : `All ${ci.total} checks passed`;
}
