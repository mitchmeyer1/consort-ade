import { app, safeStorage } from "electron";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { defaultConnector } from "../shared/defaultConnector";
import { codexModels } from "./codexModels";
import { MODELS } from "../shared/types";
import { ensureRootWorktree } from "./rootWorktree";
import { migrateQuickActions } from "../shared/quickActions";
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
    for (const c of this.data.chats) {
      if (c.sessionId) c.sessionKeyId ??= c.keyId;
      // running at shutdown, or a transcript that ends mid-turn (unanswered user message / tool call with no result) = dead
      const last = c.messages[c.messages.length - 1];
      const pendingTool = c.messages.some((m) => m.blocks.some((b) => b.type === "tool" && b.ok === undefined));
      if (c.running || (!c.error && last && (last.role === "user" || pendingTool))) c.interrupted = true;
      c.running = false;
      c.assessingPrompt = false;
      c.sideBusy = false;
      if (c.queuedMessages?.length) c.queuePaused = true;
      // reminders used to record when they were set; they now record when they come due
      const legacy = (c as Chat & { remindedAt?: number }).remindedAt;
      if (legacy && c.remindAt === undefined) { c.remindAt = legacy; delete (c as Chat & { remindedAt?: number }).remindedAt; }
      c.permissions = [];
    }
    for (const k of this.data.keys) { k.phiAllowed ??= false; k.auth ??= this.data.secrets[k.id] ? "key" : "login"; }
    // the CLI logins are always-present connectors; API keys are added on top
    for (const [id, provider, name] of [["login-codex", "codex", "Codex CLI login"], ["login-claude", "claude", "Claude Code login"]] as const)
      if (!this.data.keys.some((k) => k.id === id)) this.data.keys.unshift({ id, provider, name, phiAllowed: false, auth: "login" });
    this.data.defaultKeyId = defaultConnector(this.data)?.id;
    // Every project has a permanent chat scope at its existing checkout.
    for (const p of this.data.projects) {
      if (p.kind === "workspace" || p.kind === "home") continue; // a home's scope is its own root, named for the folder
      const existing = this.data.worktrees.find((w) => w.projectId === p.id && w.path === p.path);
      ensureRootWorktree(this.data.worktrees, p, existing?.branch ?? "(unknown)");
    }
    for (const w of this.data.worktrees) { w.title ??= w.name; w.archived ??= false; }
    // quick actions used to live on each worktree; they belong to the project
    migrateQuickActions(this.data.projects, this.data.worktrees);
  }

  public(): State {
    const { secrets: _s, ...rest } = this.data;
    // Codex keeps its own catalog on disk; Claude's list is whatever the CLI last reported, else the seed
    return { ...rest, models: { codex: codexModels(this.data.keys), claude: this.data.modelCatalog?.claude?.models?.length ? this.data.modelCatalog.claude.models : MODELS.claude } };
  }

  onChange(cb: (s: State) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // ponytail: full rewrite on every change; fine until transcripts get huge
  save() {
    this.data.defaultKeyId = defaultConnector(this.data)?.id;
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
    if (!enc) return "";
    try { return safeStorage.decryptString(Buffer.from(enc, "base64")); }
    catch { throw new Error(`Can't decrypt the API key "${this.data.keys.find((k) => k.id === id)?.name ?? id}" — remove it in Settings and add it again.`); }
  }
}

export const store = new Store();
