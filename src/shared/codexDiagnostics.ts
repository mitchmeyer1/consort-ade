import type { Chat } from "./types";

/** Notices emitted on Codex's error channel that do not mean the turn failed. */
export function isBenignCodexDiagnostic(message: string) {
  return /(?:Skill descriptions were shortened to fit the skills context budget|Exceeded skills context budget\. All skill descriptions were removed)/i.test(message);
}

/** Repair the bad terminal state written by builds that treated the notice as fatal. */
export function recoverBenignCodexFailure(chat: Chat) {
  if (chat.provider !== "codex" || chat.phase !== "complete" || !chat.error || !isBenignCodexDiagnostic(chat.error)) return false;
  chat.error = undefined;
  chat.interrupted = undefined;
  chat.unreadCompletion = true;
  chat.queuePaused = false;
  return true;
}
