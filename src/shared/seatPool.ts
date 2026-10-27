/**
 * The seat pool: every login connector of a provider is a "seat", and the pool connector ("Any
 * Claude", "Any Codex") runs each chat on the seat whose weekly credits expire soonest, spread so no one seat is crowded.
 * Consort reads each seat's usage itself (the same probe Settings shows) and picks; nothing
 * outside the app is involved. A chat keeps one seat, so its prompt cache stays warm, and
 * moves only when that seat hits a usage limit or the user moves it.
 */
import type { ApiKey, Provider } from "./types";
import { RESET_TIE_MS, SPREAD_SLACK, type ConnectorUsage, type UsageWindow } from "./usage.ts";

export type SeatWindow = { pct: number; resetsAt?: number };
export type Seat = {
  provider: Provider;
  /** the login connector this seat is */
  keyId: string;
  /** its config directory: CLAUDE_CONFIG_DIR or CODEX_HOME for a chat on it */
  dir: string;
  name: string;
  email?: string;
  /** the numbers came from the provider on the last read; false when the read failed (the rest is stale or empty) */
  live: boolean;
  /** why the last read failed, or what the provider says is shut */
  note?: string;
  /** shut by the provider, or over the ceiling on some window */
  blocked: boolean;
  fiveHour: SeatWindow;
  sevenDay: SeatWindow;
  /** per-model windows, keyed by family ("fable", "opus", "sonnet"…) */
  models: Record<string, SeatWindow>;
  /** when the numbers were read (epoch ms) */
  at: number;
};
export type SeatPick = { dir: string; keyId: string; blocked: boolean };
export type SeatPool = {
  /** when the seats were last read (epoch ms) */
  at: number;
  seats: Seat[];
  /** the seat new chats go to, per provider, as of `at` */
  picks: Partial<Record<Provider, SeatPick>>;
  /** every read failed; the seats above are from an earlier read */
  error?: string;
};

/** a window this far along is not offered a new chat; a chat already on it keeps going until the provider says no */
export const SEAT_CEILING = 95;

const NONE: SeatWindow = { pct: 0 };
const family = (w: UsageWindow) => (w.model ?? "").toLowerCase().replace(/^claude\s+/, "").trim();
const isFiveHour = (w: UsageWindow) => w.id === "five_hour" || w.id === "primary" || /^5-hour/i.test(w.label);
const isWeekly = (w: UsageWindow) => !w.model && (w.id === "seven_day" || w.id === "secondary" || /^weekly$/i.test(w.label.trim()) || /^7-day/i.test(w.label));

/** one connector's usage snapshot as a seat; a failed read keeps the previous seat's numbers, marked stale */
export function seatFromUsage(key: ApiKey, dir: string, usage: ConnectorUsage | undefined, previous: Seat | undefined, now: number): Seat {
  const base: Seat = previous ?? { provider: key.provider, keyId: key.id, dir, name: key.name, live: false, blocked: false, fiveHour: NONE, sevenDay: NONE, models: {}, at: 0 };
  if (!usage || usage.unavailable) return { ...base, provider: key.provider, keyId: key.id, dir, name: key.name, live: false, note: usage?.unavailable ?? "not read yet" };
  const win = (w: UsageWindow | undefined): SeatWindow => (w ? { pct: w.percent, ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}) } : NONE);
  const five = usage.windows.find(isFiveHour);
  const week = usage.windows.find(isWeekly);
  const models: Record<string, SeatWindow> = {};
  for (const w of usage.windows) if (w.model && family(w)) models[family(w)] = win(w);
  const locked = usage.windows.find((w) => w.locked);
  const seat: Seat = { provider: key.provider, keyId: key.id, dir, name: key.name, email: usage.account, live: true, fiveHour: win(five), sevenDay: win(week), models, at: usage.at, blocked: false };
  seat.blocked = !!usage.blocked || !!locked || seatLoad(seat) >= SEAT_CEILING;
  const note = usage.blocked ?? (locked ? `${locked.label} is locked` : undefined);
  return note ? { ...seat, note } : seat;
}

export const seatOf = (pool: SeatPool | undefined, dir: string | undefined) => (dir ? pool?.seats.find((s) => s.dir === dir) : undefined);
export const seatName = (pool: SeatPool | undefined, dir: string | undefined) =>
  seatOf(pool, dir)?.name ?? (dir ? dir.split("/").filter(Boolean).pop()!.replace(/^\.(claude|codex)-?/, "") || "default" : "no seat");

/** "fable" from "claude-fable-5-1"; the per-model window a chat on that model draws from */
export const modelFamily = (model: string | undefined) => /\b(fable|mythos|opus|sonnet|haiku)\b/i.exec(model ?? "")?.[1].toLowerCase();

/** the tightest of a seat's windows for this model: the number the chooser ranks by */
export function seatLoad(seat: Seat, model?: string) {
  const fam = modelFamily(model);
  return Math.max(seat.fiveHour.pct, seat.sevenDay.pct, fam ? seat.models[fam]?.pct ?? 0 : 0);
}

/** when the seat's unspent weekly credits for this model expire: the soonest of its weekly window and the model's own */
export function seatWeekEnds(seat: Seat, model: string | undefined, now: number) {
  const fam = modelFamily(model);
  const times = [seat.sevenDay, ...(fam && seat.models[fam] ? [seat.models[fam]] : [])]
    .filter((w) => w.pct < 100).map((w) => w.resetsAt).filter((t): t is number => !!t && t > now);
  return times.length ? Math.min(...times) : undefined;
}

/**
 * The seat a chat on this provider should run on, never one in `exclude`. Among the live, unblocked
 * seats, the one whose weekly credits expire soonest wins, since what is left at a reset is lost;
 * resets within RESET_TIE_MS tie and go to the seat with more headroom. A seat running more chats
 * (`busy`, by dir) than the quietest open seat plus SPREAD_SLACK waits behind the others so one
 * login is not throttled. With every seat blocked the least-loaded one is named and flagged, so
 * the caller can say the pool is out rather than pretend.
 */
export function pickSeat(pool: SeatPool | undefined, provider: Provider, opts: { model?: string; exclude?: string[]; busy?: Record<string, number>; now?: number } = {}): SeatPick | undefined {
  const skip = new Set(opts.exclude ?? []);
  const seats = (pool?.seats ?? []).filter((s) => s.provider === provider && !skip.has(s.dir));
  if (!seats.length) return undefined;
  const now = opts.now ?? Date.now();
  const load = (s: Seat) => seatLoad(s, opts.model);
  const open = seats.filter((s) => s.live && !s.blocked && load(s) < SEAT_CEILING);
  if (open.length) {
    const running = (s: Seat) => opts.busy?.[s.dir] ?? 0;
    const quietest = Math.min(...open.map(running));
    const ends = new Map(open.map((s) => [s.dir, seatWeekEnds(s, opts.model, now) ?? Infinity]));
    const soonest = Math.min(...ends.values());
    const tier = (s: Seat) => { const t = ends.get(s.dir)!; return t === Infinity ? Infinity : Math.floor((t - soonest) / RESET_TIE_MS); };
    const busy = (s: Seat) => (running(s) > quietest + SPREAD_SLACK ? 1 : 0);
    const s = [...open].sort((a, b) => busy(a) - busy(b) || (tier(a) === tier(b) ? 0 : tier(a) < tier(b) ? -1 : 1) || load(a) - load(b))[0];
    return { dir: s.dir, keyId: s.keyId, blocked: false };
  }
  const s = seats.reduce((a, b) => (load(b) < load(a) ? b : a));
  return { dir: s.dir, keyId: s.keyId, blocked: true };
}

/** the pool snapshot from a set of seats, with the pick per provider */
export function buildPool(seats: Seat[], now: number, error?: string): SeatPool {
  const picks: SeatPool["picks"] = {};
  for (const provider of ["claude", "codex"] as const) { const p = pickSeat({ at: now, seats, picks: {} }, provider); if (p) picks[provider] = p; }
  return { at: now, seats, picks, ...(error ? { error } : {}) };
}

/** when the soonest spent window reopens across the provider's seats, for "every seat is out" */
export function earliestReset(pool: SeatPool | undefined, provider?: Provider, now = Date.now()) {
  const times = (pool?.seats ?? []).filter((s) => !provider || s.provider === provider)
    .flatMap((s) => [s.fiveHour, s.sevenDay, ...Object.values(s.models)].filter((w) => w.pct >= SEAT_CEILING).map((w) => w.resetsAt))
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
/** Codex names the same thing in its error kinds and messages */
export const isCodexLimitText = (s: unknown): s is string =>
  typeof s === "string" && /usage.?limit|rate.?limit.?(?:exceeded|reached)|quota.?exceeded|usage.?not.?included|too many requests|\b429\b/i.test(s);

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
 * as a fraction); folding that into the snapshot keeps the meters live between reads.
 */
export function applyRateInfo(pool: SeatPool | undefined, dir: string | undefined, info: { unifiedWindows?: UnifiedWindows } | undefined): SeatPool | undefined {
  const seat = seatOf(pool, dir);
  const w = info?.unifiedWindows;
  if (!pool || !seat || !w) return pool;
  const read = (x: UnifiedWindows[string], prev: SeatWindow): SeatWindow =>
    typeof x?.utilization === "number" ? { pct: Math.round(x.utilization * 100), resetsAt: ms(x.resetsAt) ?? prev.resetsAt } : prev;
  const next: Seat = { ...seat, fiveHour: read(w.five_hour, seat.fiveHour), sevenDay: read(w.seven_day, seat.sevenDay), at: Date.now() };
  next.blocked = next.blocked || seatLoad(next) >= SEAT_CEILING;
  return { ...pool, seats: pool.seats.map((s) => (s === seat ? next : s)) };
}

/**
 * The pool as one connector's meters: each window at its lowest across the provider's seats, since
 * a chat that needs headroom goes wherever it is. Gating a model on this blocks it only when every seat is spent.
 */
export function poolUsage(keyId: string, pool: SeatPool | undefined, provider: Provider): ConnectorUsage {
  const seats = (pool?.seats ?? []).filter((s) => s.provider === provider);
  if (!seats.length) return { keyId, at: Date.now(), windows: [], unavailable: pool?.error ?? "No seats read yet." };
  const low = (pick: (s: Seat) => SeatWindow | undefined) => {
    const ws = seats.filter((s) => s.live).map(pick).filter((w): w is SeatWindow => !!w);
    return ws.length ? ws.reduce((a, b) => (b.pct < a.pct ? b : a)) : undefined;
  };
  const families = [...new Set(seats.flatMap((s) => Object.keys(s.models)))];
  const windows = [
    { id: "five_hour", label: "5-hour", w: low((s) => s.fiveHour) },
    { id: "seven_day", label: "Weekly", w: low((s) => s.sevenDay) },
    ...families.map((f) => { const model = f[0].toUpperCase() + f.slice(1); return { id: `seven_day_${f}`, label: `Weekly · ${model}`, model, w: low((s) => s.models[f] ?? { pct: 0 }) }; }),
  ].flatMap(({ w, ...rest }) => (w ? [{ ...rest, percent: w.pct, resetsAt: w.resetsAt }] : []));
  const pick = pool?.picks[provider];
  return { keyId, at: pool?.at ?? Date.now(), account: `${seats.length} seat${seats.length === 1 ? "" : "s"} · best now: ${pick ? seatName(pool, pick.dir) : "none"}`, windows };
}
