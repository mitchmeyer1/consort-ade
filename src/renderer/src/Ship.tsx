import React, { useState } from "react";
import { SHIP_STAGES, clickupIdFrom, fillShipCommand, shipActions, shipBusyLabel, shipDone, shipStep, stageIndex, ticketRef, type ShipAction, type ShipFeature } from "../../shared/ship";
import { formatAge } from "../../shared/usage";
import type { Api, Chat, State, Worktree } from "../../shared/types";

const ade = (window as any).ade as Api;
const prLabel = (url: string) => { const m = /\/([^/]+)\/pull\/(\d+)/.exec(url); return m ? `${m[1]} #${m[2]}` : url; };

/** runs one of the feature's buttons in a fresh chat of its worktree, asking for text first when the action needs it */
function useShipRun(wt: Worktree, onOpenChat: (id: string) => void, chatId?: string) {
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState<ShipAction>();
  const [text, setText] = useState("");
  const run = async (command: string) => {
    setBusy(true);
    try { const id = await ade.shipRun(wt.id, command, chatId); if (id !== chatId) onOpenChat(id); }
    catch (e) { alert((e as Error).message); }
    finally { setBusy(false); setAsk(undefined); setText(""); }
  };
  const click = (a: ShipAction) => (a.ask ? setAsk(a) : void run(a.command));
  const send = () => { if (ask && text.trim()) void run(fillShipCommand(ask.command, text)); };
  return { busy, ask, text, setText, setAsk, click, send };
}

/**
 * The stage bar of a /ship worktree: every stage with the current one lit, the ticket, and the
 * next step as a button. Sits above the chats of the worktree page and above a chat's messages.
 */
export function ShipBar({ wt, chats, compact, chatId, onOpenChat }: { wt: Worktree; chats: Chat[]; compact?: boolean; chatId?: string; onOpenChat: (id: string) => void }) {
  const f = wt.ship!;
  const at = stageIndex(f.stage);
  const running = chats.some((c) => c.running && c.worktreeId === wt.id);
  const actions = shipActions(f);
  const r = useShipRun(wt, onOpenChat, chatId);
  const primary = actions.find((a) => a.primary);
  const history = f.history.map((h) => `${new Date(h.at).toLocaleDateString()} ${h.stage}${h.note ? `: ${h.note}` : ""}`).join("\n");
  const side = <>
    <span className="badge issue" role="link" title={f.ticket.title} onClick={() => ade.openExternal(f.ticket.url)}>{ticketRef(f.ticket)}</span>
    {f.prs.map((pr) => <span key={pr} className="badge pr" role="link" title={pr} onClick={() => ade.openExternal(pr)}>{prLabel(pr)}</span>)}
    {f.tests && <span className="badge ci" title={f.report}>{f.tests.pass}/{f.tests.total} stories</span>}
    {running && <span className="badge ci pending">running</span>}
    <span className="grow" />
    {!shipDone(f) && !r.ask && primary && <button className="primary" disabled={r.busy || running} title={running ? "A chat of this feature is working on this stage" : primary.title ?? primary.command} onClick={() => r.click(primary)}>{r.busy ? "Starting…" : running ? shipBusyLabel(f) : primary.label}</button>}
    {!shipDone(f) && !r.ask && !compact && actions.filter((a) => !a.primary).map((a) => <button key={a.id} disabled={r.busy || running} title={a.title ?? a.command} onClick={() => r.click(a)}>{a.label}</button>)}
  </>;
  return (
    <div className={"ship-bar" + (compact ? " compact" : "") + (f.paused ? " paused" : "")} role="group" aria-label={`/ship ${f.stage}`}>
      {compact ? (
        // one row: a thin eight-segment meter, the stage it is at, then the badges and the next step
        <div className="ship-row">
          <span className="ship-meter" title={history} aria-label={`${f.stage}, stage ${at + 1} of ${SHIP_STAGES.length}`}>
            {SHIP_STAGES.map((s, i) => <span key={s} className={"seg" + (i < at ? " done" : i === at ? " now" : "")} />)}
          </span>
          <span className="ship-at">{f.stage}{shipStep(f) ? ` · ${shipStep(f)}` : ""}{f.paused ? " · paused" : ""} <span className="m">{at + 1}/{SHIP_STAGES.length}</span></span>
          {side}
        </div>
      ) : (
        <>
          <div className="ship-segments" title={history}>
            {SHIP_STAGES.map((s, i) => <span key={s} className={"seg" + (i < at ? " done" : i === at ? " now" : "")}>{s}</span>)}
          </div>
          <div className="ship-row">{side}</div>
        </>
      )}
      {r.ask && <div className="ship-ask">
        <textarea autoFocus rows={3} value={r.text} placeholder={r.ask.ask} aria-label={r.ask.ask} onChange={(e) => r.setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") r.setAsk(undefined); if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); r.send(); } }} />
        <div className="extension-actions"><button className="primary" disabled={!r.text.trim() || r.busy} onClick={r.send}>Send</button><button onClick={() => r.setAsk(undefined)}>Cancel</button></div>
      </div>}
    </div>
  );
}

/** everything about the feature, behind the Ship button in the top bar: ticket, history, PRs, artifacts, chats */
export function ShipPanel({ wt, chats, onOpenChat, onOpenFile }: { wt: Worktree; chats: Chat[]; onOpenChat: (id: string) => void; onOpenFile: (path: string) => void }) {
  const f = wt.ship!;
  const actions = shipActions(f);
  const r = useShipRun(wt, onOpenChat);
  const own = chats.filter((c) => c.worktreeId === wt.id && c.ship).sort((a, b) => (b.lastChattedAt ?? 0) - (a.lastChattedAt ?? 0));
  const file = (rel: string) => `${wt.path}/${rel}`;
  return (
    <div className="ship-panel">
      <h2>{f.ticket.title}</h2>
      <div className="m">{f.stage}{f.paused ? " · paused" : ""} · <span role="link" className="link" onClick={() => ade.openExternal(f.ticket.url)}>{f.ticket.source === "github" ? `issue ${ticketRef(f.ticket)}` : `ClickUp ${f.ticket.id}`}</span> · branch {wt.branch}</div>
      {f.next && <div className="ship-next-line"><span className="m">Next</span> {f.next}</div>}
      {!shipDone(f) && !r.ask && <div className="extension-actions">{actions.map((a) => <button key={a.id} className={a.primary ? "primary" : ""} disabled={r.busy} title={a.title ?? a.command} onClick={() => r.click(a)}>{a.label}</button>)}</div>}
      {r.ask && <div className="ship-ask">
        <textarea autoFocus rows={3} value={r.text} placeholder={r.ask.ask} aria-label={r.ask.ask} onChange={(e) => r.setText(e.target.value)} />
        <div className="extension-actions"><button className="primary" disabled={!r.text.trim() || r.busy} onClick={r.send}>Send</button><button onClick={() => r.setAsk(undefined)}>Cancel</button></div>
      </div>}
      <h3>Documents</h3>
      <div className="ship-docs">
        {f.spec ? <button className="linkish" onClick={() => onOpenFile(file(f.spec!))}>Spec</button> : <span className="m">No spec yet: it is written when grilling stops.</span>}
        {f.report && <button className="linkish" onClick={() => onOpenFile(file(f.report!))}>Test report{f.tests ? ` · ${f.tests.pass}/${f.tests.total}` : ""}</button>}
        {f.review && <button className="linkish" title={f.review.doneAt ? "Consort's AI self-review of the PR" : "The self-review is still running"} onClick={() => onOpenFile(file(`.consort/pr-review/pr-${f.review!.pr}.review.json`))}>Self-review · round {f.review.round}{f.review.doneAt ? "" : " · running"}</button>}
        <button className="linkish" onClick={() => onOpenFile(file(".consort/ship"))}>Folder</button>
      </div>
      {!!f.prs.length && <><h3>Pull requests</h3><div className="ship-docs">{f.prs.map((pr) => <button key={pr} className="linkish" onClick={() => ade.openExternal(pr)}>{prLabel(pr)}</button>)}</div></>}
      <h3>History</h3>
      <div className="ship-history">{[...f.history].reverse().map((h, i) => <div key={i}><span className="m">{formatAge(h.at, Date.now())}</span> <strong>{h.stage}</strong>{h.note ? ` · ${h.note}` : ""}</div>)}</div>
      {f.sync && <div className={"conn-note" + (f.sync.ok ? "" : " ship-sync-error")}>{f.sync.ok ? `Ticket updated ${formatAge(f.sync.at, Date.now())}${f.sync.note ? ` · ${f.sync.note}` : ""}` : `Ticket update failed ${formatAge(f.sync.at, Date.now())}, retrying: ${f.sync.error}`}</div>}
      {!!own.length && <><h3>Chats</h3><div className="ship-docs">{own.map((c) => <button key={c.id} className="linkish" onClick={() => onOpenChat(c.id)}>{c.name}{c.running ? " · running" : ""}</button>)}</div></>}
    </div>
  );
}

/** the project page's box for shipping a ClickUp task by id or link; shown once a ClickUp key is saved */
export function ShipClickUpBox({ projectId, onOpenChat }: { projectId: string; onOpenChat: (id: string) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const id = clickupIdFrom(text);
  const go = async () => {
    if (!id || busy) return;
    setBusy(true);
    try { onOpenChat(await ade.shipStart(projectId, { source: "clickup", id })); setText(""); }
    catch (e) { alert((e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <div className="ship-clickup">
      <input value={text} placeholder="ClickUp task id or link" aria-label="ClickUp task id or link" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void go(); }} />
      <button className="primary" disabled={!id || busy} title="Create the feature worktree from this task and start grilling" onClick={() => void go()}>{busy ? "Starting…" : "Ship ClickUp task"}</button>
    </div>
  );
}

/** the feature a project worktree list shows for an issue, if it is being shipped */
export const shipOfIssue = (state: Pick<State, "worktrees">, projectId: string, number: number): Worktree | undefined =>
  state.worktrees.find((w) => w.projectId === projectId && w.ship?.ticket.source === "github" && w.ship.ticket.id === String(number));

export type { ShipFeature };
