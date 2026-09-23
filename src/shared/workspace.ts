/**
 * A workspace is a project made of several repos checked out together on one branch: a folder
 * with a git worktree of each source repo inside it, one chat scope on top, no Root and no
 * further worktrees. Git actions fan out per repo (see main/workspaces.ts); this module holds
 * the shape both processes agree on.
 */
import type { Project, State, WorkspaceStatus, WorktreeStatus } from "./types";
// the extension matters: tests load this module straight into Node
import { canCreatePr, prBlockedBy } from "./createPr.ts";

export const isWorkspace = (p: Project | undefined): boolean => p?.kind === "workspace";

/** folder-safe name: "Billing Rework!" → "billing-rework" */
export function slugify(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "workspace";
}

/** subfolder names for the repos, from each repo folder's name, made unique */
export function repoDirs(sources: Project[]): { projectId: string; dir: string }[] {
  const taken = new Set<string>();
  return sources.map((p) => {
    const base = p.path.replace(/\/+$/, "").split("/").pop() || p.name;
    let dir = base, n = 2;
    while (taken.has(dir)) dir = `${base}-${n++}`;
    taken.add(dir);
    return { projectId: p.id, dir };
  });
}

/** the source repos of a workspace, resolved to their projects; a removed source is skipped */
export function workspaceSources(state: Pick<State, "projects">, ws: Project): { project: Project; dir: string; path: string }[] {
  return (ws.repos ?? []).flatMap(({ projectId, dir }) => {
    const project = state.projects.find((p) => p.id === projectId);
    return project ? [{ project, dir, path: `${ws.path}/${dir}` }] : [];
  });
}

/** the sidebar row's one-line summary across repos */
export function workspaceSummary(status: WorkspaceStatus | null | undefined) {
  const repos = status?.repos.map((r) => r.status).filter((s): s is WorktreeStatus => !!s) ?? [];
  return {
    dirty: repos.reduce((n, s) => n + s.dirty, 0),
    ahead: repos.reduce((n, s) => n + s.ahead, 0),
    behind: repos.reduce((n, s) => n + s.behind, 0),
    prs: repos.filter((s) => s.pr).length,
    failing: repos.filter((s) => s.ci?.state === "fail").length,
  };
}

/** repos a smart commit touches: only those with something to commit */
export const reposToCommit = (status: WorkspaceStatus | null | undefined) => (status?.repos ?? []).filter((r) => (r.status?.dirty ?? 0) > 0);

/** repos that get a PR: a real branch with commits beyond its base and no PR yet */
export const reposForPr = (status: WorkspaceStatus | null | undefined) =>
  (status?.repos ?? []).filter((r) => r.status && canCreatePr(r.status) && !prBlockedBy(r.status));

/** appended to every PR of a workspace so reviewers can find the siblings */
export function prFooter(workspace: string, prs: { name: string; url: string }[]): string {
  if (prs.length < 2) return "";
  return `\n\n---\nPart of the **${workspace}** workspace, alongside:\n${prs.map((p) => `- ${p.name}: ${p.url}`).join("\n")}`;
}
