import { Notification } from "electron";
import type { Chat } from "../shared/types";

// node timers cap out around 24.8 days; reminders are hours away, but re-arm rather than fire early
const MAX_DELAY = 2 ** 31 - 1;

/** Fires a notification when a chat's reminder comes due, and keeps one timer per chat. */
export class Reminders {
  /** one timer per chat, remembered with the time it was armed for */
  private timers = new Map<string, { at: number; timer: NodeJS.Timeout }>();
  constructor(
    private chats: () => Chat[],
    private openChat: (id: string) => void,
    private changed: () => void,
    private viewing: (chatId: string) => boolean = () => false,
    /** shows the reminder in-app instead and returns true, when Consort is the active window */
    private inApp: (chat: Chat) => boolean = () => false,
  ) {}

  /** arm every pending reminder, and drop timers whose chat moved, cleared, or went away */
  sync(now = Date.now()) {
    const chats = this.chats();
    for (const [id, armed] of this.timers) {
      const chat = chats.find((c) => c.id === id);
      if (chat?.remindAt === armed.at && armed.at > now) continue;
      clearTimeout(armed.timer);
      this.timers.delete(id);
    }
    for (const chat of chats) {
      if (chat.remindAt === undefined || chat.remindAt <= now || this.timers.has(chat.id)) continue;
      const at = chat.remindAt;
      const timer = setTimeout(() => { this.timers.delete(chat.id); this.fire(chat.id); }, Math.min(at - now, MAX_DELAY));
      timer.unref?.();
      this.timers.set(chat.id, { at, timer });
    }
  }

  private fire(chatId: string) {
    const chat = this.chats().find((c) => c.id === chatId);
    if (!chat || chat.remindAt === undefined) return;
    if (chat.remindAt > Date.now()) return this.sync(); // clock moved (sleep, timer cap): re-arm
    // the chat is now purple; tell the renderer even though nothing on the chat itself changed.
    // If it is the chat on screen, that same save clears it again — no notification needed.
    const seen = this.viewing(chat.id);
    this.changed();
    if (seen || this.inApp(chat) || !Notification.isSupported()) return;
    const notification = new Notification({ title: "Reminder", subtitle: chat.name, body: "You asked to come back to this chat." });
    notification.on("click", () => this.openChat(chat.id));
    notification.on("failed", (_event, error) => console.warn("Reminder notification failed:", error));
    notification.show();
  }

  stop() {
    for (const { timer } of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
