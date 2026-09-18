/** One metered window of a plan: how much of it is used and when it rolls over. */
export type UsageWindow = { id: string; label: string; percent: number; resetsAt?: number };

/** What Settings shows for one connector: the plan's meters, or why there are none. */
export type ConnectorUsage = {
  keyId: string;
  /** when this snapshot was taken (epoch ms) */
  at: number;
  plan?: string;
  account?: string;
  windows: UsageWindow[];
  /** the provider is refusing ordinary usage plan-wide (credits gone, workspace cap hit…) */
  blocked?: string;
  /** nothing to meter: an API key, a signed-out CLI, a probe that failed… */
  unavailable?: string;
};

const pct = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : undefined);
const isoMs = (s: unknown) => { const t = typeof s === "string" ? Date.parse(s) : NaN; return Number.isFinite(t) ? t : undefined; };
const secMs = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? n * 1000 : undefined);
const humanize = (s: string) => s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/** "5-hour" / "Weekly" from a window length, falling back to the raw duration */
export function windowLabel(minutes: number | undefined | null): string {
  if (minutes == null) return "Window";
  if (minutes === 300) return "5-hour";
  if (minutes === 10080) return "Weekly";
  if (minutes % 1440 === 0) return `${minutes / 1440}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
}

type ClaudeRow = { kind?: unknown; percent?: unknown; resets_at?: unknown; scope?: { model?: { display_name?: unknown } | null; surface?: { display_name?: unknown } | null } | null };
type ClaudeWindow = { utilization?: unknown; resets_at?: unknown; locked_reason?: unknown } | null | undefined;
type ClaudeUsage = {
  subscription_type?: unknown;
  rate_limits_available?: unknown;
  rate_limits?: {
    five_hour?: ClaudeWindow; seven_day?: ClaudeWindow; seven_day_opus?: ClaudeWindow; seven_day_sonnet?: ClaudeWindow;
    model_scoped?: { display_name?: unknown; utilization?: unknown; resets_at?: unknown }[] | null;
    limits?: ClaudeRow[] | null;
  } | null;
};

const CLAUDE_FIXED: [keyof NonNullable<ClaudeUsage["rate_limits"]>, string][] = [["five_hour", "5-hour"], ["seven_day", "Weekly"], ["seven_day_opus", "Weekly · Opus"], ["seven_day_sonnet", "Weekly · Sonnet"]];

/**
 * Shapes the Claude Code `/usage` answer for display. The server's own rows (`limits[]`) win when
 * present — they carry per-model weekly meters and arrive in the server's order — else the fixed
 * 5-hour / weekly fields are used. An API-key session reports no plan and shows as unavailable.
 */
export function claudeUsageFrom(keyId: string, raw: ClaudeUsage, at: number): ConnectorUsage {
  const plan = typeof raw?.subscription_type === "string" ? raw.subscription_type : undefined;
  const rl = raw?.rate_limits;
  if (raw?.rate_limits_available === false || !rl) return { keyId, at, plan, windows: [], unavailable: "No plan limits apply to this connector." };
  const windows: UsageWindow[] = [];
  const rows = Array.isArray(rl.limits) ? rl.limits : [];
  for (const [i, row] of rows.entries()) {
    const percent = pct(row?.percent);
    if (percent === undefined) continue;
    const kind = typeof row.kind === "string" ? row.kind : "window";
    const scope = row.scope?.model?.display_name ?? row.scope?.surface?.display_name;
    const label = kind === "session" ? "5-hour" : kind === "weekly_all" ? "Weekly" : kind.startsWith("weekly") ? (typeof scope === "string" ? `Weekly · ${scope}` : "Weekly") : humanize(kind);
    windows.push({ id: `${kind}:${typeof scope === "string" ? scope : i}`, label, percent, resetsAt: isoMs(row.resets_at) });
  }
  if (!windows.length) {
    for (const [field, label] of CLAUDE_FIXED) {
      const w = rl[field] as ClaudeWindow;
      const percent = pct(w?.utilization);
      if (percent !== undefined) windows.push({ id: field, label, percent, resetsAt: isoMs(w?.resets_at) });
    }
    for (const m of rl.model_scoped ?? []) {
      const percent = pct(m?.utilization);
      if (percent !== undefined && typeof m.display_name === "string") windows.push({ id: `model:${m.display_name}`, label: `Weekly · ${m.display_name}`, percent, resetsAt: isoMs(m.resets_at) });
    }
  }
  const locked = CLAUDE_FIXED.map(([f]) => (rl[f] as ClaudeWindow)?.locked_reason).find((r) => typeof r === "string") as string | undefined;
  return { keyId, at, plan, windows, ...(locked ? { blocked: humanize(locked) } : {}) };
}

type CodexWindow = { usedPercent?: unknown; windowDurationMins?: unknown; resetsAt?: unknown } | null | undefined;
type CodexRateLimits = {
  ordinaryUsageAllowed?: unknown;
  rateLimits?: { primary?: CodexWindow; secondary?: CodexWindow; planType?: unknown; rateLimitReachedType?: unknown } | null;
};
type CodexAccount = { account?: { email?: unknown; planType?: unknown } | null } | null | undefined;

const CODEX_BLOCKS: Record<string, string> = {
  rate_limit_reached: "Rate limit reached",
  workspace_member_credits_depleted: "Workspace credits depleted",
  workspace_owner_credits_depleted: "Workspace credits depleted",
  workspace_member_usage_limit_reached: "Workspace usage limit reached",
  workspace_owner_usage_limit_reached: "Workspace usage limit reached",
};

/** Shapes Codex's `account/rateLimits/read` (+ `account/read`) answers for display. */
export function codexUsageFrom(keyId: string, raw: CodexRateLimits, account: CodexAccount, at: number): ConnectorUsage {
  const rl = raw?.rateLimits;
  const plan = [rl?.planType, account?.account?.planType].find((p) => typeof p === "string" && p !== "unknown") as string | undefined;
  const email = typeof account?.account?.email === "string" ? account.account.email : undefined;
  if (!rl) return { keyId, at, plan, account: email, windows: [], unavailable: "No plan limits apply to this connector." };
  const windows: UsageWindow[] = [];
  for (const [id, w] of [["primary", rl.primary], ["secondary", rl.secondary]] as const) {
    const percent = pct(w?.usedPercent);
    if (percent === undefined) continue;
    const mins = typeof w?.windowDurationMins === "number" ? w.windowDurationMins : undefined;
    windows.push({ id, label: windowLabel(mins), percent, resetsAt: secMs(w?.resetsAt) });
  }
  const reached = typeof rl.rateLimitReachedType === "string" ? rl.rateLimitReachedType : undefined;
  const blocked = reached ? CODEX_BLOCKS[reached] ?? humanize(reached) : raw.ordinaryUsageAllowed === false ? "Usage paused by the provider" : undefined;
  return { keyId, at, plan, account: email, windows, ...(blocked ? { blocked } : {}) };
}

/** "resets in 2h 10m" — relative, so it reads the same in every timezone */
export function formatReset(resetsAt: number | undefined, now: number): string {
  if (resetsAt === undefined) return "";
  const s = Math.round((resetsAt - now) / 1000);
  if (s <= 0) return "resets now";
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return `resets in ${d}d${h ? ` ${h}h` : ""}`;
  if (h > 0) return `resets in ${h}h${m ? ` ${m}m` : ""}`;
  return `resets in ${Math.max(1, m)}m`;
}

/** "just now" / "4m ago" / "2h ago" for the snapshot timestamp */
export function formatAge(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** how loudly a meter should read: past 80% it warns, at 95%+ it is effectively spent */
export const usageTone = (percent: number): "ok" | "high" | "full" => (percent >= 95 ? "full" : percent >= 80 ? "high" : "ok");
