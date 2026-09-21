import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promises as fs } from "node:fs";
import type { CommitInfo, PrInfo, RepoInfo, WorktreeStatus } from "../shared/types";
import type { Commit } from "../shared/contributors";
// the extension matters: tests load this module straight into Node, which resolves relative imports literally
import { latestPushRuns, summarizeChecks, type CiInfo } from "../shared/ci.ts";
import { issueNumberOf, type IssueDetail, type IssueInfo, type IssueLink } from "../shared/issues.ts";
import { whoseTurn } from "../shared/prTurn.ts";
import { ghBudget } from "../shared/ghLimit.ts";
import { ISSUE_PAGE, PR_PAGE, issueListQuery, mapIssueNode, mapPr, pickPr, prByBranchQuery, prListQuery } from "../shared/ghQuery.ts";
import { prCreateArgs, prUrlIn, type PrDraft, type PrSummaryInput } from "../shared/createPr.ts";

const run = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (await run("git", args, { cwd, maxBuffer: 1 << 24 })).stdout;

export async function isRepo(path: string) {
  return git(path, "rev-parse", "--show-toplevel").then(() => true, () => false);
}

export async function listWorktrees(repo: string) {
  const out = await git(repo, "worktree", "list", "--porcelain");
  return out
    .split("\n\n")
    .filter(Boolean)
    .map((blk) => {
      const get = (k: string) => blk.split("\n").find((l) => l.startsWith(k + " "))?.slice(k.length + 1);
      const path = get("worktree")!;
      return { path, branch: get("branch")?.replace("refs/heads/", "") ?? "(detached)", name: basename(path) };
    });
}

export async function addWorktree(repo: string, name: string, branch: string, base: string) {
  const directory = resolve(repo, ".consort-worktrees");
  const path = resolve(directory, name);
  const child = relative(directory, path);
  if (!name.trim() || !child || child === ".." || child.startsWith("../") || isAbsolute(child)) {
    throw new Error("Worktree name must identify a folder inside .consort-worktrees.");
  }
  // The common exclude file applies across branches without dirtying .gitignore.
  const exclude = (await git(repo, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude")).trim();
  let current = "";
  try { current = await fs.readFile(exclude, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!current.split(/\r?\n/).includes("/.consort-worktrees/")) {
    await fs.mkdir(dirname(exclude), { recursive: true });
    await fs.appendFile(exclude, `${current && !current.endsWith("\n") ? "\n" : ""}/.consort-worktrees/\n`);
  }
  await git(repo, "fetch", "--quiet").catch(() => {});
  const exists = await git(repo, "rev-parse", "--verify", "--quiet", branch).then(() => true, () => false);
  if (exists) await git(repo, "worktree", "add", path, branch);
  else await git(repo, "worktree", "add", "-b", branch, path, base);
  return path;
}

export async function removeWorktree(repo: string, path: string) {
  await git(repo, "worktree", "remove", "--force", path);
}

/** the gh login, fetched once per process; it does not change while the app runs */
let meMemo: Promise<string> | undefined;
const whoAmI = (cwd: string) => (meMemo ??= run("gh", ["api", "user", "-q", ".login"], { cwd, timeout: 10_000 }).then((r) => r.stdout.trim(), () => { meMemo = undefined; return ""; }));

/**
 * The PR for a worktree, asked for by branch. The sidebar polls every worktree on a timer, so
 * it is memoized per path for a minute. Critically, a failed fetch (a GitHub rate limit, a
 * network blip) serves the last good value rather than undefined: the chip must not vanish just
 * because one poll was throttled. `null` is a real answer — this branch has no PR — and is
 * cached like any other.
 */
const prMemo = new Map<string, { at: number; value: PrInfo | null }>();
async function prInfo(path: string): Promise<PrInfo | undefined> {
  const hit = prMemo.get(path);
  if (hit && Date.now() - hit.at < 60_000) return hit.value ?? undefined;
  // over the GraphQL budget: asking again only keeps it pinned, and the cached PR is still true
  if (ghBudget.blocked()) return hit?.value ?? undefined;
  try {
    const [ref, branch, me] = await Promise.all([repoRef(path), headBranch(path), whoAmI(path)]);
    // no GitHub remote, or nothing to match a PR against: not an answer, so nothing is cached
    if (!ref?.owner || !ref.name || !branch) return hit?.value ?? undefined;
    const data = await graphql<any>(path, prByBranchQuery, { owner: ref.owner, name: ref.name, branch });
    ghBudget.ok();
    const node = pickPr(nodes(data?.repository?.pullRequests));
    // GitHub answered and this branch has no PR: a definite no, cached like any other
    if (!node) { prMemo.set(path, { at: Date.now(), value: null }); return undefined; }
    const j = mapPr(node);
    const info: PrInfo = { number: j.number, state: j.state, draft: j.isDraft, url: j.url, title: j.title, author: j.author?.login ?? "", review: j.reviewDecision ?? "", checks: j.statusCheckRollup, ...whoseTurn(j, me) };
    prMemo.set(path, { at: Date.now(), value: info });
    return info;
  } catch (error) {
    ghBudget.note(error);
    // a rate limit or an offline laptop leaves the last good value in place, refreshed to now
    // so a throttled API is not hammered
    if (hit) { prMemo.set(path, { at: Date.now(), value: hit.value }); return hit.value ?? undefined; }
    return undefined;
  }
}

/** several panels poll the same worktree every 15s; one fetch per branch per half-minute is plenty */
const ciMemo = new Map<string, { at: number; value: Promise<CiInfo | undefined> }>();
/**
 * CI for a branch with no PR, asked by branch name so it is really this branch's: the local
 * tracking ref can lag when pushes came from another checkout, and a commit shared with the base
 * carries the base's own check runs, which would pin the base's red CI on a green branch.
 */
async function branchChecks(path: string, branch: string): Promise<CiInfo | undefined> {
  const key = `${path}\0${branch}`;
  const hit = ciMemo.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.value;
  const value = (async () => {
    const runs = await gh(path, ["api", `repos/{owner}/{repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=40`]);
    const latest = latestPushRuns<{ head_sha?: string; created_at?: string }>(runs?.workflow_runs ?? []);
    // commit statuses (non-Actions CI) hang off the commit itself; the newest run tells us which commit that is
    const sha = latest[0]?.head_sha;
    const status = sha ? await gh(path, ["api", `repos/{owner}/{repo}/commits/${sha}/status`]) : null;
    return summarizeChecks([...latest, ...(status?.statuses ?? [])]);
  })();
  ciMemo.set(key, { at: Date.now(), value });
  return value;
}

/**
 * CI for what has been pushed: the PR's rollup when it has one, else the branch's latest push by
 * name. The local upstream is no guide: a worktree cut from the base tracks the base, and its
 * tracking refs lag when pushes came from elsewhere. A branch never pushed simply has no runs.
 */
async function ciInfo(path: string, branch: string, pr: PrInfo | undefined): Promise<CiInfo | undefined> {
  if (pr && pr.state === "OPEN") return summarizeChecks(pr.checks, `${pr.url}/checks`);
  if (pr || !branch || branch === "(detached)" || branch === "?") return undefined;
  return branchChecks(path, branch);
}

/** Forget cached PR and CI for a worktree so the next status is fresh; call after a push or pull. */
export function forgetRemoteStatus(path: string) {
  prMemo.delete(path);
  for (const key of ciMemo.keys()) if (key.startsWith(`${path}\0`)) ciMemo.delete(key);
  forgetRepoInfo(path);
}

/** who authored the commits this branch adds on top of its base, newest first */
export async function branchAuthors(path: string, base: string): Promise<Commit[]> {
  // only the branch's own commits count, so a long-lived base doesn't drown them out
  const log = await git(path, "log", "-200", "--no-merges", "--format=%an%x00%ae", `${base}..HEAD`).catch(() => "");
  return log.split("\n").filter(Boolean).map((l) => { const [name, email] = l.split("\0"); return { name: name ?? "", email: email ?? "" }; });
}

export async function status(path: string, base: string): Promise<WorktreeStatus> {
  const [out, log, ancestor, heads, pr] = await Promise.all([
    git(path, "status", "--porcelain=v2", "--branch"),
    git(path, "log", "-1", "--format=%s%x00%an%x00%cr").catch(() => ""),
    git(path, "merge-base", "--is-ancestor", "HEAD", base).then(() => true, () => false),
    git(path, "rev-parse", "HEAD", base).catch(() => ""),
    prInfo(path),
  ]);
  const [head, baseTip] = heads.trim().split("\n");
  const lines = out.split("\n");
  const branchName = lines.find((l) => l.startsWith("# branch.head "))?.slice(14) ?? "?";
  const issueNumber = issueNumberOf(branchName);
  const [ci, issue] = await Promise.all([ciInfo(path, branchName, pr), issueNumber ? issueLink(path, issueNumber) : undefined]);
  const ab = /^# branch\.ab \+(\d+) -(\d+)/m.exec(out);
  const [subject, author, age] = log.trim().split("\0");
  return {
    branch: branchName,
    dirty: lines.filter((l) => /^[12u?]/.test(l)).length,
    ahead: ab ? +ab[1] : 0,
    behind: ab ? +ab[2] : 0,
    merged: pr?.state === "MERGED",
    // ponytail: without a PR, "HEAD is in base" is all git can tell us (a stale fresh branch looks the same)
    inBase: ancestor && head !== baseTip,
    base,
    last: subject ? { subject, author, age } : undefined,
    files: lines.filter((l) => /^[12u?]/.test(l)).map((l) => (l.startsWith("?") ? "?? " + l.slice(2) : l.split(" ").slice(1, 2)[0] + " " + l.split(" ").pop())).join("\n"),
    pr,
    ci,
    issue,
    // over the GraphQL budget: `pr` and `issue` above are the last good ones, and may be absent entirely
    limitedUntil: ghBudget.resetsAt() || undefined,
  };
}

/** the issue an `issue/<n>` branch points at, for the sidebar chip; `gh issue view` is GraphQL like the PR query, so it shares the budget */
const issueLink = (path: string, n: number): Promise<IssueLink | undefined> =>
  cached(`${path}\0issue${n}`, 60_000, async () => {
    const j = await ghRaw(path, ["issue", "view", `${n}`, "--json", "number,title,state,url"]);
    return { number: j.number, title: j.title, state: j.state, url: j.url } as IssueLink;
  });

const mapIssue = (i: any): IssueInfo => ({
  number: i.number, title: i.title, author: i.author?.login ?? "", state: i.state, url: i.url,
  labels: (i.labels ?? []).map((l: any) => l.name).filter(Boolean), assignees: (i.assignees ?? []).map((a: any) => a.login).filter(Boolean),
  comments: Array.isArray(i.comments) ? i.comments.length : typeof i.comments === "number" ? i.comments : (i.comments?.totalCount ?? 0),
  createdAt: i.createdAt, updatedAt: i.updatedAt,
});

/** one issue with its body and thread, for the chat that opens it */
export async function issueDetail(cwd: string, n: number): Promise<IssueDetail> {
  const j = await gh(cwd, ["issue", "view", `${n}`, "--json", "number,title,author,state,url,labels,assignees,createdAt,updatedAt,body,comments"]);
  if (!j) throw new Error(`Couldn't load issue #${n} from GitHub. Is gh signed in?`);
  return {
    ...mapIssue(j), body: j.body ?? "",
    discussion: (j.comments ?? []).map((c: any) => ({ author: c.author?.login ?? "", at: c.createdAt ?? "", body: c.body ?? "" })),
  };
}

export async function diff(path: string) {
  const [files, tracked, untracked] = await Promise.all([
    git(path, "status", "--short"),
    git(path, "diff", "HEAD"),
    git(path, "ls-files", "--others", "--exclude-standard"),
  ]);
  const extra = await Promise.all(
    untracked.split("\n").filter(Boolean).map((f) => git(path, "diff", "--no-index", "--", "/dev/null", f).catch((e) => e.stdout)),
  );
  return { files, patch: tracked + extra.join("") };
}

// ponytail: one-shot shell, not a PTY; add node-pty + xterm if interactive shells are needed
export function runCommand(cwd: string, cmd: string) {
  return new Promise<{ out: string; code: number }>((res) => {
    execFile("/bin/zsh", ["-lc", cmd], { cwd, maxBuffer: 1 << 24, timeout: 120_000 }, (err, stdout, stderr) =>
      res({ out: stdout + stderr, code: err ? ((err as any).code ?? 1) : 0 }),
    );
  });
}

const ghRaw = async (cwd: string, args: string[]) =>
  JSON.parse((await run("gh", [...args], { cwd, timeout: 15_000 })).stdout);
const gh = (cwd: string, args: string[]) => ghRaw(cwd, args).catch(() => null);

/**
 * One GraphQL query, with the budget it reports folded back into the shared gate. `gh` exits
 * non-zero on a GraphQL error and prints the payload, but a query can also come back 200 with
 * an `errors` array, so both are raised the same way for `isRateLimit` to read.
 */
async function graphql<T>(cwd: string, query: string, vars: Record<string, string | number>): Promise<T> {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(vars)) args.push(typeof v === "number" ? "-F" : "-f", `${k}=${v}`);
  const { stdout } = await run("gh", args, { cwd, timeout: 15_000, maxBuffer: 1 << 24 });
  const body = JSON.parse(stdout);
  ghBudget.saw(body?.data?.rateLimit);
  if (body?.errors?.length) throw new Error(body.errors.map((e: any) => e?.message ?? "").join("; "));
  return body?.data as T;
}

const nodes = (c: any): any[] => (Array.isArray(c?.nodes) ? c.nodes.filter(Boolean) : []);

/** owner and name for the GraphQL queries, which cannot use gh's `{owner}/{repo}` placeholders */
const repoRef = (cwd: string) =>
  cached(`${cwd}\0ref`, 300_000, async () => {
    const j = await ghRaw(cwd, ["repo", "view", "--json", "owner,name"]);
    return { owner: String(j?.owner?.login ?? ""), name: String(j?.name ?? "") };
  });

/**
 * The remote branch name a PR for this worktree would carry, or "" when detached. Usually the
 * local branch name, but a branch pushed under another name (`git push -u origin mitch/x`) is
 * known to GitHub by the remote one, which is what `gh pr view` used to resolve for us.
 */
const headBranch = async (cwd: string): Promise<string> => {
  const push = await git(cwd, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{push}").then((s) => s.trim(), () => "");
  if (push) {
    const remotes = await git(cwd, "remote").then((s) => s.split("\n").map((r) => r.trim()).filter(Boolean), () => []);
    const remote = remotes.find((r) => push.startsWith(`${r}/`));
    if (remote) return push.slice(remote.length + 1);
  }
  const local = await git(cwd, "rev-parse", "--abbrev-ref", "HEAD").then((s) => s.trim(), () => "");
  return local && local !== "HEAD" ? local : "";
};

/**
 * A gh call kept behind a per-key cache that serves the last good answer when the new one
 * cannot be had. The project page polls every ten seconds and the sidebar every fifteen, and
 * the PR and issue lists carry nested reviews, comments and commits, so each poll used to be a
 * fresh heavy GraphQL query. Inside the window we reuse; over the budget, or on any failure, we
 * hand back what we already have rather than an empty list that would blank the page.
 */
const ghMemo = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, ttl: number, fetch: () => Promise<T>): Promise<T | undefined> {
  const hit = ghMemo.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value as T;
  if (ghBudget.blocked()) return hit?.value as T | undefined;
  try {
    const value = await fetch();
    ghBudget.ok();
    ghMemo.set(key, { at: Date.now(), value });
    return value;
  } catch (error) {
    ghBudget.note(error);
    // refreshed to now so a throttled API is not hammered, but the value itself is the last good one
    if (hit) { ghMemo.set(key, { at: Date.now(), value: hit.value }); return hit.value as T; }
    return undefined;
  }
}

/** owner/name of the GitHub repo, or undefined when gh cannot say */
export const repoName = (cwd: string): Promise<string | undefined> =>
  gh(cwd, ["repo", "view", "--json", "nameWithOwner"]).then((j) => j?.nameWithOwner || undefined);

export async function repoInfo(cwd: string): Promise<RepoInfo> {
  // the PR and issue lists are the two heaviest GraphQL queries the app makes; the repo blurb
  // barely changes and the run list is REST, so each gets the window that suits it
  const [repo, prs, runs, issues, me] = await Promise.all([
    cached(`${cwd}\0repo`, 300_000, () => ghRaw(cwd, ["repo", "view", "--json", "nameWithOwner,description,url,defaultBranchRef,pushedAt,isPrivate"])),
    cached(`${cwd}\0prs`, 60_000, async () => {
      const ref = await repoRef(cwd);
      if (!ref?.owner || !ref.name) throw new Error("no GitHub repo here");
      const data = await graphql<any>(cwd, prListQuery, { owner: ref.owner, name: ref.name, first: PR_PAGE });
      return nodes(data?.repository?.pullRequests).map(mapPr);
    }),
    cached(`${cwd}\0runs`, 30_000, () => ghRaw(cwd, ["run", "list", "--limit", "8", "--json", "status,conclusion,name,headBranch,createdAt,url,displayTitle"])),
    // the page shows 15 and expands to the rest; the comment count comes from the list payload without pulling bodies
    cached(`${cwd}\0issues`, 60_000, async () => {
      const ref = await repoRef(cwd);
      if (!ref?.owner || !ref.name) throw new Error("no GitHub repo here");
      const data = await graphql<any>(cwd, issueListQuery, { owner: ref.owner, name: ref.name, first: ISSUE_PAGE });
      return nodes(data?.repository?.issues).map(mapIssueNode);
    }),
    whoAmI(cwd),
  ]);
  return {
    me,
    repo: repo && { nameWithOwner: repo.nameWithOwner, description: repo.description, url: repo.url, defaultBranch: repo.defaultBranchRef?.name ?? "", pushedAt: repo.pushedAt, isPrivate: repo.isPrivate },
    prs: (prs ?? []).map((p: any) => ({
      number: p.number, title: p.title, author: p.author?.login ?? "", branch: p.headRefName, draft: p.isDraft,
      review: p.reviewDecision ?? "", updatedAt: p.updatedAt, url: p.url, ...whoseTurn(p, me),
    })),
    runs: (runs ?? []).map((r: any) => ({ name: r.name, title: r.displayTitle, branch: r.headBranch, status: r.status, conclusion: r.conclusion, createdAt: r.createdAt, url: r.url })),
    issues: (issues ?? []).map(mapIssue),
    /** set while we are over the GraphQL budget: the lists above are the last good ones, not fresh */
    limitedUntil: ghBudget.resetsAt() || undefined,
  };
}

/** Drop the cached project lists so the next `repoInfo` is fresh; call after a push or pull. */
export function forgetRepoInfo(cwd: string) {
  for (const key of ghMemo.keys()) if (key.startsWith(`${cwd}\0`)) ghMemo.delete(key);
}

// editor: paths stay inside the worktree
const inside = (cwd: string, rel: string) => {
  const abs = resolve(cwd, rel);
  if (!abs.startsWith(cwd + "/")) throw new Error("path escapes worktree");
  return abs;
};
export async function listFiles(cwd: string) {
  const files: string[] = [];
  const directories = [""];
  // Walk the filesystem, including hidden and ignored files, without consulting Git.
  // Do not follow directory symlinks: they can cycle or point outside this workspace.
  while (directories.length) {
    const dir = directories.pop()!;
    let entries;
    try { entries = await fs.readdir(join(cwd, dir), { withFileTypes: true }); }
    catch (error: any) {
      if (dir && error.code === "ENOENT") continue; // a directory disappeared during the scan
      throw error;
    }
    for (const entry of entries) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) directories.push(rel);
      else if (entry.isFile()) files.push(rel);
      else if (entry.isSymbolicLink()) {
        const target = await fs.stat(join(cwd, rel)).catch(() => undefined);
        if (target?.isFile()) files.push(rel);
      }
    }
  }
  return files.sort();
}
export const readFile = (cwd: string, rel: string) => fs.readFile(inside(cwd, rel), "utf8");
export const writeFile = (cwd: string, rel: string, content: string) => fs.writeFile(inside(cwd, rel), content);

export async function commitInfo(cwd: string): Promise<CommitInfo> {
  const [files, log, branch, ab] = await Promise.all([
    git(cwd, "status", "--short"),
    git(cwd, "log", "-40", "--format=%h%x00%s%x00%an%x00%cr").catch(() => ""),
    git(cwd, "rev-parse", "--abbrev-ref", "HEAD").then((s) => s.trim()),
    git(cwd, "rev-list", "--count", "@{upstream}..HEAD").then((s) => +s.trim(), () => 0),
  ]);
  return {
    files, changed: files.split("\n").filter(Boolean).length, branch, ahead: ab,
    log: log.split("\n").filter(Boolean).map((l) => { const [hash, subject, author, age] = l.split("\0"); return { hash, subject, author, age }; }),
  };
}

export async function commit(cwd: string, message: string) {
  await git(cwd, "add", "-A");
  const out = await git(cwd, "commit", "-m", message);
  const line = out.trim().split("\n")[0];
  // -u origin HEAD works for first push and subsequent ones alike
  try { await run("git", ["push", "-u", "origin", "HEAD"], { cwd, maxBuffer: 1 << 24 }); return `${line} · pushed`; }
  catch (e: any) { throw new Error(`${line} · push failed: ${String(e.stderr || e.message).trim().split("\n").pop()}`); }
}

// diff for the AI summary: tracked changes plus untracked files, capped so the prompt stays small
export async function diffForSummary(cwd: string) {
  const { files, patch } = await diff(cwd); // tracked + untracked as patches
  return `Changed files:\n${files}\n${patch}`.slice(0, 14_000);
}

/**
 * What a PR describes: the branch's own commits and its diff against the base, from the merge
 * base so a base that moved on does not show up as this branch's work. Uncommitted changes are
 * left out; they will not be in the PR. Trimmed like the commit summary so one call stays cheap.
 */
export async function branchDiffForSummary(cwd: string, branch: string, base: string): Promise<PrSummaryInput> {
  // two dots for the log (only commits reachable from HEAD), three for the diff (from the merge base)
  const range = `${base}...HEAD`;
  const [commits, stat, patch] = await Promise.all([
    git(cwd, "log", "--no-merges", "--format=- %s", `${base}..HEAD`),
    git(cwd, "diff", "--stat=100", range),
    git(cwd, "diff", "--no-color", "-U2", range),
  ]);
  return { branch, base, commits, stat, patch: patch.slice(0, 14_000) };
}

export async function rootStatus(path: string) {
  const [branch, commit, changes] = await Promise.all([
    git(path, "symbolic-ref", "--quiet", "--short", "HEAD").then((s) => s.trim(), () => null),
    git(path, "rev-parse", "HEAD").then((s) => s.trim()),
    git(path, "status", "--porcelain"),
  ]);
  return { branch, commit, dirty: !!changes.trim() };
}

const rootCheckouts = new Set<string>();
export async function checkoutAtRoot(root: string, source: string, commitMessage?: string) {
  if (rootCheckouts.has(root)) throw new Error("A checkout at root is already in progress.");
  rootCheckouts.add(root);
  try {
    const common = async (path: string) => fs.realpath((await git(path, "rev-parse", "--path-format=absolute", "--git-common-dir")).trim());
    if (await common(root) !== await common(source) || await fs.realpath(root) === await fs.realpath(source))
      throw new Error("Select a linked worktree belonging to this project.");
    for (const path of [root, source]) {
      for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"]) {
        const location = (await git(path, "rev-parse", "--path-format=absolute", "--git-path", marker)).trim();
        if (await fs.stat(location).then(() => true, () => false)) throw new Error("Finish the current merge, rebase, or cherry-pick before checking out at root.");
      }
    }
    if ((await rootStatus(root)).dirty) throw new Error("The root has uncommitted changes. Commit or stash them before checking out here.");
    if ((await git(source, "ls-files", "--unmerged")).trim()) throw new Error("Resolve the worktree's merge conflicts first.");
    const branch = (await rootStatus(source)).branch;
    if (!branch) throw new Error("This worktree is detached. Switch it to a branch before committing and pushing.");
    await git(source, "remote", "get-url", "origin");
    return await worktreeOperation(source, branch, async () => {
      if ((await rootStatus(source)).dirty) {
        if (!commitMessage?.trim()) throw new Error("The worktree has uncommitted changes. Supply a commit message to include them.");
        await git(source, "add", "--all");
        await git(source, "commit", "-m", commitMessage.trim());
      }
      if ((await rootStatus(source)).dirty) throw new Error("The worktree still has changes after committing. Check its status and retry.");
      const commit = (await git(source, "rev-parse", "HEAD")).trim();
      await run("git", ["push", "--set-upstream", "origin", `refs/heads/${branch}:refs/heads/${branch}`], {
        cwd: source, maxBuffer: 1 << 24, timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      }).catch((error) => { throw new Error(`Push failed. Your local commit is saved; root and worktree checkouts are unchanged. ${error.message}`); });
      if ((await rootStatus(root)).dirty) throw new Error("The root changed during push. Your commit is pushed; commit or stash root changes and retry.");
      if ((await rootStatus(source)).dirty || (await rootStatus(source)).commit !== commit)
        throw new Error("The worktree changed during push. Root is unchanged; retry after work has stopped.");
      // Transfer the branch to root rather than attach it in two working directories.
      await git(source, "switch", "--detach", commit);
      try {
        await git(root, "switch", "--no-guess", branch);
      } catch (error) {
        // A failed switch normally leaves root untouched. Reattach the source when safe.
        if ((await rootStatus(root)).branch !== branch) {
          await git(source, "switch", "--no-guess", branch).catch(() => {});
        }
        throw new Error(`Commit pushed, but checkout at root failed. ${(error as Error).message}`);
      }
      try {
        await run("git", ["pull", "--ff-only", "--no-rebase", "origin", `refs/heads/${branch}`], {
          cwd: root, maxBuffer: 1 << 24, timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        });
      } catch (error) {
        throw new Error(`Commit pushed and root switched to ${branch}, but pull failed. The source worktree is detached. Retry the pull at root. ${(error as Error).message}`);
      }
      return rootStatus(root);
    });
  } finally {
    rootCheckouts.delete(root);
  }
}

const worktreeOperations = new Set<string>();
async function worktreeOperation<T>(path: string, expectedBranch: string | null, action: (branch: string) => Promise<T>) {
  const canonical = await fs.realpath(path);
  if (worktreeOperations.has(canonical)) throw new Error("A Git operation is already running for this worktree.");
  worktreeOperations.add(canonical);
  try {
    const branch = (await git(path, "symbolic-ref", "--quiet", "--short", "HEAD").catch(() => "")).trim();
    if ((branch || null) !== expectedBranch) throw new Error("The worktree branch changed or is detached. Refresh before continuing.");
    for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"]) {
      const location = (await git(path, "rev-parse", "--path-format=absolute", "--git-path", marker)).trim();
      if (await fs.stat(location).then(() => true, () => false)) throw new Error("Finish the current merge, rebase, or cherry-pick first.");
    }
    return await action(branch);
  } finally {
    worktreeOperations.delete(canonical);
  }
}

export async function commitWorktree(path: string, expectedBranch: string, message: string) {
  if (!message.trim()) throw new Error("Enter a commit message.");
  return worktreeOperation(path, expectedBranch, async () => {
    if ((await git(path, "ls-files", "--unmerged")).trim()) throw new Error("Resolve merge conflicts before committing.");
    if (!(await git(path, "status", "--porcelain")).trim()) throw new Error("No changes to commit.");
    await git(path, "add", "--all");
    await git(path, "commit", "-m", message.trim());
    return (await git(path, "rev-parse", "HEAD")).trim();
  });
}

export async function pushWorktree(path: string, expectedBranch: string) {
  return worktreeOperation(path, expectedBranch, async (branch) => {
    // Explicit source and destination avoid push.default or upstream settings
    // accidentally sending this worktree's commits to another branch.
    const { stdout, stderr } = await run("git", ["push", "--set-upstream", "origin", `refs/heads/${branch}:refs/heads/${branch}`], {
      cwd: path, maxBuffer: 1 << 24, timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return (stdout + stderr).trim();
  });
}

/**
 * Open a PR for the worktree's branch. The push comes first, under the same lock, so the head
 * GitHub sees is the head the user sees; `gh pr create` would otherwise stop to ask where to
 * push, which no one is there to answer. The head is named explicitly so a worktree cut from
 * the base (whose upstream is the base) cannot be mistaken for it.
 */
export async function createPr(path: string, expectedBranch: string, base: string, draft: PrDraft) {
  const args = prCreateArgs({ ...draft, base, head: expectedBranch });
  return worktreeOperation(path, expectedBranch, async (branch) => {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" };
    try {
      await run("git", ["push", "--set-upstream", "origin", `refs/heads/${branch}:refs/heads/${branch}`], { cwd: path, maxBuffer: 1 << 24, timeout: 120_000, env });
    } catch (error) {
      throw new Error(`Push failed, so no PR was opened. ${String((error as any)?.stderr || (error as Error).message).trim()}`);
    }
    let out: string;
    try {
      const { stdout, stderr } = await run("gh", args, { cwd: path, maxBuffer: 1 << 24, timeout: 60_000, env });
      out = stdout + "\n" + stderr;
    } catch (error) {
      const text = String((error as any)?.stderr || (error as Error).message).trim();
      // gh says this when the head already has a PR: point at it instead of failing blind
      const existing = prUrlIn(text);
      throw new Error(existing ? `A pull request already exists for ${branch}: ${existing}` : `gh pr create failed. ${text}`);
    } finally {
      // the "no PR" answer was cached for a minute; the next status poll must ask again
      forgetRemoteStatus(path);
    }
    const url = prUrlIn(out);
    if (!url) throw new Error(`gh pr create finished but printed no PR URL. ${out.trim()}`);
    return { url, number: Number(/\/pull\/(\d+)/.exec(url)?.[1]) || undefined };
  });
}

// Hold the checkout lock across both steps; a retry can push an already saved commit.
export async function commitAndPushRoot(path: string, expectedBranch: string, message: string) {
  return worktreeOperation(path, expectedBranch, async (branch) => {
    if ((await git(path, "ls-files", "--unmerged")).trim()) throw new Error("Resolve merge conflicts before committing.");
    if ((await git(path, "status", "--porcelain")).trim()) {
      if (!message.trim()) throw new Error("Enter a commit message.");
      await git(path, "add", "--all");
      await git(path, "commit", "-m", message.trim());
    }
    try {
      await run("git", ["push", "--set-upstream", "origin", `refs/heads/${branch}:refs/heads/${branch}`], {
        cwd: path, maxBuffer: 1 << 24, timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
    } catch (error) {
      throw new Error(`Push failed. Any local commit is saved; retry to push it. ${(error as Error).message}`);
    }
    return `Root pushed to origin/${branch}.`;
  });
}

export async function rootBranches(path: string) {
  path = await fs.realpath(path);
  const [current, refs, worktrees] = await Promise.all([
    git(path, "symbolic-ref", "--quiet", "--short", "HEAD").then((s) => s.trim(), () => null),
    git(path, "for-each-ref", "--format=%(refname)\t%(symref)\t%(upstream)", "refs/heads", "refs/remotes"),
    listWorktrees(path),
  ]);
  const entries = refs.trim().split("\n").filter(Boolean).map((line) => line.split("\t"));
  const locals = entries.filter(([ref]) => ref.startsWith("refs/heads/"));
  const localNames = new Set(locals.map(([ref]) => ref.slice("refs/heads/".length)));
  const upstreams = new Set(locals.map(([, , upstream]) => upstream).filter(Boolean));
  const branches = entries.flatMap(([ref, symbolic]) => {
    if (symbolic) return [];
    const local = ref.startsWith("refs/heads/");
    const name = ref.replace(/^refs\/(heads|remotes)\//, "");
    // A local branch is the checkout target; its remote counterpart is not a second choice.
    if (!local && (localNames.has(name.slice(name.indexOf("/") + 1)) || upstreams.has(ref))) return [];
    return [{ ref, name, occupied: local ? worktrees.find((w) => w.branch === name && w.path !== path)?.path : undefined }];
  });
  return { current, branches };
}

export async function switchRootBranch(path: string, expectedBranch: string | null, ref: string) {
  if (rootCheckouts.has(path)) throw new Error("A checkout at root is already in progress.");
  rootCheckouts.add(path);
  try {
    return await worktreeOperation(path, expectedBranch, async () => {
      const choice = (await rootBranches(path)).branches.find((b) => b.ref === ref);
      if (!choice) throw new Error("Branch no longer exists. Refresh and try again.");
      if (choice.occupied) throw new Error(`Branch is checked out in ${choice.occupied}.`);
      if ((await git(path, "status", "--porcelain")).trim()) throw new Error("Commit or stash root changes before switching branches.");
      if (ref.startsWith("refs/heads/")) await git(path, "switch", "--no-guess", choice.name);
      else {
        const name = choice.name.slice(choice.name.indexOf("/") + 1);
        await git(path, "switch", "--track", "-c", name, ref);
      }
      return rootStatus(path);
    });
  } finally { rootCheckouts.delete(path); }
}

export async function pullWorktree(path: string, expectedBranch: string) {
  return worktreeOperation(path, expectedBranch, async (branch) => {
    if ((await git(path, "status", "--porcelain")).trim()) throw new Error("Commit or stash changes before pulling.");
    const { stdout, stderr } = await run("git", ["pull", "--ff-only", "--no-rebase", "--no-autostash", "origin", `refs/heads/${branch}`], {
      cwd: path, maxBuffer: 1 << 24, timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return (stdout + stderr).trim();
  });
}
