import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildPool, pickSeat, seatFromUsage, type Seat, type SeatPick, type SeatPool } from "../shared/seatPool";
import type { ApiKey, Provider, State } from "../shared/types";
import type { ConnectorUsage } from "../shared/usage";

export const POOL_IDS: Record<Provider, string> = { claude: "pool-claude", codex: "pool-codex" };
export const POOL_NAMES: Record<Provider, string> = { claude: "Any Claude", codex: "Any Codex" };
export const isPoolId = (id: string) => Object.values(POOL_IDS).includes(id);

/** the config directory a login without one of its own uses */
export const defaultSeat = (provider: Provider) =>
  provider === "claude" ? process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude") : process.env.CODEX_HOME || join(homedir(), ".codex");
export const seatDirOf = (key: ApiKey) => key.configDir ?? defaultSeat(key.provider);
/** the login connectors of a provider: the seats its pool runs on */
export const seatKeys = (keys: ApiKey[], provider: Provider) => keys.filter((k) => k.provider === provider && k.auth === "login" && !k.pool);

/**
 * A provider with at least one login gets a pool connector, placed ahead of its logins. It becomes
 * the default connector when the default was that provider's built-in login (or nothing), so new
 * chats start on the pool. A provider whose logins are all gone loses its pool.
 */
export function ensurePoolKeys(state: Pick<State, "keys" | "defaultKeyId">) {
  for (const provider of ["claude", "codex"] as const) {
    const id = POOL_IDS[provider];
    const logins = seatKeys(state.keys, provider);
    const existing = state.keys.find((k) => k.id === id);
    if (!logins.length) {
      if (existing) state.keys = state.keys.filter((k) => k.id !== id);
      if (state.defaultKeyId === id) state.defaultKeyId = undefined;
      continue;
    }
    if (existing) { existing.pool = true; continue; }
    const first = state.keys.indexOf(logins[0]);
    const model = logins.find((k) => k.defaultModel)?.defaultModel;
    state.keys.splice(first, 0, { id, provider, name: POOL_NAMES[provider], auth: "login", pool: true, ...(model ? { defaultModel: model } : {}) });
    if (!state.defaultKeyId || state.defaultKeyId === `login-${provider}`) state.defaultKeyId = id;
  }
}

/**
 * Whether a session made on one seat can resume on another: Claude keeps `projects/<cwd>/<id>.jsonl`,
 * Codex `sessions/<y>/<m>/<d>/rollout-…-<id>.jsonl`, under the seat's config directory.
 */
export function sessionOnSeat(configDir: string, sessionId: string, provider: Provider = "claude") {
  try {
    if (provider === "claude") {
      const root = join(configDir, "projects");
      return readdirSync(root).some((p) => existsSync(join(root, p, `${sessionId}.jsonl`)));
    }
    const root = join(configDir, "sessions");
    const walk = (dir: string, depth: number): boolean => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (name.endsWith(".jsonl")) { if (name.includes(sessionId)) return true; continue; }
        if (depth < 3 && statSync(p).isDirectory() && walk(p, depth + 1)) return true;
      }
      return false;
    };
    return walk(root, 0);
  } catch { return false; }
}

export type SeatDeps = {
  keys: () => ApiKey[];
  /** one connector's usage, from the same probe Settings uses; `force` skips its cache */
  read: (key: ApiKey, force: boolean) => Promise<ConnectorUsage>;
  publish: (pool: SeatPool) => void;
  last: () => SeatPool | undefined;
  interval?: number;
  now?: () => number;
};

/**
 * Keeps the pool snapshot fresh: every few minutes, on demand after a limit or a switch, and once
 * at start. Each seat is read on its own, so one failing login leaves the others live; the pool is
 * only in error when nothing could be read.
 */
export function createSeatMonitor(deps: SeatDeps) {
  let timer: NodeJS.Timeout | undefined;
  let inflight: Promise<SeatPool> | undefined;
  const now = deps.now ?? Date.now;
  const refresh = (force = false): Promise<SeatPool> => {
    inflight ??= (async () => {
      const keys = [...seatKeys(deps.keys(), "claude"), ...seatKeys(deps.keys(), "codex")];
      const last = deps.last();
      const seats: Seat[] = await Promise.all(keys.map(async (k) => {
        const dir = seatDirOf(k);
        const prev = last?.seats.find((s) => s.keyId === k.id);
        const usage = await deps.read(k, force).catch((e): ConnectorUsage => ({ keyId: k.id, at: now(), windows: [], unavailable: String((e as Error).message ?? e).split("\n")[0] }));
        return seatFromUsage(k, dir, usage, prev, now());
      }));
      const error = seats.length && seats.every((s) => !s.live) ? seats.map((s) => `${s.name}: ${s.note}`).join(" · ") : undefined;
      const pool = buildPool(seats, now(), error);
      deps.publish(pool);
      return pool;
    })().finally(() => { inflight = undefined; });
    return inflight;
  };
  const stop = () => { if (timer) clearInterval(timer); timer = undefined; };
  const start = () => { stop(); void refresh(); timer = setInterval(() => void refresh(), deps.interval ?? 180_000); };
  return { refresh, start, stop };
}

// the app's one monitor, wired by main/index.ts; the agent loop reads picks through it
let monitor: ReturnType<typeof createSeatMonitor> | undefined;
let lastPool: () => SeatPool | undefined = () => undefined;
export function configureSeats(deps: SeatDeps) { monitor = createSeatMonitor(deps); lastPool = deps.last; return monitor; }
/** the pool as of now (a fresh read when `force`), or the last snapshot when nothing is wired */
export const readPool = (opts: { force?: boolean } = {}): Promise<SeatPool | undefined> => (monitor ? monitor.refresh(!!opts.force) : Promise.resolve(lastPool()));
export { pickSeat };
export type { SeatPick };
