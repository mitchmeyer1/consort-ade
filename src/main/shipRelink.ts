import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { store } from "./store";
import { SHIP_HOME } from "./ship";
import { matchNewChats, shipChatName, type NewShipFeature } from "../shared/ship";

/**
 * A `/ship new` chat learns its slug from the skill, not from Consort: the folder appears under the pipeline
 * mid-turn. While an unlinked `new` chat exists the pipeline is polled, and a matching folder renames the chat
 * and pins it to the feature so the board's card shows it.
 */
export class ShipRelink {
  private timer?: NodeJS.Timeout;
  constructor(private root = join(SHIP_HOME, "pipeline"), private every = 5_000) {}
  start() { this.timer = setInterval(() => this.check(), this.every); this.timer.unref?.(); }
  stop() { clearInterval(this.timer); }
  check() {
    const chats = store.data.chats.filter((c) => c.ship).map((c) => ({ id: c.id, name: c.name, since: c.messages[0]?.ts ?? c.lastChattedAt ?? 0, slug: c.ship!.slug, action: c.ship!.action }));
    if (!chats.some((c) => c.action === "new" && !c.slug)) return;
    let features: NewShipFeature[] = [];
    try {
      features = readdirSync(this.root).filter((n) => !n.startsWith("_") && !n.startsWith(".")).flatMap((name) => {
        try {
          const file = join(this.root, name, "state.json");
          const at = statSync(file).mtimeMs;
          const s = JSON.parse(readFileSync(file, "utf8")) as { slug?: string; title?: string };
          return s.slug ? [{ slug: s.slug, title: s.title ?? s.slug, at }] : [];
        } catch { return []; }
      });
    } catch { return; }
    const matches = matchNewChats(chats, features);
    if (!matches.length) return;
    for (const m of matches) {
      const chat = store.chat(m.chatId);
      chat.ship = { ...chat.ship!, slug: m.slug };
      chat.name = shipChatName(chat.ship.action, m.slug);
    }
    store.save();
  }
}
