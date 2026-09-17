import type { Chat, Worktree } from "./types";

// Use the user's activity so background agent output doesn't reshuffle the list.
export function lastChattedAt(chat: Chat): number {
  return chat.messages.reduce((latest, message) =>
    message.role === "user" ? Math.max(latest, message.ts) : latest, chat.lastChattedAt ?? 0);
}

export function recentChats(chats: Chat[]): Chat[] {
  return [...chats].sort((a, b) => lastChattedAt(b) - lastChattedAt(a));
}

export function recentWorktrees(worktrees: Worktree[], chats: Chat[]): Worktree[] {
  const activity = new Map<string, number>();
  for (const chat of chats) activity.set(chat.worktreeId, Math.max(activity.get(chat.worktreeId) ?? 0, lastChattedAt(chat)));
  return [...worktrees].sort((a, b) => Number(!!b.root) - Number(!!a.root)
    || (activity.get(b.id) ?? 0) - (activity.get(a.id) ?? 0));
}
