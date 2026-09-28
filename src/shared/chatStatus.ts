import type { Chat } from "./types";

export function chatStatus(chat: Chat, now = Date.now()): "attention" | "running" | "complete" | "reminder" | "scheduled" | null {
  // A permission prompt needs the user even while the agent process is alive. Other
  // terminal-looking states can arrive in an interim Codex message, so keep the chat
  // blue until the process really exits instead of flashing an orange attention dot.
  if (chat.permissions?.length) return "attention";
  if (chat.running) return "running";
  if (chat.error || (chat.phase === "waiting" && !chat.assessingPrompt && chat.messages.length > 0)) return "attention";
  if (chat.unreadCompletion) return "complete";
  if (chat.remindAt === undefined) return null;
  // a reminder is the quietest mark: it sits under anything the chat itself is reporting.
  // Due-time rule matches reminderDue() in ./reminders.
  return chat.remindAt <= now ? "reminder" : "scheduled";
}
