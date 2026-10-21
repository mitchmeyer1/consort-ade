import { createHash } from "node:crypto";
import { suggestReviewers } from "../shared/headless.ts";
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

const THREADS = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    reviewThreads(first: 100, after: $cursor) { pageInfo { endCursor hasNextPage } nodes { id isResolved isOutdated path line comments(last: 100) { nodes { author { login } body url createdAt updatedAt } } } }
  } } }`;

export async function readPr(repoPath: string, number: number): Promise<PrState & { url: string; headSha: string }> {
  const j = JSON.parse(await gh(repoPath, ["pr", "view", String(number), "--json", "state,isDraft,reviewDecision,reviews,statusCheckRollup,reviewRequests,url,headRefOid,author"]));
  const nameWithOwner = JSON.parse(await gh(repoPath, ["repo", "view", "--json", "nameWithOwner"])).nameWithOwner as string;
  const [owner, name] = nameWithOwner.split("/");
  const threads: any[] = [];
  let cursor: string | undefined;
  do {
    const t = JSON.parse(await gh(repoPath, ["api", "graphql", "-f", `query=${THREADS}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${number}`, ...(cursor ? ["-f", `cursor=${cursor}`] : [])]));
    const connection = t.data?.repository?.pullRequest?.reviewThreads;
    if (t.errors?.length || !connection) throw new Error("GitHub review threads could not be read.");
    threads.push(...(connection.nodes ?? []));
    const next = connection.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : undefined;
    if (connection.pageInfo?.hasNextPage && (!next || next === cursor)) throw new Error("GitHub review thread pagination did not advance.");
    cursor = next;
  } while (cursor);
  const unresolved = threads.filter((th) => !th.isResolved).map((th) => {
    const first = [...(th.comments?.nodes ?? [])].reverse().find((c: any) => c.author?.login !== j.author?.login && !/\[bot\]$/.test(c.author?.login ?? "")) ?? {};
    return { threadId: String(th.id), id: `${th.id}:${first.updatedAt ?? first.createdAt ?? ""}:${createHash("sha256").update(String(first.body ?? "")).digest("hex").slice(0, 16)}`, author: String(first.author?.login ?? ""), path: th.path ?? undefined, line: th.line ?? undefined, body: `GitHub thread ID: ${th.id}\n${String(first.body ?? "")}\n\nThread context:\n${(th.comments?.nodes ?? []).map((c: any) => `${c.author?.login ?? "unknown"}: ${c.body ?? ""}`).join("\n\n")}`, url: String(first.url ?? j.url), createdAt: String(first.createdAt ?? "") };
  });
  // the latest verdict per reviewer is the one that counts
  const latest = new Map<string, string>();
  for (const r of ((j.reviews ?? []) as any[]).filter((r) => r.state && r.state !== "COMMENTED").sort((a, b) => String(a.submittedAt).localeCompare(String(b.submittedAt)))) latest.set(String(r.author?.login ?? ""), String(r.state));
  const approvals = [...latest.entries()].filter(([, s]) => s === "APPROVED").map(([a]) => a);
  const checks = (j.statusCheckRollup ?? []) as any[];
  const conclusions = checks.map((c) => String(c.conclusion ?? c.state ?? "").toUpperCase());
  const ci: PrState["ci"] = !checks.length ? "none" : conclusions.some((c) => ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"].includes(c)) ? "fail"
    : conclusions.every((c) => ["SUCCESS", "SUCCESSFUL", "SKIPPED", "NEUTRAL"].includes(c)) ? "pass" : "pending";
  return {
    feedback: (j.reviews ?? []).filter((r: any) => r.body?.trim() && ["CHANGES_REQUESTED", "COMMENTED"].includes(r.state)).map((r: any) => ({ id: `review:${r.id ?? r.author?.login}:${r.submittedAt}:${createHash("sha256").update(String(r.body)).digest("hex").slice(0, 16)}`, author: String(r.author?.login ?? ""), body: `Top-level review (no thread): ${r.body}`, url: j.url, createdAt: String(r.submittedAt ?? "") })),
    author: j.author?.login,
    state: j.state, isDraft: !!j.isDraft, reviewDecision: j.reviewDecision ?? "", approvals, changesRequestedBy: [...latest.entries()].filter(([, s]) => s === "CHANGES_REQUESTED").map(([a]) => a), unresolved, ci,
    requestedReviewers: ((j.reviewRequests ?? []) as any[]).map((r) => String(r.login ?? r.name ?? "")).filter(Boolean),
    url: j.url, headSha: j.headRefOid,
  };
}

/** Validate actual repository access, not merely username-shaped strings. */
export async function validateReviewers(repoPath: string, logins: string[]): Promise<string[]> {
  const name = (await gh(repoPath, ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"])).trim();
  const valid: string[] = [];
  for (const login of logins) {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(login)) continue;
    const result = await gh(repoPath, ["api", `repos/${name}/collaborators/${login}/permission`]).then(JSON.parse).catch(() => undefined);
    if (result?.user?.login && result.user.type !== "Bot" && ["read", "pull", "triage", "write", "push", "maintain", "admin"].includes(result.permission)) valid.push(result.user.login);
  }
  return [...new Set(valid)];
}
export async function requestReviewers(repoPath: string, number: number, logins: string[]): Promise<void> {
  if (!logins.length) return;
  await gh(repoPath, ["pr", "edit", String(number), "--add-reviewer", logins.join(",")]);
  const actual = JSON.parse(await gh(repoPath, ["pr", "view", String(number), "--json", "reviewRequests"]));
  const pending = new Set((actual.reviewRequests ?? []).map((r: { login?: string }) => r.login?.toLowerCase()));
  const missing = logins.filter(n => !pending.has(n.toLowerCase()));
  if (missing.length) throw new Error(`GitHub did not record review requests for ${missing.map(n => "@" + n).join(", ")}.`);
}

/** who touched the files this branch changes, from the history those files already have */
export async function shortlogForBranch(worktree: string, base: string): Promise<string> {
  const files = (await run("git", ["diff", "--name-only", `${base}...HEAD`], { cwd: worktree, maxBuffer: 1 << 22 })).stdout.split("\n").filter(Boolean);
  if (!files.length) return "";
  return (await run("git", ["shortlog", "-sne", base, "--", ...files.slice(0, 200)], { cwd: worktree, maxBuffer: 1 << 22 })).stdout;
}

export const whoAmI = (repoPath: string) => gh(repoPath, ["api", "user", "-q", ".login"]).then((s) => s.trim()).catch(() => "");


/** Use real GitHub identities; prefer contributors to changed files, then repository contributors. */
export async function reviewerSuggestions(worktree: string, base: string, exclude: string[]): Promise<string[]> {
  const [shortlog, name] = await Promise.all([
    shortlogForBranch(worktree, base).catch(() => ""),
    gh(worktree, ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]).then((s) => s.trim()),
  ]);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name)) throw new Error("GitHub repository identity is unavailable.");
  const pages = JSON.parse(await gh(worktree, ["api", `repos/${name}/contributors?per_page=100`, "--paginate", "--slurp"]));
  const rows: { login?: string; contributions?: number; type?: string }[] = Array.isArray(pages) ? pages.flat() : [];
  const excluded = new Set(exclude.map((n) => n.toLowerCase()));
  const contributors = rows.filter((r) => r.type !== "Bot" && r.login && /^[A-Za-z0-9-]+$/.test(r.login) && !excluded.has(r.login.toLowerCase()))
    .sort((a, b) => (b.contributions ?? 0) - (a.contributions ?? 0));
  const known = new Map(contributors.map((r) => [r.login!.toLowerCase(), r.login!]));
  const touched = suggestReviewers(shortlog, exclude, 100).map((n) => known.get(n.toLowerCase())).filter((n): n is string => !!n);
  return [...new Set([...touched, ...contributors.map((r) => r.login!)])].slice(0, 2);
}
