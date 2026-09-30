import React, { useEffect, useState } from "react";
import { resetLabel, seatLoad, seatName, type Seat, type SeatPool, type SeatWindow } from "../../shared/seatPool";
import { formatAge, formatReset, usageTone } from "../../shared/usage";
import type { Api, Chat, State } from "../../shared/types";

const ade = (window as any).ade as Api;

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

function SeatRow({ seat, best, running, now }: { seat: Seat; best: boolean; running: number; now: number }) {
  const read = seat.ageS !== undefined ? ` · read ${formatAge(now - seat.ageS * 1000, now)}` : "";
  const title = [seat.email ?? seat.dir, `${seat.live ? "live" : `cached (${seat.source || "no live read"})`}${read}`, seat.blocked ? "Over a chooser ceiling" : "", best ? "The chooser's pick for the next chat" : ""].filter(Boolean).join("\n");
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

function SeatRows({ state, now }: { state: State; now: number }) {
  const pool = state.seatPool;
  const pooled = new Set(state.keys.filter((k) => k.pool).map((k) => k.id));
  const running = (dir: string) => state.chats.filter((c) => c.running && c.seatDir === dir && pooled.has(c.keyId)).length;
  return <>
    {pool?.error && <div className="seats-error" title={pool.error}>{pool.error}</div>}
    {pool?.seats.map((s) => <SeatRow key={s.dir} seat={s} best={s.dir === pool.pick} running={running(s.dir)} now={now} />)}
    {!pool?.seats.length && !pool?.error && <div className="seats-note">Reading seats…</div>}
  </>;
}

/** the sidebar's always-on read of every seat: 5-hour, weekly and per-model windows, and which seat new chats go to */
export function SeatsStrip({ state }: { state: State }) {
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(() => { try { return localStorage.getItem("seatsOpen") !== "0"; } catch { return true; } });
  useEffect(() => { try { localStorage.setItem("seatsOpen", open ? "1" : "0"); } catch {} }, [open]);
  const pool = state.seatPool;
  if (!state.seatChooser && !pool) return null;
  const refresh = async () => {
    setBusy(true);
    try { await ade.refreshSeats(); } catch (e) { alert((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="seats">
      <div className="sect seats-head">
        <button className="seats-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>Seats {open ? "▾" : "▸"}</button>
        <span className="seats-age" title={pool?.note ?? ""}>{busy ? "reading…" : pool?.at ? formatAge(pool.at, now) : ""}{!open && pool?.pick ? ` · ${seatName(pool, pool.pick)}` : ""}</span>
        <button className="icon" title="Re-read every seat's usage now" aria-label="Refresh seats" disabled={busy} onClick={() => void refresh()}>↻</button>
      </div>
      {open && <SeatRows state={state} now={now} />}
    </div>
  );
}

/**
 * The composer's seat menu for a Claude chat: which seat it is on, and a move to the best other seat or
 * a named one. Moving a running chat stops the turn and resumes the same session on the new seat.
 */
export function SeatPicker({ chat, keys, pool }: { chat: Chat; keys: State["keys"]; pool?: SeatPool }) {
  const [busy, setBusy] = useState(false);
  const key = keys.find((k) => k.id === chat.keyId);
  if (!keys.some((k) => k.pool) || chat.provider !== "claude") return null;
  const onPool = !!key?.pool;
  const current = onPool ? chat.seatDir : undefined;
  const move = async (dir?: string) => {
    const where = dir ? seatName(pool, dir) : onPool ? "the best other seat" : "the seat pool";
    if (chat.running && !confirm(`Stop this run and continue it on ${where}?`)) return;
    setBusy(true);
    try { await ade.switchSeat(chat.id, dir); } catch (e) { alert((e as Error).message); } finally { setBusy(false); }
  };
  const label = busy ? "moving…" : onPool ? `seat · ${current ? seatName(pool, current) : "auto"}` : "seat pool";
  return (
    <select className="seat-picker" aria-label="Seat" title={onPool ? "The Claude login this chat runs on. Pick another to move it; the session comes along." : "Move this chat onto the seat pool; the session comes along."}
      value="" disabled={busy} onChange={(e) => { const v = e.target.value; if (v) void move(v === "best" ? undefined : v); }}>
      <option value="" hidden>{label}</option>
      <option value="best">{onPool ? "Best other seat" : "Seat pool · best seat"}</option>
      {pool?.seats.map((s) => <option key={s.dir} value={s.dir} disabled={s.dir === current}>
        {s.name} · {seatLoad(s, chat.model)}%{s.blocked ? " · over ceiling" : ""}{s.dir === current ? " · current" : ""}
      </option>)}
    </select>
  );
}

/** the pool connector's own settings: where the chooser lives, and the seats it reads */
export function PoolSettings({ state }: { state: State }) {
  const now = useNow();
  const [path, setPath] = useState(state.seatChooser ?? "");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setPath(state.seatChooser ?? ""); }, [state.seatChooser]);
  const save = async (next: string) => {
    setBusy(true);
    try { await ade.setSeatChooser(next); } catch (e) { alert((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="pool-settings">
      <div className="conn-note">A chat here keeps one seat so its prompt cache stays warm. When that seat hits a limit, the chat moves to the seat the chooser names and carries on in the same session. Never used for PHI.</div>
      <div className="path-pick">
        <input value={path} aria-label="Seat chooser script" placeholder="~/command-center/operating-model/bin/claude-chooser.sh" onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) void save(path); }} />
        <button disabled={busy || path.trim() === (state.seatChooser ?? "")} onClick={() => void save(path)}>Save</button>
        <button disabled={busy || !state.seatChooser} title="Stop reading seats. Chats on the pool stay on their last seat." onClick={() => void save("")}>Off</button>
      </div>
      {!!state.seatChooser && <div className="seats wide"><SeatRows state={state} now={now} /></div>}
    </div>
  );
}
