/**
 * The /ship pipeline as Consort sees it: one folder per feature under ~/command-center/pipeline,
 * each with a state.json the skill keeps. Consort only reads it; every change goes through the
 * skill, run as a fresh chat per command (the skill needs separate build and test sessions).
 */

export const SHIP_STAGES = ["Grilling", "Spec'd", "Implementing", "Ready to Test", "Revising", "In Review", "Merged", "Closed"] as const;

export type ShipFeature = {
  slug: string;
  title: string;
  /** the ClickUp task id; the skill's own commands address a feature by it */
  ticket?: string;
  clickupUrl?: string;
  stage: string;
  paused: boolean;
  built?: boolean;
  repos: string[];
  prs: string[];
  /** the skill's own note on what comes next, often a /ship command with a remark after it */
  next?: string;
  lastTransition?: number;
  lastNote?: string;
  report?: string;
  /** the latest test round's story results */
  tests?: { pass: number; total: number };
  folder: string;
  /** the background PR-review poller is alive */
  polling?: boolean;
};
export type ShipBoard = { root: string; features: ShipFeature[]; error?: string };

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const time = (v: unknown) => { const t = typeof v === "string" ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : undefined; };

export function parseShipState(raw: unknown, folder: string, polling = false): ShipFeature | undefined {
  const s = raw as Record<string, any> | null;
  if (!s || typeof s !== "object" || !str(s.slug) || !str(s.stage)) return;
  const history = Array.isArray(s.history) ? s.history : [];
  const stories = s.report?.summary && typeof s.report.summary === "object" ? Object.values(s.report.summary as Record<string, { status?: string }>) : [];
  return {
    slug: s.slug, title: str(s.title) ?? s.slug, ticket: str(s.clickup_task_id), clickupUrl: str(s.clickup_url),
    stage: s.stage, paused: !!s.paused, built: typeof s.built === "boolean" ? s.built : undefined,
    repos: strs(s.repos), prs: strs(s.prs), next: str(s.next_step),
    lastTransition: time(s.last_transition), lastNote: str(history.at(-1)?.comment),
    report: str(s.report?.html) ?? str(s.report?.md), folder, polling,
    ...(stories.length ? { tests: { pass: stories.filter((x) => x?.status === "PASS").length, total: stories.length } } : {}),
  };
}

/** active work first, in pipeline order, most recently moved first within a stage; finished work last */
export function sortShip(features: ShipFeature[]) {
  const rank = (f: ShipFeature) => { const i = SHIP_STAGES.indexOf(f.stage as (typeof SHIP_STAGES)[number]); return (f.paused ? 20 : 0) + (i < 0 ? 10 : i >= 6 ? 30 + i : i); };
  return [...features].sort((a, b) => rank(a) - rank(b) || (b.lastTransition ?? 0) - (a.lastTransition ?? 0));
}

export const shipId = (f: Pick<ShipFeature, "ticket" | "slug">) => f.ticket ?? f.slug;

/** the runnable part of the skill's next-step note: "/ship X pr-loop (round 3…)" → "/ship X pr-loop" */
export function nextCommand(f: ShipFeature): string | undefined {
  const m = /^\s*(\/ship(?:\s+(?!\()[^\s(]+)*)/.exec(f.next ?? "");
  return m?.[1].trim();
}

const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
export type ShipAction = { id: string; label: string; command: string; title?: string; primary?: boolean; ask?: string };

/** the buttons a feature gets at its stage; `ask` actions need text from the user, substituted for {text} */
export function shipActions(f: ShipFeature): ShipAction[] {
  const id = shipId(f);
  if (f.stage === "Merged" || f.stage === "Closed") return [];
  const next = nextCommand(f);
  const out: ShipAction[] = [];
  if (f.paused) return [{ id: "resume", label: "Resume", command: `/ship ${id}`, primary: true }];
  out.push({ id: "next", label: "Run next step", command: next ?? `/ship ${id}`, title: f.next, primary: true });
  if (f.stage === "Ready to Test") out.push({ id: "approve", label: "Approve", command: `/ship ${id} approve`, title: "Tests pass: open the PR" });
  if (f.stage === "In Review" && next !== `/ship ${id} pr-loop`) out.push({ id: "pr-loop", label: "PR loop", command: `/ship ${id} pr-loop`, title: "Answer review threads and CI" });
  if (["Ready to Test", "Revising", "In Review", "Implementing"].includes(f.stage))
    out.push({ id: "feedback", label: "Feedback…", command: `/ship ${id} {text}`, ask: "Feedback for this feature" });
  out.push({ id: "pause", label: "Pause", command: `/ship pause ${id}` });
  return out;
}

/** fills an `ask` action's {text}, quoted the way the skill's feedback form expects */
export const fillShipCommand = (command: string, text: string) => command.replace("{text}", quote(text.trim()));

/** "/ship 86akm7a8g pr-loop" → "pr-loop"; names the chat after what it was asked to do */
export function shipActionOf(command: string) {
  const [, , ...rest] = command.trim().split(/\s+/);
  if (command.trim().startsWith("/ship new")) return "new";
  if (command.trim().startsWith("/ship pause")) return "pause";
  const verb = rest[0];
  return !verb ? "next" : verb.startsWith('"') ? "feedback" : verb;
}

/** a message that is a slash command goes to the agent as typed: prompt text around it would become its arguments */
/** the name a new-feature chat gets at creation: the idea's first six words, so no two `new` chats read alike */
export function shipIdeaName(idea: string, max = 6): string {
  const words = idea.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const name = words.slice(0, max).join(" ");
  return words.length > max ? `${name}…` : name;
}
/** the chat name for a /ship run; the slug wins once the skill has picked one */
export const shipChatName = (action: string, slug?: string, name?: string) => `ship · ${slug ?? (name?.trim() || "new")} · ${action}`;
/** the attachment list as the prompt carries it: after a slash command it is part of the skill's arguments */
export const withAttachments = (text: string, files: string[]) => files.length ? `${text}\n\nAttached files (read them from disk):\n${files.map((f) => `- ${f}`).join("\n")}` : text;

/** a running `new` chat and the feature folder the skill just created for it */
export type NewShipChat = { id: string; name: string; since: number; slug?: string; action: string };
export type NewShipFeature = { slug: string; title: string; at: number };
const words = (s: string) => new Set(s.toLowerCase().replace(/^ship · /, "").replace(/ · \w+$/, "").split(/[^a-z0-9]+/).filter((w) => w.length > 2));
/**
 * Relink: a `new` chat has no slug until the skill's `init` writes state.json, so a feature folder that
 * appeared after the chat started, and that no chat claims yet, belongs to the unlinked `new` chat whose
 * name (the idea's first words) shares the most words with the feature's title; ties go to the older chat.
 */
export function matchNewChats(chats: NewShipChat[], features: NewShipFeature[], grace = 60_000): { chatId: string; slug: string }[] {
  const taken = new Set(chats.map((c) => c.slug).filter(Boolean));
  const free = chats.filter((c) => c.action === "new" && !c.slug).sort((a, b) => a.since - b.since);
  const out: { chatId: string; slug: string }[] = [];
  for (const f of features.filter((f) => !taken.has(f.slug)).sort((a, b) => a.at - b.at)) {
    const candidates = free.filter((c) => f.at >= c.since - grace && !out.some((o) => o.chatId === c.id));
    if (!candidates.length) continue;
    const title = words(`${f.title} ${f.slug.replace(/-/g, " ")}`);
    const score = (c: NewShipChat) => [...words(c.name)].filter((w) => title.has(w)).length;
    const best = candidates.reduce((a, b) => (score(b) > score(a) ? b : a));
    if (score(best) > 0 || candidates.length === 1) out.push({ chatId: best.id, slug: f.slug });
  }
  return out;
}

export const isSlashCommand = (text: string) => /^\/[a-z][\w:-]*(?:\s|$)/i.test(text.trim());

/**
 * Syncing with ClickUp. ClickUp owns each feature's stage; the skill's own `ship.py reconcile` moves a
 * state.json to it. Consort fetches the list's tasks on a seat, hands them over, and shows what moved.
 */
export type ShipTask = { id: string; status: string; name?: string; url?: string };
export type ShipSync = {
  at: number;
  /** features whose stage moved to match ClickUp */
  changed: { slug: string; ticket: string; from?: string; to: string }[];
  /** open ClickUp tasks with no feature folder here; `/ship <id>` brings one back */
  remote: ShipTask[];
  /** features whose ClickUp status isn't a stage, left as they are */
  unmapped: { slug: string; status: string }[];
  /** the seat the tasks were read on */
  seat?: string;
  error?: string;
};

/** the ClickUp filter tool, by the connector that provides it: the user's own MCP server or claude.ai's */
export const CLICKUP_FILTER_TOOLS = ["mcp__clickup__clickup_filter_tasks", "mcp__claude_ai_ClickUp__clickup_filter_tasks"];

/** "claude.ai Figma" → "mcp__claude_ai_Figma", the prefix every one of its tools carries */
export const mcpPrefix = (server: string) => `mcp__${server.replace(/[^A-Za-z0-9_-]/g, "_")}`;

/**
 * Everything but `tool`, denied by server where possible: a server that finishes connecting after the
 * session starts still can't add its tools (each tool schema costs context on every turn).
 */
export function denyAllBut(tool: string, tools: string[], servers: string[]) {
  const own = tool.split("__").slice(0, 2).join("__");
  return [...servers.map(mcpPrefix).filter((p) => p !== own), ...tools.filter((t) => t.startsWith(`${own}__`) && t !== tool)];
}

const text = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);

/** one task from a filter_tasks result; the status is a string or ClickUp's `{ status }` object */
export function toShipTask(raw: unknown): ShipTask | undefined {
  const t = raw as Record<string, any> | null;
  const id = text(t?.id);
  const status = text(t?.status) ?? text(t?.status?.status);
  if (!id || !status) return;
  return { id, status, ...(text(t?.name) ? { name: text(t?.name) } : {}), ...(text(t?.url) ? { url: text(t?.url) } : {}) };
}

/** a filter_tasks tool result as the session relays it: its tasks, and whether ClickUp has another page */
export function parseFilterResult(content: unknown): { tasks: ShipTask[]; more: boolean } | undefined {
  const body = typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => (c?.type === "text" ? c.text : "")).join("") : "";
  try {
    const j = JSON.parse(body);
    const list = Array.isArray(j) ? j : Array.isArray(j?.tasks) ? j.tasks : undefined;
    if (!list) return;
    return { tasks: list.map(toShipTask).filter((t: ShipTask | undefined): t is ShipTask => !!t), more: j?.has_more === true };
  } catch { return; }
}

/** the board syncs itself on open when the last sync is older than this; the button syncs any time */
export const SHIP_SYNC_MAX_AGE = 10 * 60_000;
export const shipSyncDue = (sync: ShipSync | undefined, now: number) => !sync || now - sync.at > SHIP_SYNC_MAX_AGE;

/** what the last sync changed, one line each, for the board's notes */
export function shipSyncNotes(sync: ShipSync | undefined): string[] {
  if (!sync) return [];
  return [
    ...sync.changed.map((c) => `${c.slug}: ${c.from ?? "?"} → ${c.to} (from ClickUp)`),
    ...sync.unmapped.map((u) => `${u.slug}: ClickUp says "${u.status}", which isn't a /ship stage; left as is`),
  ];
}
