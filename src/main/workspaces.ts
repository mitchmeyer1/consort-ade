/**
 * Git for a workspace: the same operations a single worktree gets, fanned out over the repos
 * checked out inside it. Each repo keeps its own base, PR and CI; the workspace shares one
 * branch name and one commit message.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import * as git from "./git.ts";
import type { CommitInfo, RepoResult, WorktreeStatus } from "../shared/types.ts";
import type { PrDraft, PrSummaryInput } from "../shared/createPr.ts";
import { prFooter } from "../shared/workspace.ts";

/** one repo of a workspace as main sees it: where its source clone is, where its worktree sits, what it merges into */
export type RepoTarget = { projectId: string; name: string; dir: string; path: string; repo: string; base: string };

/** make the folder and a worktree of every repo in it; a failure part-way removes what was made */
export async function createWorkspaceTree(root: string, branch: string, repos: Omit<RepoTarget, "path">[]): Promise<RepoTarget[]> {
  await fs.mkdir(root, { recursive: true });
  const made: RepoTarget[] = [];
  try {
    for (const r of repos) {
      const path = await git.addWorktree(r.repo, r.dir, branch, r.base, root);
      made.push({ ...r, path });
    }
    return made;
  } catch (error) {
    await removeWorkspaceTree(root, made).catch(() => {});
    throw error;
  }
}

export async function removeWorkspaceTree(root: string, repos: Pick<RepoTarget, "repo" | "path">[]) {
  for (const r of repos) await git.removeWorktree(r.repo, r.path).catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
}

export async function workspaceStatuses(repos: RepoTarget[]): Promise<{ target: RepoTarget; status: WorktreeStatus | null }[]> {
  return Promise.all(repos.map(async (target) => ({ target, status: await git.status(target.path, target.base).catch(() => null) })));
}

const banner = (dir: string) => `══ ${dir} ${"═".repeat(Math.max(0, 60 - dir.length))}`;

/** every repo's changes in one view, files and hunks prefixed with the repo folder */
export async function workspaceDiff(repos: RepoTarget[]) {
  const parts = await Promise.all(repos.map(async (r) => ({ r, d: await git.diff(r.path).catch(() => ({ files: "", patch: "" })) })));
  const files = parts.flatMap(({ r, d }) => d.files.split("\n").filter(Boolean).map((l) => `${l.slice(0, 3)}${r.dir}/${l.slice(3)}`)).join("\n");
  const patch = parts.filter(({ d }) => d.patch.trim()).map(({ r, d }) => `${banner(r.dir)}\n${d.patch}`).join("\n");
  return { files, patch };
}

export async function workspaceCommitInfo(repos: RepoTarget[], branch: string): Promise<CommitInfo> {
  const infos = await Promise.all(repos.map(async (r) => ({ r, i: await git.commitInfo(r.path).catch(() => null) })));
  const files = infos.flatMap(({ r, i }) => (i?.files ?? "").split("\n").filter(Boolean).map((l) => `${l.slice(0, 3)}${r.dir}/${l.slice(3)}`)).join("\n");
  return {
    files, changed: files.split("\n").filter(Boolean).length, branch,
    ahead: infos.reduce((n, { i }) => n + (i?.ahead ?? 0), 0),
    log: infos.flatMap(({ r, i }) => (i?.log ?? []).slice(0, 15).map((c) => ({ ...c, subject: `[${r.dir}] ${c.subject}` }))),
  };
}

export async function workspaceDiffForSummary(repos: RepoTarget[]) {
  const parts = await Promise.all(repos.map(async (r) => ({ r, d: await git.diffForSummary(r.path).catch(() => "") })));
  return parts.filter(({ d }) => d.trim()).map(({ r, d }) => `${banner(r.dir)}\n${d}`).join("\n").slice(0, 14_000);
}

export async function workspacePrSummary(repos: RepoTarget[], branch: string): Promise<PrSummaryInput> {
  const parts = await Promise.all(repos.map(async (r) => ({ r, s: await git.branchDiffForSummary(r.path, branch, r.base).catch(() => null) })));
  const withWork = parts.filter(({ s }) => s && (s.commits.trim() || s.patch.trim()));
  return {
    branch, base: [...new Set(withWork.map(({ r }) => r.base))].join(", ") || repos[0]?.base || "",
    commits: withWork.map(({ r, s }) => `${r.dir}:\n${s!.commits}`).join("\n"),
    stat: withWork.map(({ r, s }) => `${r.dir}:\n${s!.stat}`).join("\n"),
    patch: withWork.map(({ r, s }) => `${banner(r.dir)}\n${s!.patch}`).join("\n").slice(0, 14_000),
  };
}

const failure = (e: unknown) => String((e as Error)?.message ?? e).split("\n").filter(Boolean).pop() ?? "failed";

/** one message, every repo with changes: commit, then push. Repos with nothing to commit are skipped, not failed. */
export async function commitAll(repos: RepoTarget[], branch: string, message: string): Promise<RepoResult[]> {
  const out: RepoResult[] = [];
  for (const r of repos) {
    const dirty = (await git.status(r.path, r.base).catch(() => null))?.dirty ?? 0;
    if (!dirty) { out.push({ name: r.dir, ok: true, skipped: true, detail: "nothing to commit" }); continue; }
    try {
      const sha = await git.commitWorktree(r.path, branch, message);
      await git.pushWorktree(r.path, branch);
      out.push({ name: r.dir, ok: true, detail: `committed ${sha.slice(0, 7)} · pushed` });
    } catch (e) { out.push({ name: r.dir, ok: false, detail: failure(e) }); }
  }
  return out;
}

export async function pushAll(repos: RepoTarget[], branch: string): Promise<RepoResult[]> {
  return Promise.all(repos.map(async (r) => {
    try { await git.pushWorktree(r.path, branch); return { name: r.dir, ok: true, detail: "pushed" }; }
    catch (e) { return { name: r.dir, ok: false, detail: failure(e) }; }
  }));
}

export async function pullAll(repos: RepoTarget[], branch: string): Promise<RepoResult[]> {
  return Promise.all(repos.map(async (r) => {
    try { await git.pullWorktree(r.path, branch); return { name: r.dir, ok: true, detail: "pulled" }; }
    catch (e) { return { name: r.dir, ok: false, detail: failure(e) }; }
  }));
}

/**
 * A PR per repo with the same title and body, then each body gets a footer linking the others,
 * so a reviewer landing on one sees the whole change. Repos passed in are the ones that have
 * work to review; the caller decides that from the statuses.
 */
export async function createPrs(repos: RepoTarget[], branch: string, draft: PrDraft, workspaceName: string): Promise<RepoResult[]> {
  const out: RepoResult[] = [];
  for (const r of repos) {
    try {
      const { url, number } = await git.createPr(r.path, branch, r.base, draft);
      out.push({ name: r.dir, ok: true, detail: number ? `PR #${number}` : "PR opened", url, number });
    } catch (e) { out.push({ name: r.dir, ok: false, detail: failure(e) }); }
  }
  const opened = out.filter((o) => o.url);
  const footer = prFooter(workspaceName, opened.map((o) => ({ name: o.name, url: o.url! })));
  if (footer) {
    await Promise.all(opened.map(async (o) => {
      const r = repos.find((x) => x.dir === o.name)!;
      await git.editPrBody(r.path, o.number!, `${draft.body.trim()}${footer}`).catch(() => {});
    }));
  }
  return out;
}
