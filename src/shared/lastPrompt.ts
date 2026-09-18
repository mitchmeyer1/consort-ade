import type { Chat } from "./types";

export const RECALL_CHARS = 256;

/** The last thing the user asked, on one line and clipped, so several open chats stay tellable apart. */
export function lastPrompt(chat: Pick<Chat, "messages">, limit = RECALL_CHARS): string {
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    const m = chat.messages[i]!;
    if (m.role !== "user") continue;
    const text = m.blocks.map((b) => (b.type === "text" ? b.text : "")).join(" ")
      // attachment lines are the composer's doing, not part of what was asked
      .split("\n").filter((line) => !line.trimStart().startsWith("\u{1F4CE}")).join(" ")
      .replace(/\s+/g, " ").trim();
    if (text) return text.length > limit ? text.slice(0, limit - 1).trimEnd() + "…" : text;
  }
  return "";
}
