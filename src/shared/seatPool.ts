/**
 * The seat pool: several Claude subscription logins ("seats") that share one set of sessions,
 * plus an outside chooser script that reads every seat's live plan usage and names the one
 * with the most headroom. A chat on the pool connector keeps one seat, so its prompt cache
 * stays warm, and moves only when that seat hits a usage limit or the user moves it.
 */

export type SeatWindow = { pct: number; resetsAt?: number };
export type Seat = {
  dir: string;
  name: string;
  email?: string;
  /** the numbers came from the usage endpoint (or the chooser's own recent copy of it), not a days-old cache */
  live: boolean;
  source: string;
  /** over one of the chooser's ceilings */
  blocked: boolean;
  fiveHour: SeatWindow;
  sevenDay: SeatWindow;
  /** weekly per-model windows, keyed by family ("fable", "opus"…) */
  models: Record<string, SeatWindow>;
  /** seconds since the numbers were read */
  ageS?: number;
};
export type SeatPool = {
  /** when the chooser last answered (epoch ms) */
  at: number;
  pick?: string;
  /** even the best seat is over a ceiling */
  pickBlocked: boolean;
  note?: string;
  seats: Seat[];
  /** the last refresh failed; the seats above are from `at` */
  error?: string;
};

const num = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? n : 0);
const when = (s: unknown) => { const t = typeof s === "string" ? Date.parse(s) : NaN; return Number.isFinite(t) ? t : undefined; };
const win = (w: any): SeatWindow => ({ pct: Math.round(num(w?.pct)), resetsAt: when(w?.resets_at) });

/** `claude-chooser.sh --json` output → a pool snapshot; throws on anything that is not the chooser's JSON */
export function parseChooser(raw: string, at: number): SeatPool {
  const j = JSON.parse(raw);
  if (!j || !Array.isArray(j.seats)) throw new Error("not seat-chooser output");
  return {
    at,
    pick: typeof j.pick === "string" ? j.pick : undefined,
    pickBlocked: !!j.pick_blocked,
    note: typeof j.note === "string" ? j.note : undefined,
    seats: j.seats.map((s: any): Seat => ({
      dir: String(s.dir), name: String(s.name ?? s.dir), email: s.email || undefined,
      live: !!s.live, source: String(s.source ?? ""), blocked: !!s.blocked,
      fiveHour: win(s.five_hour), sevenDay: win(s.seven_day),
      models: Object.fromEntries(Object.entries(s.models ?? {}).map(([k, v]) => [k, win(v)])),
      ageS: typeof s.age_s === "number" ? s.age_s : undefined,
    })),
  };
}

export const seatOf = (pool: SeatPool | undefined, dir: string | undefined) => (dir ? pool?.seats.find((s) => s.dir === dir) : undefined);
export const seatName = (pool: SeatPool | undefined, dir: string | undefined) =>
  seatOf(pool, dir)?.name ?? (dir ? dir.split("/").filter(Boolean).pop()!.replace(/^\.claude-?/, "") || "default" : "no seat");

/** "fable" from "claude-fable-5-1"; the per-model window a chat on that model draws from */
export const modelFamily = (model: string | undefined) => /\b(fable|opus|sonnet|haiku)\b/i.exec(model ?? "")?.[1].toLowerCase();

/** the tightest of a seat's windows for this model, as the chooser scores it */
export function seatLoad(seat: Seat, model?: string) {
  const family = modelFamily(model);
  return Math.max(seat.fiveHour.pct, seat.sevenDay.pct, family ? seat.models[family]?.pct ?? 0 : 0);
}

/** when the soonest spent window reopens across the pool, for "every seat is out" */
export function earliestReset(pool: SeatPool | undefined, now = Date.now()) {
  const times = (pool?.seats ?? []).flatMap((s) => [s.fiveHour, s.sevenDay, ...Object.values(s.models)].filter((w) => w.pct >= 90).map((w) => w.resetsAt))
    .filter((t): t is number => !!t && t > now);
  return times.length ? Math.min(...times) : undefined;
}

// Mirrors the SDK's USAGE_LIMIT_ERROR_PREFIXES; the renderer shares this file and cannot load the SDK.
export const USAGE_LIMIT_PREFIXES = [
  "You've hit your", "You've reached your", "You're out of usage credits", "Your org is out of usage",
  "Your seat type doesn't include usage", "Your usage allocation has been disabled", "Your group's usage limit is set to $0",
  "Fable 5 requires usage credits", "You're out of extra usage", "Your seat type doesn't include extra usage",
];
export const isUsageLimitText = (s: unknown): s is string =>
  typeof s === "string" && (USAGE_LIMIT_PREFIXES.some((p) => s.trimStart().startsWith(p)) || /\busage limit reached\b/i.test(s));

export type LimitHit = { text: string; window?: string; resetsAt?: number };
type RateLimitInfo = { status?: string; rateLimitType?: string; resetsAt?: number; overageStatus?: string; isUsingOverage?: boolean };

const ms = (t: number | undefined) => (t ? (t < 1e12 ? t * 1000 : t) : undefined);

/** a `rate_limit_event` that stopped the turn; a rejection covered by extra usage is not one */
export function limitFromRateEvent(info: RateLimitInfo | undefined): LimitHit | undefined {
  if (info?.status !== "rejected") return;
  if (info.isUsingOverage || info.overageStatus === "allowed" || info.overageStatus === "allowed_warning") return;
  return { text: "", window: info.rateLimitType, resetsAt: ms(info.resetsAt) };
}

const WINDOWS: Record<string, string> = {
  five_hour: "5-hour limit", seven_day: "weekly limit", seven_day_opus: "weekly Opus limit", seven_day_sonnet: "weekly Sonnet limit",
  seven_day_overage_included: "weekly limit", overage: "extra-usage limit",
};
export const describeLimit = (hit: LimitHit) =>
  (hit.window && WINDOWS[hit.window]) || (/fable/i.test(hit.text) ? "Fable limit" : /week/i.test(hit.text) ? "weekly limit" : "usage limit");

/** "3:40 PM" today, "Sat 12:00 PM" later in the week */
export function resetLabel(t: number | undefined, now = Date.now()) {
  if (!t) return "";
  const d = new Date(t);
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return t - now < 20 * 3600_000 && d.getDate() === new Date(now).getDate() ? time : `${d.toLocaleDateString("en-US", { weekday: "short" })} ${time}`;
}

/** what a resumed session is told after it moved seats mid-turn */
export const SEAT_CONTINUE_PROMPT = "The previous account hit its usage limit mid-turn, so this same session now continues on another account. Your context is intact. Continue exactly where you left off: do not repeat finished work, and check the current state first if you are unsure what completed.";

type UnifiedWindows = Record<string, { utilization?: number; resetsAt?: number } | undefined>;
/**
 * Every Claude turn reports its seat's current windows (`rate_limit_event.unifiedWindows`, utilization
 * as a fraction); folding that into the snapshot keeps the meters live between chooser reads.
 */
export function applyRateInfo(pool: SeatPool | undefined, dir: string | undefined, info: { unifiedWindows?: UnifiedWindows } | undefined): SeatPool | undefined {
  const seat = seatOf(pool, dir);
  const w = info?.unifiedWindows;
  if (!pool || !seat || !w) return pool;
  const read = (x: UnifiedWindows[string], prev: SeatWindow): SeatWindow =>
    typeof x?.utilization === "number" ? { pct: Math.round(x.utilization * 100), resetsAt: ms(x.resetsAt) ?? prev.resetsAt } : prev;
  const next = { ...seat, fiveHour: read(w.five_hour, seat.fiveHour), sevenDay: read(w.seven_day, seat.sevenDay), ageS: 0 };
  return { ...pool, seats: pool.seats.map((s) => (s === seat ? next : s)) };
}

/**
 * The pool as one connector's meters: each window at its lowest across the seats, since a chat
 * that needs headroom goes wherever it is. Gating a model on this blocks it only when every seat is spent.
 */
export function poolUsage(keyId: string, pool: SeatPool | undefined): import("./usage").ConnectorUsage {
  if (!pool?.seats.length) return { keyId, at: Date.now(), windows: [], unavailable: pool?.error ?? "The seat chooser hasn't reported yet." };
  const low = (pick: (s: Seat) => SeatWindow | undefined) => {
    const ws = pool.seats.map(pick).filter((w): w is SeatWindow => !!w);
    return ws.length ? ws.reduce((a, b) => (b.pct < a.pct ? b : a)) : undefined;
  };
  const families = [...new Set(pool.seats.flatMap((s) => Object.keys(s.models)))];
  const windows = [
    { id: "five_hour", label: "5-hour", w: low((s) => s.fiveHour) },
    { id: "seven_day", label: "Weekly", w: low((s) => s.sevenDay) },
    ...families.map((f) => { const model = f[0].toUpperCase() + f.slice(1); return { id: `seven_day_${f}`, label: `Weekly · ${model}`, model, w: low((s) => s.models[f] ?? { pct: 0 }) }; }),
  ].flatMap(({ w, ...rest }) => (w ? [{ ...rest, percent: w.pct, resetsAt: w.resetsAt }] : []));
  return { keyId, at: pool.at, account: `${pool.seats.length} seats · best now: ${seatName(pool, pool.pick)}`, windows };
}
