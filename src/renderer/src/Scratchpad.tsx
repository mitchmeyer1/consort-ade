import React, { useEffect, useRef, useState } from "react";
import { activateScratchTab, activeScratchTab, addScratchTab, emptyScratchpad, normalizeScratchpad, removeScratchTab, renameScratchTab, setScratchText, type Scratchpad } from "../../shared/scratchpad";
import type { Api, State } from "../../shared/types";

declare const ade: Api;

/**
 * The Scratchpad bar under Usage at the foot of the sidebar (shared/scratchpad.ts): tabs of
 * plain text, add and remove at will, saved to Consort's state as you type. The pad is edited
 * locally and written through on a short debounce so keystrokes never wait on the main process;
 * what main echoes back is adopted only when nothing is pending here.
 */
export function ScratchpadStrip({ state }: { state: State }) {
  const [open, setOpen] = useState(() => { try { return localStorage.getItem("scratchpadOpen") === "1"; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem("scratchpadOpen", open ? "1" : "0"); } catch {} }, [open]);
  const [pad, setPad] = useState<Scratchpad>(() => normalizeScratchpad(state.scratchpad ?? emptyScratchpad()));
  const pending = useRef<Scratchpad | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // main's copy wins only when this side has nothing waiting to be written
  useEffect(() => { if (!pending.current) setPad(normalizeScratchpad(state.scratchpad ?? emptyScratchpad())); }, [state.scratchpad]);
  const flush = () => {
    clearTimeout(timer.current);
    const next = pending.current;
    pending.current = null;
    if (next) ade.setScratchpad(next).catch(() => {});
  };
  const commit = (next: Scratchpad, immediate = false) => {
    setPad(next);
    pending.current = next;
    clearTimeout(timer.current);
    if (immediate) flush();
    else timer.current = setTimeout(flush, 400);
  };
  useEffect(() => () => flush(), []);
  const [renaming, setRenaming] = useState<string | null>(null);
  const active = activeScratchTab(pad);
  const add = () => { commit(addScratchTab(pad, crypto.randomUUID(), Date.now()), true); setOpen(true); };
  const remove = (id: string) => {
    const tab = pad.tabs.find((t) => t.id === id);
    if (tab?.text.trim() && !confirm(`Delete "${tab.title}"? Its text goes with it.`)) return;
    commit(removeScratchTab(pad, id), true);
  };
  return (
    <div className="scratchpad">
      <div className="sect seats-head">
        <button className="seats-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>Scratchpad {open ? "▾" : "▸"}</button>
        <span className="seats-age">{!open && active ? active.title : pad.tabs.length ? `${pad.tabs.length} tab${pad.tabs.length === 1 ? "" : "s"}` : ""}</span>
        <button className="icon" title="New tab" aria-label="New scratchpad tab" onClick={add}>＋</button>
      </div>
      {open && (
        <div className="scratch-body">
          {pad.tabs.length > 0 && <div className="scratch-tabs" role="tablist">
            {pad.tabs.map((t) => (
              <div key={t.id} role="tab" aria-selected={t.id === active?.id} className={"scratch-tab" + (t.id === active?.id ? " on" : "")}
                onClick={() => commit(activateScratchTab(pad, t.id), true)} onDoubleClick={() => setRenaming(t.id)} title="Double-click to rename">
                {renaming === t.id
                  ? <input autoFocus defaultValue={t.title} aria-label="Tab name" onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => { commit(renameScratchTab(pad, t.id, e.target.value), true); setRenaming(null); }}
                      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setRenaming(null); }} />
                  : <span className="scratch-title">{t.title}</span>}
                {t.id === active?.id && renaming !== t.id && <button className="icon scratch-close" title="Delete tab" aria-label={`Delete ${t.title}`} onClick={(e) => { e.stopPropagation(); remove(t.id); }}>×</button>}
              </div>
            ))}
          </div>}
          {active
            ? <textarea key={active.id} className="scratch-text" value={active.text} spellCheck placeholder="Jot anything. Saved as you type."
                onChange={(e) => commit(setScratchText(pad, active.id, e.target.value, Date.now()))} onBlur={flush} />
            : <div className="row hint" onClick={add}><small>No tabs yet. Press ＋ to add one.</small></div>}
        </div>
      )}
    </div>
  );
}
