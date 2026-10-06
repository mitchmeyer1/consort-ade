/**
 * A repoless chat: work that is not on any code. Chats hang off worktrees and the worktree
 * carries the folder the agent runs in, so each repoless chat gets a worktree of its own with
 * no project, marked `scratch`, whose folder sits in the app's hidden data directory. The
 * agent can write files there when it needs to; nothing git-shaped applies.
 */
import type { Chat, Project, State, Worktree } from "./types";

export const isScratch = (wt: Worktree | undefined): boolean => !!wt?.scratch;

/**
 * A home project is a plain folder the user starts work from (a notes or scripts folder, say) that is
 * not a git repo. It gets one scratch scope at its own path, so chats there run like repoless
 * chats and can move into any sibling repo, and its chats list under the project, not under CHATS.
 */
export const isHome = (p: Project | undefined): boolean => p?.kind === "home";

/** the one scope of a home project; the /ship scope is reused when it already sits on the same folder */
export function homeWorktree(id: string, project: Project): Worktree {
  return { id, projectId: project.id, name: project.name, title: project.name, path: project.path, branch: "", archived: false, scratch: true, root: true };
}

/** the scratch scopes of a home project: a home owns its scope; a repoless chat's scope has no project */
export const homeScopes = (state: Pick<State, "worktrees">, projectId: string): Worktree[] =>
  state.worktrees.filter((w) => isScratch(w) && w.projectId === projectId);

/** the chats in the sidebar's CHATS section: every chat whose worktree is a scratch folder with no project */
export function scratchChats(state: Pick<State, "worktrees" | "chats">): Chat[] {
  const scratch = new Set(state.worktrees.filter((w) => isScratch(w) && !w.projectId).map((w) => w.id));
  return state.chats.filter((c) => scratch.has(c.worktreeId));
}

/** the scratch worktree record for a new repoless chat; the folder is created by main */
export function scratchWorktree(id: string, path: string, title = "Chat"): Worktree {
  return { id, projectId: "", name: title, title, path, branch: "", archived: false, scratch: true };
}
