import { app, safeStorage } from "electron";
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { defaultConnector } from "../shared/defaultConnector";
import { codexModels } from "./codexModels";
import { MODELS } from "../shared/types";
import { ensureRootWorktree } from "./rootWorktree";
import { migrateQuickActions } from "../shared/quickActions";
import { recoverBenignCodexFailure } from "../shared/codexDiagnostics";
import type { State, Chat, Appearance, Provider } from "../shared/types";

type Persisted = State & { secrets: Record<string, string> };
const OPENROUTER_SECRET_ID = "openrouter-jev";
const CLICKUP_SECRET_ID = "clickup-ship";

const file = () => join(app.getPath("userData"), "state.json");
/** the previous save, kept so a torn or truncated state.json is never the only copy */
const backup = () => `${file()}.bak`;
const temp = () => `${file()}.tmp`;
/** a state.json that would not parse, set aside so the next save cannot promote it over the backup */
const corrupt = () => `${file()}.corrupt`;
const empty = (): Persisted => ({ projects: [], worktrees: [], chats: [], keys: [], secrets: {}, appearance: { theme: "dark", background: "opaque" } as Appearance });

/**
 * Everything the app owns lives in one file, so a half-written one used to read as an empty state and
 * silently drop every project, chat and connector. Read defensively: a file that is missing, empty,
 * truncated mid-write or not shaped like a state is treated as no file at all, never as an empty one.
 */
function read(path: string): Persisted | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); }
  catch { return undefined; }
  if (!parsed || typeof parsed !== "object") return undefined;
  const p = parsed as Partial<Persisted>;
  // a real state always carries these four lists; anything else is a truncated or foreign file
  if (![p.projects, p.worktrees, p.chats, p.keys].every(Array.isArray)) return undefined;
  return { ...empty(), ...p } as Persisted;
}

export class Store {
  data: Persisted = empty();
  private listeners = new Set<(s: State) => void>();

  load() {
    const current = read(file());
    if (current) this.data = current;
    else {
      const previous = read(backup());
      if (previous) {
        this.data = previous;
        // hold the unreadable file aside: the next save renames state.json over the backup, and that
        // would throw away the one good copy we just recovered from
        try { if (existsSync(file())) renameSync(file(), corrupt()); } catch {}
        console.error(`state.json could not be read; recovered the previous save from ${backup()}. The unreadable file is at ${corrupt()}.`);
      } else if (existsSync(file())) {
        console.error(`state.json could not be read and no usable backup exists; starting from an empty state. The unreadable file is still at ${file()}.`);
      }
    }
    for (const c of this.data.chats) {
      if (c.sessionId) c.sessionKeyId ??= c.keyId;
      // Older builds stored Codex's harmless skill-budget notice as a failed run.
      // A turn that reached complete should recover as an unread successful result.
      recoverBenignCodexFailure(c);
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
    for (const k of this.data.keys) { k.auth ??= this.data.secrets[k.id] ? "key" : "login"; }
    // the CLI logins are always-present connectors; API keys are added on top
    for (const [id, provider, name] of [["login-codex", "codex", "Codex CLI login"], ["login-claude", "claude", "Claude Code login"]] as const)
      if (!this.data.keys.some((k) => k.id === id)) this.data.keys.unshift({ id, provider, name, auth: "login" });
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
    // what the providers last answered (main/modelDiscovery.ts); Codex also keeps its own catalog on disk; the seed list when neither has spoken
    const catalog = (p: Provider) => this.data.modelCatalog?.[p]?.models ?? [];
    const claude = catalog("claude");
    return { ...rest, openRouterConfigured: !!this.data.secrets[OPENROUTER_SECRET_ID], clickUpConfigured: !!this.data.secrets[CLICKUP_SECRET_ID], models: { codex: [...new Set([...catalog("codex"), ...codexModels(this.data.keys)])], claude: claude.length ? claude : MODELS.claude } };
  }

  onChange(cb: (s: State) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // ponytail: full rewrite on every change; fine until transcripts get huge
  save() {
    this.data.defaultKeyId = defaultConnector(this.data)?.id;
    mkdirSync(app.getPath("userData"), { recursive: true });
    // Serialise before touching disk: a throw here must leave the saved state untouched.
    const text = JSON.stringify(this.data);
    // Write beside the real file, then swap it in. Renames are atomic, so the app dying at any point
    // leaves a whole state.json or a whole backup, never a half-written one. Deliberately no fsync:
    // this runs every 80ms while a chat streams, and the swap already covers the app being killed.
    writeFileSync(temp(), text);
    try { if (existsSync(file())) renameSync(file(), backup()); } catch {}
    renameSync(temp(), file());
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

  setOpenRouterKey(key: string) {
    const value = key.trim();
    if (!value) delete this.data.secrets[OPENROUTER_SECRET_ID];
    else this.setSecret(OPENROUTER_SECRET_ID, value);
    this.save();
  }

  getOpenRouterKey() {
    return this.getSecret(OPENROUTER_SECRET_ID);
  }

  setClickUpKey(key: string) {
    const value = key.trim();
    if (!value) delete this.data.secrets[CLICKUP_SECRET_ID];
    else this.setSecret(CLICKUP_SECRET_ID, value);
    this.save();
  }

  getClickUpKey() {
    return this.getSecret(CLICKUP_SECRET_ID);
  }
}

export const store = new Store();
