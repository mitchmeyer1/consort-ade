import type { Chat } from "./types";

export function chatStatus(chat: Chat, now = Date.now()): "attention" | "running" | "complete" | "reminder" | "scheduled" | null {
  if (chat.permissions?.length || chat.error || (chat.phase === "waiting" && !chat.assessingPrompt && chat.messages.length > 0)) return "attention";
  if (chat.running) return "running";
  if (chat.unreadCompletion) return "complete";
  if (chat.remindAt === undefined) return null;
  // a reminder is the quietest mark: it sits under anything the chat itself is reporting.
  // Due-time rule matches reminderDue() in ./reminders.
  return chat.remindAt <= now ? "reminder" : "scheduled";
}
