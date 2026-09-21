import { Notification } from "electron";
import type { Chat, PermissionRequest } from "../shared/types";

// A notification belongs to one request, never to whichever prompt is newest in a chat.
export class PermissionNotifications {
  private active = new Map<string, { close(): void }>();
  constructor(
    private chats: () => Chat[],
    private answer: (id: string, allow: boolean) => void,
    private openChat: (id: string) => void,
    /** shows the request in-app instead and returns true, when Consort is the active window */
    private inApp: (chat: Chat, request: PermissionRequest) => boolean = () => false,
  ) {}

  sync() {
    const chats = this.chats();
    const pending = new Set(chats.flatMap(c => (c.permissions ?? []).map(p => p.id)));
    for (const [id, notification] of this.active) {
      if (!pending.has(id)) { this.active.delete(id); notification.close(); }
    }
    for (const chat of chats) for (const request of chat.permissions ?? []) {
      if (this.active.has(request.id)) continue;
      // the permission box is already on screen in the chat; a toast points at it and needs no Allow/Block of its own
      if (this.inApp(chat, request)) { this.active.set(request.id, { close() {} }); continue; }
      if (!Notification.isSupported()) continue;
      const notification = new Notification({
        title: `Permission needed: ${request.tool}`,
        subtitle: chat.name,
        body: "Allow or block this request. Click the notification to review the details in chat.",
        actions: process.platform === "darwin" || process.platform === "win32"
          ? [{ type: "button", text: "Allow" }, { type: "button", text: "Block" }] : [],
        timeoutType: "never",
      });
      this.active.set(request.id, notification);
      notification.on("click", () => this.openChat(chat.id));
      notification.on("action", (event, legacyIndex) => {
        const index = event.actionIndex ?? legacyIndex;
        if (index !== 0 && index !== 1) return;
        if (this.active.get(request.id) !== notification || !this.chats().some(c => c.id === chat.id && c.permissions?.some(p => p.id === request.id))) return;
        // answer removes the request and synchronously saves state; sync closes it.
        this.answer(request.id, index === 0);
      });
      notification.on("failed", (_event, error) => console.warn("Permission notification failed:", error));
      // Dismissal only hides the alert. The request remains pending in the chat.
      notification.show();
    }
  }
}
