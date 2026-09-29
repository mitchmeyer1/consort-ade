import React, { useEffect, useRef, useState } from "react";
import { chatStatus } from "../../shared/chatStatus";
import { fillShipCommand, shipActions, shipIdeaName, shipSyncDue, shipSyncNotes, type ShipAction, type ShipBoard, type ShipFeature } from "../../shared/ship";
import { formatAge } from "../../shared/usage";
import type { Api, Chat, State } from "../../shared/types";
import { Attachments, filesFromTransfer } from "./App";

const ade = (window as any).ade as Api;
const DONE = new Set(["Merged", "Closed"]);
const prLabel = (url: string) => { const m = /\/([^/]+)\/pull\/(\d+)/.exec(url); return m ? `${m[1]} #${m[2]}` : url; };
const fileUrl = (path: string) => `file://${path.split("/").map(encodeURIComponent).join("/")}`;
const lastAt = (c: Chat) => c.lastChattedAt ?? c.messages.at(-1)?.ts ?? 0;
const byRecent = (a: Chat, b: Chat) => lastAt(b) - lastAt(a);

/**
 * The /ship board: every feature under ~/command-center/pipeline, grouped by stage, with the skill's
 * own next command one click away. Each click is a fresh chat, since the skill needs its build and
 * its test in separate sessions; the board only reads state.json and never writes it. Stages follow
 * ClickUp: a sync (on open when the last one is stale, or from the button) runs the skill's reconcile.
 */
export function ShipPage({ state, onOpenChat }: { state: State; onOpenChat: (id: string) => void }) {
  const [board, setBoard] = useState<ShipBoard>();
  const [error, setError] = useState("");
  const [idea, setIdea] = useState("");
  const [name, setName] = useState("");
  const [namedByHand, setNamedByHand] = useState(false);
  const [files, setFiles] = useState<string[]>([]);
  const [over, setOver] = useState(false);
  const ideaBox = useRef<HTMLTextAreaElement>(null);
  const addFiles = (paths: string[]) => setFiles((f) => [...new Set([...f, ...paths])]);
  // the box grows with its content, like the chat composer
  const resize = (el: HTMLTextAreaElement | null) => { if (!el) return; el.style.height = "auto"; el.style.height = `${Math.min(el.scrollHeight, 240)}px`; };
  const [busy, setBusy] = useState<string>();
  const [showDone, setShowDone] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [syncing, setSyncing] = useState(false);
  const load = () => ade.shipBoard().then((b) => { setBoard(b); setError(""); setNow(Date.now()); }, (e) => setError((e as Error).message));
  const lastSync = useRef(state.shipSync);
  lastSync.current = state.shipSync;
  const sync = () => {
    setSyncing(true);
    return ade.syncShip().catch((e) => setError((e as Error).message)).finally(() => { setSyncing(false); void load(); });
  };
  useEffect(() => {
    const refresh = () => { void load(); if (shipSyncDue(lastSync.current, Date.now())) void sync(); };
    refresh();
    const t = setInterval(load, 10_000);
    window.addEventListener("focus", refresh);
    return () => { clearInterval(t); window.removeEventListener("focus", refresh); };
  }, []);
  const chats = state.chats.filter((c) => c.ship).sort(byRecent);
  const run = async (command: string, slug?: string, action?: string, extra: { name?: string; files?: string[] } = {}) => {
    // two runs on one feature would both write its state.json
    const live = slug && chats.find((c) => c.running && c.ship?.slug === slug);
    if (live && !confirm(`"${live.name}" is still running for this feature. Start another /ship chat anyway?`)) return;
    setBusy(slug ?? "new");
    try { onOpenChat(await ade.shipRun(command, { ...(slug ? { slug } : {}), ...(action ? { action } : {}), ...extra })); }
    catch (e) { alert((e as Error).message); }
    finally { setBusy(undefined); void load(); }
  };
  const start = () => {
    const text = idea.trim();
    if (!text) return;
    const chatName = (namedByHand ? name.trim() : "") || shipIdeaName(text);
    setIdea(""); setName(""); setNamedByHand(false); setFiles([]);
    requestAnimationFrame(() => resize(ideaBox.current));
    void run(`/ship new ${text}`, undefined, "new", { name: chatName, files });
  };
  const features = board?.features ?? [];
  const active = features.filter((f) => !DONE.has(f.stage));
  const done = features.filter((f) => DONE.has(f.stage));
  const group = (f: ShipFeature) => (f.paused ? "Paused" : f.stage);
  const stages = [...new Set(active.map(group))];
  const loose = chats.filter((c) => !c.ship?.slug).slice(0, 6);
  const synced = state.shipSync;
  const notes = shipSyncNotes(synced);
  const card = (f: ShipFeature) => <ShipCard key={f.slug} f={f} chats={chats.filter((c) => c.ship?.slug === f.slug)} now={now} busy={busy === f.slug} onRun={(cmd) => run(cmd, f.slug)} onOpenChat={onOpenChat} />;
  return (
    <div className="page ship-page">
      <div>
        <h1>/ship</h1>
        <div className="path">{board?.root ?? "~/command-center/pipeline"} · {active.length} active · {done.length} done{board ? ` · read ${formatAge(now, Date.now())}` : ""}</div>
      </div>
      <div className={"ship-new card" + (over ? " over" : "")}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false); }}
        onDrop={async (e) => { e.preventDefault(); setOver(false); addFiles(await filesFromTransfer(e.dataTransfer)); }}
        onPaste={async (e) => { if ([...e.clipboardData.items].some((i) => i.kind === "file")) { e.preventDefault(); addFiles(await filesFromTransfer(e.clipboardData)); } }}>
        <textarea ref={ideaBox} value={idea} rows={1} aria-label="New feature idea" placeholder="New feature: say it in a paragraph or two, or paste a ClickUp link. ↩ ships · ⇧↩ newline"
          onChange={(e) => { setIdea(e.target.value); resize(e.currentTarget); }}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); start(); } }} />
        {files.length > 0 && <div className="chips"><Attachments worktreeId={(state.worktrees.find((w) => w.ship) ?? state.worktrees[0])?.id} paths={files} onRemove={(f) => setFiles((x) => x.filter((y) => y !== f))} /></div>}
        <div className="ship-new-bar">
          <button className="icon attach" title="Attach files" aria-label="Attach files" onClick={async () => addFiles(await ade.pickFiles())}>
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.5l-8.6 8.6a5 5 0 0 1-7-7l9.2-9.2a3.3 3.3 0 0 1 4.7 4.7L10 18.9a1.6 1.6 0 0 1-2.3-2.3l8.5-8.5" /></svg>
          </button>
          <input className="ship-name" value={namedByHand ? name : shipIdeaName(idea)} aria-label="Chat name" placeholder="Name (optional)" title="The chat is named ship · <name> · new until the skill picks a slug"
            onChange={(e) => { setName(e.target.value); setNamedByHand(true); }} onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); start(); } }} />
          <span className="grow" />
          <button className="primary" disabled={!idea.trim() || busy === "new"} onClick={start}>{busy === "new" ? "Starting…" : "Ship it"}</button>
        </div>
      </div>
      <div className="ship-opts">
        <label title="The skill runs long unattended stretches: standups, AI test sessions, PR loops. Applies to /ship chats started from here on.">
          <input type="checkbox" checked={state.shipAutoApprove ?? true} onChange={(e) => ade.setShipAutoApprove(e.target.checked).catch((err) => alert(err.message))} /> Auto-approve tools in new /ship chats
        </label>
        <span className="grow" />
        <span className="ship-synced" title={synced?.seat ? `Read on seat ${synced.seat}` : undefined}>{syncing ? "Syncing with ClickUp…" : synced ? `ClickUp synced ${formatAge(synced.at, now)}` : "Not synced with ClickUp yet"}</span>
        <button disabled={syncing} title="Move every feature to its ClickUp status (the skill's own reconcile)" onClick={() => void sync()}>Sync with ClickUp</button>
        <button className="icon" title="Re-read every state.json" aria-label="Refresh the board" onClick={() => void load()}>↻</button>
      </div>
      {(error || board?.error) && <div className="conn-note">{error || board?.error}</div>}
      {synced?.error && !syncing && <div className="conn-note ship-sync-error">ClickUp sync failed: {synced.error}</div>}
      {!!notes.length && <div className="conn-note ship-sync-notes">{notes.map((n) => <div key={n}>{n}</div>)}</div>}
      {!!synced?.remote.length && <div className="ship-chats ship-remote"><span className="m">In ClickUp only</span>{synced.remote.map((r) => (
        <span key={r.id} className="chip ship-remote-task">
          <span role="link" title={`${r.id} · ${r.status}${r.url ? `\n${r.url}` : ""}`} onClick={() => r.url && ade.openExternal(r.url)}>{r.name ?? r.id} · {r.status}</span>
          <button className="icon" title={`Bring it back here: /ship ${r.id}`} disabled={busy === "new"} onClick={() => void run(`/ship ${r.id}`, undefined, "restore")}>restore</button>
        </span>
      ))}</div>}
      {!!loose.length && <div className="ship-chats loose"><span className="m">Recent /ship chats</span>{loose.map((c) => <ShipChatChip key={c.id} c={c} onOpen={onOpenChat} />)}</div>}
      {stages.map((stage) => (
        <section key={stage} className="ship-stage">
          <h2>{stage} <span className="m">({active.filter((f) => group(f) === stage).length})</span></h2>
          <div className="grid ship-grid">{active.filter((f) => group(f) === stage).map(card)}</div>
        </section>
      ))}
      {board && !active.length && !board.error && <div className="conn-note">Nothing in flight. Describe a feature above to start one.</div>}
      {!!done.length && (
        <section className="ship-stage">
          <h2>Done <span className="m">({done.length})</span> <button className="icon" onClick={() => setShowDone((v) => !v)}>{showDone ? "hide" : "show"}</button></h2>
          {showDone && <div className="grid ship-grid">{done.map(card)}</div>}
        </section>
      )}
    </div>
  );
}

function ShipCard({ f, chats, now, busy, onRun, onOpenChat }: { f: ShipFeature; chats: Chat[]; now: number; busy: boolean; onRun: (command: string) => void; onOpenChat: (id: string) => void }) {
  const [ask, setAsk] = useState<ShipAction>();
  const [text, setText] = useState("");
  const send = () => { if (!ask || !text.trim()) return; onRun(fillShipCommand(ask.command, text)); setAsk(undefined); setText(""); };
  const running = chats.some((c) => c.running);
  return (
    <div className={"card ship-card" + (f.paused ? " paused" : "") + (running ? " running" : "")}>
      <div className="t" title={f.slug}>{f.title}</div>
      <div className="badges">
        {f.ticket && <span className="badge issue" role="link" title="Open the ClickUp task" onClick={() => f.clickupUrl && ade.openExternal(f.clickupUrl)}>{f.ticket}</span>}
        {f.prs.map((pr) => <span key={pr} className="badge pr" role="link" title={pr} onClick={() => ade.openExternal(pr)}>{prLabel(pr)}</span>)}
        {f.report && <span className="badge issue" role="link" title={f.report} onClick={() => ade.openExternal(fileUrl(f.report!))}>report{f.tests ? ` ${f.tests.pass}/${f.tests.total}` : ""}</span>}
        {f.built === false && <span className="badge limited" title="The build hasn't run yet">unbuilt</span>}
        {f.polling && <span className="badge ci pending" title="The background PR-review poller is alive">polling</span>}
        {running && <span className="badge ci pending">running</span>}
      </div>
      {f.next && <div className="ship-next" title={f.next}><span className="m">Next</span>{f.next}</div>}
      {f.lastNote && <div className="snip" title={f.lastNote}>{f.lastNote}</div>}
      <div className="m">{f.repos.join(", ") || "no repo"}{f.lastTransition ? ` · moved ${formatAge(f.lastTransition, now)}` : ""}</div>
      {!ask && !!shipActions(f).length && <div className="actions ship-actions">
        {shipActions(f).map((a) => <button key={a.id} className={a.primary ? "primary" : ""} title={a.title ? `${a.title}\n${a.command}` : a.command} disabled={busy} onClick={() => (a.ask ? setAsk(a) : onRun(a.command))}>{a.label}</button>)}
      </div>}
      {ask && <div className="ship-ask">
        <textarea autoFocus rows={3} value={text} placeholder={ask.ask} aria-label={ask.ask} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") setAsk(undefined); if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }} />
        <div className="actions"><button onClick={() => setAsk(undefined)}>Cancel</button><button className="primary" disabled={!text.trim() || busy} onClick={send}>Send · ⌘↩</button></div>
      </div>}
      {!!chats.length && <div className="ship-chats">{chats.slice(0, 4).map((c) => <ShipChatChip key={c.id} c={c} onOpen={onOpenChat} />)}</div>}
    </div>
  );
}

function ShipChatChip({ c, onOpen }: { c: Chat; onOpen: (id: string) => void }) {
  const status = chatStatus(c);
  return <button className="chip ship-chat" title={`${c.name}${status ? ` · ${status}` : ""}`} onClick={() => onOpen(c.id)}>
    <span className={`chat-dot ${status ?? "idle"}`} aria-hidden />{c.ship?.action ?? "chat"}{c.ship?.slug ? "" : ` · ${c.name.replace(/^ship · /, "")}`}
  </button>;
}
