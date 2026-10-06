import React, { useState } from "react";
import { SHIP_BLURB, SHIP_STAGES, canRedoStage, clickupIdFrom, fillShipCommand, prNumberFromUrl, shipActions, shipPanelStages, shipTarget, type ShipSource, type ShipStage, shipBusyLabel, shipDone, shipStep, stageIndex, ticketRef, type ShipAction, type ShipFeature } from "../../shared/ship";
import { formatAge } from "../../shared/usage";
import { INVESTIGATE_BLURB } from "../../shared/investigate";
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

/**
 * The SHIP card at the right of a ship chat (the chat's PLAN and TICKET cards sit at the left): the stages
 * with what each one does, where the feature is, and the next step as a button. This replaces the bar the
 * chat used to show; the worktree page keeps the full bar.
 */
export function ShipCard({ wt, chats, chatId, onOpenChat }: { wt: Worktree; chats: Chat[]; chatId: string; onOpenChat: (id: string) => void }) {
  const f = wt.ship!;
  const rows = shipPanelStages(f);
  const running = chats.some((c) => c.running && c.worktreeId === wt.id);
  const actions = shipActions(f);
  const primary = actions.find((a) => a.primary);
  const r = useShipRun(wt, onOpenChat, chatId);
  const finished = rows.filter((x) => x.state === "done").length;
  const mark = (state: string) => state === "done" ? "✓" : state === "active" ? (running ? <span className="spin" /> : "▸") : "·";
  return (
    <div className={"rp-card ship-card" + (f.paused ? " paused" : "")}>
      <div className="rp-head" title={`${f.ticket.title} · stage ${stageIndex(f.stage) + 1} of ${SHIP_STAGES.length}`}><i className="ico ico-laurel" aria-hidden /><span className="rp-title">Ship{f.paused ? " · paused" : ""}</span><span className="rp-count">{finished}/{rows.length}</span></div>
      {rows.map((s) => (
        // the current stage explains itself; the others explain on hover, so the card stays short
        <div key={s.id} className={`rp-stage ${s.state}`} title={s.state === "active" ? undefined : s.detail}>
          <span className="rp-mark" aria-hidden="true">{mark(s.state)}</span>
          <span className="rp-label">{s.label}{s.state === "active" && <small className="rp-desc">{s.detail}</small>}</span>
          {canRedoStage(f, s.id as ShipStage) && !running && <button className="icon rp-redo" title={`Do ${s.id} again: the feature goes back to it and everything after it is redone`} disabled={r.busy}
            onClick={() => { if (confirm(`Redo ${s.id}?\n\nThe feature goes back to ${s.id}; the stages after it run again.`)) r.click({ id: "redo", label: "Redo", command: `/ship redo ${s.id}` }); }}>Redo</button>}
        </div>
      ))}
      {(f.prs.length > 0 || f.tests) && <div className="rp-links">
        {f.prs.map((pr) => <span key={pr} className="badge pr" role="link" title={pr} onClick={() => ade.openExternal(pr)}>{prLabel(pr)}</span>)}
        {f.tests && <span className="badge ci" title={f.report}>{f.tests.pass}/{f.tests.total} stories</span>}
      </div>}
      {!shipDone(f) && !r.ask && <div className="rp-actions">
        {primary && <button className="primary" disabled={r.busy || running} title={running ? "A chat of this feature is working on this stage" : primary.title ?? primary.command} onClick={() => r.click(primary)}>{r.busy ? "Starting…" : running ? shipBusyLabel(f) : primary.label}</button>}
        <span className="rp-secondary">{actions.filter((a) => !a.primary).map((a) => <button key={a.id} className="icon" disabled={r.busy || running} title={a.title ?? a.command} onClick={() => r.click(a)}>{a.label}</button>)}</span>
      </div>}
      {r.ask && <div className="rp-ask">
        <textarea autoFocus rows={3} value={r.text} placeholder={r.ask.ask} aria-label={r.ask.ask} onChange={(e) => r.setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") r.setAsk(undefined); if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); r.send(); } }} />
        <div className="rp-actions"><button className="primary" disabled={!r.text.trim() || r.busy} onClick={r.send}>Send</button><button className="icon" onClick={() => r.setAsk(undefined)}>Cancel</button></div>
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

/**
 * A card of the project page's Start chapter that begins from a ticket: pick the tracker, paste an
 * id or link, go. Ship and Investigate share it; what `start` does with the ticket is theirs.
 */
export function TicketStartCard({ title, blurb, action, busyLabel, hint, clickUpConfigured, start, onOpenChat }: {
  title: string; blurb: string; action: string; busyLabel: string; hint: string; clickUpConfigured: boolean;
  start: (target: NonNullable<ReturnType<typeof shipTarget>>) => Promise<string>; onOpenChat: (id: string) => void;
}) {
  const [source, setSource] = useState<ShipSource>(clickUpConfigured ? "clickup" : "github");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const target = shipTarget(source, text);
  const go = async () => {
    if (!target || busy) return;
    setBusy(true);
    try { onOpenChat(await start(target)); setText(""); }
    catch (e) { alert((e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <div className="card start-card">
      <h3>{title}</h3>
      <p>{blurb}</p>
      <div className="start-fields">
        <select value={source} aria-label="Ticket source" onChange={(e) => { setSource(e.target.value as ShipSource); setText(""); }}>
          <option value="github">GitHub issue</option>
          <option value="clickup" disabled={!clickUpConfigured}>{clickUpConfigured ? "ClickUp task" : "ClickUp task (add a key in Settings › Ship)"}</option>
        </select>
        <input value={text} placeholder={source === "github" ? "Issue number or link" : "Task id or link"} aria-label={`${source === "github" ? "GitHub issue number" : "ClickUp task id"} or link`} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void go(); }} />
      </div>
      <div className="start-actions">
        <button className="primary" disabled={!target || busy} title={hint} onClick={() => void go()}>{busy ? busyLabel : action}</button>
      </div>
    </div>
  );
}

/** the Start chapter's Ship card */
export const ShipBox = ({ projectId, clickUpConfigured, onOpenChat }: { projectId: string; clickUpConfigured: boolean; onOpenChat: (id: string) => void }) =>
  <TicketStartCard title="Ship" blurb={SHIP_BLURB} action="Ship" busyLabel="Starting…" hint="Create the feature worktree from this ticket and start grilling" clickUpConfigured={clickUpConfigured} start={(t) => ade.shipStart(projectId, t)} onOpenChat={onOpenChat} />;

/** the Start chapter's Investigate card: read-only, in the root checkout (shared/investigate.ts) */
export const InvestigateBox = ({ projectId, clickUpConfigured, onOpenChat }: { projectId: string; clickUpConfigured: boolean; onOpenChat: (id: string) => void }) =>
  <TicketStartCard title="Investigate" blurb={INVESTIGATE_BLURB} action="Investigate" busyLabel="Reading…" hint="Read the ticket, its comments and links, and the code, then brief you; nothing is built or changed" clickUpConfigured={clickUpConfigured} start={(t) => ade.investigateStart(projectId, t)} onOpenChat={onOpenChat} />;

/** the Start chapter's PR review card: a PR number or link, then the connector and model picker the PR lists use */
export function PrReviewBox({ onPick }: { onPick: (number: number) => Promise<void> }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const number = prNumberFromUrl(text) ?? (/^#?(\d+)$/.test(text.trim()) ? Number(text.trim().replace("#", "")) : undefined);
  const go = async () => {
    if (!number || busy) return;
    setBusy(true);
    try { await onPick(number); setText(""); }
    catch (e) { alert((e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <div className="card start-card">
      <h3>PR review</h3>
      <p>An AI review of a pull request: Consort opens a worktree on the PR's branch, reads every changed file, verifies each finding, and writes a review you approve finding by finding before anything is posted to GitHub.</p>
      <div className="start-fields">
        <input value={text} placeholder="PR number or link" aria-label="GitHub PR number or link" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void go(); }} />
      </div>
      <div className="start-actions">
        <button className="primary" disabled={!number || busy} title="Pick the connector and model, then review" onClick={() => void go()}>{busy ? "Loading…" : "Review"}</button>
      </div>
    </div>
  );
}

/** the feature a project worktree list shows for an issue, if it is being shipped */
export const shipOfIssue = (state: Pick<State, "worktrees">, projectId: string, number: number): Worktree | undefined =>
  state.worktrees.find((w) => w.projectId === projectId && w.ship?.ticket.source === "github" && w.ship.ticket.id === String(number));

export type { ShipFeature };
