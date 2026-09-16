import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, join, resolve } from "node:path";
import { promises as fs } from "node:fs";
import type { PrInfo, RepoInfo, WorktreeStatus } from "../shared/types";

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
  const path = join(dirname(repo), `${basename(repo)}-wt`, name);
  await git(repo, "fetch", "--quiet").catch(() => {});
  const exists = await git(repo, "rev-parse", "--verify", "--quiet", branch).then(() => true, () => false);
  if (exists) await git(repo, "worktree", "add", path, branch);
  else await git(repo, "worktree", "add", "-b", branch, path, base);
  return path;
}

export async function removeWorktree(repo: string, path: string) {
  await git(repo, "worktree", "remove", "--force", path);
}

async function prInfo(path: string): Promise<PrInfo | undefined> {
  try {
    const { stdout } = await run("gh", ["pr", "view", "--json", "number,state,isDraft,url,title,reviewDecision,statusCheckRollup"], { cwd: path, timeout: 10_000 });
    const j = JSON.parse(stdout);
    const concl: string[] = (j.statusCheckRollup ?? []).map((c: any) => c.conclusion || c.state || c.status);
    const checks = !concl.length ? null
      : concl.some((c) => /FAIL|ERROR|CANCEL|TIMED_OUT/.test(c)) ? "fail"
      : concl.some((c) => /PENDING|QUEUED|IN_PROGRESS|EXPECTED/.test(c)) ? "pending" : "pass";
    return { number: j.number, state: j.state, draft: j.isDraft, url: j.url, title: j.title, review: j.reviewDecision ?? "", checks };
  } catch {
    return undefined;
  }
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
  const ab = /^# branch\.ab \+(\d+) -(\d+)/m.exec(out);
  const [subject, author, age] = log.trim().split("\0");
  return {
    branch: lines.find((l) => l.startsWith("# branch.head "))?.slice(14) ?? "?",
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

const gh = (cwd: string, args: string[]) =>
  run("gh", [...args], { cwd, timeout: 15_000 }).then((r) => JSON.parse(r.stdout), () => null);

export async function repoInfo(cwd: string): Promise<RepoInfo> {
  const [repo, prs, runs, me] = await Promise.all([
    gh(cwd, ["repo", "view", "--json", "nameWithOwner,description,url,defaultBranchRef,pushedAt,isPrivate"]),
    gh(cwd, ["pr", "list", "--limit", "30", "--json", "number,title,author,headRefName,isDraft,reviewDecision,updatedAt,url,reviewRequests,reviews,comments,commits"]),
    gh(cwd, ["run", "list", "--limit", "8", "--json", "status,conclusion,name,headBranch,createdAt,url,displayTitle"]),
    run("gh", ["api", "user", "-q", ".login"], { cwd, timeout: 10_000 }).then((r) => r.stdout.trim(), () => ""),
  ]);
  return {
    me,
    repo: repo && { nameWithOwner: repo.nameWithOwner, description: repo.description, url: repo.url, defaultBranch: repo.defaultBranchRef?.name ?? "", pushedAt: repo.pushedAt, isPrivate: repo.isPrivate },
    prs: (prs ?? []).map((p: any) => ({
      number: p.number, title: p.title, author: p.author?.login ?? "", branch: p.headRefName, draft: p.isDraft,
      review: p.reviewDecision ?? "", updatedAt: p.updatedAt, url: p.url, ...whoseTurn(p, me),
    })),
    runs: (runs ?? []).map((r: any) => ({ name: r.name, title: r.displayTitle, branch: r.headBranch, status: r.status, conclusion: r.conclusion, createdAt: r.createdAt, url: r.url })),
  };
}

// ponytail: "turn" = who acted last (review/comment/commit), with a pending review request always yours
function whoseTurn(p: any, me: string) {
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

// editor: paths stay inside the worktree
const inside = (cwd: string, rel: string) => {
  const abs = resolve(cwd, rel);
  if (!abs.startsWith(cwd + "/")) throw new Error("path escapes worktree");
  return abs;
};
export async function listFiles(cwd: string) {
  const out = await git(cwd, "ls-files", "--cached", "--others", "--exclude-standard");
  return out.split("\n").filter(Boolean);
}
export const readFile = (cwd: string, rel: string) => fs.readFile(inside(cwd, rel), "utf8");
export const writeFile = (cwd: string, rel: string, content: string) => fs.writeFile(inside(cwd, rel), content);

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
async function worktreeOperation<T>(path: string, expectedBranch: string, action: (branch: string) => Promise<T>) {
  const canonical = await fs.realpath(path);
  if (worktreeOperations.has(canonical)) throw new Error("A Git operation is already running for this worktree.");
  worktreeOperations.add(canonical);
  try {
    const branch = (await git(path, "symbolic-ref", "--quiet", "--short", "HEAD").catch(() => "")).trim();
    if (!branch || branch !== expectedBranch) throw new Error("The worktree branch changed or is detached. Refresh before continuing.");
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
