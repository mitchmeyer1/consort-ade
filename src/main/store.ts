import { app, safeStorage } from "electron";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { State, Chat, Appearance } from "../shared/types";

type Persisted = State & { secrets: Record<string, string> };

const file = () => join(app.getPath("userData"), "state.json");
const empty = (): Persisted => ({ projects: [], worktrees: [], chats: [], keys: [], secrets: {}, appearance: { theme: "dark", background: "opaque" } as Appearance });

export class Store {
  data: Persisted = empty();
  private listeners = new Set<(s: State) => void>();

  load() {
    try {
      this.data = { ...empty(), ...JSON.parse(readFileSync(file(), "utf8")) };
    } catch {}
    for (const c of this.data.chats) { c.running = false; c.permissions = []; }
    for (const k of this.data.keys) { k.phiAllowed ??= false; k.auth ??= this.data.secrets[k.id] ? "key" : "login"; }
    // Root scopes are opt-in; retain them and their chat IDs across restarts.
    const roots = new Set(this.data.projects.map((p) => p.path));
    this.data.worktrees = this.data.worktrees.filter((w) => w.root || !roots.has(w.path));
    for (const w of this.data.worktrees) { w.title ??= w.name; w.archived ??= false; }
  }

  public(): State {
    const { secrets: _s, ...rest } = this.data;
    return rest;
  }

  onChange(cb: (s: State) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // ponytail: full rewrite on every change; fine until transcripts get huge
  save() {
    mkdirSync(app.getPath("userData"), { recursive: true });
    writeFileSync(file(), JSON.stringify(this.data));
    const pub = this.public();
    for (const l of this.listeners) l(pub);
  }

  chat(id: string): Chat {
    const c = this.data.chats.find((c) => c.id === id);
    if (!c) throw new Error(`no chat ${id}`);
    return c;
  }

  setSecret(id: string, key: string) {
    this.data.secrets[id] = safeStorage.encryptString(key).toString("base64");
  }
  getSecret(id: string) {
    const enc = this.data.secrets[id];
    return enc ? safeStorage.decryptString(Buffer.from(enc, "base64")) : "";
  }
}

export const store = new Store();
