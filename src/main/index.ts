import { startDockerRecovery } from "./dockerLifecycle";
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell, Notification, Menu } from "electron";
import { join, basename, resolve, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { store } from "./store";
import { PermissionNotifications } from "./permissionNotifications";
import * as git from "./git";
import { ensureRootWorktree, isRootWorktree } from "./rootWorktree";
import { hooksDirectory, localEnvFiles, prepareWorktree } from "./worktreeFiles";
import { installCommand } from "./worktreeInstall";
import * as agents from "./agents";
import { browserLaunch, type BrowserInfo } from "./openArtifact";
import { isScratch, scratchWorktree } from "../shared/scratch";
import { isWorkspace, repoDirs, reposForPr, slugify, workspaceSources } from "../shared/workspace";
import * as ws from "./workspaces";
import { probeClaudeModels } from "./claudeModels";
import { forgetCodexModels } from "./codexModels";
import type { Project, RepoResult, RepoStatus, WorkspaceStatus, Worktree } from "../shared/types";
import { askOnce, humanize, suggestTitle } from "./namer";
import { parsePrSuggestion, prSuggestionPrompt } from "../shared/createPr";
import { commitFromChat } from "./commitChat";
import { authLoginCmd, authStatus } from "./auth";
import { formatDuration } from "./ptyMarkers";
import { usage } from "./usage";
import * as ptys from "./ptys";
import { chatStatus } from "../shared/chatStatus";
import { REMINDER_CHOICES, reminderDue } from "../shared/reminders";
import { topContributor } from "../shared/contributors";
import { issueBriefPrompt } from "../shared/issues";
import { askSide } from "./sideChat";
import { Reminders } from "./reminders";
import { Notifier, type Notice } from "../shared/notices";
import { SETUP_TERM, setupDoneNotice, setupStartNotice } from "../shared/worktreeSetup";
import { findReview, readReview, reinvestigate, reviewDrift, setFinding, setFixRequest, submitReview, ReviewWatchers } from "./prReview";
import { fixPrompt } from "../shared/review";
import { pickReviewChat } from "../shared/reviewRunner";
import { defaultConnector, selectedModel } from "../shared/defaultConnector";
import { modelTiers } from "../shared/modelTiers";
import { MODELS, type Api, type Appearance, type PrDraft } from "../shared/types";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";

// ADE_DATA_DIR isolates state for test instances
// GUI apps get a bare PATH; borrow the login shell's so git/gh/claude resolve like in a terminal
try {
  const shellPath = execFileSync(process.env.SHELL || "/bin/zsh", ["-ilc", "echo -n \"$PATH\""], { timeout: 5000, env: { ...process.env, DISABLE_AUTO_UPDATE: "true" } }).toString().trim();
  if (shellPath) process.env.PATH = shellPath;
} catch {}
for (const d of ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin", join(process.env.HOME ?? "", ".local/bin")])
  if (!process.env.PATH?.split(":").includes(d)) process.env.PATH = `${process.env.PATH}:${d}`;

// keep the pre-productName identity ("ade"): same data dir, and the same "ade Safe Storage" keychain item for secrets
app.setName("ade");
// keep the pre-productName data dir ("ade") so existing keys/projects survive the rename
app.setPath("userData", process.env.ADE_DATA_DIR ?? join(app.getPath("appData"), "ade"));

let win: BrowserWindow;
let reminders: Reminders | undefined;
// a review file changed on disk (an agent wrote it, or a status was saved): tell the open viewer
const reviewWatchers = new ReviewWatchers((path) => { if (win && !win.isDestroyed()) win.webContents.send("reviewChanged", path); });
let activeChat: string | null = null;
const isActive = () => !!win && !win.isDestroyed() && win.isFocused() && win.isVisible() && !win.isMinimized();
const isViewing = (id: string) => activeChat === id && isActive();
function acknowledgeChat() {
  const chat = store.data.chats.find((c) => c.id === activeChat);
  if (!chat || !isViewing(chat.id)) return;
  // opening the chat is coming back to it, which is all a due reminder was asking for.
  // One still counting down stays: it is an appointment, not a mark on an unread chat.
  const reminderLanded = reminderDue(chat.remindAt, Date.now());
  if (!chat.unreadCompletion && !reminderLanded) return;
  chat.unreadCompletion = false;
  if (reminderLanded) chat.remindAt = undefined;
  store.save();
}


// macOS vibrancy: the renderer paints translucent backgrounds when frosted
const VIBRANCY: Record<Appearance["background"], Parameters<BrowserWindow["setVibrancy"]>[0]> = { opaque: null, frost: "under-window", frost2: "hud" };
const effectiveTheme = () => { const t = store.data.appearance.theme; return t === "auto" ? (nativeTheme.shouldUseDarkColors ? "dark" : "light") : t; };
function applyAppearance() {
  const a = store.data.appearance;
  if (!win || win.isDestroyed()) return;
  win.setVibrancy(VIBRANCY[a.background]);
  win.setBackgroundColor(a.background === "opaque" ? (effectiveTheme() === "light" ? "#f3ead6" : "#0a0a0a") : "#00000000");
  win.webContents.send("theme", effectiveTheme());
}
nativeTheme.on("updated", () => { if (store.data.appearance.theme === "auto") applyAppearance(); });
function createWindow() {
  const a = store.data.appearance;
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    titleBarStyle: "hiddenInset",
    vibrancy: VIBRANCY[a.background] ?? undefined,
    backgroundColor: a.background === "opaque" ? ((a.theme === "auto" ? (nativeTheme.shouldUseDarkColors ? "dark" : "light") : a.theme) === "light" ? "#f3ead6" : "#0a0a0a") : "#00000000",
    webPreferences: { preload: join(import.meta.dirname, "../preload/index.mjs"), sandbox: false },
  });
  win.on("blur", () => { activeChat = null; });
  win.webContents.on("did-start-loading", () => { activeChat = null; });
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
}

/** where repoless chats keep their folders: inside the app's data directory, out of the user's way */
const scratchRoot = () => join(app.getPath("userData"), "chats");

function artifactPath(id: string, target: string) {
  let path = target.replace(/:\d+(?::\d+)?$/, "").split("#")[0];
  if (path.startsWith("file:")) return fileURLToPath(path);
  path = decodeURIComponent(path);
  if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
  return resolve(wt(id).path, path);
}

const statusCache = new Map<string, { t: number; p: Promise<unknown> }>();
const repoCache = new Map<string, { t: number; p: Promise<unknown> }>();
const wt = (id: string) => store.data.worktrees.find((w) => w.id === id)!;
const project = (id: string) => store.data.projects.find((p) => p.id === id)!;

/**
 * Where Consort keeps what it checks out: single-project worktrees under worktrees/<repo>, and
 * multi-repo workspaces under workspaces/<name>, both inside the app's data directory rather
 * than the repo. That works the same on every machine and keeps checkouts out of the repo tree.
 */
const libraryDir = (...parts: string[]) => join(app.getPath("userData"), ...parts);
const worktreesRoot = (p: Project) => libraryDir("worktrees", basename(p.path));
const workspacesRoot = () => libraryDir("workspaces");

/** the repos of a workspace as git targets; a source project that was removed is skipped */
const targetsOf = (p: Project): ws.RepoTarget[] =>
  workspaceSources(store.data, p).map(({ project: src, dir, path }) => ({ projectId: src.id, name: src.name, dir, path, repo: src.path, base: src.defaultBase }));
/** the workspace project a worktree belongs to, if it is a workspace's scope */
const workspaceOf = (w: Worktree | undefined): Project | undefined => {
  if (!w?.workspace) return undefined;
  const p = store.data.projects.find((p) => p.id === w.projectId);
  return p && isWorkspace(p) ? p : undefined;
};
const wsStatusCache = new Map<string, { t: number; p: Promise<WorkspaceStatus | null> }>();

async function syncWorktrees(projectId: string) {
  const p = project(projectId);
  if (!p || isWorkspace(p)) return; // a workspace's checkouts belong to its source repos
  const live = await git.listWorktrees(p.path);
  ensureRootWorktree(store.data.worktrees, p, live.find((w) => w.path === p.path)?.branch ?? "(detached)");
  const mine = store.data.worktrees.filter((w) => w.projectId === projectId);
  for (const l of live) {
    const w = mine.find((w) => w.path === l.path);
    if (w) w.branch = l.branch;
    else {
      const nw = { id: randomUUID(), projectId, title: humanize(l.branch), archived: false, ...l };
      store.data.worktrees.push(nw);
      suggestTitle(nw.path, nw.branch).then((t) => { if (nw.title === humanize(nw.branch)) { nw.title = t; store.save(); } });
    }
  }
  // Worktrees made before this, or outside Consort, still need the repo's env files and
  // its generated hook runner. Scan the repo once, then fill in whatever each one is missing.
  const [env, hooks] = await Promise.all([
    localEnvFiles(p.path).catch(() => [] as string[]),
    hooksDirectory(p.path).catch(() => undefined),
  ]);
  if (env.length || hooks) {
    await Promise.all(
      live.filter((l) => l.path !== p.path).map((l) => prepareWorktree(p.path, l.path, { env, hooks })),
    );
  }
  store.data.worktrees = store.data.worktrees.filter(
    (w) => w.projectId !== projectId || w.root || live.some((l) => l.path === w.path),
  );
  const alive = new Set(store.data.worktrees.map((w) => w.id));
  store.data.chats = store.data.chats.filter((c) => alive.has(c.worktreeId));
}

/**
 * Give a new worktree the dependencies the repo already has. Workspace packages are linked
 * relatively, so a worktree cannot borrow the repo's `node_modules` without resolving into
 * the repo's own checkout — it needs its own, which a warm store makes cheap.
 *
 * Runs in a terminal of its own so the work is visible and interruptible, and starts here
 * rather than waiting for the drawer to be opened.
 */
let notify: (n: Notice) => void = () => {};

function startInstall(scopeId: string, repo: string, path: string) {
  installCommand(repo, path)
    .then(async (command) => {
      if (!command) return;
      const id = await ptys.create(scopeId, SETUP_TERM, path, 120, 30);
      // Same grace the renderer gives a new shell before typing into it.
      setTimeout(() => ptys.write(id, `${command}\r`), 700);
      // nobody asked for this run, so it announces itself; its finish is announced from onCommandDone
      notify(setupStartNotice(store.data.worktrees.find((w) => w.id === scopeId)?.title ?? "the new worktree", command, scopeId));
    })
    .catch((error) => console.error("worktree install failed to start", error));
}

const handlers: { [K in keyof Api]?: (...a: any[]) => any } = {
  getState: () => store.public(),
  effectiveTheme: () => effectiveTheme(),
  rootBranches: (id: string) => git.rootBranches(project(id).path),
  switchRootBranch: async (id: string, expectedBranch: string | null, ref: string) => {
    const p = project(id);
    const roots = store.data.worktrees.filter((w) => w.projectId === id && isRootWorktree(w, p));
    if (store.data.chats.some((c) => roots.some((w) => w.id === c.worktreeId) && c.running)) throw new Error("Wait for root chats to finish before switching branches.");
    try { return await git.switchRootBranch(p.path, expectedBranch, ref); }
    finally {
      const current = await git.rootStatus(p.path).catch(() => null);
      if (current) ensureRootWorktree(store.data.worktrees, p, current.branch ?? "(detached)");
      for (const w of roots) statusCache.delete(w.id);
      repoCache.delete(id);
      store.save();
    }
  },
  rootStatus: (id: string) => git.rootStatus(project(id).path),
  checkoutAtRoot: async (id: string, commitMessage?: string) => {
    const w = wt(id);
    if (!w) throw new Error("Worktree no longer exists.");
    if (isRootWorktree(w, project(w.projectId))) throw new Error("This entry already works at root.");
    const rootIds = new Set(store.data.worktrees.filter((entry) => entry.projectId === w.projectId && isRootWorktree(entry, project(w.projectId))).map((entry) => entry.id));
    if (store.data.chats.some((c) => (c.worktreeId === id || rootIds.has(c.worktreeId)) && c.running)) throw new Error("Wait for chats in this worktree and root to finish before checking out at root.");
    try {
      return await git.checkoutAtRoot(project(w.projectId).path, w.path, commitMessage);
    } finally {
      statusCache.delete(id);
      const current = await git.rootStatus(w.path).catch(() => null);
      if (current) w.branch = current.branch ?? "(detached)";
      const root = store.data.worktrees.find((entry) => entry.projectId === w.projectId && entry.root);
      if (root) {
        statusCache.delete(root.id);
        const status = await git.rootStatus(root.path).catch(() => null);
        if (status) root.branch = status.branch ?? "(detached)";
      }
      store.save();
    }
  },
  commitWorktree: async (id: string, branch: string, message: string) => {
    const w = wt(id);
    if (!w) throw new Error("Worktree no longer exists.");
    if (store.data.chats.some((c) => c.worktreeId === id && c.running)) throw new Error("Wait for this worktree's chats to finish before committing.");
    try { return await git.commitWorktree(w.path, branch, message); }
    finally { statusCache.delete(id); }
  },
  pullWorktree: async (id: string, branch: string) => {
    const w = wt(id);
    if (!w) throw new Error("Worktree no longer exists.");
    if (store.data.chats.some((c) => c.worktreeId === id && c.running)) throw new Error("Wait for this worktree's chats to finish before pulling.");
    try { return await git.pullWorktree(w.path, branch); }
    finally { statusCache.delete(id); git.forgetRemoteStatus(w.path); repoCache.delete(w.projectId); git.forgetRepoInfo(project(w.projectId).path); store.save(); }
  },
  pushWorktree: async (id: string, branch: string) => {
    const w = wt(id);
    if (!w) throw new Error("Worktree no longer exists.");
    if (store.data.chats.some((c) => c.worktreeId === id && c.running)) throw new Error("Wait for this worktree's chats to finish before pushing.");
    try { return await git.pushWorktree(w.path, branch); }
    finally { statusCache.delete(id); git.forgetRemoteStatus(w.path); }
  },
  createPr: async (id: string, branch: string, draft: PrDraft) => {
    const w = wt(id);
    if (!w) throw new Error("Worktree no longer exists.");
    if (store.data.chats.some((c) => c.worktreeId === id && c.running)) throw new Error("Wait for this worktree's chats to finish before opening a PR.");
    try { return await git.createPr(w.path, branch, project(w.projectId).defaultBase, draft); }
    finally { statusCache.delete(id); git.forgetRemoteStatus(w.path); repoCache.delete(w.projectId); git.forgetRepoInfo(project(w.projectId).path); }
  },
  commitAndPushRoot: async (id: string, branch: string, message: string) => {
    const w = wt(id);
    if (!w || !isRootWorktree(w, project(w.projectId))) throw new Error("Root worktree no longer exists.");
    if (store.data.chats.some((c) => c.worktreeId === id && c.running)) throw new Error("Wait for root chats to finish before committing and pushing.");
    try { return await git.commitAndPushRoot(w.path, branch, message); }
    finally { statusCache.delete(id); repoCache.delete(w.projectId); git.forgetRepoInfo(project(w.projectId).path); }
  },
  setActiveChat: (id: string | null) => {
    activeChat = id;
    acknowledgeChat();
  },
  pickFolder: async () => {
    const r = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
    return r.canceled ? null : r.filePaths[0];
  },
  addProject: async (path: string) => {
    if (!(await git.isRepo(path))) throw new Error("not a git repo");
    if (store.data.projects.some((p) => p.path === path)) return;
    const id = randomUUID();
    store.data.projects.push({ id, name: basename(path), path, defaultBase: "origin/main" });
    await syncWorktrees(id);
    store.save();
  },
  removeProject: async (id: string) => {
    const p = project(id);
    // a workspace owns its checkouts: hand each back to its source repo and drop the folder
    if (p && isWorkspace(p)) await ws.removeWorkspaceTree(p.path, targetsOf(p));
    const wts = store.data.worktrees.filter((w) => w.projectId === id).map((w) => w.id);
    store.data.chats = store.data.chats.filter((c) => !wts.includes(c.worktreeId));
    store.data.worktrees = store.data.worktrees.filter((w) => w.projectId !== id);
    store.data.projects = store.data.projects.filter((p) => p.id !== id);
    store.save();
  },
  setProjectBase: (id: string, base: string) => {
    Object.assign(project(id), { defaultBase: base, baseSetByUser: true });
    store.save();
  },
  syncWorktrees: async (id: string) => {
    await syncWorktrees(id);
    store.save();
  },
  openRootWorktree: async (projectId: string) => {
    const p = project(projectId);
    if (!p) throw new Error("Project no longer exists.");
    const current = await git.rootStatus(p.path);
    const root = ensureRootWorktree(store.data.worktrees, p, current.branch ?? "(detached)");
    store.save();
    return root.id;
  },
  addWorktree: async (projectId: string, name: string, branch: string, base: string) => {
    const repo = project(projectId).path;
    const path = await git.addWorktree(repo, name, branch, base, worktreesRoot(project(projectId)));
    // The tree is already on disk; a copy failure must not undo it.
    await prepareWorktree(repo, path);
    await syncWorktrees(projectId);
    store.save();
    const created = store.data.worktrees.find((w) => w.path === path);
    if (created) startInstall(created.id, repo, path);
  },
  removeWorktree: async (id: string) => {
    const w = store.data.worktrees.find((w) => w.id === id)!;
    if (isRootWorktree(w, project(w.projectId))) throw new Error("The project root cannot be deleted as a worktree.");
    await git.removeWorktree(project(w.projectId).path, w.path);
    store.data.chats = store.data.chats.filter((c) => c.worktreeId !== id);
    await syncWorktrees(w.projectId);
    store.save();
  },
  autoTitle: async (id: string) => {
    const w = wt(id);
    if (w.root) return;
    w.title = await suggestTitle(w.path, w.branch);
    store.save();
  },
  renameWorktree: (id: string, title: string) => {
    if (wt(id).root) return;
    wt(id).title = title.trim() || wt(id).name;
    store.save();
  },
  archiveWorktree: (id: string, on: boolean) => {
    const w = wt(id);
    if (isRootWorktree(w, project(w.projectId))) throw new Error("The project root cannot be archived.");
    w.archived = on;
    store.save();
  },
  // ponytail: 20s cache so sidebar + page + cards polling don't hammer gh
  // ---- workspaces: several repos, one branch, one chat scope
  addWorkspace: async (name: string, branch: string, projectIds: string[]) => {
    const title = name.trim(), ref = branch.trim();
    if (!title) throw new Error("Name the workspace.");
    if (!ref) throw new Error("Enter the branch to check out in every repo.");
    const sources = projectIds.map((id) => store.data.projects.find((p) => p.id === id)).filter((p): p is Project => !!p && !isWorkspace(p));
    if (sources.length < 2) throw new Error("Pick at least two projects.");
    const slug = slugify(title);
    if (store.data.projects.some((p) => isWorkspace(p) && basename(p.path) === slug)) throw new Error(`A workspace folder named ${slug} already exists.`);
    const root = join(workspacesRoot(), slug);
    const repos = repoDirs(sources);
    const targets = await ws.createWorkspaceTree(root, ref, repos.map(({ projectId, dir }) => {
      const src = sources.find((s) => s.id === projectId)!;
      return { projectId, name: src.name, dir, repo: src.path, base: src.defaultBase };
    }));
    const id = randomUUID(), wtId = randomUUID();
    store.data.projects.push({ id, name: title, path: root, defaultBase: "", kind: "workspace", branch: ref, repos });
    store.data.worktrees.push({ id: wtId, projectId: id, name: slug, title, path: root, branch: ref, archived: false, workspace: true });
    store.save();
    // env files and installs per repo, same as any new worktree; the terminal scope is the workspace
    for (const t of targets) {
      const src = sources.find((s) => s.id === t.projectId)!;
      prepareWorktree(src.path, t.path).catch(() => {}).then(() => startInstall(wtId, src.path, t.path));
    }
    return wtId;
  },
  workspaceStatus: (projectId: string) => {
    const p = store.data.projects.find((p) => p.id === projectId);
    if (!p || !isWorkspace(p)) return null;
    const hit = wsStatusCache.get(projectId);
    if (hit && Date.now() - hit.t < 20_000) return hit.p;
    const promise = ws.workspaceStatuses(targetsOf(p))
      .then((rows): WorkspaceStatus => ({ branch: p.branch ?? "", repos: rows.map(({ target, status }): RepoStatus => ({ projectId: target.projectId, name: target.name, dir: target.dir, path: target.path, status })) }))
      .catch(() => null);
    wsStatusCache.set(projectId, { t: Date.now(), p: promise });
    return promise;
  },
  commitWorkspace: async (projectId: string, message: string) => {
    const p = project(projectId);
    if (!p || !isWorkspace(p)) throw new Error("Workspace no longer exists.");
    if (store.data.chats.some((c) => c.running && store.data.worktrees.find((w) => w.id === c.worktreeId)?.projectId === projectId)) throw new Error("Wait for this workspace's chats to finish before committing.");
    try { return await ws.commitAll(targetsOf(p), p.branch ?? "", message); }
    finally { wsStatusCache.delete(projectId); for (const t of targetsOf(p)) git.forgetRemoteStatus(t.path); }
  },
  pullWorkspace: async (projectId: string) => {
    const p = project(projectId);
    if (!p || !isWorkspace(p)) throw new Error("Workspace no longer exists.");
    try { return await ws.pullAll(targetsOf(p), p.branch ?? ""); }
    finally { wsStatusCache.delete(projectId); for (const t of targetsOf(p)) git.forgetRemoteStatus(t.path); }
  },
  pushWorkspace: async (projectId: string) => {
    const p = project(projectId);
    if (!p || !isWorkspace(p)) throw new Error("Workspace no longer exists.");
    try { return await ws.pushAll(targetsOf(p), p.branch ?? ""); }
    finally { wsStatusCache.delete(projectId); for (const t of targetsOf(p)) git.forgetRemoteStatus(t.path); }
  },
  createWorkspacePrs: async (projectId: string, draft: PrDraft): Promise<RepoResult[]> => {
    const p = project(projectId);
    if (!p || !isWorkspace(p)) throw new Error("Workspace no longer exists.");
    const status = await handlers.workspaceStatus!(projectId);
    const eligible = new Set(reposForPr(status).map((r) => r.dir));
    const targets = targetsOf(p).filter((t) => eligible.has(t.dir));
    if (!targets.length) throw new Error("No repo has commits to open a PR for.");
    try { return await ws.createPrs(targets, p.branch ?? "", draft, p.name); }
    finally { wsStatusCache.delete(projectId); for (const t of targets) { git.forgetRemoteStatus(t.path); repoCache.delete(t.projectId); git.forgetRepoInfo(t.repo); } }
  },
  worktreeStatus: (id: string) => {
    const w = store.data.worktrees.find((w) => w.id === id);
    if (!w || isScratch(w) || w.workspace) return null;
    const hit = statusCache.get(id);
    if (hit && Date.now() - hit.t < 20_000) return hit.p;
    const base = project(w.projectId).defaultBase;
    // whose branch this is rides along with the status the sidebar already polls for
    const p = Promise.all([git.status(w.path, base), git.branchAuthors(w.path, base)])
      .then(([status, commits]) => ({ ...status, author: topContributor(commits) }))
      .catch(() => null);
    statusCache.set(id, { t: Date.now(), p });
    return p;
  },
  openExternal: (url: string) => shell.openExternal(url),
  ptyCreate: (scopeId: string, termId: string, cwd: string, cols: number, rows: number) => ptys.create(scopeId, termId, cwd, cols, rows),
  ptyWrite: (id: string, data: string) => ptys.write(id, data),
  ptyResize: (id: string, cols: number, rows: number) => ptys.resize(id, cols, rows),
  ptyKill: (id: string) => ptys.kill(id),
  ptySeen: (id: string) => ptys.seen(id),
  ptySeenScope: (scopeId: string) => ptys.seenScope(scopeId),
  ptys: () => ptys.list(),
  artifactMenu: (id: string, target: string) => new Promise<"open" | null>((done) => {
    const remote = /^https?:\/\//i.test(target);
    if (!remote && /^[a-z][a-z0-9+.-]*:/i.test(target.replace(/:\d+(?::\d+)?$/, "")) && !target.startsWith("file:")) throw new Error("Unsupported link");
    const path = remote ? undefined : artifactPath(id, target);
    const report = (error: unknown) => dialog.showErrorBox("Could not open artifact", String(error));
    const menu = Menu.buildFromTemplate([
      { label: "Open", click: () => done("open") },
      { label: "Show in Finder", enabled: !!path, click: () => { if (path) { try { statSync(path); shell.showItemInFolder(path); } catch (e) { report(e); } } } },
      // the default app for the file's own type: Word for .docx, Preview for .pdf, Numbers for .xlsx…
      { label: "Open in Default App", enabled: !!path, click: async () => {
        try { statSync(path!); const err = await shell.openPath(path!); if (err) report(err); } catch (e) { report(e); }
      } },
      { label: "Open in Browser", click: async () => {
        if (remote) { shell.openExternal(target).catch(report); return; }
        try {
          statSync(path!);
          // the https:// handler is the browser, whatever the file's own type would open in
          let browser: BrowserInfo;
          try { browser = await app.getApplicationInfoForProtocol("https://example.com"); } catch {}
          const launch = browserLaunch(process.platform, browser, path!);
          if (launch) execFile(launch.cmd, launch.args, (e) => { if (e) report(e); });
          else await shell.openExternal(pathToFileURL(path!).href);
        } catch (e) { report(e); }
      } },
    ]);
    menu.popup({ window: win, callback: () => done(null) });
  }),
  previewArtifact: (id: string, target: string) => {
    if (/^https?:\/\//i.test(target)) return { kind: "url" as const, content: target };
    const path = artifactPath(id, target);
    if (statSync(path).size > 20 * 1024 * 1024) throw new Error("This file is too large to preview. Use Show in Finder or Open in Browser.");
    const ext = extname(path).toLowerCase();
    const mime: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".pdf": "application/pdf" };
    if (mime[ext]) return { kind: ext === ".pdf" ? "pdf" as const : "image" as const, content: `data:${mime[ext]};base64,${readFileSync(path).toString("base64")}` };
    if ([".docx", ".xlsx", ".pptx", ".zip"].includes(ext)) return { kind: "unsupported" as const, content: "Preview unavailable for this file type. Use Show in Finder to open it in its application." };
    return { kind: ext === ".md" ? "markdown" as const : [".html", ".htm"].includes(ext) ? "html" as const : "text" as const, content: readFileSync(path, "utf8") };
  },
  readReview: (id: string, target: string) => readReview(artifactPath(id, target)),
  findReview: (id: string, pr?: number) => findReview(wt(id).path, pr),
  updateReviewFinding: (id: string, target: string, findingId: string, patch: { status?: import("../shared/review").FindingStatus; comment?: string }) => setFinding(artifactPath(id, target), findingId, patch),
  submitReview: (id: string, target: string, opts: { event: import("../shared/review").ReviewEvent; body: string; inline: boolean; draft: boolean }) => submitReview(artifactPath(id, target), opts, id),
  reviewDrift: (id: string, target: string) => reviewDrift(artifactPath(id, target)),
  // the worktree id lets the side job run on the review chat's connector and model rather than the Settings default
  reinvestigateFinding: (id: string, target: string, findingId: string) => reinvestigate(artifactPath(id, target), findingId, id),
  // "Fix locally": the review chat already holds the context, so the finding goes there, queued behind whatever it is doing;
  // a branch with no review chat gets a fresh one on the default connector
  fixFinding: async (id: string, target: string, findingId: string, note?: string) => {
    const path = artifactPath(id, target);
    const { review } = await readReview(path);
    const finding = review.findings.find((f) => f.id === findingId);
    if (!finding) throw new Error(`No finding ${findingId} in this review.`);
    let chat = pickReviewChat(store.data.chats, id, review.pr);
    if (!chat) {
      const key = defaultConnector(store.data);
      if (!key) throw new Error("Add a connector in Settings first.");
      const tiers = modelTiers(key.provider, store.public().models?.[key.provider]);
      const chatId = handlers.addChat!(id, key.id, { name: `Fix ${finding.id} · ${review.title}`, model: tiers.orchestrator, delegateModel: tiers.delegate, remember: false });
      chat = store.chat(chatId);
    }
    const queued = !!chat.running;
    await agents.send(chat.id, fixPrompt(review, finding, note));
    const next = await setFixRequest(path, findingId, chat.id);
    return { review: next, chatId: chat.id, chatName: chat.name, queued };
  },
  watchReview: (id: string, target: string) => { reviewWatchers.add(artifactPath(id, target)); },
  unwatchReview: (id: string, target: string) => { reviewWatchers.remove(artifactPath(id, target)); },
  authStatus: (keyId: string) => authStatus(keyId),
  connectorUsage: (keyId: string, force?: boolean) => { const k = store.data.keys.find((k) => k.id === keyId); if (!k) throw new Error("Connector not found"); return usage.read(k, { force }); },
  commitInfo: (id: string) => { const p = workspaceOf(wt(id)); return p ? ws.workspaceCommitInfo(targetsOf(p), p.branch ?? "") : git.commitInfo(wt(id).path); },
  commit: async (id: string, message: string) => {
    const p = workspaceOf(wt(id));
    if (p) {
      const results: RepoResult[] = await handlers.commitWorkspace!(p.id, message);
      const done = results.filter((r) => !r.skipped);
      if (done.some((r) => !r.ok)) throw new Error(done.map((r) => `${r.name}: ${r.detail}`).join(" · "));
      return done.length ? done.map((r) => `${r.name}: ${r.detail}`).join(" · ") : "Nothing to commit in any repo.";
    }
    const r = await git.commit(wt(id).path, message); statusCache.delete(id); return r;
  },
  suggestCommit: async (id: string) => {
    const p = workspaceOf(wt(id));
    const diff = p ? await ws.workspaceDiffForSummary(targetsOf(p)) : await git.diffForSummary(wt(id).path);
    if (!diff.trim()) return "";
    return askOnce(wt(id).path, `Write a git commit message for this diff.\nFormat: a short imperative subject line (max 60 chars), a blank line, then 1 to 5 bullets, each ONE sentence, each starting with "- ". No other text.\n\n${diff}`);
  },
  suggestPr: async (id: string, branch: string) => {
    const w = wt(id);
    if (!w) throw new Error("Worktree no longer exists.");
    const wsp = workspaceOf(w);
    const input = wsp ? await ws.workspacePrSummary(targetsOf(wsp), branch) : await git.branchDiffForSummary(w.path, branch, project(w.projectId).defaultBase);
    if (!input.commits.trim() && !input.patch.trim()) return { title: "", body: "" };
    return parsePrSuggestion(await askOnce(w.path, prSuggestionPrompt(input)));
  },
  commitChat: async (chatId: string, message?: string) => {
    const chat = store.data.chats.find((c) => c.id === chatId);
    try { return await commitFromChat(chatId, message); }
    catch (error) { if (chat) { chat.queuePaused = true; store.save(); } throw error; }
    finally { if (chat) { statusCache.delete(chat.worktreeId); void agents.flushQueued(chatId); } }
  },
  authLoginCmd: (keyId: string) => authLoginCmd(keyId),
  listFiles: (id: string) => git.listFiles(wt(id).path),
  readFile: (id: string, rel: string) => git.readFile(wt(id).path, rel),
  writeFile: (id: string, rel: string, content: string) => git.writeFile(wt(id).path, rel, content),
  repoInfo: (id: string) => {
    const hit = repoCache.get(id);
    if (hit && Date.now() - hit.t < 60_000) return hit.p;
    const pr = project(id);
    const p = git.repoInfo(pr.path).then((info) => {
      // adopt GitHub's default branch until the user picks one
      const auto = info.repo?.defaultBranch && `origin/${info.repo.defaultBranch}`;
      if (auto && !pr.baseSetByUser && pr.defaultBase !== auto) { pr.defaultBase = auto; store.save(); }
      return info;
    });
    repoCache.set(id, { t: Date.now(), p });
    return p;
  },
  setAppearance: (a: Partial<Appearance>) => {
    Object.assign(store.data.appearance, a);
    applyAppearance();
    store.save();
  },
  // Every Claude connector is asked what it offers; the union is the picker's list, kept in
  // state so the next launch starts from it. A connector that cannot answer changes nothing.
  refreshModels: async () => {
    forgetCodexModels();
    const keys = store.data.keys.filter((k) => k.provider === "claude");
    const lists = await Promise.all(keys.map((k) => probeClaudeModels(k, k.auth === "key" ? store.getSecret(k.id) : undefined).catch(() => [] as string[])));
    const models = [...new Set(lists.flat())];
    if (models.length) { (store.data.modelCatalog ??= {}).claude = { models, at: Date.now() }; }
    store.save();
  },
  // standing instructions reach a chat on its next turn; running turns keep the prompt they started with
  setInstructions: (items: import("../shared/instructions").Instruction[]) => {
    store.data.instructions = items.map((i) => ({ id: i.id, text: i.text.trim(), enabled: !!i.enabled })).filter((i) => i.text);
    store.save();
  },
  addChat: (worktreeId: string, keyId: string, opts: { name?: string; model?: string; delegateModel?: string; remember?: boolean } = {}) => {
    const id = randomUUID();
    const key = store.data.keys.find((k) => k.id === keyId);
    if (!key) throw new Error("Connector not found.");
    const provider = key.provider;
    const offered = store.public().models?.[provider];
    const model = opts.model?.trim() || selectedModel(store.data, key, offered?.[0] ?? MODELS[provider][0]);
    const delegateModel = opts.delegateModel?.trim();
    // A model a task pinned for itself is not the user's choice: remembering a review's
    // orchestrator tier would silently start every later chat on the priciest model.
    if (opts.remember !== false) key.defaultModel = model;
    store.data.chats.push({
      id, worktreeId, provider, keyId, model, ...(delegateModel ? { delegateModel } : {}), name: opts.name || "New chat",
      phase: "waiting", autoApprove: false, running: false, messages: [],
    });
    store.save();
    return id;
  },
  // The folder is the worktree; it is made up front so a first prompt with attachments has
  // somewhere to stage them. Deleting the chat removes both (see deleteChat).
  addScratchChat: (keyId: string, opts: { name?: string; model?: string } = {}) => {
    const id = randomUUID();
    const path = join(scratchRoot(), id);
    mkdirSync(path, { recursive: true });
    store.data.worktrees.push(scratchWorktree(id, path, opts.name?.trim() || "Chat"));
    return handlers.addChat!(id, keyId, { name: opts.name, model: opts.model });
  },
  renameChat: (id: string, name: string) => {
    const chat = store.chat(id);
    chat.name = name;
    // a repoless chat's worktree is only its folder; its title follows the chat
    const w = store.data.worktrees.find((w) => w.id === chat.worktreeId);
    if (w && isScratch(w)) w.title = name;
    store.save();
  },
  chatMenu: (id: string) => new Promise<void>((done) => {
    const chat = store.chat(id);
    // store.save() re-arms the timers through the change listener below
    const setReminder = (remindAt: number | undefined) => { chat.remindAt = remindAt; store.save(); };
    const due = chat.remindAt === undefined ? "" : ` (${new Date(chat.remindAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })})`;
    const menu = Menu.buildFromTemplate([
      { label: "Remind me", submenu: REMINDER_CHOICES.map((choice) => ({ label: choice.label, click: () => setReminder(choice.due(Date.now())) })) },
      { label: `Clear reminder${due}`, enabled: chat.remindAt !== undefined, click: () => setReminder(undefined) },
    ]);
    menu.once("menu-will-close", () => setImmediate(() => done()));
    menu.popup({ window: win });
  }),
  askSide: (id: string, question: string) => askSide(id, question),
  clearSide: (id: string) => {
    store.chat(id).sideMessages = [];
    store.save();
  },
  deleteChat: (id: string) => {
    agents.stop(id);
    const chat = store.data.chats.find((c) => c.id === id);
    store.data.chats = store.data.chats.filter((c) => c.id !== id);
    // a repoless chat owns its folder: the last chat on a scratch worktree takes the folder with it
    const w = chat && store.data.worktrees.find((w) => w.id === chat.worktreeId);
    if (w && isScratch(w) && !store.data.chats.some((c) => c.worktreeId === w.id)) {
      store.data.worktrees = store.data.worktrees.filter((x) => x.id !== w.id);
      if (w.path.startsWith(scratchRoot())) rmSync(w.path, { recursive: true, force: true });
    }
    store.save();
  },
  setAutoApprove: (id: string, on: boolean) => agents.setAutoApprove(id, on),
  setPhase: (id: string, phase) => {
    store.chat(id).phase = phase;
    store.chat(id).assessingPrompt = false;
    if (phase === "planning" || phase === "validating") store.chat(id).phaseSteps = 5;
    store.save();
  },
  send: (chatId: string, text: string, files: string[] = []) => {
    const c = store.chat(chatId);
    if (c.name === "New chat") c.name = text.slice(0, 40);
    return agents.send(chatId, text, files);
  },
  resumeQueue: (chatId: string) => {
    store.chat(chatId).queuePaused = false;
    store.save();
    void agents.flushQueued(chatId);
  },
  removeQueuedMessage: (chatId: string, messageId: string) => {
    const chat = store.chat(chatId);
    chat.queuedMessages = chat.queuedMessages?.filter((m) => m.id !== messageId);
    store.save();
  },
  // dropped/pasted data with no backing path (screenshot thumbnails, clipboard images) lands in a temp file first
  stageBlob: (name: string, bytes: ArrayBuffer) => {
    const dir = join(app.getPath("userData"), "dropped");
    mkdirSync(dir, { recursive: true });
    const safe = (name || "image.png").replace(/[^\w.\-]+/g, "_");
    const p = join(dir, `${Date.now().toString(36)}-${safe}`);
    writeFileSync(p, Buffer.from(bytes));
    return p;
  },
  pickFiles: async () => {
    const r = await dialog.showOpenDialog(win, { properties: ["openFile", "multiSelections"] });
    return r.canceled ? [] : r.filePaths;
  },
  setChatKey: (id: string, keyId: string) => agents.switchAgent(id, keyId, store.chat(id).model),
  switchAgent: (id: string, keyId: string, model: string) => agents.switchAgent(id, keyId, model),
  continueChat: (id: string) => agents.continueChat(id),
  setPhiMode: (id: string, on: boolean) => {
    agents.setPhiMode(store.chat(id), on, "manual");
    store.save();
  },
  setDefaultKey: (id: string) => {
    if (!store.data.keys.some((key) => key.id === id)) throw new Error("Connector not found.");
    store.data.defaultKeyId = id;
    store.save();
  },
  setKeyPhi: (id: string, on: boolean) => {
    store.data.keys.find((k) => k.id === id)!.phiAllowed = on;
    store.save();
  },
  stop: (id: string) => agents.stop(id),
  addKey: (name: string, provider, key: string, phiAllowed: boolean, auth?: "login" | "key") => {
    const id = randomUUID();
    auth ??= key ? "key" : "login";
    if (auth === "key") {
      if (!key) throw new Error("Enter an API key.");
      store.data.keys.push({ id, name, provider, phiAllowed, auth });
      store.setSecret(id, key);
    } else {
      // a second CLI login for the same provider: give it a private config dir so its credentials don't collide with the built-in one
      const configDir = join(app.getPath("userData"), "logins", id);
      mkdirSync(configDir, { recursive: true });
      store.data.keys.push({ id, name, provider, phiAllowed, auth, configDir });
    }
    store.save();
  },
  renameKey: (id: string, name: string) => {
    const key = store.data.keys.find((k) => k.id === id);
    if (!key) throw new Error("Connector not found.");
    const label = name.trim();
    if (!label) throw new Error("Enter a connector name.");
    key.name = label;
    store.save();
  },
  removeKey: (id: string) => {
    if (id.startsWith("login-")) return;
    const key = store.data.keys.find((k) => k.id === id);
    if (key?.configDir && key.configDir.startsWith(join(app.getPath("userData"), "logins"))) rmSync(key.configDir, { recursive: true, force: true });
    store.data.keys = store.data.keys.filter((k) => k.id !== id);
    delete store.data.secrets[id];
    usage.forget(id);
    store.save();
  },
  answerPermission: (id: string, allow: boolean) => agents.answerPermission(id, allow),
  issuePrompt: async (worktreeId: string, number: number) => {
    const w = wt(worktreeId);
    const [issue, repo] = await Promise.all([git.issueDetail(w.path, number), git.repoName(w.path)]);
    return issueBriefPrompt(issue, { repo: repo ?? project(w.projectId).name, worktreePath: w.path, branch: w.branch });
  },
  skillPrompt: (name: string, worktreeId: string, args?: string, delegateModel?: string) => {
    const dir = join(app.getAppPath(), "skills", name);
    const skill = readFileSync(join(dir, "SKILL.md"), "utf8").replace(/^---[\s\S]*?---\n/, "");
    const worktreePath = wt(worktreeId).path;
    let progress = "", rubric = "";
    if (name === "pr-writeup") {
      // The agent brief is shared context: it lives once on disk where every review agent
      // reads it, instead of being pasted into each assignment by the orchestrator.
      const categories = readFileSync(join(dir, "categories.md"), "utf8");
      const reviewDir = join(worktreePath, ".consort", "pr-review");
      mkdirSync(join(reviewDir, "agents"), { recursive: true });
      writeFileSync(join(reviewDir, "categories.md"), categories);
      progress = `Keep the user informed in chat at the phase boundaries: the plan before the first tool call, then one short plain-language update when scope is done, when a wave is dispatched, when it returns, when verification is done, and when the report is written. Not a running commentary.

Runtime rules for this review: dispatch review agents with \`run_in_background: false\`, a whole wave in one message, because a turn that ends while agents are still running loses their results. Shared context goes in .consort/pr-review/brief.md once; the agent brief is already saved at .consort/pr-review/categories.md, so assignments point at those files and stay under ~1,500 characters. Each agent writes its report to .consort/pr-review/agents/<slug>.md; on a resume, read that directory first and dispatch only groups with no report.

`;
      rubric = `\n\n## Review rubric you apply in verification (agents read their own copy from disk — never paste this into an assignment)\n\n${categories}`;
    }
    const tier = delegateModel ? `You are the orchestrator, running on this session's strongest model. Dispatch every delegated agent on \`${delegateModel}\` by passing that model on the agent call; the runtime already defaults delegated agents to it. Your tokens go to scope, grouping, short assignments, verification decisions and the final prose — not to reading the diff yourself. Escalate a single agent back to your own model only when a specific verification has already failed at the delegate tier, and say why in the summary.\n\n` : "";
    return `${progress}${tier}Run the following skill${args ? ` with argument: ${args}` : " for the current branch"} in ${worktreePath}. Its sibling files live in ${dir}.
The Artifact tool is not available here. The deliverable is the review file: write it to .consort/pr-review/pr-<n>.review.json in the worktree, in the schema the skill gives. Consort renders that file and lets Mitch approve or ignore each finding and post the approved ones to GitHub, so do not post comments yourself. Print the operational review summary in chat, then end with a clickable Markdown link to the saved review file using its absolute path.

${skill}${rubric}`;
  },
  // quick actions are the project's: one BUILD for every worktree, run wherever you press it
  addQuickAction: (projectId: string, title: string, command: string) => {
    const p = project(projectId);
    if (!p) throw new Error("Project not found.");
    if (!title.trim() || !command.trim()) throw new Error("Enter a title and Bash command.");
    (p.quickActions ??= []).push({ id: randomUUID(), title: title.trim(), command });
    store.save();
  },
  setQuickActionPinned: (projectId: string, actionId: string, pinned: boolean) => {
    const action = project(projectId)?.quickActions?.find((action) => action.id === actionId);
    if (!action) throw new Error("Quick action not found.");
    action.pinned = pinned;
    store.save();
  },
  deleteQuickAction: (projectId: string, actionId: string) => {
    const p = project(projectId);
    if (!p) throw new Error("Project not found.");
    p.quickActions = (p.quickActions ?? []).filter((action) => action.id !== actionId);
    store.save();
  },
  runCommand: (worktreeId: string, cmd: string) => git.runCommand(wt(worktreeId).path, cmd),
  diff: (worktreeId: string) => { const p = workspaceOf(wt(worktreeId)); return p ? ws.workspaceDiff(targetsOf(p)) : git.diff(wt(worktreeId).path); },
};

app.whenReady().then(() => {
  startDockerRecovery(join(app.getPath("userData"), "docker-runs"));
  store.load();
  store.save();
  // the model pickers follow the providers, not a release of Consort: ask on every start
  handlers.refreshModels!().catch((error: unknown) => console.warn("model refresh failed", error));
  // first-run titles for worktrees imported before titles existed
  for (const w of store.data.worktrees)
    if (w.title === w.name) { w.title = humanize(w.branch); suggestTitle(w.path, w.branch).then((t) => { w.title = t; store.save(); }); }
  for (const [name, fn] of Object.entries(handlers)) ipcMain.handle(name, (_e, ...args) => fn!(...args));
  // the window can be gone while jobs/agents are still winding down
  const send = (ch: string, data: unknown) => { if (win && !win.isDestroyed()) win.webContents.send(ch, data); };
  const openChat = (id: string) => {
    if (!store.data.chats.some((chat) => chat.id === id) || !win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show(); win.focus(); send("openChat", id);
  };
  // while Consort is the active window a system banner would just cover it: toast instead, with the same click target
  const notifier = new Notifier(isActive, (n) => send("toast", n), (n: Notice) => {
    if (!Notification.isSupported()) return;
    const notification = new Notification({ title: n.title, body: n.body ?? "" });
    notification.on("click", () => { if (n.open?.chat) openChat(n.open.chat); else if (n.open?.scope) openScope(n.open.scope); });
    notification.on("failed", (_event, error) => console.warn("Notification failed:", error));
    notification.show();
  });
  notify = (n) => notifier.show(n);
  const openScope = (scopeId: string) => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show(); win.focus(); send("openScope", scopeId);
  };
  const permissionNotifications = new PermissionNotifications(() => store.data.chats, agents.answerPermission, openChat, (chat, request) => {
    if (!notifier.inApp()) return false;
    notifier.show({ title: `Permission needed: ${request.tool}`, body: `${chat.name} · click to review it in chat`, open: { chat: chat.id }, kind: "info" });
    return true;
  });
  reminders = new Reminders(() => store.data.chats, openChat, () => store.save(), isViewing, (chat) => {
    if (!notifier.inApp()) return false;
    notifier.show({ title: "Reminder", body: `${chat.name} · you asked to come back to this chat`, open: { chat: chat.id }, kind: "info" });
    return true;
  });
  reminders.sync();
  const previous = new Map(store.data.chats.map((c) => [c.id, eventKey(c)]));
  function eventKey(c: (typeof store.data.chats)[number]) {
    const status = chatStatus(c);
    return c.permissions?.length ? `permission:${c.permissions.map((p) => p.id).join(",")}`
      // a reminder is something you set yourself, so it is never worth a notification
      : c.error ? `error:${c.error}` : (status === "reminder" || status === "scheduled" ? null : status) ?? "idle";
  }
  store.onChange((s) => {
    permissionNotifications.sync();
    reminders?.sync();
    for (const c of s.chats) {
      const key = eventKey(c);
      const changed = previous.get(c.id) !== key;
      previous.set(c.id, key);
      if (!changed || c.permissions?.length || key === "idle" || isViewing(c.id)) continue;
      const status = chatStatus(c);
      notifier.show({
        title: status === "attention" ? "Chat needs your attention" : status === "complete" ? "Chat complete" : "Chat started working",
        body: `${c.name} · ${c.error ? "the chat hit an error" : status === "attention" ? "waiting for your response" : status === "complete" ? "ready to review" : "running"}`,
        open: { chat: c.id },
        kind: c.error ? "error" : status === "complete" ? "success" : "info",
      });
    }
    for (const id of previous.keys()) if (!s.chats.some((c) => c.id === id)) previous.delete(id);
    send("state", s);
    acknowledgeChat();
  });
  agents.onPermission((r) => send("permission", r));
  ptys.listen((id, data) => send("pty:data", { id, data }), (s) => send("ptys", s));
  // a terminal command that ran a while has finished: say so, and let the click land on its worktree
  ptys.onCommandDone(({ scopeId, command, code, durationMs, setup }) => {
    const where = store.data.worktrees.find((w) => w.id === scopeId)?.title ?? store.data.projects.find((p) => p.id === scopeId)?.name ?? "terminal";
    notifier.show(setup ? setupDoneNotice(where, code, formatDuration(durationMs), scopeId) : {
      title: code === 0 ? "Command finished" : `Command failed (exit ${code})`,
      body: `${where} · ${command ?? "command"} · ${formatDuration(durationMs)}`,
      open: { scope: scopeId },
      kind: code === 0 ? "success" : "error",
    });
  });
  process.on("uncaughtException", (e) => console.error("[main]", e));
  createWindow();
  // drop worktrees whose folders vanished since last run
  for (const p of store.data.projects) syncWorktrees(p.id).then(() => store.save()).catch(() => {});
});
app.on("before-quit", () => ptys.killAll());
app.on("window-all-closed", () => app.quit());
