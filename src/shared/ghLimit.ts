/**
 * GitHub's GraphQL budget — 5000 points an hour for the whole account — is the scarcest thing
 * the app spends. Every `gh pr view`, `gh pr list` and `gh issue list` with nested fields
 * (reviews, comments, commits) is a GraphQL query costing far more than one point, while
 * `gh api repos/...` is REST on a separate budget. Exhaust GraphQL and the PR, turn and issue
 * chips all vanish at once while the CI chip carries on, because CI is the only one on REST.
 *
 * Two ways to hold off, in order of preference. Every GraphQL query in `ghQuery.ts` asks for
 * `rateLimit` alongside its data, so the usual case is that we see the budget running down and
 * stop at the reserve, waiting for the exact refill GitHub names. When we are told no anyway —
 * a secondary limit, a query written elsewhere, another machine on the same account — we fall
 * back to guessing: a backoff that starts short and doubles, because the real reset can be an
 * hour out and we would rather find out early than blank the chips for the whole hour. Either
 * way, callers serve the last good answer instead of nothing.
 */
export const FIRST_BACKOFF = 60_000;
export const MAX_BACKOFF = 15 * 60_000;
/**
 * Points kept back for everything that is not this app: the user's own `gh` in a terminal, a
 * `gh pr create` from a chat, the review runner. We stop polling at the floor rather than at
 * zero so those still work, and so GitHub never has to refuse us in the first place.
 */
export const RESERVE = 250;

/** what a GraphQL reply says about the budget, from the `rateLimit` field every query asks for */
export type RateSnapshot = { remaining?: number | null; resetAt?: string | number | null; cost?: number | null };

/** the wording gh and the API use when the account is over its budget, primary or secondary */
export function isRateLimit(error: unknown): boolean {
  const text = typeof error === "string" ? error
    : `${(error as any)?.stderr ?? ""} ${(error as any)?.stdout ?? ""} ${(error as Error)?.message ?? ""}`;
  return /rate limit (?:already )?exceeded|graphql_rate_limit|secondary rate limit|exceeded a secondary rate/i.test(text);
}

/** A shared "is GitHub talking to us right now" gate, one per process. */
export class GhBudget {
  private until = 0;
  private wait = FIRST_BACKOFF;
  /** when the account's real hourly budget refills, while we are holding off for it */
  private refill = 0;
  private left: number | undefined;

  /** true while we are backing off: callers should skip the query and use whatever they cached */
  blocked(now = Date.now()) { return now < this.until || now < this.refill; }

  /** when the hold lifts — GitHub's own refill when we have it, else the end of the backoff; 0 when open */
  resetsAt(now = Date.now()) { return this.blocked(now) ? Math.max(this.until, this.refill) : 0; }

  /** points left in the hour as of the last reply, undefined before the first one */
  remaining() { return this.left; }

  /**
   * A reply's `rateLimit`. Reading it is what lets us stop *before* GitHub starts refusing:
   * under the reserve we wait for the real refill, which is exact, rather than guessing with a
   * doubling backoff that can spend the whole hour a minute at a time.
   */
  saw(rate: RateSnapshot | undefined | null, now = Date.now()) {
    if (typeof rate?.remaining !== "number") return;
    this.left = rate.remaining;
    const at = typeof rate.resetAt === "string" ? Date.parse(rate.resetAt) : typeof rate.resetAt === "number" ? rate.resetAt : NaN;
    if (rate.remaining > RESERVE) this.refill = 0;
    else if (Number.isFinite(at) && at > now) this.refill = at;
  }

  /** record a failed call; true when it was a rate limit and a backoff is now in force */
  note(error: unknown, now = Date.now()): boolean {
    if (!isRateLimit(error)) return false;
    this.until = now + this.wait;
    this.wait = Math.min(this.wait * 2, MAX_BACKOFF);
    return true;
  }

  /**
   * A call got through, so the guessed backoff is over. The refill hold is not cleared here:
   * a query can succeed and still report the budget nearly gone, which is exactly the case we
   * want to stop on.
   */
  ok() { this.until = 0; this.wait = FIRST_BACKOFF; }
}

/** the one budget every gh caller in main shares */
export const ghBudget = new GhBudget();
