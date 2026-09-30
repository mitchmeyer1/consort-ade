import { chatDrafts } from "../../shared/chatDrafts";
import { toasts, type Toast } from "../../shared/toasts";
import { canRestore, scrollKey, scrollMemory } from "../../shared/scrollMemory";
import { PhaseStrip } from "./PhaseStrip";
import { defaultConnector, selectedModel } from "../../shared/defaultConnector";
import { byCapability, modelTiers, rankModel } from "../../shared/modelTiers";
import { cliSummary, type CliStatus } from "../../shared/cliUpdates";
import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { lastPrompt } from "../../shared/lastPrompt";
import { connectorAccess, formatAge, formatReset, modelBlock, usageTone, type ConnectorUsage } from "../../shared/usage";
import { MODELS, modelOptions, PHASES, phasesFor, type Api, type Block, type Chat, type ChatContext, type CommitInfo, type Phase, type PtyState, type PermissionRequest, type Project, type RepoInfo, type RootStatus, type State, type Worktree, type WorktreeStatus } from "../../shared/types";
import { chatStatus } from "../../shared/chatStatus";
import { CHAT_MARKS, hasRollup, rollupLabel, rollupStatus } from "../../shared/statusRollup";
import { ciLabel, ciTitle, type CiInfo } from "../../shared/ci";
import { recentChats, recentWorktrees } from "../../shared/conversationOrder";
import { Lockup, Mark } from "./Logo";
import { artifactLinkAction, artifactLinks, artifactWhen, chatArtifacts, localImageTarget, messageArtifacts, withFrameScrollbars, codeSpanArtifact } from "../../shared/artifacts";
import { parseFollowups, type Followup } from "../../shared/followups";
import { historyStep, promptHistory, type HistoryNav } from "../../shared/promptHistory";
import { isScratch, scratchChats } from "../../shared/scratch";
import { fillNextCommand, parseNextCommands, type NextCommand } from "../../shared/shipNext";
import { isShipCommand } from "../../shared/ship";
import { ShipBar, ShipClickUpBox, ShipPanel, shipOfIssue } from "./Ship";
import { commandQuery, completeCommand, filterCommands, isClearCommand, type SlashEntry } from "../../shared/commands";
import { contextPercent, contextTone } from "../../shared/context";
import { foldLabel, groupBlocks, showToolCalls, type ToolBlock } from "../../shared/toolFold";
import { homeScopes, isHome } from "../../shared/scratch";
import type { Instruction } from "../../shared/instructions";
import { isWorkspace, reposForPr, reposToCommit, slugify, workspaceSummary } from "../../shared/workspace";
import type { RepoResult, WorkspaceStatus } from "../../shared/types";
import { attachmentName, isImageAttachment } from "../../shared/attachments";
import { reminderLabel } from "../../shared/reminders";
import { prChatName } from "../../shared/prChat";
import { canCreatePr, prBaseBranch, prBlockedBy, suggestedPrTitle } from "../../shared/createPr";
import { ISSUE_ROWS, issueBranch, issueChatName, issueFolder, type IssueInfo } from "../../shared/issues";
import { isReviewChat, reviewProgress } from "../../shared/reviewProgress";
import { prNumberOf, type ReviewSummary } from "../../shared/review";
import { firstPrompt, reviewDeliverable } from "../../shared/skillSections";
import { quickActionParameters, resolveQuickAction } from "../../shared/quickActions";
import { isReviewFile } from "../../shared/review";
import { ReviewView } from "./ReviewView";
import { PoolSettings, SeatPicker, SeatsStrip } from "./Seats";
import { planStages } from "../../shared/planProgress";
import { featureStages } from "../../shared/featureProgress";
import type { Stage } from "../../shared/types";
import { marked } from "marked";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

const ade = (window as any).ade as Api;
const EMPTY: State = { projects: [], worktrees: [], chats: [], keys: [], appearance: { theme: "dark", background: "opaque" } };
type Tab = "terminal" | "diff" | "editor" | "markdown" | "commit" | "artifacts" | "review" | "settings" | "ship";
type Sel = { type: "chat"; id: string } | { type: "worktree"; id: string; form?: boolean } | { type: "project"; id: string; form?: boolean };

function useStatus(id?: string, revision = 0) {
  const [st, setSt] = useState<WorktreeStatus | null>(null);
  useEffect(() => {
    if (!id) return;
    const tick = () => ade.worktreeStatus(id).then(setSt);
    tick();
    const t = setInterval(tick, 15000);
    return () => clearInterval(t);
  }, [id, revision]);
  return st;
}
function useWorkspaceStatus(projectId?: string, revision = 0) {
  const [st, setSt] = useState<WorkspaceStatus | null>(null);
  useEffect(() => {
    if (!projectId) return;
    const tick = () => ade.workspaceStatus(projectId).then(setSt);
    tick();
    const t = setInterval(tick, 15000);
    return () => clearInterval(t);
  }, [projectId, revision]);
  return st;
}
type ReviewFile = { path: string; summary: ReviewSummary };
/** the finished review a branch owns; re-checked as the chat that writes it makes progress */
function useReviewFile(worktreeId?: string, pr?: number, ...deps: unknown[]) {
  const [found, setFound] = useState<ReviewFile | null>(null);
  useEffect(() => {
    if (!worktreeId) { setFound(null); return; }
    let live = true;
    ade.findReview(worktreeId, pr).then((r) => { if (live) setFound(r); }, () => { if (live) setFound(null); });
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktreeId, pr, ...deps]);
  return found;
}
/**
 * The PR this branch has, in whatever state. Clicking any of them opens the PR on GitHub — the
 * chip is the handiest pointer to it, in the sidebar tree and on the worktree page alike. The
 * click is stopped here so it does not also select the row the chip sits in. "in base" is the
 * one case with no PR and so nothing to open.
 */
const PrBadge = ({ st }: { st: WorktreeStatus }) => {
  const pr = st.pr;
  if (!pr) return st.inBase ? <span className="badge" title="HEAD is already contained in the base branch">in base</span> : null;
  const open = pr.url ? { role: "link", onClick: (e: React.MouseEvent) => { e.stopPropagation(); ade.openExternal(pr.url); } } : {};
  const hint = pr.url ? ` — click to open on GitHub` : "";
  if (pr.state === "MERGED") return <span className="badge merged" title={`${pr.title || "PR merged"} (merged)${hint}`} {...open}><Ico n="laurel" /> merged</span>;
  if (pr.state === "CLOSED") return <span className="badge closed" title={`${pr.title} (closed)${hint}`} {...open}>✗ #{pr.number}</span>;
  return <span className="badge pr" title={`${pr.title}${pr.draft ? " (draft)" : ""}${hint}`} {...open}>{pr.draft ? "◐" : "⎇"} #{pr.number}</span>;
};
/** whose move an open PR waits on: the crown when it is yours, quiet when it is theirs; it speaks for the same PR, so it opens it too */
const TurnBadge = ({ pr }: { pr?: { turn?: "yours" | "theirs" | null; why?: string; url?: string; approved?: boolean } }) => !pr?.turn ? null : (
  <span className={"badge turn " + pr.turn + (pr.approved ? " approved" : "")} title={`${pr.why ?? ""}${pr.approved ? " · you approved this PR" : ""}${pr.url ? " — click to open on GitHub" : ""}`}
    role={pr.url ? "link" : undefined}
    onClick={pr.url ? (e) => { e.stopPropagation(); ade.openExternal(pr.url!); } : undefined}>
    {pr.turn === "yours" ? <><Ico n="crown" /> Your turn</> : "Their turn"}
    {/* your approval stands: the turn may be yours again because they pushed or replied, but you have already signed off */}
    {pr.approved && <span className="turn-approved" aria-label="you approved this PR">✓</span>}
  </span>
);
/** the issue an `issue/<n>` branch was made for; clicking opens it on GitHub */
const IssueBadge = ({ issue }: { issue?: WorktreeStatus["issue"] }) => !issue ? null : (
  <span className={"badge issue " + issue.state.toLowerCase()} role="link" title={`Issue #${issue.number}: ${issue.title}${issue.state === "CLOSED" ? " (closed)" : ""}`}
    onClick={(e) => { e.stopPropagation(); ade.openExternal(issue.url); }}><Ico n="candle" /> #{issue.number}</span>
);
/** CI on the pushed commit; clicking opens the failing run, or the checks page */
const CiBadge = ({ ci }: { ci?: CiInfo }) => !ci ? null : (
  <span className={"badge ci " + ci.state} role={ci.url ? "link" : undefined} title={ciTitle(ci)}
    onClick={ci.url ? (e) => { e.stopPropagation(); ade.openExternal(ci.url!); } : undefined}>{ciLabel(ci)}</span>
);
/** whose branch this is: a GitHub login when the commits carry one, otherwise the git author's name */
const Contributor = ({ who }: { who?: WorktreeStatus["author"] }) => !who ? null : (
  <small className="contributor" title={`${who.name}${who.login ? ` (@${who.login})` : ""} — ${who.commits} commit${who.commits === 1 ? "" : "s"} on this branch`}>
    {who.login ? `@${who.login}` : who.name}
  </small>
);

/**
 * Why the PR chips are missing. GitHub's GraphQL budget is shared by the whole account, and the
 * PR, turn and issue chips all come from it while CI comes from REST — so when the budget runs
 * out they disappear together and CI carries on alone. Better to say so than to look broken.
 */
const LimitBadge = ({ until }: { until?: number }) => !until ? null : (
  <span className="badge limited" title={`GitHub's API budget for this account is spent, so the PR and issue chips have no data to show. CI still works because it uses a separate budget. Trying again at ${new Date(until).toLocaleTimeString()}.`}>gh limited</span>
);

export const Badges = ({ st, pr = true }: { st: WorktreeStatus | null; pr?: boolean }) =>
  !st ? null : (
    <span className="badges">
      {pr && <IssueBadge issue={st.issue} />}
      {pr && <PrBadge st={st} />}
      {pr && st.pr?.state === "OPEN" && <TurnBadge pr={st.pr} />}
      {pr && <CiBadge ci={st.ci} />}
      {pr && !st.pr && !st.issue && <LimitBadge until={st.limitedUntil} />}
      {st.dirty > 0 && <span className="badge" title="uncommitted changes">±{st.dirty}</span>}
      {st.ahead > 0 && <span className="badge" title="ahead of upstream">↑{st.ahead}</span>}
      {st.behind > 0 && <span className="badge" title="behind upstream">↓{st.behind}</span>}
      {!st.dirty && !st.ahead && !st.behind && !(pr && (st.pr || st.inBase || st.ci || st.issue || st.limitedUntil)) && <span className="badge">clean</span>}
    </span>
  );

export const Dots = ({ id, running, failed, done }: { id: string; running: Set<string>; failed: Set<string>; done: Set<string> }) => (
  <>{running.has(id) && <span className="live" title="a process is running here" />}{failed.has(id) && <span className="live dead" title="a process failed — open its terminal" />}{done.has(id) && !running.has(id) && !failed.has(id) && <span className="live done" title="a command finished here — click to clear" />}</>
);
/*
 * A collapsed project still has to say what's going on underneath: the process dots of its hidden
 * worktrees and one dot per chat mark, with a count when several chats share it. Loudest first.
 */
function Rollup({ chats, scopeIds, running, failed, done }: { chats: Chat[]; scopeIds: string[]; running: Set<string>; failed: Set<string>; done: Set<string> }) {
  const r = rollupStatus(chats, scopeIds, { running, failed, done });
  if (!hasRollup(r)) return null;
  return (
    <span className="rollup" aria-label="status of hidden worktrees and chats">
      {r.running && <span className="live" title="a process is running in a worktree here" />}
      {r.failed && <span className="live dead" title="a process failed in a worktree here — expand to find it" />}
      {r.done && <span className="live done" title="a command finished in a worktree here" />}
      {CHAT_MARKS.filter((m) => r.chats[m]).map((m) => {
        const n = r.chats[m]!, label = rollupLabel(m, n);
        return (
          <span key={m} className={`rmark ${m}`} role="img" aria-label={label} title={label}>
            <span className={`chat-dot ${m}`}>{m === "scheduled" && <ClockGlyph />}</span>
            {n > 1 && <small>{n}</small>}
          </span>
        );
      })}
    </span>
  );
}
const PanelIcon = () => (
  <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="4.5" width="18" height="15" rx="3" /><path d="M9.5 4.5v15" />
  </svg>
);
const Flame = () => (
  <svg className="flame" viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden>
    <path d="M12 2c.6 3.2 3.4 4.6 4.9 7.3 1.6 2.9 1.2 6.6-1.3 8.9A7 7 0 0 1 5.3 13c.3-2 1.6-3.4 2.5-4.8.3 1.3.9 2.3 1.9 2.9-.4-3.3.7-6.4 2.3-9.1zm0 9.5c-1.6 1.4-2.6 3-2.4 4.8.2 1.6 1.2 2.7 2.6 2.7 1.5 0 2.5-1.2 2.5-2.8 0-1.8-1.2-3.2-2.7-4.7z" />
  </svg>
);
const Ico = ({ n, className }: { n: string; className?: string }) => <i className={`ico ico-${n} ${className ?? ""}`} aria-hidden />;

function Dialog({ title, onClose, children, footer }: { title: string; onClose: () => void; children: React.ReactNode; footer: React.ReactNode }) {
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dtitle"><span>{title}</span><button onClick={onClose}>✕</button></div>
        {children}
        <div className="dfoot">{footer}</div>
      </div>
    </div>
  );
}
function Editable({ value, onSave, trigger = "dblclick", className }: { value: string; onSave: (v: string) => void; trigger?: "click" | "dblclick"; className?: string }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  if (!editing)
    return <span className={className} title={`${value} · ${trigger === "click" ? "click" : "double-click"} to rename`}
      onClick={(e) => { if (trigger === "click") { e.stopPropagation(); setEditing(true); } }}
      onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}>{value}</span>;
  const done = (save: boolean) => { setEditing(false); if (save && v.trim() && v !== value) onSave(v.trim()); else setV(value); };
  return <input className={"edit " + (className ?? "")} autoFocus value={v} onChange={(e) => setV(e.target.value)} onClick={(e) => e.stopPropagation()}
    onBlur={() => done(true)} onKeyDown={(e) => { if (e.key === "Enter") done(true); if (e.key === "Escape") done(false); }} />;
}
const Field = ({ label, optional, info, children }: { label: string; optional?: boolean; info?: string; children: React.ReactNode }) => (
  <div className="field">
    <label>{label}{optional && <small>(optional)</small>}{info && <span className="info" title={info}>i</span>}</label>
    {children}
  </div>
);

/** Transient progress for slow operations (worktree add/delete), stacked bottom-centre above everything. */
export function Toaster({ onOpen }: { onOpen: (open: NonNullable<Toast["open"]>) => void }) {
  const items = useSyncExternalStore(toasts.subscribe, toasts.snapshot);
  if (!items.length) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => { if (t.kind === "loading") return; if (t.open) onOpen(t.open); toasts.dismiss(t.id); }} title={t.kind === "loading" ? undefined : t.open ? "Open" : "Dismiss"}>
          <span className="toast-mark" aria-hidden>{t.kind === "loading" ? <span className="spin" /> : t.kind === "success" ? "✓" : t.kind === "error" ? "✕" : "•"}</span>
          <span className="toast-body">
            <span className="toast-text">{t.text}</span>
            {t.detail && <span className="toast-detail">{t.detail}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

export function App() {
  const [state, setState] = useState<State>(EMPTY);
  const [actionArgs, setActionArgs] = useState<{ wt: Worktree; action: { title: string; command: string }; names: string[]; values: Record<string, string> }>();
  const [sel, setSel] = useState<Sel>();
  const [connectedAgentIds, setConnectedAgentIds] = useState<Set<string>>(new Set());
  // Panel state belongs to the selected view, not the underlying terminal scope.
  // Two chats in the same worktree can therefore keep different panels open.
  const viewKey = sel ? `${sel.type}:${sel.id}` : "home";
  const [panels, setPanels] = useState<Record<string, { tab?: Tab; file?: string }>>({});
  const { tab, file } = panels[viewKey] ?? {};
  const setTab = (next: React.SetStateAction<Tab | undefined>, key = viewKey) => {
    setPanels((current) => ({ ...current, [key]: { ...current[key], tab: typeof next === "function" ? next(current[key]?.tab) : next } }));
  };
  const openFile = (path: string, tab: Tab) => setPanels((current) => ({ ...current, [viewKey]: { tab, file: path } }));
  const openMd = (path: string) => openFile(path, "markdown");
  const openEditor = (path: string) => openFile(path, "editor");
  const perms = state.chats.flatMap((c) => c.permissions ?? []);
  const [ptys, setPtys] = useState<PtyState[]>([]);
  const running = React.useMemo(() => new Set(ptys.filter((p) => p.running).map((p) => p.scopeId)), [ptys]);
  const failed = React.useMemo(() => new Set(ptys.filter((p) => p.failed).map((p) => p.scopeId)), [ptys]);
  const done = React.useMemo(() => new Set(ptys.filter((p) => p.done).map((p) => p.scopeId)), [ptys]);

  useEffect(() => {
    ade.getState().then(setState);
    ade.ptys().then(setPtys);
    const a = ade.onState(setState);
    const b = ade.onOpenChat((id) => setSel({ type: "chat", id }));
    const c = ade.onPtys(setPtys);
    const d = ade.onPtyData(({ id, data }) => xterms.get(id)?.term.write(data));
    const e = ade.onOpenScope((id) => { setSel({ type: "worktree", id }); void ade.ptySeenScope(id); });
    const f = ade.onToast((n) => toasts.notify(n.kind ?? "info", n.title, n.body, n.open));
    return () => { a(); b(); c(); d(); e(); f(); };
  }, []);
  // The built-in CLI entries exist before their accounts are connected. A first-use prompt
  // should therefore disappear only for an API key or a CLI account that is actually signed in.
  const agentKeyIds = state.keys.map((k) => `${k.id}:${k.auth}`).join("|");
  useEffect(() => {
    let disposed = false;
    Promise.all(state.keys.map(async (key) => {
      if (key.auth !== "login") return [key.id, true] as const;
      try { return [key.id, (await ade.authStatus(key.id)).loggedIn] as const; }
      catch { return [key.id, false] as const; }
    })).then((results) => { if (!disposed) setConnectedAgentIds(new Set(results.filter(([, connected]) => connected).map(([id]) => id))); });
    return () => { disposed = true; };
  }, [agentKeyIds]);

  useEffect(() => {
    const update = () => { void ade.setActiveChat(document.hasFocus() && document.visibilityState === "visible" && sel?.type === "chat" ? sel.id : null); };
    update();
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [sel]);

  const [leftW, setLeftW] = useState(() => +(localStorage.getItem("leftW") ?? 280));
  const [rightW, setRightW] = useState(() => +(localStorage.getItem("rightW") ?? 460));
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("leftCollapsed") === "1");
  useEffect(() => { localStorage.setItem("leftW", String(leftW)); localStorage.setItem("rightW", String(rightW)); localStorage.setItem("leftCollapsed", collapsed ? "1" : "0"); }, [leftW, rightW, collapsed]);
  const drag = (side: "left" | "right") => (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX, start = side === "left" ? leftW : rightW;
    const move = (ev: MouseEvent) => {
      const d = ev.clientX - startX;
      if (side === "left") setLeftW(Math.min(600, Math.max(200, start + d)));
      else setRightW(Math.min(1000, Math.max(320, start - d)));
    };
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); document.body.style.cursor = ""; };
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  };
  const [sysTheme, setSysTheme] = useState<"dark" | "light">("dark");
  useEffect(() => { ade.effectiveTheme().then(setSysTheme); return ade.onTheme(setSysTheme); }, []);
  const theme = state.appearance.theme === "auto" ? sysTheme : state.appearance.theme;
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.bg = state.appearance.background;
  }, [theme, state.appearance.background]);
  useEffect(() => { for (const x of xterms.values()) x.term.options.theme = xtermTheme(); }, [theme]);
  const chat = sel?.type === "chat" ? state.chats.find((c) => c.id === sel.id) : undefined;
  const worktree = state.worktrees.find((w) => w.id === (chat ? chat.worktreeId : sel?.type === "worktree" ? sel.id : undefined));
  // the branch's finished review, if one exists: it earns a top-bar tab and a card at the foot of the review chat
  const reviewFile = useReviewFile(worktree?.id, chat ? prNumberOf(chat.name) : undefined, chat?.running, chat?.messages.length);
  const project = sel?.type === "project" ? state.projects.find((p) => p.id === sel.id) : undefined;
  const wtProject = worktree && state.projects.find((p) => p.id === worktree.projectId);
  const scratch = isScratch(worktree);
  // a workspace project and its single worktree are the same view
  const wsProject = worktree && wtProject && isWorkspace(wtProject) ? wtProject : project && isWorkspace(project) ? project : undefined;
  const wsWorktree = wsProject ? (worktree ?? state.worktrees.find((w) => w.projectId === wsProject.id)) : undefined;
  const crumb = wtProject && isHome(wtProject) ? wtProject.name : worktree && wtProject ? `${wtProject.name}/${worktree.branch}` : scratch ? "Chats" : project ? project.name : "Consort ADE";
  useEffect(() => { document.title = chat ? `${crumb} · ${chat.name}` : crumb; }, [crumb, chat?.name]);
  const answer = (id: string, allow: boolean) => {
    ade.answerPermission(id, allow);

  };
  const toggle = (t: Tab) => setTab((cur) => (cur === t ? undefined : t));
  // views without a path to the selection (the review panel's "open chat") ask for it by event
  useEffect(() => {
    const openChat = (e: Event) => setSel({ type: "chat", id: (e as CustomEvent<string>).detail });
    window.addEventListener("consort-open-chat", openChat);
    return () => window.removeEventListener("consort-open-chat", openChat);
  }, []);
  const startQuickAction = (wt: Worktree, action: { title: string; command: string }) => {
    const termId = `action-${crypto.randomUUID()}`;
    termTabs.set(wt.id, [...(termTabs.get(wt.id) ?? ["t1"]), termId]);
    termLabels.set(`${wt.id}:${termId}`, action.title);
    wantTab = termId;
    // Quote the complete script as one Bash argument, preserving multiline commands.
    pendingCmd.set(`${wt.id}:${termId}`, "bash -lc '" + action.command.replace(/'/g, "'\"'\"'") + "'");
    setTab("terminal");
    window.dispatchEvent(new CustomEvent("consort-terminal-added", { detail: { scopeId: wt.id, termId } }));
  };
  const runQuickAction = (wt: Worktree, action: { title: string; command: string }) => {
    const names = quickActionParameters(action.command);
    if (!names.length) return startQuickAction(wt, action);
    setActionArgs({ wt, action, names, values: Object.fromEntries(names.map((name) => [name, ""])) });
  };
  const submitQuickAction = () => {
    if (!actionArgs) return;
    startQuickAction(actionArgs.wt, { ...actionArgs.action, command: resolveQuickAction(actionArgs.action.command, actionArgs.values) });
    setActionArgs(undefined);
  };
  const signIn = async (keyId: string) => {
    let sc = worktree ? { id: worktree.id, cwd: worktree.path } : null;
    if (!sc) {
      const p = project ?? state.projects[0];
      if (!p) return alert("Add a project first so there is somewhere to run the login.");
      const id = await ade.openRootWorktree(p.id);
      sc = { id, cwd: p.path };
      setSel({ type: "worktree", id });
    }
    const tabs = termTabs.get(sc.id) ?? ["t1"];
    if (!tabs.includes("auth")) termTabs.set(sc.id, [...tabs, "auth"]);
    wantTab = "auth";
    pendingCmd.set(`${sc.id}:auth`, await ade.authLoginCmd(keyId));
    setTab("terminal", worktree ? viewKey : `worktree:${sc.id}`);
    const x = xterms.get(`${sc.id}:auth`);
    if (x) { const c = pendingCmd.get(x.id); if (c) { pendingCmd.delete(x.id); ade.ptyWrite(x.id, c + "\r"); } }
  };
  const addFirstProject = async () => {
    const path = await ade.pickFolder();
    if (!path) return;
    try {
      await ade.addProject(path);
      const next = await ade.getState();
      setState(next);
      const added = next.projects.find((p) => p.path === path);
      if (added) setSel({ type: "project", id: added.id });
    } catch (e) { alert((e as Error).message); }
  };
  const hasConnectedAgent = connectedAgentIds.size > 0;

  return (
    <div className="app" style={{ gridTemplateColumns: `${collapsed ? 0 : leftW}px 1fr auto` }}>
      <Toaster onOpen={(open) => { if (open.chat) setSel({ type: "chat", id: open.chat }); else if (open.scope) { setSel({ type: "worktree", id: open.scope }); void ade.ptySeenScope(open.scope); } }} />
      {collapsed ? <div /> : <Sidebar state={state} sel={sel} running={running} failed={failed} done={done} onSelect={setSel} onCollapse={() => setCollapsed(true)} />}
      {!collapsed && <div className="resizer left" style={{ left: leftW - 3 }} onMouseDown={drag("left")} />}
      <div className="main">
        <div className={"topbar" + (collapsed ? " collapsed" : "") + (chat ? " haschat" : "")}>
          <button className="icon panel" title={collapsed ? "Show sidebar" : "Hide sidebar"} onClick={() => setCollapsed((c) => !c)}><PanelIcon /></button>
          {chat ? (
            <div className="chat-heading">
              <input className="name" aria-label="Chat name" title={chat.name} defaultValue={chat.name} key={chat.id} onBlur={(e) => ade.renameChat(chat.id, e.target.value)} />
              <span className="crumb" title={worktree?.path}>{crumb}</span>
            </div>
          ) : <span className="title">{crumb}</span>}
          {chat?.context && <ContextMeter context={chat.context} />}
          <div className="tabs">
            {worktree?.ship && <button className={"shipbtn" + (tab === "ship" ? " on" : "")} aria-pressed={tab === "ship"} title="Everything about this /ship feature: ticket, stage history, spec, report, PRs" onClick={() => toggle("ship")}><Ico n="laurel" /><span>Ship</span></button>}
            {worktree && wtProject?.quickActions?.filter((action) => action.pinned).map((action) => (
              <button key={action.id} className="pinned-action" title={`Run ${action.title} in ${worktree.path}`} onClick={() => runQuickAction(worktree, action)}><Ico n="star" />{action.title}</button>
            ))}
            {/* the same dots the sidebar shows, so a process running in this worktree is visible from the page it is running for */}
            {worktree && <button className={tab === "terminal" ? "on" : ""} onClick={() => toggle("terminal")}><Ico n="terminal" /><span>Terminal</span><Dots id={worktree.id} running={running} failed={failed} done={done} /></button>}
            {worktree && !scratch && <button className={tab === "diff" ? "on" : ""} onClick={() => toggle("diff")}><Ico n="branch" /><span>Diff</span></button>}
            {worktree && <button className={tab === "editor" ? "on" : ""} onClick={() => toggle("editor")}><Ico n="pencil" /><span>Editor</span></button>}
            {worktree && !scratch && <button className={tab === "commit" ? "on" : ""} onClick={() => toggle("commit")}><Ico n="wheat" /><span>Commit</span></button>}
            {worktree && reviewFile && <button className={tab === "review" ? "on" : ""} title={`PR #${reviewFile.summary.pr} · ${reviewFile.summary.title}`} onClick={() => toggle("review")}><Ico n="laurel" /><span>Review</span></button>}
            {chat && <button className={tab === "artifacts" ? "on" : ""} aria-pressed={tab === "artifacts"} onClick={() => toggle("artifacts")}><Ico n="scroll" /><span>Artifacts</span></button>}
            <button className={tab === "settings" ? "on" : ""} onClick={() => toggle("settings")}><Ico n="gear" /><span>Settings</span></button>
          </div>
        </div>
        {chat ? (
          <ChatPane key={chat.id} chat={chat} worktree={worktree} chats={state.chats} onOpenChat={(id) => setSel({ type: "chat", id })} keys={state.keys} models={state.models} openRouterConfigured={state.openRouterConfigured} pool={state.seatPool} showTools={showToolCalls(chat, state.showToolCalls)} perms={perms.filter((p) => p.chatId === chat.id)} ptys={ptys} answer={answer} reviewFile={reviewFile} onOpenReview={() => setTab("review")} onOpenMd={(target) => { if (worktree) ade.artifactMenu(worktree.id, target).then((action) => { if (action === "open") openMd(target); }).catch((e) => alert(e.message)); }} />
        ) : wsProject && wsWorktree ? (
          <WorkspacePage key={wsProject.id} project={wsProject} wt={wsWorktree} state={state} openForm={!!(sel && "form" in sel && sel.form)} onRunAction={runQuickAction} onSelect={setSel} />
        ) : (wtProject && isHome(wtProject)) || (project && isHome(project)) ? (
          <HomePage key={(wtProject ?? project)!.id} project={(wtProject ?? project)!} state={state} openForm={!!(sel && "form" in sel && sel.form)} onSelect={setSel} />
        ) : worktree ? (
          <WorktreePage key={worktree.id} wt={worktree} state={state} openForm={sel?.type === "worktree" && !!sel.form} onRunAction={runQuickAction} onSelect={setSel} />
        ) : project ? (
          <ProjectPage key={project.id} project={project} state={state} openForm={sel?.type === "project" && !!sel.form} onRunAction={runQuickAction} onSelect={setSel} />
        ) : (
          <div className="empty">
            <div>
              <Mark />
              <div className="word">Consort</div>
              <div className="sub">AGENTIC DEVELOPMENT ENVIRONMENT</div>
              <div className="est">Arbor Operis et Ramorum Progression ● New York</div>
              <div className="ornament rose" />
              <div className="empty-actions">
                {!hasConnectedAgent && <button className="primary" onClick={() => setTab("settings")}>Connect agents</button>}
                {!state.projects.length && <button onClick={() => void addFirstProject()}>Add projects</button>}
              </div>
            </div>
            <div className="tagline">Agents to work on your code within feature branch worktrees. Multiple chats per worktree. Multiple worktrees per project.</div>
          </div>
        )}
      </div>
      {tab && (!["terminal", "editor", "diff"].includes(tab) || worktree) && <>
        <div className="resizer right" style={{ right: rightW - 3 }} onMouseDown={drag("right")} />
        <Drawer onOpenChat={(id) => setSel({ type: "chat", id })} key={viewKey} tab={tab} memoryKey={viewKey} state={state} chat={chat} worktree={worktree} scope={worktree ? { id: worktree.id, cwd: worktree.path, title: worktree.title } : project ? { id: project.id, cwd: project.path, title: project.name } : undefined}
          ptys={ptys} width={rightW} file={file} reviewPath={reviewFile?.path} onEdit={openEditor} onView={openMd} onSignIn={signIn} onClose={() => setTab(undefined)} />
      </>}
      {actionArgs && <Dialog title={actionArgs.action.title} onClose={() => setActionArgs(undefined)} footer={<>
        <button onClick={() => setActionArgs(undefined)}>Cancel</button>
        <button className="primary" onClick={submitQuickAction}>Run action</button>
      </>}>
        <div className="m">Runs in {actionArgs.wt.path}.</div>
        {actionArgs.names.map((name, index) => <Field key={name} label={name}>
          <input autoFocus={index === 0} value={actionArgs.values[name]} placeholder={`Enter ${name}`} onChange={(e) => setActionArgs((current) => current ? { ...current, values: { ...current.values, [name]: e.target.value } } : current)} onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); submitQuickAction(); } }} />
        </Field>)}
      </Dialog>}
    </div>
  );
}

/* ---------- sidebar ---------- */

function Sidebar({ state, sel, running, failed, done, onSelect, onCollapse }: { state: State; sel?: Sel; running: Set<string>; failed: Set<string>; done: Set<string>; onSelect: (s: Sel) => void; onCollapse: () => void }) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggle = (id: string) => setCollapsed((c) => ({ ...c, [id]: !c[id] }));
  const [newProject, setNewProject] = useState(false);
  // repoless chats: not on any code, each working out of a hidden folder of its own
  const [newChat, setNewChat] = useState(false);
  const chats = recentChats(scratchChats(state)).filter((c) => !c.ship);
  const needKey = () => { if (!state.keys.length) { alert("Add a connector in Settings first."); return true; } return false; };
  return (
    <div className="sidebar">
      <div className="brandrow"><Lockup /></div>
      <div className="sect">
        <span>Projects</span>
        <button className="icon" title="Add a project or a multi-repo workspace" onClick={() => setNewProject(true)}>＋</button>
      </div>
      {state.projects.map((p) => isWorkspace(p)
        ? <WorkspaceNode key={p.id} project={p} state={state} sel={sel} running={running} failed={failed} done={done} onSelect={onSelect} collapsed={collapsed} toggle={toggle} />
        : isHome(p)
        ? <HomeNode key={p.id} project={p} state={state} sel={sel} onSelect={onSelect} collapsed={collapsed} toggle={toggle} />
        : <ProjectNode key={p.id} project={p} state={state} sel={sel} running={running} failed={failed} done={done} onSelect={onSelect} collapsed={collapsed} toggle={toggle} />
      )}
      {newProject && <NewProjectDialog state={state} onClose={() => setNewProject(false)} onWorkspace={(id) => { setNewProject(false); onSelect({ type: "worktree", id }); }} />}
      <div className="sect chats">
        <span>Chats</span>
        <button className="icon" title="New chat (no repo)" onClick={() => !needKey() && setNewChat(true)}>＋</button>
      </div>
      <div className="scratch-chats">
        {chats.length ? <div className="chatlist">{chats.map((c) => <ChatRow key={c.id} c={c} sel={sel} onSelect={onSelect} />)}</div>
          : <div className="row hint" onClick={() => !needKey() && setNewChat(true)}><small>Chat or work without a repo.</small></div>}
      </div>
      {newChat && <NewChatForm scratch state={state} onClose={() => setNewChat(false)} onDone={(id) => { setNewChat(false); onSelect({ type: "chat", id }); }} />}
      <SeatsStrip state={state} />
    </div>
  );
}

// one chat in the sidebar: under a worktree, or on its own in the CHATS section
function ChatRow({ c, sel, onSelect }: { c: Chat; sel?: Sel; onSelect: (s: Sel) => void }) {
  const status = chatStatus(c);
  const dotLabel = (status === "reminder" || status === "scheduled") ? reminderLabel(c.remindAt!, Date.now()) : status;
  return (
    <div className={"row chat" + (sel?.type === "chat" && c.id === sel.id ? " active" : "") + (status ? ` st-${status}` : "")} onClick={() => onSelect({ type: "chat", id: c.id })} onContextMenu={(e) => { e.preventDefault(); void ade.chatMenu(c.id); }}>
      <span className="slot chat-symbol"><Ico n="celtic" />{status && <span role="img" aria-label={dotLabel!} title={dotLabel!} className={`chat-dot ${status}`}>{status === "scheduled" && <ClockGlyph />}</span>}</span>
      <span className="grow"><Editable value={c.name} onSave={(n) => ade.renameChat(c.id, n)} /></span>
      <MiniBar phase={c.phase} steps={c.phaseSteps} />
      <span className="tools" onClick={(e) => e.stopPropagation()}>
        <button className="icon" onClick={() => confirm("Delete chat?") && ade.deleteChat(c.id)}>×</button>
      </span>
    </div>
  );
}

function NewWorktreeDialog({ p, onClose, branchPreset, onRoot }: { p: Project; onClose: () => void; branchPreset?: string; onRoot: (id: string) => void }) {
  const [workAtRoot, setWorkAtRoot] = useState(false);
  const [name, setName] = useState(branchPreset ? branchPreset.split("/").pop()! : "");
  const [branch, setBranch] = useState(branchPreset ?? "");
  const [base, setBase] = useState(branchPreset ? `origin/${branchPreset}` : p.defaultBase);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!workAtRoot) {
      // the create copies env files and kicks off installs, so the dialog closes at once and a toast carries the progress
      const label = name || branch;
      void toasts.track(ade.addWorktree(p.id, name, branch || name, base), { start: `Creating worktree ${label}…`, done: `Worktree ${label} ready`, fail: `Couldn't create worktree ${label}` });
      onClose();
      return;
    }
    setBusy(true);
    try {
      onRoot(await ade.openRootWorktree(p.id));
      onClose();
    } catch (e: any) { alert(e.message); } finally { setBusy(false); }
  };
  return (
    <Dialog title="Create a worktree" onClose={onClose} footer={<>
      <button onClick={onClose}>Cancel</button>
      <button className="primary" disabled={(!workAtRoot && !name) || busy} onClick={submit}>{busy ? "Opening…" : workAtRoot ? "Open Root" : "Create"}</button>
    </>}>
      <label className="root-option"><input type="checkbox" checked={workAtRoot} disabled={busy} onChange={(e) => setWorkAtRoot(e.target.checked)} /> Work out of root</label>
      {workAtRoot ? <p>Open Root at {p.path}. Chats will work directly in this folder on its current checkout. No branch or worktree will be created.</p> : <>
      <Field label="Name" info={`Folder name under ${p.name}-wt/`}><input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="feature-name" /></Field>
      <Field label="Branch" optional info="Created from the base ref if it doesn't exist; an existing local or remote branch is checked out as-is"><input placeholder={name || "defaults to name"} value={branch} onChange={(e) => setBranch(e.target.value)} /></Field>
      <Field label="Base ref" info="Change the project default on its page"><input value={base} onChange={(e) => setBase(e.target.value)} /></Field>
      </>}
    </Dialog>
  );
}

/* "+" in the Projects header: a repo folder, or a workspace built from several projects already here */
function NewProjectDialog({ state, onClose, onWorkspace }: { state: State; onClose: () => void; onWorkspace: (worktreeId: string) => void }) {
  const [mode, setMode] = useState<"repo" | "workspace">("repo");
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [branchTouched, setBranchTouched] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const repos = state.projects.filter((p) => !isWorkspace(p));
  const addRepo = async () => {
    const p = await ade.pickFolder();
    if (!p) return;
    try { await ade.addProject(p); onClose(); } catch (e) { alert((e as Error).message); }
  };
  const setNameAndBranch = (n: string) => { setName(n); if (!branchTouched) setBranch(slugify(n)); };
  const toggleRepo = (id: string) => setPicked((x) => x.includes(id) ? x.filter((y) => y !== id) : [...x, id]);
  const create = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const id = await toasts.track(ade.addWorkspace(name, branch, picked), { start: `Creating workspace ${name}…`, done: `Workspace ${name} ready`, fail: `Couldn't create workspace ${name}` });
      if (id) onWorkspace(id);
    } catch { /* the toast carries the error */ } finally { setBusy(false); }
  };
  return (
    <Dialog title="Add to Consort" onClose={() => { if (!busy) onClose(); }} footer={<>
      <button disabled={busy} onClick={onClose}>Cancel</button>
      {mode === "repo"
        ? <button className="primary" onClick={addRepo}>Choose folder…</button>
        : <button className="primary" disabled={busy || !name.trim() || !branch.trim() || picked.length < 2} onClick={create}>{busy ? "Creating…" : "Create workspace"}</button>}
    </>}>
      <div className="seg newproj-mode">
        <button className={mode === "repo" ? "on" : ""} onClick={() => setMode("repo")}><Ico n="arch" /> Repository</button>
        <button className={mode === "workspace" ? "on" : ""} onClick={() => setMode("workspace")}><Ico n="thorn" /> Multi-repo workspace</button>
      </div>
      {mode === "repo" ? (
        <p>A git repository on this machine: its branches become worktrees you can open chats on. A plain folder works too: it gets chats only, and they can work in any repo beside it.</p>
      ) : (
        <>
          <p>One folder, one branch, several repos: a worktree of each chosen project is checked out inside it, and chats work across all of them. Commit and PR fan out per repo.</p>
          <Field label="Name"><input autoFocus value={name} placeholder="Billing rework" onChange={(e) => setNameAndBranch(e.target.value)} /></Field>
          <Field label="Branch" info="Created in every repo from its own base branch, or checked out if it already exists"><input value={branch} placeholder="mm/billing-rework" onChange={(e) => { setBranch(e.target.value); setBranchTouched(true); }} /></Field>
          <div className="field">
            <label>Repositories <small>pick at least two</small></label>
            {repos.length < 2 && <div className="m">Add the repositories as projects first; a workspace is built from projects already in Consort.</div>}
            <div className="repo-picks">
              {repos.map((p) => (
                <label key={p.id} className="check"><input type="checkbox" checked={picked.includes(p.id)} onChange={() => toggleRepo(p.id)} /> {p.name} <small className="mono">{p.path}</small></label>
              ))}
            </div>
          </div>
        </>
      )}
    </Dialog>
  );
}

/* a workspace in the sidebar: the project, its one scope on the shared branch, a status line per repo, then its chats */
function WorkspaceNode({ project: p, state, sel, running, failed, done, onSelect, collapsed, toggle }: {
  project: Project; state: State; sel?: Sel; running: Set<string>; failed: Set<string>; done: Set<string>; onSelect: (s: Sel) => void;
  collapsed: Record<string, boolean>; toggle: (id: string) => void;
}) {
  const wt = state.worktrees.find((w) => w.projectId === p.id);
  const st = useWorkspaceStatus(p.id);
  const chats = wt ? recentChats(state.chats.filter((c) => c.worktreeId === wt.id)) : [];
  const active = (sel?.type === "project" && sel.id === p.id) || (wt && sel?.type === "worktree" && sel.id === wt.id);
  const remove = () => confirm(`Remove workspace ${p.name}?\n\nRemoves the checkout of each repo under ${p.path}${chats.length ? ` and deletes ${chats.length} chat(s)` : ""}. The source repositories are untouched.`)
    && void toasts.track(ade.removeProject(p.id), { start: `Removing workspace ${p.name}…`, done: `Workspace ${p.name} removed`, fail: `Couldn't remove workspace ${p.name}` });
  return (
    <div className={"projnode workspace" + (collapsed[p.id] ? " closed" : "")}>
      <div className={"row project" + (active ? " active" : "") + (collapsed[p.id] ? " closed" : "")} onClick={() => onSelect({ type: "project", id: p.id })}>
        <span className="slot caret" title={collapsed[p.id] ? "Expand" : "Collapse"} onClick={(e) => { e.stopPropagation(); toggle(p.id); }}><Ico n="thorn" className="proj" /><span className="chev">{collapsed[p.id] ? "▸" : "▾"}</span></span>
        <span className="grow" title={p.path}>{p.name}{wt && <Dots id={wt.id} running={running} failed={failed} done={done} />}{collapsed[p.id] && <Rollup chats={chats} scopeIds={[]} running={running} failed={failed} done={done} />}</span>
        <span className="tools" onClick={(e) => e.stopPropagation()}>
          {wt && <button className="icon" title="New chat here" onClick={() => onSelect({ type: "worktree", id: wt.id, form: true })}>＋</button>}
          <button className="icon" title="Remove workspace" onClick={remove}>×</button>
        </span>
      </div>
      {!collapsed[p.id] && wt && <div className="wtlist"><div>
        {/* only the top line highlights when selected: the branch and repo lines beneath are its detail, not a second target */}
        <div className="row worktree" onClick={() => { onSelect({ type: "worktree", id: wt.id }); if (done.has(wt.id)) void ade.ptySeenScope(wt.id); }}>
          <span className="slot"><Ico n="branch" className="wt" /></span>
          <span className="grow"><small className="branch" title={p.branch}>{p.branch}</small></span>
          {/* one line per repo: its name, then the same chips a worktree row shows */}
          {(st?.repos ?? (p.repos ?? []).map((r) => ({ projectId: r.projectId, name: state.projects.find((x) => x.id === r.projectId)?.name ?? r.dir, dir: r.dir, path: "", status: null }))).map((r) => (
            <span key={r.dir} className="meta status repo" title={r.path || r.dir}>
              <small className="repo-name">{r.name}</small>
              {r.status ? <Badges st={r.status} /> : <small className="m">…</small>}
            </span>
          ))}
        </div>
        {chats.length > 0 && <div className="chatlist">{chats.map((c) => <ChatRow key={c.id} c={c} sel={sel} onSelect={onSelect} />)}</div>}
      </div></div>}
    </div>
  );
}

function ProjectNode({ project: p, state, sel, running, failed, done, onSelect, collapsed, toggle }: {
  project: Project; state: State; sel?: Sel; running: Set<string>; failed: Set<string>; done: Set<string>; onSelect: (s: Sel) => void;
  collapsed: Record<string, boolean>; toggle: (id: string) => void;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const all = state.worktrees.filter((w) => w.projectId === p.id);
  const wts = recentWorktrees(all.filter((w) => w.root || showArchived || !w.archived), state.chats);
  const archivedN = all.filter((w) => w.archived).length;
  // what the closed caret hides: the listed worktrees' process dots and their chats' marks
  const wtIds = wts.map((w) => w.id);
  const hiddenChats = collapsed[p.id] ? state.chats.filter((c) => wtIds.includes(c.worktreeId!)) : [];
  return (
    <div className={"projnode" + (collapsed[p.id] ? " closed" : "")}>
      <div className={"row project" + (sel?.type === "project" && sel.id === p.id ? " active" : "") + (collapsed[p.id] ? " closed" : "")} onClick={() => onSelect({ type: "project", id: p.id })}>
        {/* the caret lives in the icon slot: icon at rest, caret on hover or while collapsed */}
        <span className="slot caret" title={collapsed[p.id] ? "Expand" : "Collapse"} onClick={(e) => { e.stopPropagation(); toggle(p.id); }}><Ico n="arch" className="proj" /><span className="chev">{collapsed[p.id] ? "▸" : "▾"}</span></span>
        <span className="grow" title={p.path}>{p.name}<Dots id={p.id} running={running} failed={failed} done={done} />{collapsed[p.id] && <Rollup chats={hiddenChats} scopeIds={wtIds} running={running} failed={failed} done={done} />}</span>
        <span className="tools" onClick={(e) => e.stopPropagation()}>
          <button className="icon" title="New worktree" onClick={() => onSelect({ type: "project", id: p.id, form: true })}>＋</button>
          <button className="icon" title="Re-scan worktrees" onClick={() => ade.syncWorktrees(p.id)}>↻</button>
          <button className="icon" title="Remove project" onClick={() => confirm(`Remove ${p.name} from Consort?`) && ade.removeProject(p.id)}>×</button>
        </span>
      </div>
      {!collapsed[p.id] && <div className="wtlist">{wts.map((w) => (
        <WorktreeNode key={w.id} wt={w} state={state} sel={sel} running={running} failed={failed} done={done} onSelect={onSelect} collapsed={collapsed} toggle={toggle} />
      ))}</div>}
      {!collapsed[p.id] && archivedN > 0 && (
        <div className="row worktree archived-toggle" onClick={() => setShowArchived((x) => !x)}>
          <small>{showArchived ? "hide" : "show"} {archivedN} archived</small>
        </div>
      )}
    </div>
  );
}

/* a home project in the sidebar: the folder, then its chats; /ship chats stay under Ship */
function HomeNode({ project: p, state, sel, onSelect, collapsed, toggle }: {
  project: Project; state: State; sel?: Sel; onSelect: (s: Sel) => void; collapsed: Record<string, boolean>; toggle: (id: string) => void;
}) {
  const scopes = homeScopes(state, p.id).map((w) => w.id);
  const chats = recentChats(state.chats.filter((c) => scopes.includes(c.worktreeId) && !c.ship));
  const active = (sel?.type === "project" && sel.id === p.id) || (sel?.type === "worktree" && scopes.includes(sel.id));
  return (
    <div className={"projnode" + (collapsed[p.id] ? " closed" : "")}>
      <div className={"row project" + (active ? " active" : "") + (collapsed[p.id] ? " closed" : "")} onClick={() => onSelect({ type: "project", id: p.id })}>
        <span className="slot caret" title={collapsed[p.id] ? "Expand" : "Collapse"} onClick={(e) => { e.stopPropagation(); toggle(p.id); }}><Ico n="candle" className="proj" /><span className="chev">{collapsed[p.id] ? "▸" : "▾"}</span></span>
        <span className="grow" title={p.path}>{p.name}</span>
        <span className="tools" onClick={(e) => e.stopPropagation()}>
          <button className="icon" title="New chat here" onClick={() => onSelect({ type: "project", id: p.id, form: true })}>＋</button>
          <button className="icon" title="Remove from Consort (keeps the folder and its chats)" onClick={() => confirm(`Remove ${p.name} from Consort? The folder and its chats stay.`) && ade.removeProject(p.id)}>×</button>
        </span>
      </div>
      {!collapsed[p.id] && !!chats.length && <div className="wtlist chatlist">{chats.map((c) => <ChatRow key={c.id} c={c} sel={sel} onSelect={onSelect} />)}</div>}
    </div>
  );
}

/* the home project's page: where the chats run, and a new one; nothing git-shaped */
function HomePage({ project: p, state, openForm, onSelect }: { project: Project; state: State; openForm: boolean; onSelect: (s: Sel) => void }) {
  const [form, setForm] = useState(openForm);
  useEffect(() => { setForm(openForm); }, [openForm]);
  const scope = homeScopes(state, p.id)[0];
  const chats = recentChats(state.chats.filter((c) => c.worktreeId === scope?.id));
  return (
    <div className="page">
      <div>
        <h1>{p.name}</h1>
        <div className="path">{p.path}</div>
        <div className="m" style={{ marginTop: 8 }}>A folder, not a repository. Chats start here and can work in any repo beside it; commits, PRs and status belong to those repos.</div>
      </div>
      <div className="actions"><button className="primary" disabled={!scope} onClick={() => setForm((f) => !f)}><Ico n="quill" /> New chat</button></div>
      {chats.length ? <div className="grid">{chats.map((c) => (
        <div key={c.id} className="card click" onClick={() => onSelect({ type: "chat", id: c.id })}>
          <div className="t">{c.name}</div>
          <div className="m">{c.ship ? "/ship · " : ""}{chatStatus(c) ?? "idle"} · {c.model}</div>
        </div>
      ))}</div> : <div className="m">No chats yet.</div>}
      {form && scope && <NewChatForm wt={scope} state={state} onClose={() => setForm(false)} onDone={(id) => { setForm(false); onSelect({ type: "chat", id }); }} />}
    </div>
  );
}

function WorktreeNode({ wt, state, sel, running, failed, done, onSelect, collapsed, toggle }: {
  wt: Worktree; state: State; sel?: Sel; running: Set<string>; failed: Set<string>; done: Set<string>; onSelect: (s: Sel) => void;
  collapsed: Record<string, boolean>; toggle: (id: string) => void;
}) {
  const st = useStatus(wt.id);
  const chats = recentChats(state.chats.filter((c) => c.worktreeId === wt.id));
  const active = sel?.type === "worktree" && sel.id === wt.id;
  return (
    <div>
      <div className={"row worktree" + (active ? " active" : "") + (wt.archived ? " dim" : "")} onClick={() => { onSelect({ type: "worktree", id: wt.id }); if (done.has(wt.id)) void ade.ptySeenScope(wt.id); }}>
        <span className="slot"><Ico n="thorn" className="wt" /></span>
        <span className="grow">{wt.root ? "Root" : <Editable value={wt.title} onSave={(t) => ade.renameWorktree(wt.id, t)} />}<Dots id={wt.id} running={running} failed={failed} done={done} /></span>
        {/* two subtitle lines, aligned under the title text rather than the icon: the branch, then who owns it and where it stands */}
        <span className="meta">
          <small className="branch" title={st?.branch ?? wt.branch}>{st?.branch ?? wt.branch}</small>
        </span>
        <span className="meta status">
          {!wt.root && <Contributor who={st?.author} />}
          {st && (st.dirty > 0 || st.ahead > 0 || st.behind > 0 || st.pr || st.inBase || st.ci || st.issue) && <Badges st={st} />}
        </span>
        <span className="tools" onClick={(e) => e.stopPropagation()}>
          <button className="icon" title="New chat here" onClick={() => onSelect({ type: "worktree", id: wt.id, form: true })}>＋</button>
          {!wt.root && <button className="icon" title={wt.archived ? "Unarchive" : "Archive (hide from list)"} onClick={() => ade.archiveWorktree(wt.id, !wt.archived)}><Ico n="vase" className="solo" /></button>}
          {!wt.root && <button className="icon" title="Delete worktree from disk" onClick={() => confirm(`Delete worktree ${wt.title}?\n\nRuns: git worktree remove --force ${wt.path}\n${chats.length ? `Also deletes ${chats.length} chat(s).` : ""}`) && void toasts.track(ade.removeWorktree(wt.id), { start: `Deleting worktree ${wt.title}…`, done: `Worktree ${wt.title} deleted`, fail: `Couldn't delete worktree ${wt.title}` })}><Flame /></button>}
          <button className="icon" title={collapsed[wt.id] ? "Expand" : "Collapse"} onClick={() => toggle(wt.id)}>{collapsed[wt.id] ? "▸" : "▾"}</button>
        </span>
      </div>
      {!collapsed[wt.id] && chats.length > 0 && <div className="chatlist">{chats.map((c) => <ChatRow key={c.id} c={c} sel={sel} onSelect={onSelect} />)}</div>}
    </div>
  );
}

/* a reminder that hasn't come due yet: a clock rather than the purple dot */
const ClockGlyph = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" /><path d="M12 7v5.2l3.3 2" />
  </svg>
);

const MiniBar = ({ phase, steps }: { phase: Phase; steps?: 3 | 5 }) => {
  const phases = phasesFor(steps);
  const i = phases.indexOf(phase), all = phase === "complete";
  return <span className="mini">{phases.map((p, j) => <i key={p} className={all && j === phases.length - 1 ? "done final" : all || j < i ? "done" : j === i ? "on" : ""} />)}</span>;
};

/* ---------- project page ---------- */

const ago = (iso: string) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};
const RUN = { success: "●", failure: "✗", cancelled: "⊘", skipped: "◌" } as Record<string, string>;

/* before a review starts: which connector and which model, preset to the default connector and its top tier */
function ReviewDialog({ pr, state, onClose, onStart }: { pr: RepoInfo["prs"][number]; state: State; onClose: () => void; onStart: (keyId: string, model: string) => void }) {
  const [keyId, setKeyId] = useState(defaultConnector(state)?.id ?? state.keys[0]?.id ?? "");
  const key = state.keys.find((k) => k.id === keyId);
  const provider = key?.provider ?? "claude";
  const options = modelOptions(state, provider);
  const top = () => modelTiers(provider, options).orchestrator;
  const [model, setModel] = useState(top);
  useEffect(() => { setModel(top()); }, [keyId]);
  const delegate = byCapability(options).find((m) => rankModel(m) < rankModel(model)) ?? model;
  return (
    <Dialog title={`Review #${pr.number}`} onClose={onClose} footer={<>
      <button onClick={onClose}>Cancel</button>
      <button className="primary" disabled={!keyId || !model} onClick={() => onStart(keyId, model)}><Ico n="laurel" /> Review</button>
    </>}>
      <p className="m">{pr.title}</p>
      <div className="two">
        <Field label="Connector">
          <select value={keyId} onChange={(e) => setKeyId(e.target.value)}>
            {state.keys.map((k) => <option key={k.id} value={k.id}>{k.provider}: {k.name}</option>)}
          </select>
        </Field>
        <Field label="Model" info="Runs the review; the agents it dispatches use the next tier down">
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            {[...new Set([model, ...options])].map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </Field>
      </div>
      <div className="m">Orchestrates on {model}{delegate !== model ? `, delegates to ${delegate}` : ""}. Opens a worktree for {pr.branch} if there is none.</div>
    </Dialog>
  );
}

function ProjectPage({ project: p, state, openForm, onRunAction, onSelect }: { project: Project; state: State; openForm: boolean; onRunAction: (wt: Worktree, action: { title: string; command: string }) => void; onSelect: (s: Sel) => void }) {
  const [form, setForm] = useState<false | { branch?: string }>(openForm ? {} : false);
  useEffect(() => { if (openForm) setForm({}); }, [openForm]);
  const [info, setInfo] = useState<RepoInfo>();
  const [root, setRoot] = useState<RootStatus>();
  const [rootError, setRootError] = useState("");
  const [checkout, setCheckout] = useState<Worktree>();
  const [commitMessage, setCommitMessage] = useState("");
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [checkoutError, setCheckoutError] = useState("");
  useEffect(() => {
    let disposed = false;
    const refresh = () => ade.rootStatus(p.id).then((s) => { if (!disposed) { setRoot(s); setRootError(""); } }, (e) => { if (!disposed) setRootError(e.message); });
    refresh();
    const timer = setInterval(refresh, 10000);
    window.addEventListener("focus", refresh);
    return () => { disposed = true; clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [p.id]);
  const doCheckout = async () => {
    if (!checkout) return;
    setCheckoutBusy(true);
    setCheckoutError("");
    try { setRoot(await ade.checkoutAtRoot(checkout.id, commitMessage)); setCheckout(undefined); }
    catch (e: any) {
      setCheckoutError(e.message);
      await ade.rootStatus(p.id).then(setRoot, () => {});
    }
    finally { setCheckoutBusy(false); }
  };

  const [showArchived, setShowArchived] = useState(false);
  useEffect(() => { ade.repoInfo(p.id).then(setInfo); }, [p.id]);
  const rootWorktree = state.worktrees.find((w) => w.projectId === p.id && w.root);
  const wts = recentWorktrees(state.worktrees.filter((w) => w.projectId === p.id && !w.root && (showArchived || !w.archived)), state.chats);
  const archivedN = state.worktrees.filter((w) => w.projectId === p.id && w.archived).length;
  const localBranches = new Set(state.worktrees.filter((w) => w.projectId === p.id).map((w) => w.branch));
  const [busyPr, setBusyPr] = useState<number>();
  // the Review button opens a picker first: which connector and model run the review
  const [reviewing, setReviewing] = useState<RepoInfo["prs"][number] | null>(null);
  // Review = ensure a worktree for the PR branch, then start a pr-writeup chat in it on the chosen connector and model
  const review = async (pr: RepoInfo["prs"][number], keyId: string, model: string) => {
    const key = state.keys.find((k) => k.id === keyId);
    if (!key) return alert("Add a connector first (Settings)");
    setReviewing(null);
    setBusyPr(pr.number);
    try {
      let wt = state.worktrees.find((w) => w.projectId === p.id && w.branch === pr.branch);
      if (!wt) {
        const id = toasts.start(`Creating worktree for ${pr.branch}…`);
        try { await ade.addWorktree(p.id, pr.branch.split("/").pop()!, pr.branch, `origin/${pr.branch}`); }
        catch (e: any) { toasts.fail(id, `Couldn't create worktree for ${pr.branch}`, String(e.message ?? e).split("\n")[0]); return; }
        toasts.succeed(id, `Worktree for ${pr.branch} ready`);
        wt = (await ade.getState()).worktrees.find((w) => w.projectId === p.id && w.branch === pr.branch);
      }
      if (!wt) throw new Error("worktree not found after create");
      // the agents the review dispatches run one tier below the chosen model, or on it when nothing lesser is offered
      const delegate = byCapability(modelOptions(state, key.provider)).find((m) => rankModel(m) < rankModel(model)) ?? model;
      const id = await ade.addChat(wt.id, key.id, { name: prChatName(pr, `Review #${pr.number}`), model, delegateModel: delegate, remember: false });
      onSelect({ type: "chat", id });
      ade.send(id, await ade.skillPrompt("pr-writeup", wt.id, `${pr.number}`, delegate)).catch((e) => alert(e.message));
    } catch (e: any) { alert(e.message); } finally { setBusyPr(undefined); }
  };
  const [busyIssue, setBusyIssue] = useState<number>();
  const [allIssues, setAllIssues] = useState(false);
  // Branch and solve = ensure a worktree on issue/<n>, then open a chat that pitches a plan (no code yet)
  const solve = async (issue: IssueInfo) => {
    const key = defaultConnector(state);
    if (!key) return alert("Add a connector first (Settings)");
    setBusyIssue(issue.number);
    try {
      const branch = issueBranch(issue.number, state.branchPrefix);
      let wt = state.worktrees.find((w) => w.projectId === p.id && w.branch === branch);
      if (!wt) {
        const id = toasts.start(`Creating worktree ${branch}…`);
        try { await ade.addWorktree(p.id, issueFolder(issue.number), branch, p.defaultBase); }
        catch (e: any) { toasts.fail(id, `Couldn't create worktree for ${branch}`, String(e.message ?? e).split("\n")[0]); return; }
        toasts.succeed(id, `Worktree ${branch} ready`);
        wt = (await ade.getState()).worktrees.find((w) => w.projectId === p.id && w.branch === branch);
      }
      if (!wt) throw new Error("worktree not found after create");
      const prompt = await ade.issuePrompt(wt.id, issue.number);
      const id = await ade.addChat(wt.id, key.id, { name: issueChatName(issue), remember: false });
      onSelect({ type: "chat", id });
      ade.send(id, prompt).catch((e) => alert(e.message));
    } catch (e: any) { alert(e.message); } finally { setBusyIssue(undefined); }
  };
  // /ship: the issue becomes a feature worktree at Grilling; the first chat interrogates the idea
  const shipIssue = async (issue: IssueInfo) => {
    setBusyIssue(issue.number);
    try { onSelect({ type: "chat", id: await ade.shipStart(p.id, { source: "github", number: issue.number }) }); }
    catch (e: any) { alert(e.message); } finally { setBusyIssue(undefined); }
  };
  const IssueRow = ({ issue }: { issue: IssueInfo }) => {
    const linked = state.worktrees.find((w) => w.projectId === p.id && w.branch === issueBranch(issue.number, state.branchPrefix));
    const shipped = shipOfIssue(state, p.id, issue.number);
    return (
      <div className="lrow">
        <span className="num">#{issue.number}</span>
        <span className="grow">
          <a href="#" onClick={(e) => { e.preventDefault(); ade.openExternal(issue.url); }}>{issue.title}</a>
          <div className="m">
            {issue.author} · {ago(issue.updatedAt)}{issue.comments ? ` · ${issue.comments} comment${issue.comments === 1 ? "" : "s"}` : ""}{issue.assignees.length ? ` · ${issue.assignees.map((a) => `@${a}`).join(" ")}` : ""}
            {issue.labels.map((l) => <span key={l} className="badge label">{l}</span>)}
          </div>
        </span>
        {linked && <span className="badge issue open" role="link" title={`Open worktree ${linked.title}`} onClick={() => onSelect({ type: "worktree", id: linked.id })}><Ico n="candle" /> {linked.branch}</span>}
        {shipped ? <span className="badge ship" role="link" title={`/ship · ${shipped.branch}`} onClick={() => onSelect({ type: "worktree", id: shipped.id })}><Ico n="laurel" /> {shipped.ship!.stage}</span>
          : <button disabled={busyIssue === issue.number} title="Ship it: a feature worktree and a chat that grills the idea into a spec, then builds, tests and reviews it" onClick={() => shipIssue(issue)}>{busyIssue === issue.number ? "…" : "Ship"}</button>}
        <button disabled={busyIssue === issue.number} title={linked ? `Start a new planning chat in ${linked.branch}` : `Create a worktree on ${issueBranch(issue.number, state.branchPrefix)} and plan the fix`} onClick={() => solve(issue)}>{busyIssue === issue.number ? "…" : linked ? "Solve" : "Branch and solve"}</button>
      </div>
    );
  };
  const PrRow = ({ pr }: { pr: RepoInfo["prs"][number] }) => (
    <div className="lrow">
      <span className="num">#{pr.number}</span>
      <span className="grow">
        <a href="#" onClick={(e) => { e.preventDefault(); ade.openExternal(pr.url); }}>{pr.title}</a>
        <div className="m">{pr.author} · {pr.branch} · {ago(pr.updatedAt)}{pr.draft ? " · draft" : ""}{pr.review ? ` · ${pr.review.toLowerCase().replace("_", " ")}` : ""}{pr.mine ? ` · ${pr.role}` : ""}</div>
      </span>
      <TurnBadge pr={pr} />
      {localBranches.has(pr.branch) ? <span className="badge">local</span> : <button onClick={() => setForm({ branch: pr.branch })}>open as worktree</button>}
      <button disabled={busyPr === pr.number} onClick={() => state.keys.length ? setReviewing(pr) : alert("Add a connector first (Settings)")}>{busyPr === pr.number ? "…" : "Review"}</button>
    </div>
  );
  const mine = info?.prs.filter((pr) => pr.mine) ?? [];
  const others = info?.prs.filter((pr) => !pr.mine) ?? [];
  return (
    <div className="page">
      <div>
        <h1>{p.name}</h1>
        <div className="path">{p.path}</div>
        <div className="m" style={{ marginTop: 8 }}>Root: {rootError || (root ? `${root.branch ?? "detached HEAD"} · ${root.commit.slice(0, 8)}${root.dirty ? " · uncommitted changes" : ""}` : "loading…")}</div>
        {info?.repo && <div className="m" style={{ marginTop: 6 }}>
          <a href="#" onClick={(e) => { e.preventDefault(); ade.openExternal(info.repo!.url); }}>{info.repo.nameWithOwner}</a>
          {info.repo.isPrivate ? " · private" : ""} · pushed {ago(info.repo.pushedAt)}{info.repo.description ? ` — ${info.repo.description}` : ""}
        </div>}
      </div>
      <div className="actions" style={{ alignItems: "center" }}>
        <button className="primary" onClick={() => setForm({})}><Ico n="branch" /> New worktree</button>
        <span className="m" style={{ marginLeft: 8 }}>Default base branch</span>
        <input className="inline" defaultValue={p.defaultBase} key={p.defaultBase} onBlur={(e) => e.target.value !== p.defaultBase && ade.setProjectBase(p.id, e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} title="Base ref new worktrees branch from" />
        {info?.repo?.defaultBranch && p.defaultBase !== `origin/${info.repo.defaultBranch}` && (
          <button className="icon" title={`GitHub default is ${info.repo.defaultBranch}`} onClick={() => ade.setProjectBase(p.id, `origin/${info.repo!.defaultBranch}`)}>use origin/{info.repo.defaultBranch}</button>
        )}
      </div>
      {reviewing && <ReviewDialog pr={reviewing} state={state} onClose={() => setReviewing(null)} onStart={(keyId, model) => review(reviewing, keyId, model)} />}
      {form && <NewWorktreeDialog p={p} branchPreset={form.branch} onClose={() => setForm(false)} onRoot={(id) => onSelect({ type: "worktree", id })} />}

      <section className="project-quick-actions">
        <h2><Ico n="star" />Quick actions</h2>
        <p className="sect-note">Saved commands for this project. Run one in any worktree's terminal, pin it to the header, or add a new one.</p>
        <QuickActions project={p} wt={rootWorktree} manage onRun={(action) => { if (rootWorktree) onRunAction(rootWorktree, action); }} />
      </section>

      {rootWorktree && <RootCard wt={rootWorktree} state={state} status={root} error={rootError} onRefresh={() => ade.rootStatus(p.id).then((s) => { setRoot(s); setRootError(""); }, (e) => setRootError(e.message))} onSelect={onSelect} />}

      <h2>Worktrees {archivedN > 0 && <button className="icon" onClick={() => setShowArchived((x) => !x)}>{showArchived ? "hide" : "show"} {archivedN} archived</button>}</h2>
      <p className="sect-note">Each branch checked out in its own folder. Open one to chat there, or push it and check it out at root.</p>
      {!wts.length && <div className="m">No worktrees yet — create one above or open a PR below as a worktree.</div>}
      <div className="grid">{wts.map((w) => <WorktreeCard key={w.id} wt={w} state={state} onSelect={onSelect} onCheckout={() => { setCheckout(w); setCommitMessage(""); setCheckoutError(""); }} />)}</div>

      {checkout && <Dialog title={`Push ${checkout.title} and checkout at root`} onClose={() => { if (!checkoutBusy) setCheckout(undefined); }} footer={<>
        <button disabled={checkoutBusy} onClick={() => setCheckout(undefined)}>Cancel</button>
        <button className="primary" disabled={checkoutBusy || !!root?.dirty} onClick={doCheckout}>{checkoutBusy ? "Pushing and checking out…" : "Push and checkout at root"}</button>
      </>}>
        <p>Commit changes in this worktree, push {checkout.branch} to origin, then switch {p.path} to that branch and pull. This worktree will be left detached at its pushed commit.</p>
        <Field label="Commit message" optional info="If this worktree has changes, a message is required. All tracked and untracked changes, except ignored files, will be committed first."><input value={commitMessage} disabled={checkoutBusy} onChange={(e) => setCommitMessage(e.target.value)} placeholder="Leave blank if already committed" /></Field>
        <p>Any uncommitted tracked and untracked files (except ignored files) will be included. A commit message is required when there are changes.</p>
        {root?.dirty && <p role="alert">The root has uncommitted changes. Commit or stash them first.</p>}
        {checkoutError && <p role="alert">{checkoutError}</p>}
      </Dialog>}

      <h2>My PRs {info && <span className="m">({mine.length}{info.me ? ` · ${info.me}` : ""})</span>}</h2>
      <p className="sect-note">Pull requests you wrote or were asked to review. Open one as a worktree or start an AI review.</p>
      {!info ? <div className="m">loading from GitHub…</div> : !mine.length ? <div className="m">nothing waiting on you</div> : (
        <div className="card list">{mine.map((pr) => <PrRow key={pr.number} pr={pr} />)}</div>
      )}
      <h2>Other open PRs {info && <span className="m">({others.length})</span>}</h2>
      <p className="sect-note">Everyone else's open pull requests, ready to review or open as a worktree.</p>
      {!info ? null : !others.length ? <div className="m">none</div> : (
        <div className="card list">{others.map((pr) => <PrRow key={pr.number} pr={pr} />)}</div>
      )}

      {state.clickUpConfigured && <>
        <h2>Ship a ClickUp task</h2>
        <p className="sect-note">Paste a task id or link. Consort makes the feature worktree, grills the task into a spec, and moves the task's status with each stage.</p>
        <ShipClickUpBox projectId={p.id} onOpenChat={(id) => onSelect({ type: "chat", id })} />
      </>}
      <h2>Open issues {info && <span className="m">({info.issues.length}{info.issues.length >= 50 ? "+" : ""})</span>}
        {info && info.issues.length > ISSUE_ROWS && <button className="icon" onClick={() => setAllIssues((x) => !x)}>{allIssues ? `show ${ISSUE_ROWS}` : `show all ${info.issues.length}`}</button>}
      </h2>
      <p className="sect-note">Open GitHub issues. Branch and solve creates a worktree on an issue branch and opens a chat that plans the fix.</p>
      {!info ? <div className="m">loading…</div> : !info.issues.length ? <div className="m">none open</div> : (
        <div className="card list">{(allIssues ? info.issues : info.issues.slice(0, ISSUE_ROWS)).map((issue) => <IssueRow key={issue.number} issue={issue} />)}</div>
      )}

      <h2>Recent CI runs</h2>
      <p className="sect-note">The latest workflow runs on this repository, with their branch and result.</p>
      {!info ? <div className="m">loading…</div> : !info.runs.length ? <div className="m">none</div> : (
        <div className="card list">
          {info.runs.map((r, i) => (
            <div key={i} className="lrow">
              <span className={"num run " + (r.conclusion || r.status)}>{r.status !== "completed" ? "◐" : RUN[r.conclusion] ?? "·"}</span>
              <span className="grow">
                <a href="#" onClick={(e) => { e.preventDefault(); ade.openExternal(r.url); }}>{r.title}</a>
                <div className="m">{r.name} · {r.branch} · {r.status !== "completed" ? r.status.replace("_", " ") : r.conclusion} · {ago(r.createdAt)}</div>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* one repo of a workspace on its page: the same facts GitCard shows, compact, with the repo named */
function RepoCard({ r }: { r: WorkspaceStatus["repos"][number] }) {
  const st = r.status;
  return (
    <div className="card repo">
      <h3>{r.name} <small className="mono">{r.dir}/</small></h3>
      {!st ? <div className="m">loading…</div> : (
        <>
          <div className="rmeta"><span className="badge">{st.branch}</span><Badges st={st} /><span className="m">vs {st.base}: {st.merged ? "merged" : st.inBase ? "in base" : `↑${st.ahead} ↓${st.behind}`}</span></div>
          <div>{st.dirty ? `${st.dirty} changed file${st.dirty === 1 ? "" : "s"}` : "clean"}</div>
          {st.files && <pre className="files">{st.files.split("\n").slice(0, 6).join("\n")}{st.dirty > 6 ? "\n…" : ""}</pre>}
          <div className="m">{st.last ? `${st.last.subject} · ${st.last.author} · ${st.last.age}` : "no commits"}</div>
          {st.pr && <div><a href="#" onClick={(e) => { e.preventDefault(); ade.openExternal(st.pr!.url); }}>#{st.pr.number} {st.pr.title}</a> <span className="m">{st.pr.draft ? "draft" : st.pr.state.toLowerCase()}</span></div>}
        </>
      )}
    </div>
  );
}

/* the results of a fanned-out git action, one line per repo */
function RepoResults({ title, rows }: { title: string; rows: RepoResult[] }) {
  return (
    <div className="repo-results" role="status">
      <div className="m">{title}</div>
      {rows.map((r) => (
        <div key={r.name} className={"rrow" + (r.ok ? "" : " bad") + (r.skipped ? " skipped" : "")}>
          <span className="name">{r.name}</span>
          <span>{r.url ? <a href="#" onClick={(e) => { e.preventDefault(); ade.openExternal(r.url!); }}>{r.detail}</a> : r.detail}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * A workspace's page: several repos on one branch. Commit takes one message and lands in every
 * repo with changes; Pull and Push touch every repo; Create PRs opens one per repo with work and
 * links them together. Each repo keeps its own card, so what is where stays visible.
 */
function WorkspacePage({ project: p, wt, state, openForm, onSelect, onRunAction }: { project: Project; wt: Worktree; state: State; openForm: boolean; onSelect: (s: Sel) => void; onRunAction: (wt: Worktree, action: { title: string; command: string }) => void }) {
  const [revision, setRevision] = useState(0);
  const st = useWorkspaceStatus(p.id, revision);
  const chats = recentChats(state.chats.filter((c) => c.worktreeId === wt.id));
  const anyRunning = chats.some((c) => c.running);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<{ title: string; rows: RepoResult[] } | null>(null);
  const [gitError, setGitError] = useState("");
  const [committing, setCommitting] = useState(false);
  const [message, setMessage] = useState("");
  const [prDraft, setPrDraft] = useState<{ title: string; body: string; draft: boolean } | null>(null);
  const [prGen, setPrGen] = useState<{ busy: boolean; note?: string }>({ busy: false });
  const [form, setForm] = useState(openForm);
  useEffect(() => { if (openForm) setForm(true); }, [openForm]);
  const needKey = () => (state.keys.length ? false : (alert("Add a connector first (Settings)"), true));
  const dirty = reposToCommit(st);
  const prRepos = reposForPr(st);
  const sum = workspaceSummary(st);
  const branch = p.branch ?? wt.branch;
  const fanout = async (title: string, action: () => Promise<RepoResult[]>) => {
    if (busy) return;
    setBusy(true); setGitError(""); setResults(null);
    try { setResults({ title, rows: await action() }); }
    catch (e) { setGitError((e as Error).message); }
    finally { setBusy(false); setRevision((n) => n + 1); }
  };
  const commit = async () => {
    await fanout(`Commit to ${branch}`, () => ade.commitWorkspace(p.id, message));
    setMessage(""); setCommitting(false);
  };
  const generatePr = async () => {
    if (prGen.busy) return;
    setPrGen({ busy: true });
    try {
      const { title, body } = await ade.suggestPr(wt.id, branch);
      if (!title && !body) { setPrGen({ busy: false, note: `Nothing to summarize: no commits on ${branch} in any repo.` }); return; }
      setPrDraft((d) => d && { ...d, title: title || d.title, body: body || d.body });
      setPrGen({ busy: false });
    } catch (e) { setPrGen({ busy: false, note: (e as Error).message.split("\n")[0] }); }
  };
  const createPrs = async () => {
    if (!prDraft) return;
    const draft = prDraft;
    await fanout(`Pull requests for ${branch}`, () => ade.createWorkspacePrs(p.id, draft));
    setPrDraft(null);
  };
  return (
    <div className="page">
      <div className="workspace-heading">
        <div className="workspace-heading-info">
          <h1>{p.name} <span className="badge ws">workspace</span></h1>
          <div className="meta-rows">
            <div><span className="badge">{branch}</span> <span className="m">{p.repos?.length ?? 0} repos · {sum.dirty ? `${sum.dirty} changed` : "clean"}{sum.ahead ? ` · ↑${sum.ahead}` : ""}{sum.behind ? ` · ↓${sum.behind}` : ""}{sum.prs ? ` · ${sum.prs} PR${sum.prs === 1 ? "" : "s"}` : ""}</span></div>
            <div className="path">{p.path}</div>
          </div>
        </div>
        <QuickActions key={wt.id} project={p} wt={wt} manage onRun={(action) => onRunAction(wt, action)} />
      </div>
      <div className="actions">
        <button className="primary" onClick={() => !needKey() && setForm((f) => !f)}><Ico n="quill" /> New chat</button>
        <button disabled={busy || anyRunning || !dirty.length} title={dirty.length ? `Commit the changes in ${dirty.map((r) => r.dir).join(", ")} with one message, then push` : "No repo has changes"} onClick={() => { setGitError(""); setCommitting(true); }}><Ico n="wheat" /> Commit…{dirty.length > 0 && <span className="m"> {dirty.length}/{st?.repos.length}</span>}</button>
        <button disabled={busy || anyRunning || !st} onClick={() => fanout(`Pull ${branch}`, () => ade.pullWorkspace(p.id))}>{busy ? "Working…" : "Pull all"}</button>
        <button disabled={busy || anyRunning || !st} onClick={() => fanout(`Push ${branch}`, () => ade.pushWorkspace(p.id))}>{busy ? "Working…" : "Push all"}</button>
        <button className="create-pr" disabled={busy || anyRunning || !prRepos.length} title={prRepos.length ? `Open a PR in ${prRepos.map((r) => r.dir).join(", ")}` : "No repo has commits without a PR"} onClick={() => { setGitError(""); setPrGen({ busy: false }); setPrDraft({ title: `${p.name}`, body: "", draft: false }); }}><Ico n="grapes" /> Create PRs{prRepos.length > 0 && <span className="m"> {prRepos.length}</span>}</button>
      </div>
      {anyRunning && <div className="m">Commit, pull, push and PRs are available when this workspace's chats finish.</div>}
      {!committing && !prDraft && gitError && <div className="error">{gitError}</div>}
      {results && <RepoResults title={results.title} rows={results.rows} />}
      <h2>Repositories</h2>
      <p className="sect-note">Each repo's checkout on the shared branch: its changes, last commit, pull request and CI.</p>
      <div className="grid repos">
        {(st?.repos ?? (p.repos ?? []).map((r) => ({ projectId: r.projectId, name: state.projects.find((x) => x.id === r.projectId)?.name ?? r.dir, dir: r.dir, path: `${p.path}/${r.dir}`, status: null }))).map((r) => <RepoCard key={r.dir} r={r} />)}
      </div>
      {committing && <Dialog title={`Commit to ${branch}`} onClose={() => { if (!busy) setCommitting(false); }} footer={<>
        <button disabled={busy} onClick={() => setCommitting(false)}>Cancel</button>
        <button className="primary" disabled={busy || !message.trim() || anyRunning} onClick={commit}>{busy ? "Committing…" : `Commit in ${dirty.length} repo${dirty.length === 1 ? "" : "s"} + push`}</button>
      </>}>
        <p>One message, every repo with changes. Repos with a clean tree are left alone.</p>
        {dirty.map((r) => <div key={r.dir}><div className="mono">{r.dir}/</div><pre className="files">{r.status?.files}</pre></div>)}
        <Field label="Commit message"><input autoFocus value={message} disabled={busy} onChange={(e) => setMessage(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && message.trim()) void commit(); }} /></Field>
        {gitError && <div className="error">{gitError}</div>}
      </Dialog>}
      {prDraft && <Dialog title={`Create PRs: ${branch}`} onClose={() => { if (!busy) setPrDraft(null); }} footer={<>
        <button disabled={busy} onClick={() => setPrDraft(null)}>Cancel</button>
        <button className="primary" disabled={busy || !prDraft.title.trim() || anyRunning} onClick={createPrs}>{busy ? "Creating…" : `Create ${prRepos.length} ${prDraft.draft ? "draft " : ""}PR${prRepos.length === 1 ? "" : "s"}`}</button>
      </>}>
        <p>Pushes {branch} and opens a pull request in each repo with commits to review. Every PR gets the same title and description, plus links to the others.</p>
        <ul className="m">{prRepos.map((r) => <li key={r.dir}>{r.name}: {branch} → {prBaseBranch(r.status!.base)}{r.status!.dirty ? ` · ${r.status!.dirty} uncommitted change${r.status!.dirty === 1 ? "" : "s"} stay behind` : ""}</li>)}</ul>
        <div className={"pr-fields" + (prGen.busy ? " thinking" : "")} aria-busy={prGen.busy}>
          <div className="field">
            <label>Title<button className="icon generate" disabled={busy || prGen.busy} title="Draft a title and bullet points from the commits in every repo" onClick={generatePr}><Ico n="star" />Generate</button></label>
            <input autoFocus value={prDraft.title} disabled={busy || prGen.busy} onChange={(e) => setPrDraft({ ...prDraft, title: e.target.value })} />
          </div>
          <Field label="Description" optional><textarea rows={6} value={prDraft.body} disabled={busy || prGen.busy} placeholder="What changed and why, across the repos" onChange={(e) => setPrDraft({ ...prDraft, body: e.target.value })} /></Field>
          {prGen.busy && <div className="m" role="status">Drafting from the commits in every repo…</div>}
        </div>
        {prGen.note && <div className="m" role="status">{prGen.note}</div>}
        <div className="field"><label className="check"><input type="checkbox" checked={prDraft.draft} disabled={busy} onChange={(e) => setPrDraft({ ...prDraft, draft: e.target.checked })} /> Open as drafts</label></div>
        {gitError && <div className="error" role="alert">{gitError}</div>}
      </Dialog>}
      {form && <NewChatForm wt={wt} state={state} onClose={() => setForm(false)} onDone={(id) => { setForm(false); onSelect({ type: "chat", id }); }} />}
      <h2>Chats</h2>
      <p className="sect-note">Conversations working across every repo in this workspace. Click one to continue it.</p>
      {!chats.length && <div className="m">No chats in this workspace yet.</div>}
      <div className="grid">
        {chats.map((c) => (
          <div key={c.id} className={"card click" + (chatStatus(c) === "reminder" ? " reminded" : "")} onClick={() => onSelect({ type: "chat", id: c.id })} onContextMenu={(e) => { e.preventDefault(); void ade.chatMenu(c.id); }}>
            <div className="t">{c.running && <span className="spin" />} <Editable value={c.name} onSave={(n) => ade.renameChat(c.id, n)} /></div>
            <div className="m">{c.provider} · {c.model} · {c.messages.length} msgs{c.error ? " · error" : ""}</div>
            <div className="snip">{lastText(c) || "—"}</div>
            <MiniBar phase={c.phase} steps={c.phaseSteps} />
          </div>
        ))}
      </div>
    </div>
  );
}

function RootBranchPicker({ wt, disabled, onChanged }: { wt: Worktree; disabled?: boolean; onChanged: () => void }) {
  const [data, setData] = useState<Awaited<ReturnType<Api["rootBranches"]>>>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const listId = React.useId();
  useEffect(() => { if (disabled || busy) setOpen(false); }, [disabled, busy]);
  useEffect(() => {
    if (busy) return;
    let disposed = false;
    const refresh = () => ade.rootBranches(wt.projectId).then((value) => { if (!disposed) setData(value); }, (e) => { if (!disposed) setError(e.message); });
    refresh();
    const timer = setInterval(refresh, 10000);
    window.addEventListener("focus", refresh);
    return () => { disposed = true; clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [wt.projectId, wt.branch, busy]);
  const change = async (ref: string) => {
    if (!data || busy || disabled) return;
    setOpen(false); trigger.current?.focus();
    setBusy(true); setError("");
    try { await ade.switchRootBranch(wt.projectId, data.current, ref); onChanged(); }
    catch (e: any) { setError(e.message); }
    finally {
      await ade.rootBranches(wt.projectId).then(setData, () => {});
      setBusy(false);
    }
  };
  const current = data ? data.current : wt.branch;
  const value = current ? `refs/heads/${current}` : "";
  const matches = data?.branches.filter((b) => b.name.toLowerCase().includes(query.trim().toLowerCase())) ?? [];
  return <div className="root-branch-picker" ref={container} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); }} onKeyDown={(e) => {
    if (e.key === "Escape") { e.preventDefault(); setOpen(false); trigger.current?.focus(); }
    if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      const options = Array.from(container.current?.querySelectorAll<HTMLButtonElement>(".root-branch-option:not(:disabled)") ?? []);
      const index = options.indexOf(document.activeElement as HTMLButtonElement);
      options[(index + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length]?.focus();
    }
  }}>
    <span className="root-branch-label">Root branch</span>
    <button type="button" className="root-branch-trigger" ref={trigger} disabled={disabled || busy || !data} aria-expanded={open} aria-controls={listId} onClick={() => { setQuery(""); setOpen(!open); }}>
      <span>{current ?? "Detached HEAD"}</span><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m3 4.5 3 3 3-3" /></svg>
    </button>
    {open && <div className="root-branch-popover" id={listId}>
      <input autoFocus aria-label="Search branches" placeholder="Search branches…" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); const first = matches.find((b) => !b.occupied); if (first) void change(first.ref); }
      }} />
      <div className="root-branch-results" role="group" aria-label="Matching branches">
        {matches.map((b) => <button type="button" className="root-branch-option" key={b.ref} disabled={!!b.occupied} aria-pressed={b.ref === value} onClick={() => change(b.ref)}>
          <span>{b.name}</span>{b.occupied ? <small>In another worktree</small> : b.ref === value ? <small>Current</small> : null}
        </button>)}
        {!matches.length && <div className="root-branch-empty" role="status">No matching branches</div>}
      </div>
    </div>}
    {busy && <span className="m" role="status">Switching branch…</span>}
    {error && <div className="err" role="alert">{error}</div>}
  </div>;
}

function RootCard({ wt, state, status, error, onRefresh, onSelect }: {
  wt: Worktree; state: State; status?: RootStatus; error: string; onRefresh: () => Promise<void>; onSelect: (s: Sel) => void;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const [failure, setFailure] = useState("");
  const [summary, setSummary] = useState<CommitInfo>();
  const [summaryError, setSummaryError] = useState("");
  useEffect(() => {
    let disposed = false;
    const refresh = () => ade.commitInfo(wt.id).then((value) => { if (!disposed) { setSummary(value); setSummaryError(""); } }, (e) => { if (!disposed) setSummaryError(e.message); });
    refresh();
    const timer = setInterval(refresh, 10000);
    window.addEventListener("focus", refresh);
    return () => { disposed = true; clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [wt.id, wt.branch, status?.branch, status?.commit, status?.dirty, busy]);
  const chats = recentChats(state.chats.filter((c) => c.worktreeId === wt.id));
  const running = chats.some((c) => c.running);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!status?.branch || busy) return;
    setBusy(true); setResult(""); setFailure("");
    try {
      setResult(await ade.commitAndPushRoot(wt.id, status.branch, message));
      setMessage("");
    } catch (e: any) { setFailure(e.message); }
    finally { await onRefresh(); setBusy(false); }
  };
  return <div className="root-panels">
    <section className="card root-card" aria-label="Root">
      <h2><Ico n="thorn" />Root</h2>
      <p className="sect-note">The repository's own checkout. Switch its branch, open it, or start a chat working directly in it.</p>
      <RootBranchPicker wt={wt} disabled={busy || running} onChanged={() => { setResult(""); setFailure(""); void onRefresh(); }} />
      <div className="path">{wt.path}</div>
      <div className="snip">{chats.length} chat{chats.length === 1 ? "" : "s"} · {status ? status.dirty ? "uncommitted changes" : "clean" : "loading…"}</div>
      <div className="actions">
        <button onClick={() => onSelect({ type: "worktree", id: wt.id })}>Open root</button>
        <button disabled={busy} onClick={() => onSelect({ type: "worktree", id: wt.id, form: true })}>New chat</button>
      </div>
    </section>
    <form className="card root-commit" aria-label="Commit root changes" onSubmit={submit}>
      <h2>Commit and push</h2>
      <p className="sect-note">Commit everything changed at root with one message and push it to the branch's origin.</p>
      <div className="root-change-summary">
        {summaryError ? <div className="err" role="alert">{summaryError}</div> : !summary ? <div className="m">Loading changes…</div> : <>
          <div className="root-change-counts"><strong>{summary.changed ? `${summary.changed} changed file${summary.changed === 1 ? "" : "s"}` : "No uncommitted changes"}</strong><span className="m">{summary.ahead} unpushed commit{summary.ahead === 1 ? "" : "s"}</span></div>
          {summary.changed > 0 && <details><summary>View changed files</summary><pre className="root-changed-files">{summary.files}</pre></details>}
        </>}
      </div>
      <div className="m root-push-target">Push to <span className="mono">{status?.branch ? `origin/${status.branch}` : "the current branch"}</span></div>
      <label className="sr-only" htmlFor={`root-message-${wt.id}`}>Commit message</label>
      <input id={`root-message-${wt.id}`} aria-label="Root commit message" placeholder="Commit message" value={message} disabled={busy} onChange={(e) => setMessage(e.target.value)} />
      <button className="primary" disabled={busy || running || !!error || !status?.branch || (!!status?.dirty && !message.trim())}>{busy ? "Committing and pushing…" : "Commit and push"}</button>
      {running && <div className="m">Wait for root chats to finish.</div>}
      {status && !status.branch && <div className="m">Switch root to a branch before pushing.</div>}
      {(failure || error) && <div className="err" role="alert">{failure || error}</div>}
      {result && <div className="m" role="status">{result}</div>}
    </form>
  </div>;
}

function WorktreeCard({ wt, state, onSelect, onCheckout }: { wt: Worktree; state: State; onSelect: (s: Sel) => void; onCheckout?: () => void }) {
  const st = useStatus(wt.id);
  const chats = recentChats(state.chats.filter((c) => c.worktreeId === wt.id));
  const running = chats.filter((c) => c.running).length;
  return (
    <div className={"card click" + (wt.archived ? " dim" : "")} onClick={() => onSelect({ type: "worktree", id: wt.id })}>
      <div className="t">{wt.title}</div>
      <div className="m mono">{st?.branch ?? wt.branch}</div>
      <Badges st={st} />
      <div className="snip">{chats.length} chat{chats.length === 1 ? "" : "s"}{running ? ` · ${running} running` : ""}{wt.archived ? " · archived" : ""}</div>
      {onCheckout && !wt.root && <button style={{ marginTop: 10 }} disabled={running > 0} title={running ? "Wait for running chats to finish" : "Commit and push this worktree, then check out its branch at the root"} onClick={(e) => { e.stopPropagation(); onCheckout(); }}>Push and checkout at root</button>}
    </div>
  );
}

/* ---------- worktree page ---------- */

const lastText = (c: Chat) => {
  for (let i = c.messages.length - 1; i >= 0; i--)
    for (const b of [...c.messages[i].blocks].reverse()) if (b.type === "text" && b.text.trim()) return b.text.trim();
  return "";
};

function WorktreePage({ wt, state, openForm, onSelect, onRunAction }: { wt: Worktree; state: State; openForm: boolean; onSelect: (s: Sel) => void; onRunAction: (wt: Worktree, action: { title: string; command: string }) => void }) {
  const project = state.projects.find((p) => p.id === wt.projectId);
  const [revision, setRevision] = useState(0);
  const st = useStatus(wt.id, revision);
  const [committing, setCommitting] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [gitError, setGitError] = useState("");
  const [gitResult, setGitResult] = useState<React.ReactNode>("");
  // the Create PR dialog; null while closed. Opened with a title from the last commit.
  const [prDraft, setPrDraft] = useState<{ title: string; body: string; draft: boolean } | null>(null);
  // the Generate button's state: drafting, or a short note when it came back empty or failed
  const [prGen, setPrGen] = useState<{ busy: boolean; note?: string }>({ busy: false });
  // seconds since Generate was pressed: a 30-second wait needs a clock, not a frozen word
  const [prGenSeconds, setPrGenSeconds] = useState(0);
  useEffect(() => {
    if (!prGen.busy) { setPrGenSeconds(0); return; }
    const t = setInterval(() => setPrGenSeconds((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [prGen.busy]);
  const generatePr = async () => {
    if (!st || prGen.busy) return;
    setPrGen({ busy: true });
    try {
      const { title, body } = await ade.suggestPr(wt.id, st.branch);
      if (!title && !body) { setPrGen({ busy: false, note: `Nothing to summarize: no commits on ${st.branch} beyond ${prBaseBranch(st.base)}.` }); return; }
      setPrDraft((d) => d && { ...d, title: title || d.title, body: body || d.body });
      setPrGen({ busy: false });
    } catch (e) { setPrGen({ busy: false, note: (e as Error).message.split("\n")[0] }); }
  };
  const createPr = async () => {
    if (!st || !prDraft || busy) return;
    setBusy(true); setGitError(""); setGitResult("");
    try {
      const { url, number } = await ade.createPr(wt.id, st.branch, prDraft);
      setPrDraft(null);
      setGitResult(<>Opened <a href="#" onClick={(e) => { e.preventDefault(); ade.openExternal(url); }}>{number ? `PR #${number}` : "the PR"}</a> for {st.branch}{prDraft.draft ? " as a draft" : ""}.</>);
    } catch (e) { setGitError((e as Error).message); }
    finally { setBusy(false); setRevision((n) => n + 1); }
  };
  const runGit = async (action: "commit" | "push" | "pull") => {
    if (!st || busy) return;
    setBusy(true); setGitError(""); setGitResult("");
    try {
      if (action === "pull") { await ade.pullWorktree(wt.id, st.branch); setGitResult(`Pulled from origin/${st.branch}.`); }
      else if (action === "push") { await ade.pushWorktree(wt.id, st.branch); setGitResult(`Pushed to origin/${st.branch}.`); }
      else {
        const commit = await ade.commitWorktree(wt.id, st.branch, message);
        setGitResult(`Committed ${commit.slice(0, 7)} on ${st.branch}.`);
        setMessage(""); setCommitting(false);
      }
    } catch (e) { setGitError((e as Error).message); }
    finally { setBusy(false); setRevision((n) => n + 1); }
  };
  const [form, setForm] = useState(openForm);
  useEffect(() => { if (openForm) setForm(true); }, [openForm]);
  const chats = recentChats(state.chats.filter((c) => c.worktreeId === wt.id));
  const siblings = recentWorktrees(state.worktrees.filter((w) => w.projectId === wt.projectId && w.id !== wt.id && !w.archived), state.chats);
  const needKey = () => (state.keys.length ? false : (alert("Add a connector first (Settings)"), true));
  const prWriteup = async () => {
    if (needKey()) return;
    const k = defaultConnector(state);
    const tiers = modelTiers(k.provider, modelOptions(state, k.provider));
    const id = await ade.addChat(wt.id, k.id, { name: prChatName(st?.pr, `PR write-up · ${wt.title}`), model: tiers.orchestrator, delegateModel: tiers.delegate, remember: false });
    onSelect({ type: "chat", id });
    ade.send(id, await ade.skillPrompt("pr-writeup", wt.id, undefined, tiers.delegate)).catch((e) => alert(e.message));
  };
  return (
    <div className="page">
      {wt.ship && <ShipBar wt={wt} chats={state.chats} onOpenChat={(id) => onSelect({ type: "chat", id })} />}
      <div className="workspace-heading">
        <div className="workspace-heading-info">
        <h1>{wt.root ? "Root" : <><Editable value={wt.title} onSave={(t) => ade.renameWorktree(wt.id, t)} trigger="click" /> <button className="icon" title="Name with AI" onClick={() => ade.autoTitle(wt.id)}><Ico n="star" className="big" /></button></>}</h1>
        <div className="meta-rows">
          {wt.root ? <RootBranchPicker wt={wt} disabled={busy || chats.some((c) => c.running)} onChanged={() => { setRevision((n) => n + 1); setGitResult(""); setGitError(""); }} /> : <div><span className="badge">{st?.branch ?? wt.branch}</span></div>}
          <Badges st={st} />
          <div className="path">{wt.path}</div>
        </div>
        </div>
        {project && <QuickActions key={wt.id} project={project} wt={wt} onRun={(action) => onRunAction(wt, action)} />}
      </div>
      <div className="actions">
        <button className="primary" onClick={() => !needKey() && setForm((f) => !f)}><Ico n="quill" /> New chat</button>
        <button onClick={prWriteup}><Ico n="scroll" /> PR write-up</button>
        {canCreatePr(st) && (
          <button className="create-pr" disabled={busy || !!prBlockedBy(st) || chats.some((c) => c.running)}
            title={prBlockedBy(st) ?? `Push ${st.branch} and open a pull request against ${prBaseBranch(st.base)}`}
            onClick={() => { setGitError(""); setPrGen({ busy: false }); setPrDraft({ title: suggestedPrTitle(st), body: "", draft: false }); }}><Ico n="grapes" /> Create PR</button>
        )}
      </div>
      {st && <GitCard st={st} />}
      <div className="actions">
        <button disabled={busy || !st?.dirty || chats.some((c) => c.running)} onClick={() => { setCommitting(true); setGitError(""); }}>Commit…</button>
        <button disabled={busy || !st || st.branch === "(detached)" || chats.some((c) => c.running)} onClick={() => runGit("pull")}>{busy ? "Working…" : `Pull from origin/${st?.branch ?? wt.branch}`}</button>
        <button disabled={busy || !st || chats.some((c) => c.running)} onClick={() => runGit("push")}>{busy ? "Working…" : `Push to origin/${st?.branch ?? wt.branch}`}</button>
      </div>
      {chats.some((c) => c.running) && <div className="m">Commit, pull, and push are available when this worktree's chats finish.</div>}
      {!committing && !prDraft && gitError && <div className="error">{gitError}</div>}
      {gitResult && <div role="status">{gitResult}</div>}
      {committing && <Dialog title={`Commit to ${st?.branch ?? wt.branch}`} onClose={() => { if (!busy) setCommitting(false); }} footer={<>
        <button disabled={busy} onClick={() => setCommitting(false)}>Cancel</button>
        <button className="primary" disabled={busy || !message.trim() || chats.some((c) => c.running)} onClick={() => runGit("commit")}>{busy ? "Committing…" : "Commit changes"}</button>
      </>}>
        <p>Include all tracked and untracked changes in this worktree. Ignored files are excluded.</p>
        <pre className="files">{st?.files}</pre>
        <Field label="Commit message"><input autoFocus value={message} disabled={busy} onChange={(e) => setMessage(e.target.value)} /></Field>
        {gitError && <div className="error">{gitError}</div>}
      </Dialog>}
      {prDraft && st && <Dialog title={`Create PR: ${st.branch} → ${prBaseBranch(st.base)}`} onClose={() => { if (!busy) setPrDraft(null); }} footer={<>
        <button disabled={busy} onClick={() => setPrDraft(null)}>Cancel</button>
        <button className="primary" disabled={busy || !prDraft.title.trim() || chats.some((c) => c.running)} onClick={createPr}>{busy ? "Creating…" : prDraft.draft ? "Create draft PR" : "Create PR"}</button>
      </>}>
        <p>Push {st.branch} to origin{st.ahead ? ` (${st.ahead} unpushed commit${st.ahead === 1 ? "" : "s"})` : ""}, then open a pull request against {prBaseBranch(st.base)}.{st.dirty ? ` ${st.dirty} uncommitted change${st.dirty === 1 ? " stays" : "s stay"} local.` : ""}</p>
        <div className={"pr-fields" + (prGen.busy ? " thinking" : "")} aria-busy={prGen.busy}>
          <div className="field">
            <label>Title<button className="icon generate" disabled={busy || prGen.busy} title={`Draft a title and bullet points from the commits on ${st.branch}`} onClick={generatePr}><Ico n="star" />Generate</button></label>
            <input autoFocus value={prDraft.title} disabled={busy || prGen.busy} onChange={(e) => setPrDraft({ ...prDraft, title: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") void createPr(); }} />
          </div>
          <Field label="Description" optional><textarea rows={6} value={prDraft.body} disabled={busy || prGen.busy} placeholder="What changed and why" onChange={(e) => setPrDraft({ ...prDraft, body: e.target.value })} /></Field>
          {prGen.busy && (
            <div className="pr-thinking" role="status" aria-live="polite">
              <span className="pr-thinking-orb" aria-hidden><span /><span /><span /></span>
              <div className="pr-thinking-text">
                <strong>Drafting the title and description…</strong>
                <span>Reading the commits and diff on {st.branch}. This usually takes 15 to 30 seconds.{prGenSeconds >= 3 ? ` ${prGenSeconds}s` : ""}</span>
              </div>
            </div>
          )}
        </div>
        {prGen.note && <div className="m" role="status">{prGen.note}</div>}
        <div className="field"><label className="check"><input type="checkbox" checked={prDraft.draft} disabled={busy} onChange={(e) => setPrDraft({ ...prDraft, draft: e.target.checked })} /> Open as a draft</label></div>
        {gitError && <div className="error" role="alert">{gitError}</div>}
      </Dialog>}
      {form && <NewChatForm wt={wt} state={state} onClose={() => setForm(false)} onDone={(id) => { setForm(false); onSelect({ type: "chat", id }); }} />}
      <h2>Chats</h2>
      <p className="sect-note">Conversations in this worktree. Click one to continue it, or start a new chat above.</p>
      {!chats.length && <div className="m">No chats in this worktree yet.</div>}
      <div className="grid">
        {chats.map((c) => (
          <div key={c.id} className={"card click" + (chatStatus(c) === "reminder" ? " reminded" : "")} onClick={() => onSelect({ type: "chat", id: c.id })} onContextMenu={(e) => { e.preventDefault(); void ade.chatMenu(c.id); }}>
            <div className="t">{c.running && <span className="spin" />} <Editable value={c.name} onSave={(n) => ade.renameChat(c.id, n)} /></div>
            <div className="m">{c.provider} · {c.model} · {c.messages.length} msgs{c.error ? " · error" : ""}</div>
            <div className="snip">{lastText(c) || "—"}</div>
            <MiniBar phase={c.phase} steps={c.phaseSteps} />
          </div>
        ))}
      </div>
      {siblings.length > 0 && (
        <>
          <h2>Other worktrees</h2>
          <p className="sect-note">The project's other branches. Open one to switch to it.</p>
          <div className="grid">{siblings.map((w) => <SiblingCard key={w.id} wt={w} state={state} onSelect={onSelect} />)}</div>
        </>
      )}
    </div>
  );
}

// Actions are managed once on the project. Worktrees only expose the project's run buttons.
function QuickActions({ project, wt, manage = false, onRun }: { project: Project; wt?: Worktree; manage?: boolean; onRun: (action: { title: string; command: string }) => void }) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [command, setCommand] = useState("");
  const [deleting, setDeleting] = useState<{ id: string; title: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    if (busy || !title.trim() || !command.trim()) return;
    setBusy(true); setError("");
    try { await ade.addQuickAction(project.id, title, command); setAdding(false); setTitle(""); setCommand(""); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!deleting || busy) return;
    setBusy(true); setError("");
    try { await ade.deleteQuickAction(project.id, deleting.id); setDeleting(null); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <section className="quick-actions" aria-label="Quick actions">
    {manage && <h4><Ico n="star" />Quick actions</h4>}
    <div className="quick-action-tiles">
      {(project.quickActions ?? []).map(action => <div className="quick-action-tile" key={action.id}>
        <button className="quick-action-run" disabled={!wt} title={wt ? `Run ${action.title} in ${wt.path}` : "A root worktree is still being prepared"} onClick={() => onRun(action)}>
          <Ico n="star" /><span>{action.title}</span>
        </button>
        {manage && <details className="quick-action-menu">
          <summary aria-label={`Options for ${action.title}`}>⋯</summary>
          <div className="quick-action-menu-items">
            <button onClick={(e) => {
              e.currentTarget.closest("details")?.removeAttribute("open");
              ade.setQuickActionPinned(project.id, action.id, !action.pinned).catch((e) => alert(e.message));
            }}>{action.pinned ? "Unpin from header" : "Pin to header"}</button>
            <button onClick={(e) => { e.currentTarget.closest("details")?.removeAttribute("open"); setError(""); setDeleting(action); }}>Delete action…</button>
          </div>
        </details>}
      </div>)}
      {manage && <button className="quick-action-new" onClick={() => { setError(""); setAdding(true); }}><span aria-hidden="true">＋</span>New Action</button>}
    </div>
    {adding && <Dialog title="New quick action" onClose={() => { if (!busy) setAdding(false); }} footer={<>
      <button disabled={busy} onClick={() => setAdding(false)}>Cancel</button>
      <button className="primary" disabled={busy || !title.trim() || !command.trim()} onClick={save}>{busy ? "Saving…" : "Save action"}</button>
    </>}>
      <Field label="Title"><input aria-label="Action title" autoFocus value={title} onChange={e => setTitle(e.target.value)} placeholder="BUILD" disabled={busy} /></Field>
      <Field label="Bash command"><textarea aria-label="Bash command" className="quick-action-code" rows={6} spellCheck={false} value={command} onChange={e => setCommand(e.target.value)} placeholder="pnpm package:mac" disabled={busy} /></Field>
      <div className="m">Use {"{{name}}"} for a value requested before the command runs, for example: git checkout {"{{branch}}"}.</div>
      <div className="m">Saved for every worktree in {project.name}. {wt ? `Runs here in ${wt.path}.` : "It will run from the worktree you choose."}</div>
      {error && <div className="error" role="alert">{error}</div>}
    </Dialog>}
    {deleting && <Dialog title="Delete quick action" onClose={() => { if (!busy) setDeleting(null); }} footer={<>
      <button disabled={busy} onClick={() => setDeleting(null)}>Cancel</button>
      <button disabled={busy} onClick={remove}>{busy ? "Deleting…" : "Delete action"}</button>
    </>}><p>Delete “{deleting.title}” from {project.name}? It disappears from every worktree. Running terminals will stay open.</p>{error && <div className="error" role="alert">{error}</div>}</Dialog>}
  </section>;
}

function GitCard({ st }: { st: WorktreeStatus }) {
  const pr = st.pr;
  return (
    <div className="card git">
      <div className="gitgrid">
        <div><h4><Ico n="olive" />Branch</h4><div className="mono">{st.branch}</div><div className="m">vs {st.base}: {st.merged ? "merged" : st.inBase ? "in base" : `↑${st.ahead} ↓${st.behind}`}</div></div>
        <div><h4><Ico n="cypress" />Working tree</h4><div>{st.dirty ? `${st.dirty} changed file${st.dirty === 1 ? "" : "s"}` : "clean"}</div>{st.files && <pre className="files">{st.files.split("\n").slice(0, 8).join("\n")}{st.dirty > 8 ? "\n…" : ""}</pre>}</div>
        <div><h4><Ico n="wheat" />Last commit</h4>{st.last ? <><div>{st.last.subject}</div><div className="m">{st.last.author} · {st.last.age}</div></> : <div className="m">none</div>}</div>
        <div>
          <h4><Ico n="grapes" />Pull request</h4>
          {pr ? (
            <>
              <a href="#" onClick={(e) => { e.preventDefault(); ade.openExternal(pr.url); }}>#{pr.number} {pr.title}</a>
              <div className="m">{pr.draft ? "draft" : pr.state.toLowerCase()}{pr.review ? ` · ${pr.review.toLowerCase().replace("_", " ")}` : ""}{st.ci ? ` · ${ciTitle(st.ci).toLowerCase()}` : ""}</div>
            </>
          ) : <div className="m">no PR</div>}
        </div>
      </div>
    </div>
  );
}

function SiblingCard({ wt, state, onSelect }: { wt: Worktree; state: State; onSelect: (s: Sel) => void }) {
  const st = useStatus(wt.id);
  const chats = recentChats(state.chats.filter((c) => c.worktreeId === wt.id));
  const running = chats.filter((c) => c.running).length;
  const done = chats.filter((c) => c.phase === "complete").length;
  return (
    <div className="card click" onClick={() => onSelect({ type: "worktree", id: wt.id })}>
      <div className="t">{wt.title}</div>
      <div className="m">{st?.branch ?? wt.branch}</div>
      <Badges st={st} />
      <div className="snip">{chats.length} chat{chats.length === 1 ? "" : "s"}{running ? ` · ${running} running` : ""}{done ? ` · ${done} complete` : ""}</div>
    </div>
  );
}

function NewChatForm({ wt, scratch, state, onClose, onDone }: { wt?: Worktree; scratch?: boolean; state: State; onClose: () => void; onDone: (id: string) => void }) {
  const [name, setName] = useState(wt?.title ?? "");
  const [keyId, setKeyId] = useState(defaultConnector(state)?.id ?? "");
  const provider = state.keys.find((k) => k.id === keyId)?.provider ?? "claude";
  const preferredModel = () => { const first = modelOptions(state, provider)[0] ?? MODELS[provider][0]; const key = state.keys.find((k) => k.id === keyId); return key ? selectedModel(state, key, first) : first; };
  const [model, setModel] = useState(preferredModel);
  const [custom, setCustom] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [over, setOver] = useState(false);
  const addFiles = (paths: string[]) => setFiles((f) => [...new Set([...f, ...paths])]);
  const options = modelOptions(state, provider);
  useEffect(() => { const next = preferredModel(); setModel(next); setCustom(!modelOptions(state, provider).includes(next)); }, [keyId]);
  const start = async () => {
    let id: string;
    try { id = wt ? await ade.addChat(wt.id, keyId, { name, model }) : await ade.addScratchChat(keyId, { name, model }); }
    catch (e) { alert((e as Error).message); return; }
    if (prompt.trim() || files.length) ade.send(id, prompt.trim() || "See attached files.", files).catch((e) => alert(e.message));
    onDone(id);
  };
  return (
    <Dialog title={scratch ? "Create a chat · no repo" : "Create a chat"} onClose={onClose} footer={<>
      <button onClick={onClose}>Cancel</button>
      <button className="primary" disabled={!keyId || !name || !model} onClick={start}>Create</button>
    </>}>
      <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder={scratch ? "What is this about?" : undefined} /></Field>
      {scratch && <p className="m">Not on any code. The chat gets a private folder to work out of if it needs one; every connector and model is available.</p>}
      <div className="two">
        <Field label="Key">
          <select value={keyId} onChange={(e) => setKeyId(e.target.value)}>
            {state.keys.map((k) => <option key={k.id} value={k.id}>{k.provider}: {k.name}</option>)}
          </select>
        </Field>
        <Field label="Model">
          {custom ? (
            <input autoFocus value={model} placeholder="model id" onChange={(e) => setModel(e.target.value)} onBlur={() => !model && setCustom(false)} />
          ) : (
            <select value={model} onChange={(e) => { if (e.target.value === "__other") { setCustom(true); setModel(""); } else setModel(e.target.value); }}>
              {options.map((m) => <option key={m} value={m}>{m}</option>)}
              <option value="__other">other…</option>
            </select>
          )}
        </Field>
      </div>
      <Field label="Initial prompt" optional info="⌘↩ to create and send · drop files onto the box to attach them">
        <div className={"dropwrap" + (over ? " over" : "")} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
          onDrop={async (e) => { e.preventDefault(); setOver(false); addFiles(await filesFromTransfer(e.dataTransfer)); }}
          onPaste={async (e) => { if ([...e.clipboardData.items].some((i) => i.kind === "file")) { e.preventDefault(); addFiles(await filesFromTransfer(e.clipboardData)); } }}>
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="What should this chat do?"
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) start(); }} />
          <div className="attachrow">
            <button className="icon attach" title="Attach files" onClick={async () => addFiles(await ade.pickFiles())}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.5l-8.6 8.6a5 5 0 0 1-7-7l9.2-9.2a3.3 3.3 0 0 1 4.7 4.7L10 18.9a1.6 1.6 0 0 1-2.3-2.3l8.5-8.5" /></svg>
            </button>
            <Attachments worktreeId={wt?.id} paths={files} onRemove={(f) => setFiles((x) => x.filter((y) => y !== f))} />
            {!files.length && <span className="m">no attachments</span>}
          </div>
        </div>
      </Field>
    </Dialog>
  );
}

/* ---------- chat ---------- */

function MdLinks({ text, onOpen }: { text: string; onOpen: (p: string) => void }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const link of artifactLinks(text)) {
    parts.push(text.slice(last, link.index));
    parts.push(<a key={link.index} href="#" className="mdlink" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onOpen(link.target); }} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onOpen(link.target); }}>{link.label}</a>);
    last = link.index + link.length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}

// Local images in rendered Markdown: the <img> the browser cannot load becomes an artifact
// anchor carrying the source path and alt text; useArtifactImages fills it with the file.
function linkImages(root: ParentNode) {
  for (const img of [...root.querySelectorAll("img")]) {
    const target = localImageTarget(img.getAttribute("src"));
    if (!target) continue;
    const a = document.createElement("a");
    a.href = "#"; a.className = "mdlink mdimg"; a.dataset.artifact = target;
    const alt = img.getAttribute("alt") || target.split("/").pop() || target;
    a.dataset.alt = alt; a.title = alt; a.textContent = alt;
    img.replaceWith(a);
  }
}

// Once the HTML is in the document, load each image anchor's file. One that cannot be read
// keeps its text label, which still opens the artifact like any other link.
function useArtifactImages(ref: React.RefObject<HTMLElement | null>, worktreeId: string | undefined, resolve: (target: string) => string, html: string) {
  useEffect(() => {
    const root = ref.current;
    if (!root || !worktreeId) return;
    let live = true;
    for (const a of root.querySelectorAll<HTMLAnchorElement>("a.mdimg[data-artifact]")) {
      if (a.querySelector("img")) continue;
      attachmentPreview(worktreeId, resolve(a.dataset.artifact!)).then((src) => {
        if (!live) return;
        const img = document.createElement("img");
        img.src = src; img.alt = a.dataset.alt ?? "";
        a.replaceChildren(img); a.classList.add("loaded");
      }, () => {});
    }
    return () => { live = false; };
  }, [ref, worktreeId, html]);
}

// One assistant turn: its prose and tool rows, then the follow-ups it suggested as chips.
// Clicking a chip sends that prompt to this chat (queued if the agent is still working).
// In a /ship chat the last turn's `Next:` footer also becomes chips: click one and the chat is cleared, then the
// command sent, the clear-then-resume habit in one click (onShipNext is only passed for that last message).
function AssistantMessage({ blocks, onOpen, worktreeId, live, onFollowup, onShipNext, showTools = true }: { blocks: Block[]; onOpen: (p: string) => void; worktreeId?: string; live: boolean; onFollowup: (prompt: string) => void; onShipNext?: (command: string) => void; showTools?: boolean }) {
  const parsed = React.useMemo(() => {
    const followups: Followup[] = [];
    const rows = blocks.map((b) => {
      if (b.type !== "text") return b;
      const p = parseFollowups(b.text);
      followups.push(...p.followups);
      return { ...b, text: p.text };
    });
    const next = onShipNext ? parseNextCommands(blocks.map((b) => (b.type === "text" ? b.text : "")).join("\n")) : [];
    return { rows, followups, next };
  }, [blocks, onShipNext]);
  // whatever this response made — a doc it wrote, a page an MCP tool created — gets a way to open it,
  // whether or not the model remembered to link it in its prose
  const made = React.useMemo(() => (live ? [] : messageArtifacts(blocks)), [blocks, live]);
  return (
    <div className="msg assistant">
      {showTools
        ? parsed.rows.map((b, k) => b.type === "text" ? (b.text.trim() ? <Prose key={k} text={b.text} onOpen={onOpen} worktreeId={worktreeId} /> : null) : <ToolRow key={b.id} b={b} onOpen={onOpen} live={live} />)
        : groupBlocks(parsed.rows, live).map((s, k) => s.type === "text" ? (s.text.trim() ? <Prose key={k} text={s.text} onOpen={onOpen} worktreeId={worktreeId} /> : null)
          : s.type === "tool" ? <ToolRow key={s.block.id} b={s.block} onOpen={onOpen} live={live} />
          : <ToolFold key={s.tools[0].id} tools={s.tools} onOpen={onOpen} live={live} />)}
      {made.length > 0 && (
        <div className="made" role="group" aria-label="Files from this response">
          {made.map((a) => (
            <button key={a.target} className="made-link" title={a.target} onClick={() => a.remote ? ade.openExternal(a.target) : onOpen(a.target)}>
              <Ico n="scroll" />{a.label}<span className="made-chev" aria-hidden="true">{a.remote ? "↗" : "›"}</span>
            </button>
          ))}
        </div>
      )}
      {parsed.followups.length > 0 && (
        <div className="followups" role="group" aria-label="Suggested follow-ups">
          {parsed.followups.map((f) => <button key={f.prompt} className="followup" title={f.prompt} onClick={() => onFollowup(f.prompt)}>{f.label}</button>)}
        </div>
      )}
      {onShipNext && parsed.next.length > 0 && <ShipNextChips next={parsed.next} live={live} onRun={onShipNext} />}
    </div>
  );
}

/** the /ship footer's next steps as chips; a command with a "<feedback>" placeholder asks for the text first */
function ShipNextChips({ next, live, onRun }: { next: NextCommand[]; live: boolean; onRun: (command: string) => void }) {
  const [ask, setAsk] = useState<NextCommand>();
  const [text, setText] = useState("");
  const send = () => { if (!ask || !text.trim()) return; onRun(fillNextCommand(ask.command, text)); setAsk(undefined); setText(""); };
  return (
    <div className="followups ship-next" role="group" aria-label="Next /ship step (clears the context first)">
      {!ask && next.map((n) => (
        <button key={n.command} className="followup ship-next-chip" disabled={live} title={`Clear the context, then send:\n${n.command}`} onClick={() => (n.needsFeedback ? setAsk(n) : onRun(n.command))}>{n.label}</button>
      ))}
      {ask && <div className="ship-ask">
        <textarea autoFocus rows={3} value={text} placeholder={`Feedback for ${ask.command}`} aria-label="Feedback" onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") setAsk(undefined); if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }} />
        <div className="actions"><button onClick={() => setAsk(undefined)}>Cancel</button><button className="primary" disabled={!text.trim()} onClick={send}>Clear + send ⌘↩</button></div>
      </div>}
    </div>
  );
}

/** the context meter: percent of the model's window the last turn used; green under 30, yellow to 70, red above */
function ContextMeter({ context }: { context: ChatContext }) {
  const percent = contextPercent(context);
  const tone = contextTone(percent);
  const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  return (
    <span className={`context-meter ${tone}`} role="meter" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label="Context used"
      title={`Context: ${k(context.used)} of ${k(context.window)} tokens (${percent}%) at the last turn's final call. /clear starts fresh.`}>
      <span className="context-track"><span className="context-fill" style={{ width: `${percent}%` }} /></span>
      <span className="context-pct">{percent}%</span>
    </span>
  );
}

// Assistant prose: Markdown, with bare file paths turned into artifact links.
function Prose({ text, onOpen, worktreeId }: { text: string; onOpen: (p: string) => void; worktreeId?: string }) {
  return <ProseMd text={text} onOpen={onOpen} worktreeId={worktreeId} />;
}
function ProseMd({ text, onOpen, worktreeId }: { text: string; onOpen: (p: string) => void; worktreeId?: string }) {
  const el = useRef<HTMLDivElement>(null);
  const html = React.useMemo(() => {
    const tpl = document.createElement("template");
    tpl.innerHTML = marked.parse(text) as string;
    linkImages(tpl.content);
    // a code span that is one path becomes a clickable chip whole, spaces and all; other spans are scanned like prose
    for (const code of Array.from(tpl.content.querySelectorAll("code"))) {
      if (code.closest("a, pre")) continue;
      const whole = codeSpanArtifact(code.textContent ?? "");
      if (!whole) continue;
      const a = document.createElement("a"); a.href = "#"; a.dataset.artifact = whole; a.className = "mdlink";
      code.replaceWith(a); a.append(code);
    }
    const walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (!(n.parentElement?.closest("a, pre"))) nodes.push(n as Text);
    for (const n of nodes) {
      const t = n.data, links = artifactLinks(t); if (!links.length) continue;
      const frag = document.createDocumentFragment(); let last = 0;
      for (const link of links) { frag.append(t.slice(last, link.index)); const a = document.createElement("a"); a.href = "#"; a.dataset.artifact = link.target; a.className = "mdlink"; a.textContent = link.label; frag.append(a); last = link.index + link.length; }
      frag.append(t.slice(last)); n.replaceWith(frag);
    }
    return tpl.innerHTML;
  }, [text]);
  useArtifactImages(el, worktreeId, (t) => t, html);
  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a"); if (!a) return;
    const target = a.dataset.artifact ?? a.getAttribute("href") ?? "";
    const action = a.dataset.artifact ? "artifact" : artifactLinkAction(target);
    if (e.type === "contextmenu" && action !== "artifact") return;
    e.preventDefault();
    if (action === "artifact") onOpen(target);
    else if (action === "external") ade.openExternal(target);
  };
  return <div ref={el} className="md prose" onClick={onClick} onContextMenu={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}

// files from a drop or paste: real paths when Finder gives them, otherwise read the bytes and stage them
export async function filesFromTransfer(dt: DataTransfer): Promise<string[]> {
  const out: string[] = [];
  const files = [...dt.files];
  const paths = ade.pathsFor(files);
  for (let i = 0; i < files.length; i++) {
    if (paths[i]) { out.push(paths[i]); continue; }
    const f = files[i];
    const name = f.name || `pasted-${Date.now()}.${(f.type.split("/")[1] || "png").replace("jpeg", "jpg")}`;
    out.push(await ade.stageBlob(name, await f.arrayBuffer()));
  }
  if (!out.length) for (const it of [...dt.items]) if (it.kind === "file") { const f = it.getAsFile(); if (f) out.push(await ade.stageBlob(f.name || `pasted-${Date.now()}.png`, await f.arrayBuffer())); }
  return out;
}

/* attachments: the staged file is read once per path and kept for the life of the window */
const previews = new Map<string, Promise<string>>();
function attachmentPreview(worktreeId: string, path: string) {
  const key = `${worktreeId}\u0000${path}`;
  let pending = previews.get(key);
  if (!pending) {
    pending = ade.previewArtifact(worktreeId, path).then((p) => p.kind === "image" ? p.content : Promise.reject(new Error("not an image")));
    pending.catch(() => previews.delete(key)); // a file that is still being written can succeed on the next look
    previews.set(key, pending);
  }
  return pending;
}

function useAttachmentPreview(worktreeId: string | undefined, path: string) {
  const [state, setState] = useState<{ src?: string; failed?: boolean }>({});
  useEffect(() => {
    if (!worktreeId) return setState({ failed: true });
    let live = true;
    setState({});
    attachmentPreview(worktreeId, path).then((src) => { if (live) setState({ src }); }, () => { if (live) setState({ failed: true }); });
    return () => { live = false; };
  }, [worktreeId, path]);
  return state;
}

function AttachmentChip({ path, onRemove }: { path: string; onRemove?: () => void }) {
  return <span className="chip">📎 {attachmentName(path)}{onRemove && <button title="Remove" aria-label={`Remove ${attachmentName(path)}`} onClick={onRemove}>×</button>}</span>;
}

function Thumb({ worktreeId, path, onOpen, onRemove }: { worktreeId?: string; path: string; onOpen: () => void; onRemove?: () => void }) {
  const { src, failed } = useAttachmentPreview(worktreeId, path);
  if (failed) return <AttachmentChip path={path} onRemove={onRemove} />;
  return (
    <span className="thumb">
      <button className="thumb-open" title={`${attachmentName(path)} — click to enlarge`} onClick={(e) => { e.stopPropagation(); onOpen(); }}>
        {src ? <img src={src} alt={attachmentName(path)} /> : <span className="thumb-loading" aria-label={`Loading ${attachmentName(path)}`} />}
      </button>
      {onRemove && <button className="thumb-remove" title="Remove" aria-label={`Remove ${attachmentName(path)}`} onClick={(e) => { e.stopPropagation(); onRemove(); }}>×</button>}
    </span>
  );
}

function Lightbox({ worktreeId, path, onClose }: { worktreeId?: string; path: string; onClose: () => void }) {
  const { src, failed } = useAttachmentPreview(worktreeId, path);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={attachmentName(path)} onClick={onClose}>
      <div className="lightbox-bar"><span className="mono">{attachmentName(path)}</span><button className="icon" aria-label="Close" onClick={onClose}>×</button></div>
      {failed ? <div className="card">This file can no longer be previewed.</div>
        : src ? <img src={src} alt={attachmentName(path)} onClick={(e) => e.stopPropagation()} />
        : <div className="m">loading…</div>}
    </div>
  );
}

export function Attachments({ worktreeId, paths, onRemove }: { worktreeId?: string; paths: string[]; onRemove?: (path: string) => void }) {
  const [zoom, setZoom] = useState<string>();
  if (!paths.length) return null;
  return (
    <div className="attachments">
      {paths.map((path) => isImageAttachment(path)
        ? <Thumb key={path} worktreeId={worktreeId} path={path} onOpen={() => setZoom(path)} onRemove={onRemove && (() => onRemove(path))} />
        : <AttachmentChip key={path} path={path} onRemove={onRemove && (() => onRemove(path))} />)}
      {zoom !== undefined && <Lightbox worktreeId={worktreeId} path={zoom} onClose={() => setZoom(undefined)} />}
    </div>
  );
}

function UserBubble({ text, attachments, worktreeId }: { text: string; attachments?: string[]; worktreeId?: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 700 || text.split("\n").length > 8;
  return (
    <div className={"msg user" + (long && !open ? " clipped" : "")}>
      <div className="utext">{text}</div>
      {!!attachments?.length && <Attachments worktreeId={worktreeId} paths={attachments} />}
      {long && <button className="more" onClick={() => setOpen((o) => !o)}>{open ? "Show less" : "Show more"}</button>}
    </div>
  );
}

/** a tool call's input as it reads, not as it was sent: the command bare on top, the other fields as `key: value` lines */
export function toolInputText(input: string): string {
  let j: unknown;
  try { j = JSON.parse(input); } catch { return input; }
  if (!j || typeof j !== "object" || Array.isArray(j)) return input;
  const fields = Object.entries(j as Record<string, unknown>);
  const lead = fields.find(([k]) => k === "command" || k === "content" || k === "prompt");
  const rest = fields.filter((f) => f !== lead).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  const head = lead ? (typeof lead[1] === "string" ? lead[1] : JSON.stringify(lead[1], null, 2)) : "";
  return [head, ...rest].filter(Boolean).join("\n");
}

/** a run of quiet tool calls as one line; click for the rows, click again to fold them */
function ToolFold({ tools, onOpen, live }: { tools: ToolBlock[]; onOpen: (p: string) => void; live: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={"toolfold" + (open ? " open" : "")}>
      <button type="button" className="trhead" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="chev">{open ? "▾" : "▸"}</span>
        <span className="hint">{foldLabel(tools)}</span>
      </button>
      {open && <div className="foldbody">{tools.map((b) => <ToolRow key={b.id} b={b} onOpen={onOpen} live={live} />)}</div>}
    </div>
  );
}

function ToolRow({ b, onOpen, live }: { b: Extract<Block, { type: "tool" }>; onOpen: (p: string) => void; live: boolean }) {
  const [open, setOpen] = useState(false);
  let hint = b.input.split("\n")[0].slice(0, 110);
  try { const j = JSON.parse(b.input); hint = j.command ?? j.file_path ?? j.path ?? j.pattern ?? j.query ?? j.url ?? j.description ?? Object.values(j).find((v) => typeof v === "string") ?? hint; } catch {}
  return (
    <div className={"toolrow" + (open ? " open" : "")}>
      <div className="trhead" onClick={() => setOpen((o) => !o)}>
        <span className="chev">{open ? "▾" : "▸"}</span>
        <b>{b.name}</b>
        <span className="hint"><MdLinks text={String(hint)} onOpen={onOpen} /></span>
        {b.ok === true && <span className="status-ok">✓</span>}
        {b.ok === false && <span className="status-err">✗</span>}
        {b.ok === undefined && (live ? <span className="spin" /> : <span className="cut" title="cut off">–</span>)}
      </div>
      {open && <div className="trbody"><pre>{toolInputText(b.input)}</pre>{b.output && <pre className="out">{b.output.slice(0, 6000)}</pre>}</div>}
    </div>
  );
}

function AgentPicker({ chat, keys, models }: { chat: Chat; keys: State["keys"]; models: State["models"] }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [usage, setUsage] = useState<Record<string, ConnectorUsage>>({});
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const key = keys.find((k) => k.id === selected);
  const providerName = (provider: string) => provider === "codex" ? "Codex" : "Claude";
  const close = () => { setOpen(false); setSelected(null); trigger.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) { setOpen(false); setSelected(null); } };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  // plan limits colour the options: main keeps each snapshot for a minute, so opening the picker is cheap
  useEffect(() => {
    if (!open) return;
    let live = true;
    for (const k of keys) ade.connectorUsage(k.id).then((u) => { if (live) setUsage((prev) => ({ ...prev, [k.id]: u })); }, () => {});
    return () => { live = false; };
  }, [open, keys.map((k) => k.id).join("|")]);
  const optionClass = (level: "ok" | "partial" | "blocked" | undefined) => "agent-picker-option" + (level && level !== "ok" ? ` ${level}` : "");
  useEffect(() => {
    if (open) root.current?.querySelector<HTMLButtonElement>(".agent-picker-popover button")?.focus();
  }, [open, selected]);
  const chooseModel = async (model: string) => {
    if (!key || !model.trim()) return;
    if (key.provider !== chat.provider && !confirm(`Hand this conversation to ${providerName(key.provider)} (${key.name})? The current run stops and the new agent gets a transcript to pick up from.`)) return;
    setBusy(true);
    try { await ade.switchAgent(chat.id, key.id, model.trim()); close(); }
    catch (error) { alert((error as Error).message); }
    finally { setBusy(false); }
  };
  return <div className="agent-picker" ref={root} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); close(); } }}>
    <button ref={trigger} className="agent-picker-trigger" aria-expanded={open} aria-haspopup="dialog" title="Choose AI and model" onClick={() => { setSelected(null); setOpen(!open); }}>
      <span>{keys.find((key) => key.id === chat.keyId)?.name ?? providerName(chat.provider)} · {chat.model}</span><svg className="agent-picker-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3 4.5 3 3 3-3" /></svg>
    </button>
    {open && <div className="agent-picker-popover" role="dialog" aria-label={key ? "Choose model" : "Choose AI"} aria-busy={busy}>
      <div className="agent-picker-heading">{key ? <button disabled={busy} onClick={() => setSelected(null)}>← Choose AI</button> : <strong>Choose AI</strong>}<button aria-label="Close AI picker" onClick={close}>×</button></div>
      {key ? <>
        <div className="agent-picker-caption">{providerName(key.provider)} · {key.name}</div>
        {[...new Set([...(key.provider === chat.provider ? [chat.model] : []), ...modelOptions({ models }, key.provider)])].map((model) => {
          const block = modelBlock(usage[key.id], model);
          return <button className={optionClass(block ? "blocked" : "ok")} key={model} disabled={busy} title={block} onClick={() => chooseModel(model)} aria-pressed={key.id === chat.keyId && model === chat.model}>{model}</button>;
        })}
        <button className="agent-picker-option" disabled={busy} onClick={() => { const model = prompt("Model ID", key.provider === chat.provider ? chat.model : ""); if (model) chooseModel(model); }}>Other model…</button>
      </> : <>
        {(["codex", "claude"] as const).map((provider) => <React.Fragment key={provider}>
          <div className="agent-picker-caption">{providerName(provider)}</div>
          {keys.filter((k) => k.provider === provider).map((k) => {
            const access = connectorAccess(usage[k.id], modelOptions({ models }, provider));
            return <button className={optionClass(access.level)} key={k.id} title={access.reason} onClick={() => setSelected(k.id)} aria-pressed={k.id === chat.keyId}><span>{k.name}</span><span aria-hidden="true">›</span></button>;
          })}
          {!keys.some((k) => k.provider === provider) && <div className="agent-picker-caption">Add a connection in Settings</div>}
        </React.Fragment>)}
      </>}
    </div>}
  </div>;
}

/* The foot of a review chat: the finished file, or the fact that none was saved and a way to get it. */
function ReviewFooter({ chat, review, onOpen }: { chat: Chat; review: ReviewFile | null; onOpen: () => void }) {
  const pr = prNumberOf(chat.name);
  if (review) {
    const s = review.summary;
    const parts = [`${s.total} finding${s.total === 1 ? "" : "s"}`];
    if (s.pending) parts.push(`${s.pending} to decide`);
    if (s.queued) parts.push(`${s.queued} queued`);
    if (s.commented) parts.push(`${s.commented} on the PR`);
    if (s.fixing) parts.push(`${s.fixing} fixing locally`);
    if (s.submitted) parts.push(`${s.submitted} review${s.submitted === 1 ? "" : "s"} submitted`);
    return (
      <div className="review-ready">
        <Ico n="laurel" className="big" />
        <div className="grow"><b>Review ready · PR #{s.pr}</b><small>{parts.join(" · ")}</small></div>
        <button className="primary" onClick={onOpen}>Open review</button>
      </div>
    );
  }
  // the run is over and left no file: the transcript may hold a verdict, but nothing Consort can act on
  const ran = chat.messages.some((m) => m.blocks.some((b) => b.type === "tool"));
  if (chat.running || chat.phase === "waiting" || chat.interrupted || chat.error || !ran) return null;
  const file = `.consort/pr-review/pr-${pr ?? "<number>"}.review.json`;
  // the run lost the skill's tail when it was resumed; send the schema and link rule back with the request
  const ask = () => {
    const sections = reviewDeliverable(firstPrompt(chat));
    const text = `The review file was not saved. Write \`${file}\` now from the findings you already verified in this chat and the brief and agent reports under .consort/pr-review (do not re-review), then end with the link \`[PR ${pr ?? "<number>"} review](<absolute path to the file>)\`.${sections ? `\n\nThe skill's rules for the file and the link, again:\n\n${sections}` : ""}`;
    ade.send(chat.id, text).catch((e) => alert(e.message));
  };
  return (
    <div className="review-ready missing">
      <Ico n="laurel" className="big" />
      <div className="grow"><b>No review file was saved</b><small>A review ends in a file Consort can act on. This run stopped before writing one.</small></div>
      <button onClick={ask}>Write the review file</button>
    </div>
  );
}

/* Where the work actually is: a review's known phases, or the steps the agent laid out itself. */
/** the plan card on the left, or, with `side="right"`, the feature checklist the task belongs to */
function ProgressPanel({ title, stages, icon = "laurel", side }: { title: string; stages: Stage[]; icon?: string; side?: "right" }) {
  const finished = stages.filter((s) => s.state === "done").length;
  const mark = (state: Stage["state"]) => state === "done" ? "✓" : state === "active" ? <span className="spin" /> : state === "skipped" ? "–" : "·";
  return (
    <div className={"review-progress" + (side === "right" ? " right" : "")}>
      <div className="rp-card">
        <div className="rp-head" title={title}><Ico n={icon} /><span className="rp-title">{title}</span><span className="rp-count">{finished}/{stages.length}</span></div>
        {stages.map((s) => (
          <div key={s.id} className={`rp-stage ${s.state}`} title={s.state === "skipped" ? `${s.label} — not run` : undefined}>
            <span className="rp-mark" aria-hidden="true">{mark(s.state)}</span>
            <span className="rp-label">
              {s.label}
              {s.detail && <small>{s.detail}</small>}
              {s.total ? <span className="rp-bar" role="img" aria-label={s.detail}><i style={{ width: `${Math.round(100 * Math.min(1, (s.done ?? 0) / s.total))}%` }} /></span> : null}
              {s.subtasks?.length ? <span className="rp-subs">{s.subtasks.map((t, i) => (
                <span key={i} className={`rp-sub ${t.state}`} title={t.label}><span className="rp-mark" aria-hidden="true">{mark(t.state)}</span>{t.label}</span>
              ))}</span> : null}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* A second, read-only agent you can ask about a long job while it runs. */
function SideChatPane({ chat }: { chat: Chat }) {
  const [text, setText] = useState("");
  const bottom = useRef<HTMLDivElement>(null);
  const messages = chat.sideMessages ?? [];
  useEffect(() => { bottom.current?.scrollIntoView({ block: "end" }); }, [messages.length, chat.sideBusy]);
  const ask = () => {
    const question = text.trim();
    if (!question || chat.sideBusy) return;
    setText("");
    ade.askSide(chat.id, question).catch((e) => alert(e.message));
  };
  return (
    <div className="sidechat card">
      <div className="sidechat-head">
        <span><Ico n="candle" />Side chat · read-only</span>
        <span className="grow" />
        {messages.length > 0 && <button className="icon" title="Clear these questions" onClick={() => ade.clearSide(chat.id).catch(() => {})}>clear</button>}
      </div>
      <div className="sidechat-log">
        {!messages.length && <div className="m">Ask about this job while it works — “how far along is this?”, “what is it doing now?”, “has anything failed?”. It reads the transcript, the notes and the files the job has written, and can’t change anything or interrupt it.</div>}
        {messages.map((m) => <div key={m.id} className={`sidechat-msg ${m.role}`}>{m.text}</div>)}
        {chat.sideBusy && <div className="sidechat-msg assistant busy"><span className="spin" />reading the job…</div>}
        <div ref={bottom} />
      </div>
      <div className="sidechat-input">
        <textarea rows={1} value={text} placeholder="Ask about this job…" autoFocus disabled={chat.sideBusy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); ask(); } }} />
        <button className="icon enter" title="Ask (↩)" disabled={!text.trim() || chat.sideBusy} onClick={ask}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5" /><path d="M6 11l6-6 6 6" /></svg>
        </button>
      </div>
    </div>
  );
}

// what the two composer switches do, on the label's help cursor
const AUTOPILOT_HELP = "Lets this chat see your screen and click, type and switch between visible macOS apps to finish a task in another app. The Jev navigator drives it through your OpenRouter key. Off by default; turn it on for one task and off again after.";
const AUTO_APPROVE_HELP = "Runs every tool call without asking: shell commands, file edits, git, installs. Off by default, so the chat asks before each action that needs permission. Turn on for long unattended work you trust.";

function ChatPane({ chat, worktree, chats, onOpenChat, keys, models, pool, showTools, perms, ptys, answer, reviewFile, onOpenReview, onOpenMd, openRouterConfigured }: { chat: Chat; worktree?: Worktree; chats: Chat[]; onOpenChat: (id: string) => void; keys: State["keys"]; models: State["models"]; pool?: State["seatPool"]; showTools: boolean; perms: PermissionRequest[]; ptys: PtyState[]; answer: (id: string, ok: boolean) => void; reviewFile: ReviewFile | null; onOpenReview: () => void; onOpenMd: (p: string) => void; openRouterConfigured?: boolean }) {
  // the chat's own terminal is on screen whenever the chat is, so a finished command there is seen at once
  const composerDone = !!worktree && !!ptys.find((p) => p.id === `${worktree.id}:composer-${chat.id}`)?.done;
  // a Claude chat can hop seats: on the pool to the best other seat, off it onto the pool
  const chatKey = keys.find((k) => k.id === chat.keyId);
  const canSeat = chat.provider === "claude" && keys.some((k) => k.pool);
  const [errorDetails, setErrorDetails] = useState<string>();
  const [copyStatus, setCopyStatus] = useState("");
  useEffect(() => { setErrorDetails(undefined); setCopyStatus(""); }, [chat.id]);
  useEffect(() => {
    if (errorDetails === undefined) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setErrorDetails(undefined); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [errorDetails]);
  const [codeModes, setCodeModes] = useState<Record<string, boolean>>({});
  const code = !!worktree && !!codeModes[chat.id];
  // the composer shows one of three things: the message box, the worktree terminal, or the side chat
  const [sideModes, setSideModes] = useState<Record<string, boolean>>({});
  const side = !!worktree && !!sideModes[chat.id];
  const setMode = (mode: "chat" | "code" | "side") => {
    setCommit(null);
    setCodeModes((modes) => ({ ...modes, [chat.id]: mode === "code" }));
    setSideModes((modes) => ({ ...modes, [chat.id]: mode === "side" }));
    if (mode === "chat") requestAnimationFrame(() => box.current?.focus());
  };
  const draft = useSyncExternalStore(chatDrafts.subscribe, () => chatDrafts.get(chat.id));
  const files = draft.files;
  const setFiles = (update: (files: string[]) => string[]) => chatDrafts.update(chat.id, { files: update(chatDrafts.get(chat.id).files) });
  const [commitText, setCommitText] = useState("");
  const [over, setOver] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  // Scrolling follows new content only while you are at the bottom. Once you scroll up to read,
  // the view stays put and a pulse at the foot of the pane says more has arrived; clicking it,
  // or sending a message of your own, goes back to following.
  const messagesEl = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const seenContent = useRef<string | null>(null);
  const [unseen, setUnseen] = useState(false);
  const nearBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  const onMessagesScroll = () => { const el = messagesEl.current; if (!el) return; pinned.current = nearBottom(el); if (pinned.current) setUnseen(false); };
  const jump = () => { pinned.current = true; setUnseen(false); bottom.current?.scrollIntoView({ block: "end" }); };
  // A pane starts clean for the chat it is showing.  In particular, an update to another chat
  // must never leave its "new below" indicator on the newly selected one.
  const visibleContent = `${chat.id}:${chat.messages.map((m) => `${m.id}:${m.blocks.map((b) => b.type === "text" ? b.text.length : b.type).join(",")}`).join("|")}:${perms.map((p) => p.id).join(",")}`;
  useEffect(() => { pinned.current = true; seenContent.current = null; setUnseen(false); }, [chat.id]);
  useEffect(() => {
    if (seenContent.current === null) {
      seenContent.current = visibleContent;
      bottom.current?.scrollIntoView({ block: "end" });
      return;
    }
    if (seenContent.current === visibleContent) return;
    seenContent.current = visibleContent;
    if (pinned.current) bottom.current?.scrollIntoView({ block: "end" }); else setUnseen(true);
  }, [visibleContent]);
  // Commit shortcut: the composer becomes a commit-message box with a 5s fuse. Typing defuses it; silence lets the AI write the message.
  const [commit, setCommit] = useState<{ count: number; typed: boolean } | null>(null);
  const text = commit ? commitText : draft.text;
  const setText = (value: string) => { if (commit) setCommitText(value); else chatDrafts.update(chat.id, { text: value }); };
  // The command popup: open while the box holds a lone /word. The list is the seat's own (read once per seat + worktree
  // in main); ↑/↓ move, Tab/↩ complete the highlight, Esc closes until the text changes, ↩ with no highlight sends as ever.
  const [cmds, setCmds] = useState<SlashEntry[]>([]);
  const [cmdIdx, setCmdIdx] = useState(-1);
  const [cmdClosed, setCmdClosed] = useState(false);
  const cmdQuery = commit ? undefined : commandQuery(text);
  const popup = cmdQuery !== undefined && !cmdClosed;
  useEffect(() => {
    if (!popup) return;
    let live = true;
    ade.listCommands(chat.id).then((list) => { if (live) setCmds(list); }, () => {});
    return () => { live = false; };
  }, [popup, chat.id]);
  const cmdMatches = popup ? filterCommands(cmds, cmdQuery) : [];
  const completeCmd = (entry: SlashEntry) => { setText(completeCommand(entry)); setCmdIdx(-1); requestAnimationFrame(() => { box.current?.focus(); resizeComposer(box.current); }); };
  // The box grows with what you type, up to ten lines (or a third of a short window), then scrolls.
  // This sets the actual height; the CSS max-height is the fallback for the same ceiling.
  const resizeComposer = (input: HTMLTextAreaElement | null) => {
    if (!input) return;
    const cs = getComputedStyle(input);
    const line = parseFloat(cs.lineHeight) || 22;
    const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const max = Math.min(Math.round(line * 10 + pad), Math.max(line * 3 + pad, Math.floor(window.innerHeight / 3)));
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, max)}px`;
    input.style.overflowY = input.scrollHeight > max ? "auto" : "hidden";
  };
  // This must be a layout effect: a normal effect can measure the one-line DOM just before
  // React commits the controlled value that wrapped onto line two.
  useLayoutEffect(() => {
    resizeComposer(box.current);
  }, [text]);
  useEffect(() => {
    const onResize = () => resizeComposer(box.current);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const armCommit = () => { if (chat.running || commit) return; setCommitText(""); setCommit({ count: 5, typed: false }); requestAnimationFrame(() => box.current?.focus()); };
  const fireCommit = (message?: string) => {
    setCommit(null); setCommitText("");
    // failures are narrated into the transcript by main, so nothing to surface here
    ade.commitChat(chat.id, message).catch(() => {});
  };
  useEffect(() => {
    if (!commit || commit.typed) return;
    if (commit.count <= 0) { fireCommit(); return; }
    const t = setTimeout(() => setCommit((c) => c && !c.typed ? { ...c, count: c.count - 1 } : c), 1000);
    return () => clearTimeout(t);
  }, [commit]);
  useEffect(() => { if (commit && chat.running) setCommit(null); }, [chat.running]);
  // a /ship Next chip: fresh provider session (as /clear), then the command in the same chat
  const shipNext = React.useCallback((command: string) => ade.clearChat(chat.id).then(() => ade.shipCommand(chat.id, command)).then((id) => { if (id !== chat.id) onOpenChat(id); }).catch((e) => alert(e.message)), [chat.id, onOpenChat]);
  const send = () => {
    if (commit) { if (text.trim() || !commit.typed) fireCommit(text.trim() || undefined); return; }
    if (!text.trim() && !files.length) return;
    setNav(null);
    // /clear is Consort's, not the model's: the session is dropped here and the transcript stays. A clear means clear, attachments included
    if (isClearCommand(text)) { ade.clearChat(chat.id).then(() => { setText(""); setFiles(() => []); }, (e) => alert(e.message)); return; }
    // /ship runs the pipeline: in this chat when it is idle and this worktree ships a feature, else in the chat it opens
    if (isShipCommand(text)) { ade.shipCommand(chat.id, text.trim(), files).then((id) => { setText(""); setFiles(() => []); if (id !== chat.id) onOpenChat(id); }, (e) => alert(e.message)); return; }
    chatDrafts.submit(chat.id, (draft) => ade.send(chat.id, draft.text.trim() || "See attached files.", draft.files)).catch((e) => alert(e.message));
    jump();
  };
  const placeholder = commit
    ? commit.typed ? "commit message · ↩ to commit and push · esc to cancel" : `start typing commit or ai will decide ${commit.count}…`
    : chat.running ? "Working… (you can queue a message)" : "Reply…";
  const addFiles = (paths: string[]) => setFiles((f) => [...new Set([...f, ...paths])]);
  const onDrop = async (e: React.DragEvent) => { e.preventDefault(); setOver(false); addFiles(await filesFromTransfer(e.dataTransfer)); };
  const onPaste = async (e: React.ClipboardEvent) => { if ([...e.clipboardData.items].some((i) => i.kind === "file")) { e.preventDefault(); addFiles(await filesFromTransfer(e.clipboardData)); } };
  // ↑/↓ in the box walk the prompts already sent, as a shell walks its history
  const history = React.useMemo(() => promptHistory(chat.messages), [chat.messages]);
  const [nav, setNav] = useState<HistoryNav>(null);
  useEffect(() => { setNav(null); }, [commit]);
  const stepHistory = (input: HTMLTextAreaElement, key: "up" | "down") => {
    if (commit) return false;
    const step = historyStep(key, { nav, value: input.value, caret: input.selectionStart ?? 0, history });
    if (!step.handled) return false;
    if (step.text !== undefined) {
      setNav(step.nav ?? null);
      setText(step.text);
      // the controlled value lands on the next render, so the caret goes to the end after it
      requestAnimationFrame(() => { const el = box.current; if (el) el.setSelectionRange(el.value.length, el.value.length); });
    }
    return true;
  };
  const recall = lastPrompt(chat);
  // the recall chip repeats the last prompt; while that bubble is itself on screen the chip would only cover it
  const [recallHidden, setRecallHidden] = useState(true);
  const lastUserId = [...chat.messages].reverse().find((m) => m.role === "user" && m.blocks.length)?.id;
  useEffect(() => {
    const root = messagesEl.current;
    const bubble = root?.querySelector<HTMLElement>(".msg.user:last-of-type");
    if (!root || !bubble) { setRecallHidden(true); return; }
    const io = new IntersectionObserver(([entry]) => setRecallHidden(!!entry?.isIntersecting), { root, threshold: 0 });
    io.observe(bubble);
    return () => io.disconnect();
  }, [chat.id, lastUserId]);
  // a review follows our own skill, so its stages are known; every other chat shows the plan the agent declared
  const review = reviewProgress(chat);
  const stages = review ?? planStages(chat);
  const feature = featureStages(chat);
  return (
    <div className={"chatpane" + (over ? " over" : "")} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false); }} onDrop={onDrop} onPaste={onPaste}>
      {over && <div className="dropveil">Drop to attach</div>}
      <PhaseStrip phase={chat.phase} steps={chat.phaseSteps} onSelect={(phase) => ade.setPhase(chat.id, phase)} />
      {worktree?.ship && <ShipBar wt={worktree} chats={chats} compact onOpenChat={onOpenChat} />}
      <div className="messages" ref={messagesEl} onScroll={onMessagesScroll}>
        {stages && <ProgressPanel title={review ? "Review" : "Plan"} stages={stages} />}
        {feature && chat.feature && <ProgressPanel title={chat.feature.title} icon="wreath" side="right" stages={feature} />}
        {recall && !recallHidden && <div className="chat-recall"><span title={recall}>{recall}</span></div>}
        <div className="column">
        {chat.messages.filter((m) => m.blocks.length).map((m, i, all) =>
          m.role === "user" ? <UserBubble key={m.id} text={m.blocks.map((b) => (b.type === "text" ? b.text : "")).join("\n")} attachments={m.attachments} worktreeId={worktree?.id} /> :
          m.role === "system" && m.kind === "clear" ? <div key={m.id} className="msg system clear-divider" role="separator"><span>{m.blocks.map((b) => (b.type === "text" ? b.text : "")).join(" ")}</span><time dateTime={new Date(m.ts).toISOString()}>{new Date(m.ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time></div> :
          m.role === "system" ? <div key={m.id} className="msg system">{m.blocks.map((b) => (b.type === "text" ? b.text : "")).join(" ")}</div> : (
          <AssistantMessage key={m.id} blocks={m.blocks} onOpen={onOpenMd} worktreeId={worktree?.id} live={chat.running} showTools={showTools}
            onFollowup={(prompt) => ade.send(chat.id, prompt).catch((e) => alert(e.message))}
            onShipNext={chat.ship && i === all.length - 1 ? shipNext : undefined} />
        ))}
        {perms.map((p) => (
          <div key={p.id} className="perm">
            <b><Ico n="celtic" className="big" />Allow {p.tool}?</b>
            <pre>{JSON.stringify(p.input, null, 2)}</pre>
            <button className="primary" onClick={() => answer(p.id, true)}>Allow</button> <button onClick={() => answer(p.id, false)}>Deny</button>
          </div>
        ))}
        {isReviewChat(chat) && <ReviewFooter chat={chat} review={reviewFile} onOpen={onOpenReview} />}
        <div ref={bottom} />
        </div>
      </div>
      {/* the seam between messages and composer: a pulse here means more arrived below where you are reading */}
      <button type="button" className={"new-below" + (unseen ? " on" : "")} aria-hidden={!unseen} tabIndex={unseen ? 0 : -1} title="New messages below — click to scroll down" onClick={jump} />
      {!chat.running && (chat.interrupted || chat.error) && (
        <div className="resume">
          {chat.error ? <button className="resume-error" title="View full error details" onClick={() => { setErrorDetails(chat.error); setCopyStatus(""); }}>
            <span>Last run failed: <span className="err">{chat.error}</span></span><span className="error-details-link">View details</span>
          </button> : <span>This chat was interrupted when the app closed.</span>}
          <button className="primary" onClick={() => ade.continueChat(chat.id).catch((e) => alert(e.message))}>Continue where it left off</button>
          {canSeat && <button title="Resume this same session on the seat with the most headroom" onClick={() => ade.switchSeat(chat.id).catch((e) => alert(e.message))}>{chatKey?.pool ? "Switch seat & continue" : "Move to seat pool & continue"}</button>}
        </div>
      )}
      {errorDetails !== undefined && <Dialog title="Run error details" onClose={() => setErrorDetails(undefined)} footer={<>
        <span role="status">{copyStatus}</span>
        <button onClick={async () => {
          try { await navigator.clipboard.writeText(errorDetails); setCopyStatus("Copied"); }
          catch { setCopyStatus("Could not copy. Select and copy the text below."); }
        }}>Copy error</button>
        <button className="primary" onClick={() => setErrorDetails(undefined)}>Close</button>
      </>}>
        <pre className="run-error-details" tabIndex={0} aria-label="Full error details">{errorDetails}</pre>
      </Dialog>}
      {files.length > 0 && (
        <div className="chips"><Attachments worktreeId={worktree?.id} paths={files} onRemove={(f) => setFiles((x) => x.filter((y) => y !== f))} /></div>
      )}
      <div className="composer-wrap">
        {!!chat.queuedMessages?.length && <div className="message-queue" aria-label="Queued messages">
          <div className="queue-heading"><span>{chat.queuedMessages.length} queued{chat.queuePaused ? " · paused" : " · runs after the current task"}</span>
            {!chat.running && <button onClick={() => ade.resumeQueue(chat.id).catch((e) => alert(e.message))}>Resume queue</button>}
          </div>
          {chat.queuedMessages.map((message, index) => <div className="queued-message" key={message.id}>
            <span>{index + 1}. {message.text}</span>
            <button title="Remove queued message" aria-label={`Remove queued message ${index + 1}`} onClick={() => ade.removeQueuedMessage(chat.id, message.id).catch((e) => alert(e.message))}>×</button>
            <Attachments worktreeId={worktree?.id} paths={message.files} />
          </div>)}
        </div>}
        <div className="composer-options">
          <span className="left">
            {!isScratch(worktree) && <button className={"commitbtn" + (commit ? " armed" : "")} title="Stage everything, commit, and push. Type a message or let the AI write one." disabled={code || chat.running || !!commit} onClick={armCommit}><Ico n="wheat" />{commit && !commit.typed ? `commit ${commit.count}` : "commit"}</button>}
            <button className="commitbtn" disabled={!worktree} aria-pressed={code} title={code ? "Return to AI chat" : "Run commands in this worktree"} onClick={() => setMode(code ? "chat" : "code")}><Ico n={code ? "quill" : "terminal"} />{code ? "CHAT" : "TERMINAL"}</button>
            <button className="commitbtn" disabled={!worktree} aria-pressed={side} title={side ? "Return to AI chat" : "Ask a read-only agent about this job — it won't interrupt the work"} onClick={() => setMode(side ? "chat" : "side")}><Ico n={side ? "quill" : "candle"} />{side ? "CHAT" : "SIDECHAT"}</button>
            {chat.running && <button className="commitbtn stopbtn" title="Stop this chat" onClick={() => ade.stop(chat.id)}><span className="stop-square" aria-hidden="true" />Stop</button>}
            {chatStatus(chat) === "running" && <div className="composer-working" role="status"><span className="working-circle" aria-hidden="true" />Working…</div>}
          </span>
          {openRouterConfigured && <label><input type="checkbox" checked={!!chat.autopilot} onChange={(e) => ade.setAutopilot(chat.id, e.target.checked).catch((e) => alert(e.message))} /> <span className="help" title={AUTOPILOT_HELP}>Autopilot</span></label>}
          <label title={chat.showToolCalls === undefined ? "Following the global setting (Settings › Appearance)" : "This chat's own choice; it overrides the global setting"}><input type="checkbox" checked={showTools} onChange={(e) => ade.setChatToolCalls(chat.id, e.target.checked).catch((e) => alert(e.message))} /> Tool calls</label>
          <label><input type="checkbox" checked={chat.autoApprove} onChange={(e) => ade.setAutoApprove(chat.id, e.target.checked).catch((e) => alert(e.message))} /> <span className="help" title={AUTO_APPROVE_HELP}>Auto-approve</span></label>
        </div>
        {side && worktree && <SideChatPane chat={chat} />}
        {code && worktree && <div className="composer-terminal card">
          <XTermPane key={chat.id} scope={{ id: worktree.id, cwd: worktree.path, title: worktree.title }} termId={`composer-${chat.id}`} active failed={false} done={composerDone} />
        </div>}
        <div style={code || side ? { display: "none" } : undefined} className={"composer card" + (over ? " over" : "") + (commit ? " committing" : "")}>
          {popup && cmdMatches.length > 0 && <div className="cmd-popup" role="listbox" aria-label="Commands">
            {cmdMatches.map((c, i) => <div key={c.name} role="option" aria-selected={i === cmdIdx} className={"cmd-row" + (i === cmdIdx ? " on" : "")}
              onMouseEnter={() => setCmdIdx(i)} onMouseDown={(e) => { e.preventDefault(); completeCmd(c); }}>
              <span className="cmd-name">/{c.name}{c.argumentHint && <span className="cmd-hint"> {c.argumentHint}</span>}</span>
              <span className="cmd-desc">{c.description}</span>
            </div>)}
          </div>}
          <textarea ref={box} value={text} rows={1} onChange={(e) => {
            const input = e.currentTarget;
            setText(input.value);
            setNav(null); // typing leaves history: the next ↑ starts again at the newest prompt
            setCmdClosed(false); setCmdIdx(-1);
            if (commit && !commit.typed && input.value) setCommit({ ...commit, typed: true });
            // The native input event fires before the controlled value has been committed.
            requestAnimationFrame(() => resizeComposer(input));
          }} placeholder={placeholder}
            onKeyDown={(e) => {
              if (e.key === "Escape" && commit) { e.preventDefault(); setCommit(null); setCommitText(""); return; }
              if (popup && cmdMatches.length) {
                if (e.key === "ArrowDown") { e.preventDefault(); setCmdIdx((i) => (i + 1) % cmdMatches.length); return; }
                if (e.key === "ArrowUp") { e.preventDefault(); setCmdIdx((i) => (i <= 0 ? cmdMatches.length : i) - 1); return; }
                if (e.key === "Tab") { e.preventDefault(); completeCmd(cmdMatches[Math.max(cmdIdx, 0)]); return; }
                if (e.key === "Enter" && cmdIdx >= 0 && !e.nativeEvent.isComposing) { e.preventDefault(); completeCmd(cmdMatches[cmdIdx]); return; }
                if (e.key === "Escape") { e.preventDefault(); setCmdClosed(true); return; }
              }
              if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey && !e.metaKey && !e.altKey && !e.nativeEvent.isComposing) {
                if (stepHistory(e.currentTarget, e.key === "ArrowUp" ? "up" : "down")) { e.preventDefault(); return; }
              }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
            }} />
          <div className="cbar">
            <button className="icon attach" title="Attach files" onClick={async () => addFiles(await ade.pickFiles())}>
              <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.5l-8.6 8.6a5 5 0 0 1-7-7l9.2-9.2a3.3 3.3 0 0 1 4.7 4.7L10 18.9a1.6 1.6 0 0 1-2.3-2.3l8.5-8.5" /></svg>
            </button>
            <AgentPicker key={chat.id} chat={chat} keys={keys} models={models} />
            <SeatPicker chat={chat} keys={keys} pool={pool} />
            <span className="grow" />
            <span className="m hint">{commit ? "↩ commit + push · esc cancel" : `${chat.running ? "↩ queue" : "↩ send"} · ⇧↩ newline${!text && history.length ? " · ↑ history" : ""}`}</span>
            <button className="icon enter" title={commit ? "Commit and push (↩)" : chat.running ? "Queue message (↩)" : "Send (↩)"} disabled={commit ? (commit.typed && !text.trim()) : (!text.trim() && !files.length)} onClick={send}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5" /><path d="M6 11l6-6 6 6" /></svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Keeps a scrolling element's offset across unmounts. The remembered offset is applied as soon as
 * the content is tall enough (previews and files load after mount, so it retries on growth) and is
 * abandoned the moment the user scrolls on their own. `deps` should change when content renders.
 */
function useScrollMemory(key: string, ref: React.RefObject<HTMLElement | null>, deps: unknown[]) {
  const pending = useRef<number | undefined>(undefined);
  const attempt = () => {
    const el = ref.current, target = pending.current;
    if (!el || target === undefined) return;
    if (canRestore(target, el.scrollHeight, el.clientHeight)) { el.scrollTop = target; pending.current = undefined; }
  };
  useEffect(() => { pending.current = scrollMemory.get(key); attempt(); }, [key]);
  useEffect(attempt, deps);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => { if (pending.current === undefined) scrollMemory.set(key, el.scrollTop); };
    const cancel = () => { pending.current = undefined; };
    el.addEventListener("scroll", onScroll, { passive: true });
    for (const ev of ["wheel", "pointerdown", "keydown"] as const) el.addEventListener(ev, cancel, { passive: true });
    // content arrives after mount: watch the children grow and retry the restore
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(attempt) : undefined;
    const watch = () => { ro?.disconnect(); for (const c of Array.from(el.children)) ro?.observe(c); attempt(); };
    const mo = typeof MutationObserver === "function" ? new MutationObserver(watch) : undefined;
    mo?.observe(el, { childList: true, subtree: true });
    watch();
    return () => {
      el.removeEventListener("scroll", onScroll);
      for (const ev of ["wheel", "pointerdown", "keydown"] as const) el.removeEventListener(ev, cancel);
      ro?.disconnect(); mo?.disconnect();
    };
  }, [key]);
}

/* ---------- drawer ---------- */

type Scope = { id: string; cwd: string; title: string };
function Drawer({ onOpenChat, tab, state, chat, worktree, scope, ptys, width, file, reviewPath, memoryKey, onEdit, onView, onSignIn, onClose }: { onOpenChat: (id: string) => void; tab: Tab; state: State; chat?: Chat; worktree?: Worktree; scope?: Scope; ptys: PtyState[]; width: number; file?: string; reviewPath?: string; memoryKey: string; onEdit: (p: string) => void; onView: (p: string) => void; onSignIn: (keyId: string) => void; onClose: () => void }) {
  // the body is the scroller for previews, diffs and settings; its place is kept per view + tab + file
  const body = useRef<HTMLDivElement>(null);
  useScrollMemory(scrollKey(memoryKey, tab, file), body, [tab, file]);
  return (
    <div className="drawer" style={{ width }}>
      <div className="dhead">
        <span><Ico n={{ terminal: "terminal", diff: "branch", editor: "pencil", markdown: "scroll", commit: "wheat", artifacts: "scroll", review: "laurel", settings: "gear", ship: "laurel" }[tab]} className="big" /> {tab[0].toUpperCase() + tab.slice(1)}{scope && tab !== "settings" ? ` · ${scope.title}` : ""}</span>
        <button className="icon" onClick={onClose}>×</button>
      </div>
      <div className="dbody" ref={body}>
        {tab === "settings" ? <Settings state={state} onSignIn={onSignIn} />
          : tab === "ship" ? (worktree?.ship ? <ShipPanel key={worktree.id} wt={worktree} chats={state.chats} onOpenChat={onOpenChat} onOpenFile={onView} /> : <div className="card">This worktree is not a /ship feature.</div>)
          : tab === "artifacts" ? (chat ? <ArtifactsView key={chat.id} chat={chat} onOpen={onView} /> : <div className="card">Select a chat to see its artifacts.</div>)
          : tab === "terminal" ? (worktree && scope ? <Terminals key={scope.id} scope={scope} ptys={ptys.filter((p) => p.scopeId === scope.id)} /> : <div className="card">Select Root, a worktree or a chat first.</div>)
          : !worktree ? <div className="card">Select a worktree or chat first.</div>
          : tab === "editor" ? <Editor key={worktree.id + (file ?? "")} worktree={worktree} initial={file} memoryKey={memoryKey} onView={onView} />
          : tab === "markdown" ? <MarkdownView key={worktree.id + (file ?? "")} worktree={worktree} path={file} onEdit={onEdit} onNavigate={onView} />
          : tab === "commit" ? <CommitPane key={worktree.id} worktree={worktree} />
          : tab === "review" ? (reviewPath ? <MarkdownView key={worktree.id + reviewPath} worktree={worktree} path={reviewPath} onEdit={onEdit} onNavigate={onView} /> : <div className="card">No review file for this branch yet.</div>)
          : <Diff key={worktree.id} worktree={worktree} />}
      </div>
    </div>
  );
}

function ArtifactsView({ chat, onOpen }: { chat: Chat; onOpen: (path: string) => void }) {
  const artifacts = React.useMemo(() => chatArtifacts(chat.messages), [chat.messages]);
  const [error, setError] = useState("");
  const open = async (target: string) => {
    setError("");
    try { if (await ade.artifactMenu(chat.worktreeId, target) === "open") onOpen(target); }
    catch (e) { setError((e as Error).message); }
  };
  return <div className="artifacts-list">
    <div className="m">{artifacts.length} linked file{artifacts.length === 1 ? "" : "s"} · {chat.name}</div>
    {error && <div className="error" role="alert">{error}</div>}
    {!artifacts.length ? <div className="card">No artifacts yet. Files linked in assistant responses will appear here.</div>
      : <ul>{artifacts.map(({ label, target, linkedAt, updatedAt }) => <li key={target}>
        <button className="artifact-entry" title={target} onClick={() => open(target)} onContextMenu={(e) => { e.preventDefault(); open(target); }}>
          <Ico n="scroll" />
          <strong>{label}</strong>
          {/* one date, the latest, as a file browser shows "modified"; the tooltip has the history */}
          <time className="artifact-when" dateTime={new Date(updatedAt).toISOString()}
            title={updatedAt > linkedAt ? `Linked ${new Date(linkedAt).toLocaleString()} · updated ${new Date(updatedAt).toLocaleString()}` : `Linked ${new Date(linkedAt).toLocaleString()}`}>
            {artifactWhen(updatedAt, Date.now())}
          </time>
          {label !== target && <small className="artifact-path"><span>{target}</span></small>}
          <span className="artifact-chev" aria-hidden="true">›</span>
        </button>
      </li>)}</ul>}
  </div>;
}

const termLabels = new Map<string, string>();
const termTabs = new Map<string, string[]>(); // scopeId -> terminal ids (session-lived)
let wantTab: string | undefined; // tab to focus when the drawer next opens (e.g. "auth")
const pendingCmd = new Map<string, string>(); // pty id -> command to type once the shell is up
const xterms = new Map<string, { id: string; term: XTerm; fit: FitAddon; el: HTMLDivElement; ready: boolean }>();
const cssVar = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const xtermTheme = () => {
  const light = document.documentElement.dataset.theme === "light";
  const fg = cssVar("--fg"), bg = cssVar("--bg-solid");
  return { background: bg, foreground: fg, cursor: fg, cursorAccent: bg, selectionBackground: light ? "rgba(20,19,17,.22)" : "rgba(243,234,214,.25)",
    black: light ? "#141311" : "#0a0a0a", brightBlack: light ? "#6b665c" : "#6f6a60", white: light ? "#6b665c" : "#d8d0bc", brightWhite: fg,
    red: "#d98a78", brightRed: "#e0a08f", green: "#9fbf8a", brightGreen: "#b8d3a6", yellow: "#d8b56a", brightYellow: "#e3c98d",
    blue: "#8fa8c4", brightBlue: "#a9bed4", magenta: "#c49ab9", brightMagenta: "#d3b2ca", cyan: "#8fbdb5", brightCyan: "#a9cfc8" };
};

function Terminals({ scope, ptys }: { scope: Scope; ptys: PtyState[] }) {
  // A session the main process opened for this scope (a worktree's dependency install) has
  // no tab yet; show it alongside the ones this window created.
  const live = ptys.filter((p) => p.scopeId === scope.id).map((p) => p.termId);
  const [tabs, setTabs] = useState<string[]>(() => [...new Set([...(termTabs.get(scope.id) ?? ["t1"]), ...live])]);
  const [cur, setCur] = useState(() => { const w = wantTab && tabs.includes(wantTab) ? wantTab : tabs[0]; wantTab = undefined; return w; });
  useEffect(() => { termTabs.set(scope.id, tabs); if (!tabs.includes(cur)) setCur(tabs[tabs.length - 1]); }, [tabs]);
  useEffect(() => {
    const extra = live.filter((termId) => !tabs.includes(termId));
    if (extra.length) setTabs((t) => [...t, ...extra]);
  }, [live.join("\u0000")]);
  useEffect(() => {
    const added = (event: Event) => {
      const { scopeId, termId } = (event as CustomEvent).detail;
      if (scopeId !== scope.id) return;
      setTabs(termTabs.get(scope.id) ?? [termId]); setCur(termId); wantTab = undefined;
    };
    window.addEventListener("consort-terminal-added", added);
    return () => window.removeEventListener("consort-terminal-added", added);
  }, [scope.id]);
  const add = () => { const id = "t" + (Date.now() % 100000); setTabs((t) => [...t, id]); setCur(id); };
  const close = (termId: string) => {
    const id = `${scope.id}:${termId}`;
    ade.ptyKill(id); xterms.get(id)?.term.dispose(); xterms.delete(id);
    setTabs((t) => (t.length > 1 ? t.filter((x) => x !== termId) : t));
  };
  return (
    <div className="terms">
      <div className="termtabs">
        {tabs.map((termId, i) => {
          const st = ptys.find((p) => p.termId === termId);
          return (
            <span key={termId} className={"termtab" + (termId === cur ? " on" : "")} onClick={() => setCur(termId)}>
              {st?.running && <span className="live" />}{st?.failed && termId !== cur && <span className="live dead" />}{st?.done && !st.running && termId !== cur && <span className="live done" />}{termLabels.get(`${scope.id}:${termId}`) ?? (termId === "auth" ? "sign-in" : termId === "install" ? "install" : i + 1)}
              {tabs.length > 1 && <button className="icon" title="Close terminal" onClick={(e) => { e.stopPropagation(); close(termId); }}>×</button>}
            </span>
          );
        })}
        <button className="icon" title="New terminal" onClick={add}>＋</button>
        <span className="m ttypath">{scope.cwd}</span>
      </div>
      {tabs.map((termId) => { const st = ptys.find((p) => p.termId === termId); return <XTermPane key={termId} scope={scope} termId={termId} active={termId === cur} failed={!!st?.failed} done={!!st?.done} />; })}
    </div>
  );
}

// ponytail: xterm instances live in a module map so scrollback survives closing the drawer
function XTermPane({ scope, termId, active, failed, done = false }: { scope: Scope; termId: string; active: boolean; failed: boolean; done?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const id = `${scope.id}:${termId}`;
  useEffect(() => {
    let x = xterms.get(id);
    if (!x) {
      const term = new XTerm({ fontFamily: '"JetBrains Mono", Menlo, monospace', fontSize: 12, lineHeight: 1.25, cursorBlink: true, cursorStyle: "bar", scrollback: 5000, theme: xtermTheme(), allowProposedApi: true, macOptionIsMeta: true });
      const fit = new FitAddon();
      term.loadAddon(fit); term.loadAddon(new WebLinksAddon((_e, uri) => ade.openExternal(uri)));
      const el = document.createElement("div"); el.className = "xthost";
      term.open(el);
      term.onData((d) => ade.ptyWrite(id, d));
      x = { id, term, fit, el, ready: false };
      xterms.set(id, x);
    }
    const h = host.current!;
    h.appendChild(x.el);
    const sync = () => { try { x!.fit.fit(); ade.ptyResize(id, x!.term.cols, x!.term.rows); } catch {} };
    const start = async () => {
      sync();
      if (!x!.ready) {
        await ade.ptyCreate(scope.id, termId, scope.cwd, x!.term.cols, x!.term.rows);
        x!.ready = true;
        const c = pendingCmd.get(id);
        if (c) { pendingCmd.delete(id); setTimeout(() => ade.ptyWrite(id, c + "\r"), 700); }
      }
    };
    start();
    const ro = new ResizeObserver(() => active && sync());
    ro.observe(h);
    return () => { ro.disconnect(); if (x!.el.parentElement === h) h.removeChild(x!.el); };
  }, [id]);
  useEffect(() => { if (active) { const x = xterms.get(id); setTimeout(() => { try { x?.fit.fit(); ade.ptyResize(id, x!.term.cols, x!.term.rows); x?.term.focus(); } catch {} }, 30); if (failed || done) ade.ptySeen(id); } }, [active, failed, done]);
  return <div ref={host} className="xtpane" style={{ display: active ? "block" : "none" }} />;
}

type TreeNode = { name: string; path: string; children?: TreeNode[] };
function buildTree(files: string[]): TreeNode[] {
  const root: TreeNode[] = [];
  const nodes = new Map<string, TreeNode>();
  for (const f of files) {
    let level = root, acc = "";
    const parts = f.split("/");
    parts.forEach((part, i) => {
      acc = acc ? `${acc}/${part}` : part;
      let n = nodes.get(acc);
      if (!n) { n = i < parts.length - 1 ? { name: part, path: acc, children: [] } : { name: part, path: acc }; level.push(n); nodes.set(acc, n); }
      level = n.children ?? level;
    });
  }
  const sort = (ns: TreeNode[]) => { ns.sort((a, b) => Number(!!b.children) - Number(!!a.children) || a.name.localeCompare(b.name)); ns.forEach((n) => n.children && sort(n.children)); };
  sort(root);
  return root;
}
function FileTree({ files, current, onOpen }: { files: string[]; current: string; onOpen: (p: string) => void }) {
  const tree = React.useMemo(() => buildTree(files), [files]);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const toggle = (p: string) => setOpen((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; });
  const Row = ({ n, depth }: { n: TreeNode; depth: number }) => (
    <>
      <div className={"trow" + (n.path === current ? " on" : "")} style={{ paddingLeft: 6 + depth * 14 }}
        onClick={() => (n.children ? toggle(n.path) : onOpen(n.path))}>
        <span className="tw">{n.children ? (open.has(n.path) ? "▾" : "▸") : ""}</span>{n.name}
      </div>
      {n.children && open.has(n.path) && n.children.map((c) => <Row key={c.path} n={c} depth={depth + 1} />)}
    </>
  );
  return <div className="tree">{tree.map((n) => <Row key={n.path} n={n} depth={0} />)}</div>;
}

// ponytail: textarea editor; swap in CodeMirror if highlighting becomes a need
function Editor({ worktree, initial, memoryKey, onView }: { worktree: Worktree; initial?: string; memoryKey: string; onView: (p: string) => void }) {
  const [files, setFiles] = useState<string[]>([]);
  const [path, setPath] = useState("");
  const [text, setText] = useState("");
  // the code box is its own scroller (the drawer body stops scrolling around it), so it keeps its own place per file
  const code = useRef<HTMLTextAreaElement>(null);
  useScrollMemory(scrollKey(memoryKey, "code", path), code, [text, path]);
  const [saved, setSaved] = useState("");
  const [q, setQ] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");
  useEffect(() => {
    let active = true;
    setLoading(true); setListError(""); setFiles([]);
    ade.listFiles(worktree.id).then(
      (files) => { if (active) { setFiles(files); setLoading(false); } },
      (error) => { if (active) { setListError(error.message); setLoading(false); } },
    );
    return () => { active = false; };
  }, [worktree.id, refresh]);
  useEffect(() => { if (initial) open(initial); }, [worktree.id]);
  const open = async (p: string) => { const t = await ade.readFile(worktree.id, p).catch((e) => `// ${e.message}`); setPath(p); setText(t); setSaved(t); setQ(""); };
  const save = async () => { await ade.writeFile(worktree.id, path, text); setSaved(text); };
  const dirty = text !== saved;
  const hits = q ? files.filter((f) => f.toLowerCase().includes(q.toLowerCase())).slice(0, 30) : [];
  return (
    <div className="card editor">
      <div className="ebar">
        <input value={q || path} placeholder="find a file…" onChange={(e) => setQ(e.target.value)} onFocus={(e) => e.target.select()} />
        <button title="Refresh all workspace files" disabled={loading} onClick={() => setRefresh((n) => n + 1)}>Refresh</button>
        {path.endsWith(".md") && <button onClick={() => onView(path)}>View</button>}
        <button className="primary" disabled={!path || !dirty} onClick={save}>{dirty ? "Save ⌘S" : "Saved"}</button>
      </div>
      {hits.length > 0 && <div className="hits">{hits.map((f) => <div key={f} className="hit" onMouseDown={() => open(f)}>{f}</div>)}</div>}
      {loading && <div className="m">Loading workspace files…</div>}
      {listError && <div className="error">Could not list files: {listError}</div>}
      {!q && <FileTree files={files} current={path} onOpen={open} />}
      {path && (
        <textarea className="code" ref={code} value={text} spellCheck={false} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); if (dirty) save(); }
            if (e.key === "Tab") { e.preventDefault(); const t = e.currentTarget, a = t.selectionStart, b = t.selectionEnd; setText(text.slice(0, a) + "  " + text.slice(b)); requestAnimationFrame(() => t.setSelectionRange(a + 2, a + 2)); }
          }} />
      )}
      {!loading && !listError && !path && !hits.length && !files.length && <div className="m">No files.</div>}
    </div>
  );
}

function MarkdownView({ worktree, path, onEdit, onNavigate }: { worktree: Worktree; path?: string; onEdit: (p: string) => void; onNavigate: (p: string) => void }) {
  const [preview, setPreview] = useState<Awaited<ReturnType<Api["previewArtifact"]>>>();
  const [err, setErr] = useState<string>();
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setPreview(undefined); setErr(undefined);
    if (path && !isReviewFile(path)) ade.previewArtifact(worktree.id, path).then((p) => { if (active) setPreview(p); }, (e) => { if (active) setErr(e.message); });
    return () => { active = false; };
  }, [worktree.id, path, reload]);
  const dir = path?.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
  const resolve = (href: string) => /^(?:[a-z]+:|\/|~\/)/i.test(href) ? href : dir + href;
  const html = React.useMemo(() => {
    if (preview?.kind !== "markdown") return "";
    const tpl = document.createElement("template");
    tpl.innerHTML = marked.parse(preview.content) as string;
    linkImages(tpl.content);
    return tpl.innerHTML;
  }, [preview]);
  const article = useRef<HTMLElement>(null);
  useArtifactImages(article, worktree.id, resolve, html);
  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    const href = a.dataset.artifact ?? a.getAttribute("href") ?? "";
    if (href.startsWith("#")) return;
    const target = resolve(href);
    ade.artifactMenu(worktree.id, target).then((action) => { if (action === "open") onNavigate(target); }).catch((e) => setErr(e.message));
  };
  if (!path) return <div className="card">Open a linked file in a chat to preview it here.</div>;
  const review = isReviewFile(path);
  return (
    <div className="mdwrap">
      <div className="ebar">
        <span className="grow mono" title={path}>{path}</span>
        {!review && <button className="icon" title="Reload" onClick={() => setReload((n) => n + 1)}>↻</button>}
        <button onClick={() => ade.artifactMenu(worktree.id, path).catch((e) => setErr(e.message))}>Actions</button>
        {(review || (preview && ["text", "markdown", "html"].includes(preview.kind))) && <button onClick={() => onEdit(path)}>Edit</button>}
      </div>
      {review ? <ReviewView worktree={worktree} path={path} />
        : err ? <div className="error">{err}</div> : !preview ? <div className="m">loading…</div>
        : preview.kind === "markdown" ? <article ref={article} className="md" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
        : preview.kind === "image" ? <img className="artifact-image" src={preview.content} alt={path} />
        : preview.kind === "html" ? <iframe className="artifact-frame" title={path} sandbox="" srcDoc={withFrameScrollbars(preview.content, document.documentElement.dataset.theme === "light" ? "light" : "dark")} />
        : preview.kind === "url" || preview.kind === "pdf" ? <iframe className="artifact-frame" title={path} sandbox="" src={preview.content} />
        : <pre className="artifact-text">{preview.content}</pre>}
    </div>
  );
}

function CommitPane({ worktree }: { worktree: Worktree }) {
  const [info, setInfo] = useState<CommitInfo>();
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState<"ai" | "commit">();
  const [note, setNote] = useState<string>();
  const load = () => ade.commitInfo(worktree.id).then(setInfo, (e) => setNote(e.message));
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [worktree.id]);
  const generate = async () => {
    setBusy("ai"); setNote(undefined);
    try { const m = await ade.suggestCommit(worktree.id); if (m) setMsg(m); else setNote("nothing to summarize"); } catch (e: any) { setNote(e.message); } finally { setBusy(undefined); }
  };
  const doCommit = async () => {
    setBusy("commit"); setNote(undefined);
    try { setNote(await ade.commit(worktree.id, msg.trim())); setMsg(""); await load(); } catch (e: any) { setNote(e.message.split("\n").slice(-3).join(" ")); } finally { setBusy(undefined); }
  };
  return (
    <div className="commit">
      <div className="card">
        <h4><Ico n="cypress" />Changes {info && <span className="m">({info.changed})</span>} <button className="icon" title="Refresh" onClick={load}>↻</button></h4>
        {!info ? <div className="m">loading…</div> : !info.changed ? <div className="m">No changes to commit.</div> : (
          <>
            <pre className="files">{info.files}</pre>
            <textarea className="cmsg" value={msg} placeholder="Commit message" onChange={(e) => setMsg(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && msg.trim()) doCommit(); }} />
            <div className="crow">
              <button onClick={generate} disabled={!!busy} title="Draft a message from the diff"><Ico n="star" />{busy === "ai" ? "thinking…" : "Generate"}</button>
              <button className="primary" onClick={doCommit} disabled={!!busy || !msg.trim()}>{busy === "commit" ? "pushing…" : "Commit + push"} <span className="m">⌘↩</span></button>
            </div>
          </>
        )}
        {note && <div className="m cnote">{note}</div>}
      </div>
      <div className="card list">
        <h4 style={{ padding: "10px 0 2px" }}><Ico n="wheat" />History <span className="m">{info ? `${info.branch}${info.ahead ? ` · ${info.ahead} unpushed` : ""}` : ""}</span></h4>
        {info?.log.map((c, i) => (
          <div key={c.hash} className="lrow">
            <span className="num">{c.hash}</span>
            <span className="grow">
              <div className={i < (info.ahead ?? 0) ? "" : "m"}>{c.subject}</div>
              <div className="m">{c.author} · {c.age}{i < (info.ahead ?? 0) ? " · unpushed" : ""}</div>
            </span>
          </div>
        ))}
        {info && !info.log.length && <div className="m">no commits yet</div>}
      </div>
    </div>
  );
}

function Diff({ worktree }: { worktree: Worktree }) {
  const [d, setD] = useState<{ files: string; patch: string }>();
  const load = () => ade.diff(worktree.id).then(setD);
  useEffect(() => { load(); }, [worktree.id]);
  const cls = (l: string) =>
    l.startsWith("diff --git") ? "file" : l.startsWith("@@") ? "hunk" : l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : "";
  return (
    <div className="card diff">
      <h4>Changes <button className="icon" onClick={load}>↻</button></h4>
      {!d ? "loading…" : !d.files ? "Clean working tree." : (
        <>
          <div className="files">{d.files}</div>
          <pre>{d.patch.split("\n").map((l, i) => <span key={i} className={cls(l)}>{l}{"\n"}</span>)}</pre>
        </>
      )}
    </div>
  );
}

type AuthState = { loggedIn: boolean; detail: string };

/**
 * One connector: who it is, how much of its plan is used, and its switches. CLI logins carry
 * plan meters; API keys are billed per token and say so instead of showing bars.
 */
/**
 * The Claude Code and Codex binaries the connectors run on. Consort bundles one of each and
 * downloads a newer release itself when a provider needs it (main/cliRuntime.ts); this shows
 * which is in use and lets the fetch be asked for by hand.
 */
function CliRuntimes() {
  const [status, setStatus] = useState<CliStatus[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { ade.cliStatus().then(setStatus, () => {}); }, []);
  const update = async () => {
    if (busy) return;
    setBusy(true);
    try { setStatus(await ade.updateClis()); } catch (e) { alert((e as Error).message); }
    finally { setBusy(false); }
  };
  return <div className="cli-runtimes">
    <div className="conn-note">CLI runtimes. A newer release than the bundled one is fetched on start, daily, and when a model needs it.</div>
    {status.map((s) => <div className="conn-sub" key={s.provider}>
      <span className={`dot ${s.source === "missing" ? "" : "ok"}`} aria-hidden />
      <span>{cliSummary(s)}</span>
      {s.note && <span className="m" title={s.note}>· {s.note}</span>}
    </div>)}
    <button className="tog" disabled={busy} onClick={update}>{busy ? "Checking…" : "Check for CLI updates"}</button>
  </div>;
}

function Connector({ k, isDefault, status, usage, now, onSignIn, onRename, onRefresh, children }: {
  k: State["keys"][number]; isDefault: boolean; status?: AuthState; usage?: ConnectorUsage; now: number;
  onSignIn: () => void; onRename: () => void; onRefresh: () => void; children?: React.ReactNode;
}) {
  const login = k.auth === "login";
  const builtIn = k.id.startsWith("login-");
  const identity = usage?.account ? [usage.account, usage.plan].filter(Boolean).join(" · ") : status?.loggedIn ? status.detail : usage?.plan;
  const dot = !login ? "ok" : !status ? "" : status.loggedIn ? "ok" : "bad";
  const signedOut = login && status && !status.loggedIn;
  // the pool's seats sign in from a terminal (CLAUDE_CONFIG_DIR=… claude), and it never carries PHI
  const pool = !!k.pool;
  return (
    <div className="conn" data-testid={`connector-${k.id}`}>
      <div className="conn-head">
        <div className="conn-name">{k.name}</div>
        <div className="conn-actions">
          {signedOut && !pool && <button onClick={onSignIn}>Sign in</button>}
          {login && status?.loggedIn && k.configDir && !pool && <button title="Sign in again as a different account" onClick={onSignIn}>Switch account</button>}
          <button aria-label={`Rename ${k.name}`} onClick={onRename}>Rename</button>
          {!builtIn && <button onClick={() => confirm(`Remove ${k.name}?`) && ade.removeKey(k.id)}>Remove</button>}
        </div>
      </div>
      <div className="conn-sub">
        <span className={`dot ${dot}`} aria-hidden />
        <span>{k.provider === "claude" ? "Claude" : "Codex"} · {pool ? "seat pool" : login ? "terminal login" : "API key"}</span>
        {signedOut ? <span className="conn-bad">not signed in</span> : identity ? <span className="conn-who" title={identity}>{identity}</span> : login && !status ? <span>checking…</span> : null}
      </div>
      <Meters usage={usage} signedOut={!!signedOut && !pool} now={now} />
      {children}
      <div className="conn-foot">
        <button className={"tog " + (isDefault ? "on" : "")} aria-pressed={isDefault} title="Used for PR reviews and as the connector new chats start with" onClick={() => !isDefault && ade.setDefaultKey(k.id).catch((e) => alert(e.message))}>Default</button>
        <span className="conn-age">
          {signedOut || usage?.unavailable ? "" : usage ? `usage ${formatAge(usage.at, now)}` : "checking usage…"}
          {login && <button className="icon" title="Refresh sign-in state and usage" aria-label={`Refresh ${k.name}`} onClick={onRefresh}>↻</button>}
        </span>
      </div>
    </div>
  );
}

function Meters({ usage, signedOut, now }: { usage?: ConnectorUsage; signedOut: boolean; now: number }) {
  if (signedOut) return <div className="conn-note">Sign in to see plan usage.</div>;
  if (!usage) return (
    <div className="meters" aria-busy>
      {[0, 1].map((i) => <div key={i} className="meter skeleton"><span className="meter-label" /><span className="meter-track" /><span className="meter-pct" /><span className="meter-reset" /></div>)}
    </div>
  );
  if (usage.unavailable) return <div className="conn-note">{usage.unavailable}</div>;
  return (
    <div className="meters">
      {usage.blocked && <div className="conn-alert" role="status">{usage.blocked}{usage.windows[0]?.resetsAt ? ` · ${formatReset(usage.windows[0].resetsAt, now)}` : ""}</div>}
      {usage.windows.map((w) => (
        <div key={w.id} className={`meter ${usageTone(w.percent)}`} role="meter" aria-valuenow={w.percent} aria-valuemin={0} aria-valuemax={100} aria-label={`${w.label} usage`}>
          <span className="meter-label" title={w.label}>{w.label}</span>
          <span className="meter-track"><span className="meter-fill" style={{ width: `${w.percent}%` }} /></span>
          <span className="meter-pct">{w.percent}%</span>
          <span className="meter-reset">{formatReset(w.resetsAt, now)}</span>
        </div>
      ))}
      {!usage.windows.length && !usage.blocked && <div className="conn-note">The provider reported no usage windows.</div>}
    </div>
  );
}

/* standing instructions for every chat: one line each, click to read the whole thing, switch off without losing it, × to remove */
function InstructionsCard({ items }: { items: Instruction[] }) {
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const save = (next: Instruction[]) => ade.setInstructions(next).catch((e) => alert(e.message));
  const add = (text: string) => { const t = text.trim(); if (!t) return; save([...items, { id: crypto.randomUUID(), text: t, enabled: true }]); setDraft(""); };
  return (
    <div className="instructions">
      <div className="conn-note">Standing instructions appended to every chat's prompt, on every connector and model. They apply from the next message.</div>
      {items.map((i) => (
        <div key={i.id} className={"instr" + (i.enabled ? "" : " off") + (open === i.id ? " open" : "")}>
          <input type="checkbox" checked={i.enabled} aria-label={i.enabled ? "Pause this instruction" : "Resume this instruction"} onChange={(e) => save(items.map((x) => x.id === i.id ? { ...x, enabled: e.target.checked } : x))} />
          <span className="grow" title={open === i.id ? "Collapse" : "Show the whole instruction"} onClick={() => setOpen((o) => (o === i.id ? null : i.id))}>{i.text}</span>
          <button className="icon" title="Remove" aria-label="Remove instruction" onClick={() => save(items.filter((x) => x.id !== i.id))}>×</button>
        </div>
      ))}
      <div className="instr-add">
        <input value={draft} placeholder={items.length ? "Add another instruction…" : "e.g. Respond with brevity."} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); add(draft); } }} />
        <button disabled={!draft.trim()} onClick={() => add(draft)}>Add</button>
      </div>
    </div>
  );
}

/** `count` is how many things the section holds, shown by the chevron so a collapsed section still says what is in it */
function SettingsSection({ icon, title, children, actions, count, initialOpen = true }: { icon: string; title: string; children: React.ReactNode; actions?: React.ReactNode; count?: number; initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  // the whole head row toggles; the actions sit before the chevron so every section's chevron lines up at the edge
  return <section className={`card settings-section ${open ? "open" : ""}`}>
    <div className="settings-section-head" onClick={() => setOpen((v) => !v)}>
      <button className="settings-section-toggle" aria-expanded={open}><Ico n={icon} />{title}</button>
      {actions && <span className="h4-actions" onClick={(e) => e.stopPropagation()}>{actions}</span>}
      {count !== undefined && <span className="settings-count" title={`${count} in this section`}>{count}</span>}
      <span className="settings-chevron" aria-hidden>{open ? "▾" : "▸"}</span>
    </div>
    {open && <div className="settings-section-body">{children}</div>}
  </section>;
}

function ExtensionsCard({ state }: { state: State }) {
  const [kind, setKind] = useState<"claude" | "codex">("claude");
  const claude = state.keys.filter((k) => k.provider === "claude" && k.auth === "login");
  const codex = state.keys.filter((k) => k.provider === "codex");
  const [keyId, setKeyId] = useState("");
  const [marketplace, setMarketplace] = useState("");
  const [plugin, setPlugin] = useState("");
  const [skillPath, setSkillPath] = useState("");
  const [busy, setBusy] = useState(false);
  const keys = kind === "claude" ? claude : codex;
  const selected = keys.some((k) => k.id === keyId) ? keyId : keys[0]?.id ?? "";
  const install = async () => {
    if (!selected || busy) return;
    setBusy(true);
    try {
      if (kind === "claude") await ade.installClaudePlugin(selected, marketplace, plugin);
      else await ade.installCodexSkill(selected, skillPath);
      setMarketplace(""); setPlugin(""); setSkillPath("");
    } catch (e) { alert((e as Error).message); }
    finally { setBusy(false); }
  };
  const chooseSkill = async () => { const path = await ade.pickFolder(); if (path) setSkillPath(path); };
  const installed = (state.extensions ?? []).slice().sort((a, b) => b.installedAt - a.installedAt);
  return <div className="extensions">
    <div className="conn-note">Use each provider's native extension format. New chats load extensions installed for their selected connector.</div>
    <div className="seg extension-kind">
      <button className={kind === "claude" ? "on" : ""} onClick={() => setKind("claude")}>Claude plugin</button>
      <button className={kind === "codex" ? "on" : ""} onClick={() => setKind("codex")}>Codex skill</button>
    </div>
    {!keys.length ? <div className="conn-note">Add a {kind === "claude" ? "Claude Code terminal-login" : "Codex"} connector first.</div> : <>
      <Field label="Connector"><select value={selected} onChange={(e) => setKeyId(e.target.value)}>{keys.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}</select></Field>
      {kind === "claude" ? <>
        <Field label="Marketplace" optional><input value={marketplace} placeholder="aligned-marketplace/claude-plugins" onChange={(e) => setMarketplace(e.target.value)} /></Field>
        <Field label="Plugin"><input value={plugin} placeholder="dan-hex-practices" onChange={(e) => setPlugin(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void install(); }} /></Field>
        <div className="extension-actions"><button className="primary" disabled={busy || !plugin.trim()} onClick={install}>{busy ? "Installing…" : "Install plugin"}</button></div>
      </> : <>
        <Field label="Skill folder" info="Choose the folder containing SKILL.md."><div className="path-pick"><input readOnly value={skillPath} placeholder="No folder selected" /><button onClick={chooseSkill}>Choose…</button></div></Field>
        <div className="extension-actions"><button className="primary" disabled={busy || !skillPath} onClick={install}>{busy ? "Installing…" : "Install skill"}</button></div>
      </>}
    </>}
    {!!installed.length && <div className="extension-list">{installed.map((x) => <div className="extension-row" key={x.id}><span><Ico n={x.kind === "plugin" ? "star" : "quill"} />{x.name}</span><small>{state.keys.find((k) => k.id === x.connectorId)?.name ?? "Removed connector"} · {x.kind}</small></div>)}</div>}
  </div>;
}

function Settings({ state, onSignIn }: { state: State; onSignIn: (keyId: string) => void }) {
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [savingName, setSavingName] = useState(false);
  const rename = async () => {
    if (!renaming?.name.trim() || savingName) return;
    setSavingName(true);
    try {
      await ade.renameKey(renaming.id, renaming.name);
      setRenaming(null);
    } catch (e) { alert((e as Error).message); }
    finally { setSavingName(false); }
  };
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<"claude" | "codex">("claude");
  const [key, setKey] = useState("");
  const [auth, setAuth] = useState<"login" | "key">("key");
  const [status, setStatus] = useState<Record<string, AuthState>>({});
  const [usage, setUsage] = useState<Record<string, ConnectorUsage>>({});
  const [now, setNow] = useState(Date.now());
  const [openRouterKey, setOpenRouterKey] = useState("");
  const [clickUpKey, setClickUpKey] = useState("");
  const [savingClickUp, setSavingClickUp] = useState(false);
  const [prefix, setPrefix] = useState(state.branchPrefix ?? "");
  const saveClickUp = async (remove = false) => {
    if (savingClickUp || (!remove && !clickUpKey.trim())) return;
    setSavingClickUp(true);
    try { await ade.setClickUpKey(remove ? "" : clickUpKey); setClickUpKey(""); }
    catch (e) { alert((e as Error).message); }
    finally { setSavingClickUp(false); }
  };
  const [savingOpenRouter, setSavingOpenRouter] = useState(false);
  const saveOpenRouter = async (remove = false) => {
    if (savingOpenRouter || (!remove && !openRouterKey.trim())) return;
    setSavingOpenRouter(true);
    try {
      await ade.setOpenRouterKey(remove ? "" : openRouterKey);
      setOpenRouterKey("");
    } catch (e) { alert((e as Error).message); }
    finally { setSavingOpenRouter(false); }
  };
  // status is per connector: each extra CLI login has its own config dir and therefore its own sign-in state
  const keyIds = state.keys.map((k) => k.id).join("|");
  const loginIds = state.keys.filter((k) => k.auth === "login").map((k) => k.id).join("|");
  const refreshStatus = () => { for (const k of state.keys) if (k.auth === "login") ade.authStatus(k.id).then((r) => setStatus((s) => ({ ...s, [k.id]: r }))); };
  // usage is read when the panel opens (main keeps it for a minute) and on demand from ↻, which re-asks the CLI
  const refreshUsage = (force = false, only?: string) => {
    for (const k of state.keys) {
      if (only && k.id !== only) continue;
      if (force) setUsage((u) => { const { [k.id]: _drop, ...rest } = u; return rest; });
      ade.connectorUsage(k.id, force).then((r) => setUsage((u) => ({ ...u, [k.id]: r })), () => {});
    }
  };
  useEffect(() => { refreshStatus(); const t = setInterval(refreshStatus, 8000); return () => clearInterval(t); }, [loginIds]);
  useEffect(() => { refreshUsage(); }, [keyIds]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  const add = async () => {
    const n = state.keys.filter((k) => k.provider === provider && k.auth === "login").length + 1;
    await ade.addKey(name || (auth === "login" ? `${provider === "claude" ? "Claude Code" : "Codex CLI"} login ${n}` : provider), provider, auth === "key" ? key : "", auth).catch((e) => alert(e.message));
    setName(""); setKey(""); setAdding(false);
  };
  return (
    <>
      {/* collapsed by default so the drawer reads as a list; connectors open when there is nothing set up yet, since that is the first thing to do */}
      <SettingsSection icon="fleur" title="AI connectors" count={state.keys.length} initialOpen={state.keys.length === 0} actions={<>
            <button className="icon" title="Refresh sign-in state, usage and the model lists" aria-label="Refresh all connectors" onClick={() => { refreshStatus(); refreshUsage(true); ade.refreshModels().catch(() => {}); }}>↻</button>
            <button className="icon" title="Add a connector (API key or another CLI login)" onClick={() => setAdding(true)}>＋</button>
          </>}>
        {state.keys.map((k) => (
          <Connector key={k.id} k={k} isDefault={defaultConnector(state)?.id === k.id} status={status[k.id]} usage={usage[k.id]} now={now}
            onSignIn={() => onSignIn(k.id)} onRename={() => setRenaming({ id: k.id, name: k.name })} onRefresh={() => { refreshStatus(); refreshUsage(true, k.id); }}>
            {k.pool && <PoolSettings state={state} />}
          </Connector>
        ))}
        {!state.keys.length && <div className="conn-note">No connectors yet.</div>}
        <CliRuntimes />
      </SettingsSection>
      <SettingsSection icon="butterfly" title="OpenRouter navigator" count={state.openRouterConfigured ? 1 : 0} initialOpen={false}>
        <div className="conn-note">Adding an OpenRouter key turns on Autopilot: an Autopilot switch appears in every chat, and a chat with it on can see your screen and click, type and switch between visible macOS apps to finish a task in another app. The Jev navigator model does that driving, billed to this key. Without a key the switch is not shown and nothing can control your desktop.</div>
        <div className="conn-note">The key is used only for that. It is encrypted in the macOS Keychain and is never used as a chat connector.</div>
        <div className="conn-sub" style={{ marginBottom: 10 }}>
          <span className={`dot ${state.openRouterConfigured ? "ok" : ""}`} aria-hidden />
          <span>{state.openRouterConfigured ? "Jev navigator configured" : "Jev navigator not configured"}</span>
        </div>
        <Field label={state.openRouterConfigured ? "Replace key" : "API key"} info="Stored encrypted; the saved value is never shown again.">
          <input type="password" autoComplete="off" placeholder="sk-or-v1-…" value={openRouterKey} onChange={(e) => setOpenRouterKey(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && openRouterKey.trim()) void saveOpenRouter(); }} />
        </Field>
        <div className="extension-actions">
          <button className="primary" disabled={savingOpenRouter || !openRouterKey.trim()} onClick={() => void saveOpenRouter()}>{savingOpenRouter ? "Saving…" : state.openRouterConfigured ? "Replace key" : "Save key"}</button>
          {state.openRouterConfigured && <button disabled={savingOpenRouter} onClick={() => confirm("Remove the OpenRouter key?") && void saveOpenRouter(true)}>Remove</button>}
        </div>
      </SettingsSection>
      <SettingsSection icon="laurel" title="Ship" count={(state.clickUpConfigured ? 1 : 0) + (state.branchPrefix ? 1 : 0)} initialOpen={false}>
        <div className="conn-note">/ship takes a feature from a GitHub issue or a ClickUp task to a merged PR: a worktree per feature, grilling into a spec, tickets, build, test report, review. GitHub issues need nothing here beyond gh. A ClickUp key lets the project page ship a task by id and moves the task's status with each stage.</div>
        <Field label="Branch prefix" info="Every branch Consort generates starts with it: mm gives mm/hris-address-494 and mm/issue/12.">
          <input value={prefix} placeholder="mm" autoComplete="off" onChange={(e) => setPrefix(e.target.value)} onBlur={() => ade.setBranchPrefix(prefix).catch((e) => alert(e.message))} onKeyDown={(e) => { if (e.key === "Enter") ade.setBranchPrefix(prefix).catch((err) => alert(err.message)); }} />
        </Field>
        <label className="ship-opt" title="The pipeline runs long unattended stretches: builds, test sessions, PR loops. Applies to /ship chats started from here on.">
          <input type="checkbox" checked={state.shipAutoApprove ?? true} onChange={(e) => ade.setShipAutoApprove(e.target.checked).catch((err) => alert(err.message))} /> Auto-approve tools in new /ship chats
        </label>
        <div className="conn-sub" style={{ margin: "10px 0" }}>
          <span className={`dot ${state.clickUpConfigured ? "ok" : ""}`} aria-hidden />
          <span>{state.clickUpConfigured ? "ClickUp connected" : "ClickUp not connected"}</span>
        </div>
        <Field label={state.clickUpConfigured ? "Replace ClickUp key" : "ClickUp API key"} info="A personal API token from ClickUp › Settings › Apps. Stored encrypted; the saved value is never shown again. Task statuses must match the stage names.">
          <input type="password" autoComplete="off" placeholder="pk_…" value={clickUpKey} onChange={(e) => setClickUpKey(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && clickUpKey.trim()) void saveClickUp(); }} />
        </Field>
        <div className="extension-actions">
          <button className="primary" disabled={savingClickUp || !clickUpKey.trim()} onClick={() => void saveClickUp()}>{savingClickUp ? "Saving…" : state.clickUpConfigured ? "Replace key" : "Save key"}</button>
          {state.clickUpConfigured && <button disabled={savingClickUp} onClick={() => confirm("Remove the ClickUp key?") && void saveClickUp(true)}>Remove</button>}
        </div>
      </SettingsSection>
      <SettingsSection icon="quill" title="Chat rules" count={state.instructions?.length ?? 0} initialOpen={false}><InstructionsCard items={state.instructions ?? []} /></SettingsSection>
      <SettingsSection icon="star" title="Plugins + skills" count={state.extensions?.length ?? 0} initialOpen={false}><ExtensionsCard state={state} /></SettingsSection>
      <SettingsSection icon="butterfly" title="Appearance">
        <div className="krow">
          <span className="grow">Mode</span>
          <div className="seg">
            {(["auto", "dark", "light"] as const).map((t) => <button key={t} className={state.appearance.theme === t ? "on" : ""} onClick={() => ade.setAppearance({ theme: t })}>{t !== "auto" && <Ico n={t === "dark" ? "moon" : "sun"} />} {t}</button>)}
          </div>
        </div>
        <div className="krow">
          <span className="grow" title="Off folds consecutive tool calls into one line per run; failed and running calls always show. A chat can override this from its composer.">Show tool calls</span>
          <label className="switch"><input type="checkbox" checked={!!state.showToolCalls} onChange={(e) => ade.setShowToolCalls(e.target.checked).catch((err) => alert(err.message))} /> {state.showToolCalls ? "every call as a row" : "folded"}</label>
        </div>
        <div className="krow">
          <span className="grow">Background</span>
          <div className="seg">
            {([["opaque", "opaque"], ["frost", "frosted"], ["frost2", "frosted+"]] as const).map(([v, l]) => <button key={v} className={state.appearance.background === v ? "on" : ""} onClick={() => ade.setAppearance({ background: v })}>{l}</button>)}
          </div>
        </div>
      </SettingsSection>
      {renaming && (
        <Dialog title="Rename connector" onClose={() => { if (!savingName) setRenaming(null); }} footer={<>
          <button disabled={savingName} onClick={() => setRenaming(null)}>Cancel</button>
          <button className="primary" disabled={savingName || !renaming.name.trim()} onClick={rename}>{savingName ? "Saving…" : "Save"}</button>
        </>}>
          <Field label="Name"><input aria-label="Connector name" autoFocus value={renaming.name} disabled={savingName}
            onFocus={(e) => e.target.select()} onChange={(e) => setRenaming({ ...renaming, name: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); void rename(); } }} /></Field>
        </Dialog>
      )}
      {adding && (
        <Dialog title="Add a connector" onClose={() => setAdding(false)} footer={<>
          <button onClick={() => setAdding(false)}>Cancel</button>
          <button className="primary" disabled={auth === "key" && !key} onClick={add}>Add</button>
        </>}>
          <div className="two">
            <Field label="Provider">
              <select value={provider} onChange={(e) => setProvider(e.target.value as any)}>
                <option value="claude">claude</option>
                <option value="codex">codex</option>
              </select>
            </Field>
            <Field label="Sign-in method">
              <div className="seg">
                <button className={auth === "key" ? "on" : ""} onClick={() => setAuth("key")}>api key</button>
                <button className={auth === "login" ? "on" : ""} onClick={() => setAuth("login")}>terminal login</button>
              </div>
            </Field>
          </div>
          <Field label="Label" optional><input placeholder={auth === "login" ? `e.g. ${provider} work account` : "e.g. claude billing key"} value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
          <div className="m">{auth === "login"
            ? "Adds another CLI login for this provider with its own credentials, so you can sign in to a second account (say, work and personal) and pick one per chat. The original login keeps the CLI's default sign-in. After adding it, press Sign in to run the login in a terminal tab."
            : "Adds a separate API key, billed per token. It has no plan limits, so no usage meters."}</div>
          {auth === "key" && (
            <Field label="Key" info="Encrypted at rest via macOS keychain.">
              <input type="password" placeholder="sk-…" value={key} onChange={(e) => setKey(e.target.value)} />
            </Field>
          )}
        </Dialog>
      )}
    </>
  );
}
