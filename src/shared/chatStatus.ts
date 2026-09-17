import type { Chat } from "./types";

export function chatStatus(chat: Chat): "attention" | "running" | "complete" | null {
  if (chat.permissions?.length || chat.error || (chat.phase === "waiting" && !chat.assessingPrompt && chat.messages.length > 0)) return "attention";
  if (chat.running) return "running";
  return chat.unreadCompletion ? "complete" : null;
}
