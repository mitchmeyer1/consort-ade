import { randomUUID } from "node:crypto";
import type { Project, Worktree } from "../shared/types";

// This is only a UI/chat scope; it never creates a branch or a Git worktree.
export function ensureRootWorktree(worktrees: Worktree[], project: Project, branch: string): Worktree {
  let root = worktrees.find((w) => w.projectId === project.id && w.path === project.path);
  if (!root) {
    root = { id: randomUUID(), projectId: project.id, name: "root", title: "Root", path: project.path, branch, archived: false, root: true };
    worktrees.push(root);
  } else {
    Object.assign(root, { root: true, name: "root", title: "Root", branch, archived: false });
  }
  return root;
}

export function isRootWorktree(worktree: Worktree, project: Project): boolean {
  return !!worktree.root || worktree.path === project.path;
}
