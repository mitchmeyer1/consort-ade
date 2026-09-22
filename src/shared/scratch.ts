/**
 * A repoless chat: work that is not on any code. Chats hang off worktrees and the worktree
 * carries the folder the agent runs in, so each repoless chat gets a worktree of its own with
 * no project, marked `scratch`, whose folder sits in the app's hidden data directory. The
 * agent can write files there when it needs to; nothing git-shaped applies.
 */
import type { Chat, State, Worktree } from "./types";

export const isScratch = (wt: Worktree | undefined): boolean => !!wt?.scratch;

/** the chats in the sidebar's CHATS section: every chat whose worktree is a scratch folder */
export function scratchChats(state: Pick<State, "worktrees" | "chats">): Chat[] {
  const scratch = new Set(state.worktrees.filter(isScratch).map((w) => w.id));
  return state.chats.filter((c) => scratch.has(c.worktreeId));
}

/** the scratch worktree record for a new repoless chat; the folder is created by main */
export function scratchWorktree(id: string, path: string, title = "Chat"): Worktree {
  return { id, projectId: "", name: title, title, path, branch: "", archived: false, scratch: true };
}
