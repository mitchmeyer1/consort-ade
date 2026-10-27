import type { Chat, Worktree } from "./types";

type LegacyWorktree = Omit<Worktree, "ship"> & { ship?: Worktree["ship"] | boolean };

/**
 * The first /ship board ran every feature from one shared worktree marked `ship: true` and tagged each
 * run's chat with `ship`. A worktree's `ship` is now its feature record, and a tagged chat only shows
 * inside its feature, so those chats dropped out of every list, and opening one read a ticket off `true`.
 * Clearing both flags brings them back as ordinary chats with transcripts and sessions intact.
 * Returns how many chats came back.
 */
export function migrateLegacyShip(worktrees: LegacyWorktree[], chats: Chat[]): number {
  const legacy = new Set<string>();
  for (const w of worktrees) if (w.ship !== undefined && typeof w.ship !== "object") { delete w.ship; legacy.add(w.id); }
  let restored = 0;
  for (const c of chats) if (c.ship && legacy.has(c.worktreeId)) { delete c.ship; restored++; }
  return restored;
}
