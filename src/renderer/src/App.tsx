import React, { useEffect, useRef, useState } from "react";
import { MODELS, PHASES, type Api, type Chat, type Job, type Phase, type PermissionRequest, type Project, type RepoInfo, type RootStatus, type State, type Worktree, type WorktreeStatus } from "../../shared/types";
import { chatStatus } from "../../shared/chatStatus";
import { Lockup, Mark } from "./Logo";
import { artifactLinks, chatArtifacts } from "../../shared/artifacts";
import { marked } from "marked";

const ade = (window as any).ade as Api;
const EMPTY: State = { projects: [], worktrees: [], chats: [], keys: [], appearance: { theme: "dark", background: "opaque" } };
type Tab = "terminal" | "diff" | "editor" | "markdown" | "artifacts" | "settings";
const PHASE_ICON: Record<Phase, string> = { waiting: "candle", planning: "scroll", executing: "sun", validating: "chalice", complete: "wreath" };
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
const CHECK = { pass: "●", fail: "✗", pending: "◌" } as const;
const PrBadge = ({ st }: { st: WorktreeStatus }) => {
  const pr = st.pr;
  if (pr?.state === "MERGED") return <span className="badge merged" title="PR merged"><Ico n="laurel" /> merged</span>;
  if (!pr) return st.inBase ? <span className="badge" title="HEAD is already contained in the base branch">in base</span> : null;
  const c = pr.checks ? CHECK[pr.checks] : "";
  if (pr.state === "CLOSED") return <span className="badge closed" title={pr.title}>✗ #{pr.number}</span>;
  return <span className={"badge pr" + (pr.checks === "fail" ? " bad" : "")} title={`${pr.title} · checks ${pr.checks ?? "none"}`}>{pr.draft ? "◐" : "⎇"} #{pr.number} {c}</span>;
};
const Badges = ({ st, pr = true }: { st: WorktreeStatus | null; pr?: boolean }) =>
  !st ? null : (
    <span className="badges">
      {pr && <PrBadge st={st} />}
      {st.dirty > 0 && <span className="badge" title="uncommitted changes">±{st.dirty}</span>}
      {st.ahead > 0 && <span className="badge" title="ahead of upstream">↑{st.ahead}</span>}
      {st.behind > 0 && <span className="badge" title="behind upstream">↓{st.behind}</span>}
      {!st.dirty && !st.ahead && !st.behind && !(pr && (st.pr || st.inBase)) && <span className="badge">clean</span>}
    </span>
  );

// a non-zero exit the user hasn't looked at yet; user-stopped (-1) doesn't count
const isUnseenFailure = (j: Job) => j.status === "exited" && j.code != null && j.code > 0 && !j.seen;
const Dots = ({ id, running, failed }: { id: string; running: Set<string>; failed: Set<string> }) => (
  <>{running.has(id) && <span className="live" title="a process is running here" />}{failed.has(id) && <span className="live dead" title="a process failed — open its terminal" />}</>
);
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
    return <span className={className} title={`${trigger === "click" ? "Click" : "Double-click"} to rename`}
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

export function App() {
  const [state, setState] = useState<State>(EMPTY);
  const [sel, setSel] = useState<Sel>();
  const [tab, setTab] = useState<Tab>();
  const [file, setFile] = useState<string>();
  const openMd = (path: string) => { setFile(path); setTab("markdown"); };
  const openEditor = (path: string) => { setFile(path); setTab("editor"); };
  const perms = state.chats.flatMap((c) => c.permissions ?? []);
  const [jobs, setJobs] = useState<Job[]>([]);
  const running = React.useMemo(() => new Set(jobs.filter((j) => j.status === "running").map((j) => j.scopeId)), [jobs]);
  const failed = React.useMemo(() => new Set(jobs.filter(isUnseenFailure).map((j) => j.scopeId)), [jobs]);

  useEffect(() => {
    ade.getState().then(setState);
    ade.jobs().then(setJobs);
    const a = ade.onState(setState);
    const b = ade.onOpenChat((id) => setSel({ type: "chat", id }));
    const c = ade.onJobs(setJobs);
    return () => { a(); b(); c(); };
  }, []);

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
  useEffect(() => {
    document.documentElement.dataset.theme = state.appearance.theme;
    document.documentElement.dataset.bg = state.appearance.background;
  }, [state.appearance.theme, state.appearance.background]);
  const chat = sel?.type === "chat" ? state.chats.find((c) => c.id === sel.id) : undefined;
  const worktree = state.worktrees.find((w) => w.id === (chat ? chat.worktreeId : sel?.type === "worktree" ? sel.id : undefined));
  const project = sel?.type === "project" ? state.projects.find((p) => p.id === sel.id) : undefined;
  const wtProject = worktree && state.projects.find((p) => p.id === worktree.projectId);
  const crumb = worktree && wtProject ? `${wtProject.name}/${worktree.branch}` : project ? project.name : "Consort ADE";
  useEffect(() => { document.title = chat ? `${crumb} · ${chat.name}` : crumb; }, [crumb, chat?.name]);
  const answer = (id: string, allow: boolean) => {
    ade.answerPermission(id, allow);

  };
  const toggle = (t: Tab) => setTab((cur) => (cur === t ? undefined : t));

  return (
    <div className="app" style={{ gridTemplateColumns: `${collapsed ? 0 : leftW}px 1fr auto` }}>
      {collapsed ? <div /> : <Sidebar state={state} sel={sel} running={running} failed={failed} onSelect={setSel} onCollapse={() => setCollapsed(true)} />}
      {!collapsed && <div className="resizer left" style={{ left: leftW - 3 }} onMouseDown={drag("left")} />}
      <div className="main">
        <div className={"topbar" + (collapsed ? " collapsed" : "") + (chat ? " haschat" : "")}>
          {collapsed && <button className="icon panel" title="Show sidebar" onClick={() => setCollapsed(false)}><PanelIcon /></button>}
          {chat ? (
            <>
              <span className="crumb" title={worktree?.path}>{crumb}</span>
              <input className="name" defaultValue={chat.name} key={chat.id} onBlur={(e) => ade.renameChat(chat.id, e.target.value)} />
              <span className="meta">{chat.model}</span>
              <select value={chat.keyId} title="API key" onChange={(e) => ade.setChatKey(chat.id, e.target.value)}>
                {!state.keys.some((k) => k.id === chat.keyId) && <option value={chat.keyId}>missing key</option>}
                {state.keys.filter((k) => k.provider === chat.provider).map((k) => <option key={k.id} value={k.id}>{k.name}{k.phiAllowed ? " · PHI" : ""}</option>)}
              </select>
              <label className={"phimode" + (state.keys.find((k) => k.id === chat.keyId)?.phiAllowed ? " on" : "")} title="PHI mode: use a PHI-approved key. Flips on automatically for suspicious uploads or prompts.">
                <input type="checkbox" checked={!!state.keys.find((k) => k.id === chat.keyId)?.phiAllowed} onChange={(e) => ade.setPhiMode(chat.id, e.target.checked)} /> <Ico n="cross" />PHI mode
              </label>
              <label><input type="checkbox" checked={chat.autoApprove} onChange={(e) => ade.setAutoApprove(chat.id, e.target.checked)} /> <span>auto-approve</span></label>
              {chat.running && <button onClick={() => ade.stop(chat.id)}>Stop</button>}
            </>
          ) : <span className="title">{crumb}</span>}
          <div className="tabs">
            <button className={tab === "terminal" ? "on" : ""} onClick={() => toggle("terminal")}><Ico n="terminal" /><span>Terminal</span></button>
            <button className={tab === "diff" ? "on" : ""} onClick={() => toggle("diff")}><Ico n="branch" /><span>Diff</span></button>
            <button className={tab === "editor" ? "on" : ""} onClick={() => toggle("editor")}><Ico n="pencil" /><span>Editor</span></button>
            {chat && <button className={tab === "artifacts" ? "on" : ""} aria-pressed={tab === "artifacts"} onClick={() => toggle("artifacts")}><Ico n="scroll" /><span>Artifacts</span></button>}
            <button className={tab === "settings" ? "on" : ""} onClick={() => toggle("settings")}><Ico n="gear" /><span>Settings</span></button>
          </div>
        </div>
        {chat ? (
          <ChatPane chat={chat} perms={perms.filter((p) => p.chatId === chat.id)} answer={answer} onOpenMd={(target) => { if (worktree) ade.artifactMenu(worktree.id, target).then((action) => { if (action === "open") openMd(target); }).catch((e) => alert(e.message)); }} />
        ) : worktree ? (
          <WorktreePage key={worktree.id} wt={worktree} state={state} openForm={sel?.type === "worktree" && !!sel.form} onSelect={setSel} />
        ) : project ? (
          <ProjectPage key={project.id} project={project} state={state} openForm={sel?.type === "project" && !!sel.form} onSelect={setSel} />
        ) : (
          <div className="empty">
            <div>
              <Mark />
              <div className="word">Consort</div>
              <div className="sub">AGENTIC DEVELOPMENT ENVIRONMENT</div>
              <div className="est">AN AGENTIC WORKSPACE · NEW YORK</div>
              <div className="ornament rose" />
            </div>
          </div>
        )}
      </div>
      {tab && <>
        <div className="resizer right" style={{ right: rightW - 3 }} onMouseDown={drag("right")} />
        <Drawer tab={tab} state={state} chat={chat} worktree={worktree} scope={worktree ? { id: worktree.id, cwd: worktree.path, title: worktree.title } : project ? { id: project.id, cwd: project.path, title: project.name } : undefined}
          jobs={jobs} width={rightW} file={file} onEdit={openEditor} onView={openMd} onClose={() => setTab(undefined)} />
      </>}
    </div>
  );
}

/* ---------- sidebar ---------- */

function Sidebar({ state, sel, running, failed, onSelect, onCollapse }: { state: State; sel?: Sel; running: Set<string>; failed: Set<string>; onSelect: (s: Sel) => void; onCollapse: () => void }) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggle = (id: string) => setCollapsed((c) => ({ ...c, [id]: !c[id] }));
  const addProject = async () => {
    const p = await ade.pickFolder();
    if (p) ade.addProject(p).catch((e) => alert(e.message));
  };
  return (
    <div className="sidebar">
      <div className="brandrow"><Lockup /><button className="icon panel" title="Hide sidebar" onClick={onCollapse}><PanelIcon /></button></div>
      <div className="sect">
        <span>Projects</span>
        <button className="icon" title="Add project" onClick={addProject}>＋</button>
      </div>
      {state.projects.map((p) => (
        <ProjectNode key={p.id} project={p} state={state} sel={sel} running={running} failed={failed} onSelect={onSelect} collapsed={collapsed} toggle={toggle} />
      ))}
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
    setBusy(true);
    try {
      if (workAtRoot) onRoot(await ade.openRootWorktree(p.id));
      else await ade.addWorktree(p.id, name, branch || name, base);
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

function ProjectNode({ project: p, state, sel, running, failed, onSelect, collapsed, toggle }: {
  project: Project; state: State; sel?: Sel; running: Set<string>; failed: Set<string>; onSelect: (s: Sel) => void;
  collapsed: Record<string, boolean>; toggle: (id: string) => void;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const all = state.worktrees.filter((w) => w.projectId === p.id);
  const wts = all.filter((w) => showArchived || !w.archived);
  const archivedN = all.filter((w) => w.archived).length;
  return (
    <div>
      <div className={"row project" + (sel?.type === "project" && sel.id === p.id ? " active" : "")} onClick={() => onSelect({ type: "project", id: p.id })}>
        <span onClick={(e) => { e.stopPropagation(); toggle(p.id); }}>{collapsed[p.id] ? "▸" : "▾"}</span>
        <span className="grow" title={p.path}><Ico n="arch" className="proj" />{p.name}<Dots id={p.id} running={running} failed={failed} /></span>
        <span className="tools" onClick={(e) => e.stopPropagation()}>
          <button className="icon" title="New worktree" onClick={() => onSelect({ type: "project", id: p.id, form: true })}>＋</button>
          <button className="icon" title="Re-scan worktrees" onClick={() => ade.syncWorktrees(p.id)}>↻</button>
          <button className="icon" title="Remove project" onClick={() => confirm(`Remove ${p.name} from Consort?`) && ade.removeProject(p.id)}>×</button>
        </span>
      </div>
      {!collapsed[p.id] && <div className="wtlist">{wts.map((w) => (
        <WorktreeNode key={w.id} wt={w} state={state} sel={sel} running={running} failed={failed} onSelect={onSelect} collapsed={collapsed} toggle={toggle} />
      ))}</div>}
      {!collapsed[p.id] && archivedN > 0 && (
        <div className="row worktree archived-toggle" onClick={() => setShowArchived((x) => !x)}>
          <small>{showArchived ? "hide" : "show"} {archivedN} archived</small>
        </div>
      )}
    </div>
  );
}

function WorktreeNode({ wt, state, sel, running, failed, onSelect, collapsed, toggle }: {
  wt: Worktree; state: State; sel?: Sel; running: Set<string>; failed: Set<string>; onSelect: (s: Sel) => void;
  collapsed: Record<string, boolean>; toggle: (id: string) => void;
}) {
  const st = useStatus(wt.id);
  const chats = state.chats.filter((c) => c.worktreeId === wt.id);
  const active = sel?.type === "worktree" && sel.id === wt.id;
  return (
    <div>
      <div className={"row worktree" + (active ? " active" : "") + (wt.archived ? " dim" : "")} onClick={() => onSelect({ type: "worktree", id: wt.id })}>
        <span className="grow">{wt.root ? "Root" : <Editable value={wt.title} onSave={(t) => ade.renameWorktree(wt.id, t)} />}<Dots id={wt.id} running={running} failed={failed} /></span>
        <small className="branch">{st?.branch ?? wt.branch}</small>
        {st && (st.dirty > 0 || st.ahead > 0 || st.behind > 0 || st.pr || st.inBase) && <Badges st={st} />}
        <span className="tools" onClick={(e) => e.stopPropagation()}>
          <button className="icon" title="New chat here" onClick={() => onSelect({ type: "worktree", id: wt.id, form: true })}>＋</button>
          <button className="icon" title={wt.archived ? "Unarchive" : "Archive (hide from list)"} onClick={() => ade.archiveWorktree(wt.id, !wt.archived)}><Ico n="vase" className="solo" /></button>
          {!wt.root && <button className="icon" title="Delete worktree from disk" onClick={() => confirm(`Delete worktree ${wt.title}?\n\nRuns: git worktree remove --force ${wt.path}\n${chats.length ? `Also deletes ${chats.length} chat(s).` : ""}`) && ade.removeWorktree(wt.id).catch((e) => alert(e.message))}><Flame /></button>}
          <button className="icon" title={collapsed[wt.id] ? "Expand" : "Collapse"} onClick={() => toggle(wt.id)}>{collapsed[wt.id] ? "▸" : "▾"}</button>
        </span>
      </div>
      {!collapsed[wt.id] && chats.map((c) => (
        <div key={c.id} className={"row chat" + (sel?.type === "chat" && c.id === sel.id ? " active" : "")} onClick={() => onSelect({ type: "chat", id: c.id })}>
          <span className="chat-symbol"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="8" cy="8" r="4.5" /><path d="M8 0v5M8 11v5M0 8h5M11 8h5" /></svg>{chatStatus(c) && <span role="img" aria-label={chatStatus(c)!} title={chatStatus(c)!} className={`chat-dot ${chatStatus(c)}`} />}</span>
          <span className="grow">{c.name}</span>
          <MiniBar phase={c.phase} />
          <span className="tools" onClick={(e) => e.stopPropagation()}>
            <button className="icon" onClick={() => confirm("Delete chat?") && ade.deleteChat(c.id)}>×</button>
          </span>
        </div>
      ))}
    </div>
  );
}

const MiniBar = ({ phase }: { phase: Phase }) => {
  const i = PHASES.indexOf(phase);
  return <span className="mini">{PHASES.map((p, j) => <i key={p} className={j < i ? "done" : j === i ? "on" : ""} />)}</span>;
};

/* ---------- project page ---------- */

const ago = (iso: string) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};
const RUN = { success: "●", failure: "✗", cancelled: "⊘", skipped: "◌" } as Record<string, string>;

function ProjectPage({ project: p, state, openForm, onSelect }: { project: Project; state: State; openForm: boolean; onSelect: (s: Sel) => void }) {
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
  const wts = state.worktrees.filter((w) => w.projectId === p.id && (showArchived || !w.archived));
  const archivedN = state.worktrees.filter((w) => w.projectId === p.id && w.archived).length;
  const localBranches = new Set(state.worktrees.filter((w) => w.projectId === p.id).map((w) => w.branch));
  const [busyPr, setBusyPr] = useState<number>();
  // Review = ensure a worktree for the PR branch, then start a pr-writeup chat in it
  const review = async (pr: RepoInfo["prs"][number]) => {
    const key = state.keys.find((k) => k.provider === "claude") ?? state.keys[0];
    if (!key) return alert("Add an API key first (Settings)");
    setBusyPr(pr.number);
    try {
      let wt = state.worktrees.find((w) => w.projectId === p.id && w.branch === pr.branch);
      if (!wt) {
        await ade.addWorktree(p.id, pr.branch.split("/").pop()!, pr.branch, `origin/${pr.branch}`);
        wt = (await ade.getState()).worktrees.find((w) => w.projectId === p.id && w.branch === pr.branch);
      }
      if (!wt) throw new Error("worktree not found after create");
      const id = await ade.addChat(wt.id, key.id, { name: `Review #${pr.number}` });
      onSelect({ type: "chat", id });
      ade.send(id, await ade.skillPrompt("pr-writeup", wt.id, `${pr.number}`)).catch((e) => alert(e.message));
    } catch (e: any) { alert(e.message); } finally { setBusyPr(undefined); }
  };
  const PrRow = ({ pr }: { pr: RepoInfo["prs"][number] }) => (
    <div className="lrow">
      <span className="num">#{pr.number}</span>
      <span className="grow">
        <a href="#" onClick={(e) => { e.preventDefault(); ade.openExternal(pr.url); }}>{pr.title}</a>
        <div className="m">{pr.author} · {pr.branch} · {ago(pr.updatedAt)}{pr.draft ? " · draft" : ""}{pr.review ? ` · ${pr.review.toLowerCase().replace("_", " ")}` : ""}{pr.mine ? ` · ${pr.role}` : ""}</div>
      </span>
      {pr.turn && <span className={"badge turn " + pr.turn} title={pr.why}>{pr.turn === "yours" ? <><Ico n="crown" /> Your turn</> : "Their turn"}</span>}
      {localBranches.has(pr.branch) ? <span className="badge">local</span> : <button onClick={() => setForm({ branch: pr.branch })}>open as worktree</button>}
      <button disabled={busyPr === pr.number} onClick={() => review(pr)}>{busyPr === pr.number ? "…" : "Review"}</button>
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
      {form && <NewWorktreeDialog p={p} branchPreset={form.branch} onClose={() => setForm(false)} onRoot={(id) => onSelect({ type: "worktree", id })} />}

      <h2>Worktrees {archivedN > 0 && <button className="icon" onClick={() => setShowArchived((x) => !x)}>{showArchived ? "hide" : "show"} {archivedN} archived</button>}</h2>
      {!wts.length && <div className="m">No worktrees yet — create one above or open a PR below as a worktree.</div>}
      <div className="grid">{wts.map((w) => <WorktreeCard key={w.id} wt={w} state={state} onSelect={onSelect} onCheckout={() => { setCheckout(w); setCommitMessage(""); setCheckoutError(""); }} />)}</div>

      {checkout && <Dialog title={`Pull ${checkout.title} into root`} onClose={() => { if (!checkoutBusy) setCheckout(undefined); }} footer={<>
        <button disabled={checkoutBusy} onClick={() => setCheckout(undefined)}>Cancel</button>
        <button className="primary" disabled={checkoutBusy || !!root?.dirty} onClick={doCheckout}>{checkoutBusy ? "Pulling into root…" : "Pull into root"}</button>
      </>}>
        <p>Commit changes in this worktree, push {checkout.branch} to origin, then switch {p.path} to that branch and pull. This worktree will be left detached at its pushed commit.</p>
        <Field label="Commit message" optional info="If this worktree has changes, a message is required. All tracked and untracked changes, except ignored files, will be committed first."><input value={commitMessage} disabled={checkoutBusy} onChange={(e) => setCommitMessage(e.target.value)} placeholder="Leave blank if already committed" /></Field>
        <p>Any uncommitted tracked and untracked files (except ignored files) will be included. A commit message is required when there are changes.</p>
        {root?.dirty && <p role="alert">The root has uncommitted changes. Commit or stash them first.</p>}
        {checkoutError && <p role="alert">{checkoutError}</p>}
      </Dialog>}

      <h2>My PRs {info && <span className="m">({mine.length}{info.me ? ` · ${info.me}` : ""})</span>}</h2>
      {!info ? <div className="m">loading from GitHub…</div> : !mine.length ? <div className="m">nothing waiting on you</div> : (
        <div className="card list">{mine.map((pr) => <PrRow key={pr.number} pr={pr} />)}</div>
      )}
      <h2>Other open PRs {info && <span className="m">({others.length})</span>}</h2>
      {!info ? null : !others.length ? <div className="m">none</div> : (
        <div className="card list">{others.map((pr) => <PrRow key={pr.number} pr={pr} />)}</div>
      )}

      <h2>Recent CI runs</h2>
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

function WorktreeCard({ wt, state, onSelect, onCheckout }: { wt: Worktree; state: State; onSelect: (s: Sel) => void; onCheckout?: () => void }) {
  const st = useStatus(wt.id);
  const chats = state.chats.filter((c) => c.worktreeId === wt.id);
  const running = chats.filter((c) => c.running).length;
  return (
    <div className={"card click" + (wt.archived ? " dim" : "")} onClick={() => onSelect({ type: "worktree", id: wt.id })}>
      <div className="t">{wt.title}</div>
      <div className="m mono">{st?.branch ?? wt.branch}</div>
      <Badges st={st} />
      <div className="snip">{chats.length} chat{chats.length === 1 ? "" : "s"}{running ? ` · ${running} running` : ""}{wt.archived ? " · archived" : ""}</div>
      {onCheckout && !wt.root && <button style={{ marginTop: 10 }} disabled={running > 0} title={running ? "Wait for running chats to finish" : "Commit and push this worktree, then switch the root to its branch and pull"} onClick={(e) => { e.stopPropagation(); onCheckout(); }}>Pull into root</button>}
    </div>
  );
}

/* ---------- worktree page ---------- */

const lastText = (c: Chat) => {
  for (let i = c.messages.length - 1; i >= 0; i--)
    for (const b of [...c.messages[i].blocks].reverse()) if (b.type === "text" && b.text.trim()) return b.text.trim();
  return "";
};

function WorktreePage({ wt, state, openForm, onSelect }: { wt: Worktree; state: State; openForm: boolean; onSelect: (s: Sel) => void }) {
  const [revision, setRevision] = useState(0);
  const st = useStatus(wt.id, revision);
  const [committing, setCommitting] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [gitError, setGitError] = useState("");
  const [gitResult, setGitResult] = useState("");
  const runGit = async (push: boolean) => {
    if (!st || busy) return;
    setBusy(true); setGitError(""); setGitResult("");
    try {
      if (push) { await ade.pushWorktree(wt.id, st.branch); setGitResult(`Pushed to origin/${st.branch}.`); }
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
  const chats = state.chats.filter((c) => c.worktreeId === wt.id);
  const siblings = state.worktrees.filter((w) => w.projectId === wt.projectId && w.id !== wt.id && !w.archived);
  const needKey = () => (state.keys.length ? false : (alert("Add an API key first (Settings)"), true));
  const prWriteup = async () => {
    if (needKey()) return;
    const k = state.keys.find((k) => k.provider === "claude") ?? state.keys[0];
    const id = await ade.addChat(wt.id, k.id, { name: `PR write-up · ${wt.title}` });
    onSelect({ type: "chat", id });
    ade.send(id, await ade.skillPrompt("pr-writeup", wt.id)).catch((e) => alert(e.message));
  };
  return (
    <div className="page">
      <div>
        <h1>{wt.root ? "Root" : <><Editable value={wt.title} onSave={(t) => ade.renameWorktree(wt.id, t)} trigger="click" /> <button className="icon" title="Name with AI" onClick={() => ade.autoTitle(wt.id)}><Ico n="star" className="big" /></button></>}</h1>
        <div className="meta-rows">
          <div><span className="badge">{st?.branch ?? wt.branch}</span></div>
          <Badges st={st} />
          <div className="path">{wt.path}</div>
        </div>
      </div>
      <div className="actions">
        <button className="primary" onClick={() => !needKey() && setForm((f) => !f)}><Ico n="quill" /> New chat</button>
        <button onClick={prWriteup}><Ico n="scroll" /> PR write-up</button>
      </div>
      {st && <GitCard st={st} />}
      <div className="actions">
        <button disabled={busy || !st?.dirty || chats.some((c) => c.running)} onClick={() => { setCommitting(true); setGitError(""); }}>Commit…</button>
        <button disabled={busy || !st || chats.some((c) => c.running)} onClick={() => runGit(true)}>{busy ? "Working…" : `Push to origin/${st?.branch ?? wt.branch}`}</button>
      </div>
      {chats.some((c) => c.running) && <div className="m">Commit and push are available when this worktree's chats finish.</div>}
      {!committing && gitError && <div className="error">{gitError}</div>}
      {gitResult && <div role="status">{gitResult}</div>}
      {committing && <Dialog title={`Commit to ${st?.branch ?? wt.branch}`} onClose={() => { if (!busy) setCommitting(false); }} footer={<>
        <button disabled={busy} onClick={() => setCommitting(false)}>Cancel</button>
        <button className="primary" disabled={busy || !message.trim() || chats.some((c) => c.running)} onClick={() => runGit(false)}>{busy ? "Committing…" : "Commit changes"}</button>
      </>}>
        <p>Include all tracked and untracked changes in this worktree. Ignored files are excluded.</p>
        <pre className="files">{st?.files}</pre>
        <Field label="Commit message"><input autoFocus value={message} disabled={busy} onChange={(e) => setMessage(e.target.value)} /></Field>
        {gitError && <div className="error">{gitError}</div>}
      </Dialog>}
      {form && <NewChatForm wt={wt} state={state} onClose={() => setForm(false)} onDone={(id) => { setForm(false); onSelect({ type: "chat", id }); }} />}
      <h2>Chats</h2>
      {!chats.length && <div className="m">No chats in this worktree yet.</div>}
      <div className="grid">
        {chats.map((c) => (
          <div key={c.id} className="card click" onClick={() => onSelect({ type: "chat", id: c.id })}>
            <div className="t">{c.running && <span className="spin" />} {c.name}</div>
            <div className="m">{c.provider} · {c.model} · {c.messages.length} msgs{c.error ? " · error" : ""}</div>
            <div className="snip">{lastText(c) || "—"}</div>
            <MiniBar phase={c.phase} />
          </div>
        ))}
      </div>
      {siblings.length > 0 && (
        <>
          <h2>Other worktrees</h2>
          <div className="grid">{siblings.map((w) => <SiblingCard key={w.id} wt={w} state={state} onSelect={onSelect} />)}</div>
        </>
      )}
    </div>
  );
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
              <div className="m">{pr.draft ? "draft" : pr.state.toLowerCase()}{pr.review ? ` · ${pr.review.toLowerCase().replace("_", " ")}` : ""}{pr.checks ? ` · checks ${pr.checks}` : ""}</div>
            </>
          ) : <div className="m">no PR</div>}
        </div>
      </div>
    </div>
  );
}

function SiblingCard({ wt, state, onSelect }: { wt: Worktree; state: State; onSelect: (s: Sel) => void }) {
  const st = useStatus(wt.id);
  const chats = state.chats.filter((c) => c.worktreeId === wt.id);
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

function NewChatForm({ wt, state, onClose, onDone }: { wt: Worktree; state: State; onClose: () => void; onDone: (id: string) => void }) {
  const [name, setName] = useState(wt.title);
  const [keyId, setKeyId] = useState(state.keys[0]?.id ?? "");
  const provider = state.keys.find((k) => k.id === keyId)?.provider ?? "claude";
  const [model, setModel] = useState(MODELS[provider][0]);
  const [custom, setCustom] = useState(false);
  const [prompt, setPrompt] = useState("");
  useEffect(() => { setModel(MODELS[provider][0]); setCustom(false); }, [provider]);
  const start = async () => {
    const id = await ade.addChat(wt.id, keyId, { name, model });
    if (prompt.trim()) ade.send(id, prompt).catch((e) => alert(e.message));
    onDone(id);
  };
  return (
    <Dialog title="Create a chat" onClose={onClose} footer={<>
      <button onClick={onClose}>Cancel</button>
      <button className="primary" disabled={!keyId || !name || !model} onClick={start}>Create</button>
    </>}>
      <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
      <div className="two">
        <Field label="Key" info="PHI-approved keys are marked">
          <select value={keyId} onChange={(e) => setKeyId(e.target.value)}>
            {state.keys.map((k) => <option key={k.id} value={k.id}>{k.provider}: {k.name}{k.phiAllowed ? " · PHI" : ""}</option>)}
          </select>
        </Field>
        <Field label="Model">
          {custom ? (
            <input autoFocus value={model} placeholder="model id" onChange={(e) => setModel(e.target.value)} onBlur={() => !model && setCustom(false)} />
          ) : (
            <select value={model} onChange={(e) => { if (e.target.value === "__other") { setCustom(true); setModel(""); } else setModel(e.target.value); }}>
              {MODELS[provider].map((m) => <option key={m} value={m}>{m}</option>)}
              <option value="__other">other…</option>
            </select>
          )}
        </Field>
      </div>
      <Field label="Initial prompt" optional info="⌘↩ to create and send">
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="What should this chat do?"
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) start(); }} />
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

function ChatPane({ chat, perms, answer, onOpenMd }: { chat: Chat; perms: PermissionRequest[]; answer: (id: string, ok: boolean) => void; onOpenMd: (p: string) => void }) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [over, setOver] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => { bottom.current?.scrollIntoView({ block: "end" }); }, [chat.messages, perms.length]);
  const send = () => {
    if ((!text.trim() && !files.length) || chat.running) return;
    ade.send(chat.id, text.trim() || "See attached files.", files).catch((e) => alert(e.message));
    setText(""); setFiles([]);
  };
  const addFiles = (paths: string[]) => setFiles((f) => [...new Set([...f, ...paths])]);
  const onDrop = (e: React.DragEvent) => { e.preventDefault(); setOver(false); addFiles(ade.pathsFor([...e.dataTransfer.files])); };
  const i = PHASES.indexOf(chat.phase);
  return (
    <>
      <div className="phases">
        {PHASES.map((p, j) => <div key={p} className={j < i ? "done" : j === i ? "on" : ""} onClick={() => ade.setPhase(chat.id, p)}><Ico n={PHASE_ICON[p]} />{p}</div>)}
      </div>
      <div className="messages">
        {chat.messages.filter((m) => m.blocks.length).map((m) => (
          <div key={m.id} className={"msg " + m.role}>
            {m.blocks.map((b, k) =>
              b.type === "text" ? (
                <div key={k} className="text"><MdLinks text={b.text} onOpen={onOpenMd} /></div>
              ) : (
                <details key={b.id} className="tool">
                  <summary>
                    <b>{b.name}</b> <MdLinks text={b.input.split("\n")[0].slice(0, 100)} onOpen={onOpenMd} />{" "}
                    {b.ok === true && <span className="status-ok">✓</span>}
                    {b.ok === false && <span className="status-err">✗</span>}
                  </summary>
                  <pre>{b.input}</pre>
                  {b.output && <pre>{b.output.slice(0, 4000)}</pre>}
                </details>
              ),
            )}
          </div>
        ))}
        {perms.map((p) => (
          <div key={p.id} className="perm">
            <b><Ico n="celtic" className="big" />Allow {p.tool}?</b>
            <pre>{JSON.stringify(p.input, null, 2)}</pre>
            <button className="primary" onClick={() => answer(p.id, true)}>Allow</button> <button onClick={() => answer(p.id, false)}>Deny</button>
          </div>
        ))}
        <div ref={bottom} />
      </div>
      {chat.error && <div className="error">{chat.error}</div>}
      {files.length > 0 && (
        <div className="chips">{files.map((f) => <span key={f} className="chip">📎 {f.split("/").pop()}<button onClick={() => setFiles((x) => x.filter((y) => y !== f))}>×</button></span>)}</div>
      )}
      {chatStatus(chat) === "running" && <div className="composer-working" role="status"><span className="working-circle" aria-hidden="true" />Working…</div>}
      <div className={"composer" + (over ? " over" : "")} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
        <button className="icon attach" title="Attach files" onClick={async () => addFiles(await ade.pickFiles())}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.5l-8.6 8.6a5 5 0 0 1-7-7l9.2-9.2a3.3 3.3 0 0 1 4.7 4.7L10 18.9a1.6 1.6 0 0 1-2.3-2.3l8.5-8.5" /></svg>
        </button>
        <textarea value={text} rows={1} onChange={(e) => setText(e.target.value)} placeholder={chat.running ? "Draft your next message…" : "Message… ↩ to send, ⇧↩ for a new line"}
          onInput={(e) => { const t = e.currentTarget; t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 220) + "px"; }}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
        <button className="icon enter" title="Send (↩)" disabled={chat.running || (!text.trim() && !files.length)} onClick={send}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20 5v6a3 3 0 0 1-3 3H5" /><path d="M9 10l-4 4 4 4" /></svg>
        </button>
      </div>
    </>
  );
}

/* ---------- drawer ---------- */

type Scope = { id: string; cwd: string; title: string };
function Drawer({ tab, state, chat, worktree, scope, jobs, width, file, onEdit, onView, onClose }: { tab: Tab; state: State; chat?: Chat; worktree?: Worktree; scope?: Scope; jobs: Job[]; width: number; file?: string; onEdit: (p: string) => void; onView: (p: string) => void; onClose: () => void }) {
  return (
    <div className="drawer" style={{ width }}>
      <div className="dhead">
        <span><Ico n={{ terminal: "terminal", diff: "branch", editor: "pencil", markdown: "scroll", artifacts: "scroll", settings: "gear" }[tab]} className="big" /> {tab[0].toUpperCase() + tab.slice(1)}{scope && tab !== "settings" ? ` · ${scope.title}` : ""}</span>
        <button className="icon" onClick={onClose}>×</button>
      </div>
      <div className="dbody">
        {tab === "settings" ? <Settings state={state} />
          : tab === "artifacts" ? (chat ? <ArtifactsView key={chat.id} chat={chat} onOpen={onView} /> : <div className="card">Select a chat to see its artifacts.</div>)
          : tab === "terminal" ? (scope ? <Terminals key={scope.id} scope={scope} jobs={jobs.filter((j) => j.scopeId === scope.id)} /> : <div className="card">Select a project, worktree or chat first.</div>)
          : !worktree ? <div className="card">Select a worktree or chat first.</div>
          : tab === "editor" ? <Editor key={worktree.id + (file ?? "")} worktree={worktree} initial={file} onView={onView} />
          : tab === "markdown" ? <MarkdownView key={worktree.id + (file ?? "")} worktree={worktree} path={file} onEdit={onEdit} />
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
      : <ul>{artifacts.map(({ label, target }) => <li key={target}>
        <button className="artifact-entry" title={target} onClick={() => open(target)} onContextMenu={(e) => { e.preventDefault(); open(target); }}>
          <Ico n="scroll" /><span><strong>{label}</strong>{label !== target && <small>{target}</small>}</span><span aria-hidden="true">›</span>
        </button>
      </li>)}</ul>}
  </div>;
}

const termTabs = new Map<string, string[]>(); // scopeId -> terminal ids (session-lived)
function Terminals({ scope, jobs }: { scope: Scope; jobs: Job[] }) {
  const [tabs, setTabs] = useState<string[]>(() => termTabs.get(scope.id) ?? ["t1"]);
  const [cur, setCur] = useState(tabs[0]);
  useEffect(() => { termTabs.set(scope.id, tabs); if (!tabs.includes(cur)) setCur(tabs[tabs.length - 1]); }, [tabs]);
  const add = () => { const id = "t" + (Date.now() % 100000); setTabs((t) => [...t, id]); setCur(id); };
  const close = (id: string) => {
    jobs.filter((j) => j.termId === id).forEach((j) => ade.jobRemove(j.id));
    setTabs((t) => (t.length > 1 ? t.filter((x) => x !== id) : t));
  };
  return (
    <div className="terms">
      <div className="termtabs">
        {tabs.map((id, i) => {
          const live = jobs.some((j) => j.termId === id && j.status === "running");
          const bad = id !== cur && jobs.some((j) => j.termId === id && isUnseenFailure(j));
          return (
            <span key={id} className={"termtab" + (id === cur ? " on" : "")} onClick={() => setCur(id)}>
              {live && <span className="live" />}{bad && <span className="live dead" />}{i + 1}
              {tabs.length > 1 && <button className="icon" title="Close terminal" onClick={(e) => { e.stopPropagation(); close(id); }}>×</button>}
            </span>
          );
        })}
        <button className="icon" title="New terminal" onClick={add}>＋</button>
      </div>
      <Terminal key={cur} scope={scope} termId={cur} jobs={jobs.filter((j) => j.termId === cur)} />
    </div>
  );
}

// ponytail: one transcript + inline prompt over spawned jobs; node-pty + xterm if you need a true shell
function Terminal({ scope, termId, jobs }: { scope: Scope; termId: string; jobs: Job[] }) {
  const [line, setLine] = useState("");
  const [hist, setHist] = useState(-1);
  const [echo, setEcho] = useState<Record<string, string[]>>({});
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const running = jobs.find((j) => j.status === "running");
  const cmds = jobs.map((j) => j.cmd);
  useEffect(() => { const el = box.current; if (el) el.scrollTop = el.scrollHeight; }, [jobs, echo]);
  useEffect(() => { jobs.filter(isUnseenFailure).forEach((j) => ade.jobSeen(j.id)); }, [jobs]); // viewing the transcript clears the red dot
  const submit = () => {
    if (running) { ade.jobWrite(running.id, line + "\n"); setEcho((e) => ({ ...e, [running.id]: [...(e[running.id] ?? []), line] })); }
    else if (line.trim()) { if (line.trim() === "clear") { jobs.forEach((j) => ade.jobRemove(j.id)); } else ade.jobStart(scope.id, scope.cwd, line, termId); }
    setLine(""); setHist(-1);
  };
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === "c" && !window.getSelection()?.toString()) { e.preventDefault(); if (running) ade.jobStop(running.id); else setLine(""); return; }
    if (mod && e.key === "k") { e.preventDefault(); jobs.filter((j) => j.status !== "running").forEach((j) => ade.jobRemove(j.id)); return; }
    if (e.key === "Enter") { e.preventDefault(); submit(); return; }
    if (!running && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      const n = e.key === "ArrowUp" ? Math.min(hist + 1, cmds.length - 1) : Math.max(hist - 1, -1);
      setHist(n); setLine(n < 0 ? "" : cmds[cmds.length - 1 - n]);
    }
  };
  return (
    <div className="tty" onClick={() => input.current?.focus()}>
      <div className="ttyhead">{scope.cwd}</div>
      <div className="ttybody" ref={box}>
        {jobs.map((j) => (
          <div key={j.id} className="ttyjob">
            <div className="ttycmd"><span className="prompt">$</span> {j.cmd}{j.status === "running" && <span className="live" />}</div>
            {j.out && <pre>{j.out}</pre>}
            {(echo[j.id] ?? []).map((t, i) => <div key={i} className="ttyecho">› {t}</div>)}
            {j.status === "exited" && j.code !== 0 && <div className="ttyexit">[{j.code === -1 || j.code == null ? "stopped" : `exit ${j.code}`}]</div>}
          </div>
        ))}
        <div className="ttyline">
          <span className="prompt">{running ? "›" : "$"}</span>
          <input ref={input} value={line} onChange={(e) => setLine(e.target.value)} onKeyDown={onKey} autoFocus spellCheck={false}
            placeholder={running ? "stdin · ^C stops" : jobs.length ? "" : "type a command"} />
        </div>
      </div>
    </div>
  );
}

type Node = { name: string; path: string; children?: Node[] };
function buildTree(files: string[]): Node[] {
  const root: Node[] = [];
  for (const f of files) {
    let level = root, acc = "";
    const parts = f.split("/");
    parts.forEach((part, i) => {
      acc = acc ? `${acc}/${part}` : part;
      let n = level.find((x) => x.name === part);
      if (!n) { n = i < parts.length - 1 ? { name: part, path: acc, children: [] } : { name: part, path: acc }; level.push(n); }
      level = n.children ?? level;
    });
  }
  const sort = (ns: Node[]) => { ns.sort((a, b) => Number(!!b.children) - Number(!!a.children) || a.name.localeCompare(b.name)); ns.forEach((n) => n.children && sort(n.children)); };
  sort(root);
  return root;
}
function FileTree({ files, current, onOpen }: { files: string[]; current: string; onOpen: (p: string) => void }) {
  const tree = React.useMemo(() => buildTree(files), [files]);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const toggle = (p: string) => setOpen((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; });
  const Row = ({ n, depth }: { n: Node; depth: number }) => (
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
function Editor({ worktree, initial, onView }: { worktree: Worktree; initial?: string; onView: (p: string) => void }) {
  const [files, setFiles] = useState<string[]>([]);
  const [path, setPath] = useState("");
  const [text, setText] = useState("");
  const [saved, setSaved] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => { ade.listFiles(worktree.id).then(setFiles); if (initial) open(initial); }, [worktree.id]);
  const open = async (p: string) => { const t = await ade.readFile(worktree.id, p).catch((e) => `// ${e.message}`); setPath(p); setText(t); setSaved(t); setQ(""); };
  const save = async () => { await ade.writeFile(worktree.id, path, text); setSaved(text); };
  const dirty = text !== saved;
  const hits = q ? files.filter((f) => f.toLowerCase().includes(q.toLowerCase())).slice(0, 30) : [];
  return (
    <div className="card editor">
      <div className="ebar">
        <input value={q || path} placeholder="find a file…" onChange={(e) => setQ(e.target.value)} onFocus={(e) => e.target.select()} />
        {path.endsWith(".md") && <button onClick={() => onView(path)}>View</button>}
        <button className="primary" disabled={!path || !dirty} onClick={save}>{dirty ? "Save ⌘S" : "Saved"}</button>
      </div>
      {hits.length > 0 && <div className="hits">{hits.map((f) => <div key={f} className="hit" onMouseDown={() => open(f)}>{f}</div>)}</div>}
      {!q && <FileTree files={files} current={path} onOpen={open} />}
      {path && (
        <textarea className="code" value={text} spellCheck={false} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); if (dirty) save(); }
            if (e.key === "Tab") { e.preventDefault(); const t = e.currentTarget, a = t.selectionStart, b = t.selectionEnd; setText(text.slice(0, a) + "  " + text.slice(b)); requestAnimationFrame(() => t.setSelectionRange(a + 2, a + 2)); }
          }} />
      )}
      {!path && !hits.length && !files.length && <div className="m">No files.</div>}
    </div>
  );
}

function MarkdownView({ worktree, path: initial, onEdit }: { worktree: Worktree; path?: string; onEdit: (p: string) => void }) {
  const [path, setPath] = useState(initial);
  const [preview, setPreview] = useState<Awaited<ReturnType<Api["previewArtifact"]>>>();
  const [err, setErr] = useState<string>();
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setPreview(undefined); setErr(undefined);
    if (path) ade.previewArtifact(worktree.id, path).then((p) => { if (active) setPreview(p); }, (e) => { if (active) setErr(e.message); });
    return () => { active = false; };
  }, [worktree.id, path, reload]);
  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("#")) return;
    const dir = path!.includes("/") ? path!.slice(0, path!.lastIndexOf("/") + 1) : "";
    const target = /^(?:[a-z]+:|\/|~\/)/i.test(href) ? href : dir + href;
    ade.artifactMenu(worktree.id, target).then((action) => { if (action === "open") setPath(target); }).catch((e) => setErr(e.message));
  };
  if (!path) return <div className="card">Open a linked file in a chat to preview it here.</div>;
  return (
    <div className="mdwrap">
      <div className="ebar">
        <span className="grow mono" title={path}>{path}</span>
        <button className="icon" title="Reload" onClick={() => setReload((n) => n + 1)}>↻</button>
        <button onClick={() => ade.artifactMenu(worktree.id, path).catch((e) => setErr(e.message))}>Actions</button>
        {preview && ["text", "markdown", "html"].includes(preview.kind) && <button onClick={() => onEdit(path)}>Edit</button>}
      </div>
      {err ? <div className="error">{err}</div> : !preview ? <div className="m">loading…</div>
        : preview.kind === "markdown" ? <article className="md" onClick={onClick} dangerouslySetInnerHTML={{ __html: marked.parse(preview.content) as string }} />
        : preview.kind === "image" ? <img className="artifact-image" src={preview.content} alt={path} />
        : preview.kind === "html" ? <iframe className="artifact-frame" title={path} sandbox="" srcDoc={preview.content} />
        : preview.kind === "url" || preview.kind === "pdf" ? <iframe className="artifact-frame" title={path} sandbox="" src={preview.content} />
        : <pre className="artifact-text">{preview.content}</pre>}
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

function Settings({ state }: { state: State }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<"claude" | "codex">("claude");
  const [key, setKey] = useState("");
  const [auth, setAuth] = useState<"login" | "key">("login");
  const [phi, setPhi] = useState(false);
  const [status, setStatus] = useState<Record<string, { loggedIn: boolean; detail: string }>>({});
  const refreshStatus = () => { for (const p of ["claude", "codex"] as const) ade.authStatus(p).then((r) => setStatus((s) => ({ ...s, [p]: r }))); };
  useEffect(refreshStatus, []);
  const Status = ({ p }: { p: "claude" | "codex" }) => {
    const st = status[p];
    return <span className={"m status " + (st?.loggedIn ? "ok" : "bad")}>{!st ? "checking…" : (st.loggedIn ? "● signed in" : "○ ") + (st.detail ? ` ${st.detail}` : "")}</span>;
  };
  const add = async () => {
    await ade.addKey(name || (auth === "login" ? `${provider} login` : provider), provider, auth === "key" ? key : "", phi);
    setName(""); setKey(""); setPhi(false); setAdding(false);
  };
  return (
    <>
      <div className="card">
        <h4><Ico n="fleur" />AI API keys <button className="icon" title="Add key" onClick={() => setAdding(true)}>＋</button></h4>
        {state.keys.map((k) => (
          <div key={k.id} className="krow">
            <span className="grow">{k.name} <span className="badge">{k.provider}</span> <span className="badge" title={k.auth === "login" ? "Uses the provider CLI's own sign-in (your subscription)" : "API key, billed per token"}>{k.auth === "login" ? "subscription login" : "api key"}</span>
              {k.auth === "login" && <div><Status p={k.provider} /></div>}</span>
            <label className="check" style={{ color: "var(--dim)", fontSize: 12 }}>
              <input type="checkbox" checked={k.phiAllowed} onChange={(e) => ade.setKeyPhi(k.id, e.target.checked)} /> PHI allowed
            </label>
            <button onClick={() => confirm(`Remove key ${k.name}?`) && ade.removeKey(k.id)}>remove</button>
          </div>
        ))}
        {!state.keys.length && <div style={{ color: "var(--dim)" }}>No keys yet.</div>}
      </div>
      <div className="card">
        <h4><Ico n="butterfly" />Appearance</h4>
        <div className="krow">
          <span className="grow">Mode</span>
          <div className="seg">
            {(["dark", "light"] as const).map((t) => <button key={t} className={state.appearance.theme === t ? "on" : ""} onClick={() => ade.setAppearance({ theme: t })}><Ico n={t === "dark" ? "moon" : "sun"} /> {t}</button>)}
          </div>
        </div>
        <div className="krow">
          <span className="grow">Background</span>
          <div className="seg">
            {([["opaque", "opaque"], ["frost", "frosted"], ["frost2", "frosted+"]] as const).map(([v, l]) => <button key={v} className={state.appearance.background === v ? "on" : ""} onClick={() => ade.setAppearance({ background: v })}>{l}</button>)}
          </div>
        </div>
      </div>
      {adding && (
        <Dialog title="Add an API key" onClose={() => setAdding(false)} footer={<>
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
            <Field label="Label" optional><input placeholder={auth === "login" ? `${provider} login` : "e.g. claude-phi"} value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
          </div>
          <Field label="Auth" info={provider === "claude" ? "Login = the same sign-in as running `claude` in your terminal (Max/Pro subscription). Run `claude` once and /login if you haven't." : "Login = `codex login` (ChatGPT account). Run it once in a terminal."}>
            <select value={auth} onChange={(e) => setAuth(e.target.value as any)}>
              <option value="login">{provider === "claude" ? "Claude Code login (subscription)" : "Codex CLI login (ChatGPT)"}</option>
              <option value="key">API key</option>
            </select>
            {auth === "login" && <div><Status p={provider} /> <button className="icon" onClick={refreshStatus}>↻</button></div>}
          </Field>
          {auth === "key" && (
            <Field label="Key" info="Encrypted at rest via macOS keychain.">
              <input type="password" placeholder="sk-…" value={key} onChange={(e) => setKey(e.target.value)} />
            </Field>
          )}
          <Field label="Compliance" info="Chats on a non-PHI key will stop and switch to a PHI key before touching PHI">
            <label className="check"><input type="checkbox" checked={phi} onChange={(e) => setPhi(e.target.checked)} /> PHI allowed</label>
          </Field>
        </Dialog>
      )}
    </>
  );
}
