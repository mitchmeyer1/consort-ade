import React, { useEffect, useState } from "react";
import { resetLabel, seatLoad, seatName, type Seat, type SeatPool, type SeatWindow } from "../../shared/seatPool";
import { formatAge, formatReset, usageTone } from "../../shared/usage";
import type { Api, Chat, Provider, State } from "../../shared/types";

const ade = (window as any).ade as Api;
const PROVIDERS: Provider[] = ["claude", "codex"];
const providerName = (p: Provider) => (p === "claude" ? "Claude" : "Codex");

function useNow(ms = 30_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

const windowsOf = (s: Seat): [string, string, SeatWindow][] => [
  ["5h", "5-hour", s.fiveHour], ["wk", "Weekly", s.sevenDay],
  ...Object.entries(s.models).map(([f, w]): [string, string, SeatWindow] => [f, `Weekly · ${f}`, w]),
];
const windowTitle = (label: string, w: SeatWindow, now: number) => `${label}: ${w.pct}%${w.resetsAt ? ` · ${formatReset(w.resetsAt, now)} (${resetLabel(w.resetsAt, now)})` : ""}`;

/** one login's meters: 5-hour, weekly and per-model windows, its star when it is the provider's pick */
function SeatRow({ seat, best, running, now }: { seat: Seat; best: boolean; running: number; now: number }) {
  const read = seat.at ? ` · read ${formatAge(seat.at, now)}` : "";
  const title = [seat.email ?? seat.dir, `${seat.live ? "live" : `stale${seat.note ? ` (${seat.note})` : ""}`}${read}`, seat.blocked ? `At its limit${seat.note ? `: ${seat.note}` : ""}` : "", best ? `Where new ${providerName(seat.provider)} chats go` : ""].filter(Boolean).join("\n");
  return (
    <div className={"seat" + (best ? " best" : "") + (seat.blocked ? " blocked" : "") + (seat.live ? "" : " stale")} title={title}>
      <span className="seat-name">{seat.name}{best && <span className="seat-best" aria-label="best seat">★</span>}{running > 0 && <span className="seat-count" title={`${running} chat${running === 1 ? "" : "s"} running on this seat`}>{running}</span>}</span>
      <span className="seat-bars">
        {windowsOf(seat).map(([short, label, w]) => (
          <span key={short} className={`seat-bar ${usageTone(w.pct)}`} title={windowTitle(label, w, now)} role="meter" aria-label={`${seat.name} ${label}`} aria-valuenow={w.pct} aria-valuemin={0} aria-valuemax={100}>
            <span className="seat-bar-label">{short}<span className="seat-bar-pct">{w.pct}</span></span>
            <span className="seat-bar-track"><span className="seat-bar-fill" style={{ width: `${Math.min(100, w.pct)}%` }} /></span>
          </span>
        ))}
      </span>
    </div>
  );
}

/** every seat, grouped by provider, with the pick starred */
function SeatRows({ state, now, provider }: { state: State; now: number; provider?: Provider }) {
  const pool = state.seatPool;
  const pooled = new Set(state.keys.filter((k) => k.pool).map((k) => k.id));
  const running = (dir: string) => state.chats.filter((c) => c.running && c.seatDir === dir && pooled.has(c.keyId)).length;
  const groups = PROVIDERS.filter((p) => !provider || p === provider).map((p) => ({ p, seats: (pool?.seats ?? []).filter((s) => s.provider === p) })).filter((g) => g.seats.length);
  return <>
    {pool?.error && <div className="seats-error" title={pool.error}>{pool.error}</div>}
    {groups.map(({ p, seats }) => <React.Fragment key={p}>
      {!provider && groups.length > 1 && <div className="seats-provider">{providerName(p)}</div>}
      {seats.map((s) => <SeatRow key={s.dir} seat={s} best={s.dir === pool?.picks[p]?.dir} running={running(s.dir)} now={now} />)}
    </React.Fragment>)}
    {!groups.length && !pool?.error && <div className="seats-note">{state.keys.some((k) => k.auth === "login" && !k.pool) ? "Reading usage…" : "Sign in to a Claude or Codex login to see usage."}</div>}
  </>;
}

/** the sidebar's always-on read of every login: 5-hour, weekly and per-model windows, and which seat new chats go to */
export function SeatsStrip({ state }: { state: State }) {
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(() => { try { return localStorage.getItem("seatsOpen") !== "0"; } catch { return true; } });
  useEffect(() => { try { localStorage.setItem("seatsOpen", open ? "1" : "0"); } catch {} }, [open]);
  const pool = state.seatPool;
  const refresh = async () => {
    setBusy(true);
    try { await ade.refreshSeats(); } catch (e) { alert((e as Error).message); } finally { setBusy(false); }
  };
  const picks = PROVIDERS.map((p) => pool?.picks[p]).filter(Boolean).map((k) => seatName(pool, k!.dir)).join(" · ");
  return (
    <div className="seats">
      <div className="sect seats-head">
        <button className="seats-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>Usage {open ? "▾" : "▸"}</button>
        <span className="seats-age" title={picks ? `Best seats now: ${picks}` : ""}>{busy ? "reading…" : pool?.at ? formatAge(pool.at, now) : ""}{!open && picks ? ` · ${picks}` : ""}</span>
        <button className="icon" title="Re-read every login's usage now" aria-label="Refresh usage" disabled={busy} onClick={() => void refresh()}>↻</button>
      </div>
      {open && <SeatRows state={state} now={now} />}
    </div>
  );
}

/**
 * The composer's seat menu for a pool chat: which login it is on, and a move to the best other one or
 * a named one. Moving a running chat stops the turn and resumes the same session on the new seat.
 */
export function SeatPicker({ chat, keys, pool }: { chat: Chat; keys: State["keys"]; pool?: SeatPool }) {
  const [busy, setBusy] = useState(false);
  const key = keys.find((k) => k.id === chat.keyId);
  if (!keys.some((k) => k.pool && k.provider === chat.provider)) return null;
  const onPool = !!key?.pool;
  const current = onPool ? chat.seatDir : key?.configDir;
  const seats = (pool?.seats ?? []).filter((s) => s.provider === chat.provider);
  const move = async (dir?: string) => {
    const where = dir ? seatName(pool, dir) : onPool ? "the best other seat" : `Any ${chat.provider === "claude" ? "Claude" : "Codex"}`;
    if (chat.running && !confirm(`Stop this run and continue it on ${where}?`)) return;
    setBusy(true);
    try { await ade.switchSeat(chat.id, dir); } catch (e) { alert((e as Error).message); } finally { setBusy(false); }
  };
  const label = busy ? "moving…" : onPool ? `seat · ${current ? seatName(pool, current) : "auto"}` : "seat";
  return (
    <select className="seat-picker" aria-label="Seat" title={onPool ? "The login this chat runs on. Pick another to move it; the session comes along when it can." : "Move this chat onto the pool, which switches logins when one hits its limit."}
      value="" disabled={busy} onChange={(e) => { const v = e.target.value; if (v) void move(v === "best" ? undefined : v); }}>
      <option value="" hidden>{label}</option>
      <option value="best">{onPool ? "Best other seat" : `Any ${chat.provider === "claude" ? "Claude" : "Codex"} · best seat`}</option>
      {seats.map((s) => <option key={s.dir} value={s.dir} disabled={s.dir === current}>
        {s.name} · {seatLoad(s, chat.model)}%{s.blocked ? " · at limit" : ""}{s.dir === current ? " · current" : ""}
      </option>)}
    </select>
  );
}

/** the pool connector's card in Settings: what it does, and the seats it runs on */
export function PoolSettings({ state, provider }: { state: State; provider: Provider }) {
  const now = useNow();
  return (
    <div className="pool-settings">
      <div className="conn-note">Runs each chat on whichever {providerName(provider)} login has the most headroom for its model. A chat keeps its login so its prompt cache stays warm; when that login hits a usage limit the chat moves to the next one and carries on, in the same session when the login can see it, else with a transcript handoff. Add logins under AI connectors to widen the pool.</div>
      <div className="seats wide"><SeatRows state={state} now={now} provider={provider} /></div>
    </div>
  );
}
