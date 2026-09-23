/**
 * Quick actions ("BUILD", "START SERVER") belong to a project: the same buttons show on every
 * worktree under it, and each run happens in whichever worktree you launched it from. They
 * used to be saved per worktree; the first load after the change lifts those onto the project.
 */
import type { Project, QuickAction, Worktree } from "./types";

const PLACEHOLDER = /\{\{\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*\}\}/g;

/** Ordered, distinct values an action asks for, written as `{{branch}}` in its Bash. */
export function quickActionParameters(command: string): string[] {
  const names: string[] = [];
  for (const match of command.matchAll(PLACEHOLDER)) if (!names.includes(match[1])) names.push(match[1]);
  return names;
}

/** Quote values as one zsh argument, so typing a space or quote cannot change the saved command. */
export function resolveQuickAction(command: string, values: Record<string, string>): string {
  return command.replace(PLACEHOLDER, (_match, name: string) => `'${(values[name] ?? "").replace(/'/g, "'\"'\"'")}'`);
}

type LegacyWorktree = Worktree & { quickActions?: QuickAction[] };

/** move per-worktree actions onto their project, once each by title and command; returns how many moved */
export function migrateQuickActions(projects: Project[], worktrees: LegacyWorktree[]): number {
  let moved = 0;
  for (const w of worktrees) {
    const actions = w.quickActions;
    if (!actions) continue;
    const project = projects.find((p) => p.id === w.projectId);
    if (project) {
      const list = (project.quickActions ??= []);
      for (const a of actions) {
        const same = list.find((x) => x.title === a.title && x.command === a.command);
        if (same) { if (a.pinned) same.pinned = true; continue; }
        list.push({ ...a });
        moved++;
      }
    }
    delete w.quickActions;
  }
  return moved;
}
