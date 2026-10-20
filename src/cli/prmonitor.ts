import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PrState } from "../shared/headless";

/**
 * The PR as GitHub sees it, read with gh: state, approvals, unresolved review threads, CI. The
 * worker polls this on a timer once the PR is up, answers humans, and declares the PR ready on
 * shared/headless.ts prReadiness. Nothing here merges.
 */
const run = promisify(execFile);
const gh = async (cwd: string, args: string[]) => (await run("gh", args, { cwd, timeout: 60_000, maxBuffer: 1 << 23 })).stdout;

const THREADS = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    reviewThreads(first: 100) { nodes { id isResolved isOutdated path line comments(first: 30) { nodes { author { login } body url createdAt } } } }
  } } }`;

export async function readPr(repoPath: string, number: number): Promise<PrState & { url: string; headSha: string }> {
  const j = JSON.parse(await gh(repoPath, ["pr", "view", String(number), "--json", "state,isDraft,reviewDecision,reviews,statusCheckRollup,reviewRequests,url,headRefOid"]));
  const nameWithOwner = JSON.parse(await gh(repoPath, ["repo", "view", "--json", "nameWithOwner"])).nameWithOwner as string;
  const [owner, name] = nameWithOwner.split("/");
  const t = JSON.parse(await gh(repoPath, ["api", "graphql", "-f", `query=${THREADS}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${number}`]));
  const threads = (t.data?.repository?.pullRequest?.reviewThreads?.nodes ?? []) as any[];
  const unresolved = threads.filter((th) => !th.isResolved).map((th) => {
    const first = [...(th.comments?.nodes ?? [])].reverse().find((c: any) => !/\[bot\]$/.test(c.author?.login ?? "")) ?? {};
    return { id: `${th.id}:${first.createdAt ?? ""}`, author: String(first.author?.login ?? ""), path: th.path ?? undefined, line: th.line ?? undefined, body: `GitHub thread ID: ${th.id}\n${String(first.body ?? "")}`, url: String(first.url ?? j.url), createdAt: String(first.createdAt ?? "") };
  });
  // the latest verdict per reviewer is the one that counts
  const latest = new Map<string, string>();
  for (const r of ((j.reviews ?? []) as any[]).filter((r) => r.state && r.state !== "COMMENTED").sort((a, b) => String(a.submittedAt).localeCompare(String(b.submittedAt)))) latest.set(String(r.author?.login ?? ""), String(r.state));
  const approvals = [...latest.entries()].filter(([, s]) => s === "APPROVED").map(([a]) => a);
  const checks = (j.statusCheckRollup ?? []) as any[];
  const conclusions = checks.map((c) => String(c.conclusion ?? c.state ?? "").toUpperCase());
  const ci: PrState["ci"] = !checks.length ? "none" : conclusions.some((c) => ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(c)) ? "fail"
    : checks.some((c) => ["PENDING", "IN_PROGRESS", "QUEUED", "REQUESTED", "WAITING", ""].includes(String(c.status ?? c.state ?? "").toUpperCase()) && !c.conclusion) ? "pending" : "pass";
  return {
    feedback: (j.reviews ?? []).filter((r: any) => r.body?.trim() && ["CHANGES_REQUESTED", "COMMENTED"].includes(r.state)).map((r: any) => ({ id: `review:${r.id ?? r.author?.login}:${r.submittedAt}`, author: String(r.author?.login ?? ""), body: `Top-level review (no thread): ${r.body}`, url: j.url, createdAt: String(r.submittedAt ?? "") })),
    state: j.state, isDraft: !!j.isDraft, reviewDecision: j.reviewDecision ?? "", approvals, unresolved, ci,
    requestedReviewers: ((j.reviewRequests ?? []) as any[]).map((r) => String(r.login ?? r.name ?? "")).filter(Boolean),
    url: j.url, headSha: j.headRefOid,
  };
}

export const requestReviewers = (repoPath: string, number: number, logins: string[]) =>
  logins.length ? gh(repoPath, ["pr", "edit", String(number), "--add-reviewer", logins.join(",")]).then(() => undefined) : Promise.resolve();

/** who touched the files this branch changes, from the history those files already have */
export async function shortlogForBranch(worktree: string, base: string): Promise<string> {
  const files = (await run("git", ["diff", "--name-only", `${base}...HEAD`], { cwd: worktree, maxBuffer: 1 << 22 })).stdout.split("\n").filter(Boolean);
  if (!files.length) return "";
  return (await run("git", ["shortlog", "-sne", base, "--", ...files.slice(0, 200)], { cwd: worktree, maxBuffer: 1 << 22 })).stdout;
}

export const whoAmI = (repoPath: string) => gh(repoPath, ["api", "user", "-q", ".login"]).then((s) => s.trim()).catch(() => "");
