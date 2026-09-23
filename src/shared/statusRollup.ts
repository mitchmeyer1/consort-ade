import type { Chat } from "./types";
import { chatStatus } from "./chatStatus.ts";

export type ChatMark = NonNullable<ReturnType<typeof chatStatus>>;

/* loudest first: the order the marks appear in on a collapsed row */
export const CHAT_MARKS: ChatMark[] = ["attention", "running", "complete", "reminder", "scheduled"];

export type Rollup = {
  /** how many chats sit at each mark, only marks that occur */
  chats: Partial<Record<ChatMark, number>>;
  /** any process running / failed / finished-unseen in one of the scopes */
  running: boolean;
  failed: boolean;
  done: boolean;
};

/**
 * What a collapsed project should still show: the marks its hidden worktrees and chats would
 * have shown, folded into one line. Process dots follow the same precedence as the row dots do
 * (a finished mark hides while something is still running or has failed).
 */
export function rollupStatus(
  chats: Chat[],
  scopeIds: string[],
  procs: { running: Set<string>; failed: Set<string>; done: Set<string> },
  now = Date.now(),
): Rollup {
  const counts: Partial<Record<ChatMark, number>> = {};
  for (const c of chats) {
    const s = chatStatus(c, now);
    if (s) counts[s] = (counts[s] ?? 0) + 1;
  }
  const running = scopeIds.some((id) => procs.running.has(id));
  const failed = scopeIds.some((id) => procs.failed.has(id));
  const done = !running && !failed && scopeIds.some((id) => procs.done.has(id));
  return { chats: counts, running, failed, done };
}

export function hasRollup(r: Rollup): boolean {
  return r.running || r.failed || r.done || Object.keys(r.chats).length > 0;
}

export function rollupLabel(mark: ChatMark, n: number): string {
  const chats = n === 1 ? "chat" : "chats";
  switch (mark) {
    case "attention": return `${n} ${chats} need${n === 1 ? "s" : ""} attention`;
    case "running": return `${n} ${chats} running`;
    case "complete": return `${n} ${chats} finished`;
    case "reminder": return `${n} reminder${n === 1 ? "" : "s"} due`;
    case "scheduled": return `${n} reminder${n === 1 ? "" : "s"} scheduled`;
  }
}
