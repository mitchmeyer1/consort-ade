import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from "electron";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { store } from "./store";
import * as git from "./git";
import * as agents from "./agents";
import { askOnce, humanize, suggestTitle } from "./namer";
import { authStatus, claudeBin, codexBin } from "./auth";
import * as ptys from "./ptys";
import { MODELS, type Api, type Appearance } from "../shared/types";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

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
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
}

const statusCache = new Map<string, { t: number; p: Promise<unknown> }>();
const repoCache = new Map<string, { t: number; p: Promise<unknown> }>();
const wt = (id: string) => store.data.worktrees.find((w) => w.id === id)!;
const project = (id: string) => store.data.projects.find((p) => p.id === id)!;

async function syncWorktrees(projectId: string) {
  const p = project(projectId);
  const live = (await git.listWorktrees(p.path)).filter((l) => l.path !== p.path);
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
  store.data.worktrees = store.data.worktrees.filter(
    (w) => w.projectId !== projectId || live.some((l) => l.path === w.path),
  );
  const alive = new Set(store.data.worktrees.map((w) => w.id));
  store.data.chats = store.data.chats.filter((c) => alive.has(c.worktreeId));
}

const handlers: { [K in keyof Api]?: (...a: any[]) => any } = {
  getState: () => store.public(),
  effectiveTheme: () => effectiveTheme(),
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
  removeProject: (id: string) => {
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
  addWorktree: async (projectId: string, name: string, branch: string, base: string) => {
    await git.addWorktree(project(projectId).path, name, branch, base);
    await syncWorktrees(projectId);
    store.save();
  },
  removeWorktree: async (id: string) => {
    const w = store.data.worktrees.find((w) => w.id === id)!;
    await git.removeWorktree(project(w.projectId).path, w.path);
    store.data.chats = store.data.chats.filter((c) => c.worktreeId !== id);
    await syncWorktrees(w.projectId);
    store.save();
  },
  autoTitle: async (id: string) => {
    const w = wt(id);
    w.title = await suggestTitle(w.path, w.branch);
    store.save();
  },
  renameWorktree: (id: string, title: string) => {
    wt(id).title = title.trim() || wt(id).name;
    store.save();
  },
  archiveWorktree: (id: string, on: boolean) => {
    wt(id).archived = on;
    store.save();
  },
  // ponytail: 20s cache so sidebar + page + cards polling don't hammer gh
  worktreeStatus: (id: string) => {
    const w = store.data.worktrees.find((w) => w.id === id);
    if (!w) return null;
    const hit = statusCache.get(id);
    if (hit && Date.now() - hit.t < 20_000) return hit.p;
    const p = git.status(w.path, project(w.projectId).defaultBase).catch(() => null);
    statusCache.set(id, { t: Date.now(), p });
    return p;
  },
  openExternal: (url: string) => shell.openExternal(url),
  ptyCreate: (scopeId: string, termId: string, cwd: string, cols: number, rows: number) => ptys.create(scopeId, termId, cwd, cols, rows),
  ptyWrite: (id: string, data: string) => ptys.write(id, data),
  ptyResize: (id: string, cols: number, rows: number) => ptys.resize(id, cols, rows),
  ptyKill: (id: string) => ptys.kill(id),
  ptySeen: (id: string) => ptys.seen(id),
  ptys: () => ptys.list(),
  authStatus: (provider) => authStatus(provider),
  commitInfo: (id: string) => git.commitInfo(wt(id).path),
  commit: async (id: string, message: string) => { const r = await git.commit(wt(id).path, message); statusCache.delete(id); return r; },
  suggestCommit: async (id: string) => {
    const diff = await git.diffForSummary(wt(id).path);
    if (!diff.trim()) return "";
    return askOnce(wt(id).path, `Write a git commit message for this diff.\nFormat: a short imperative subject line (max 60 chars), a blank line, then 1 to 5 bullets, each ONE sentence, each starting with "- ". No other text.\n\n${diff}`);
  },
  authLoginCmd: (provider) => (provider === "claude" ? `${JSON.stringify(claudeBin())} auth login --claudeai` : `${JSON.stringify(codexBin())} login`),
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
  addChat: (worktreeId: string, keyId: string, opts: { name?: string; model?: string } = {}) => {
    const id = randomUUID();
    const provider = store.data.keys.find((k) => k.id === keyId)!.provider;
    store.data.chats.push({
      id, worktreeId, provider, keyId, model: opts.model ?? MODELS[provider][0], name: opts.name || "New chat",
      phase: "waiting", autoApprove: false, running: false, messages: [],
    });
    store.save();
    return id;
  },
  renameChat: (id: string, name: string) => {
    store.chat(id).name = name;
    store.save();
  },
  deleteChat: (id: string) => {
    agents.stop(id);
    store.data.chats = store.data.chats.filter((c) => c.id !== id);
    store.save();
  },
  setAutoApprove: (id: string, on: boolean) => {
    store.chat(id).autoApprove = on;
    store.save();
  },
  setPhase: (id: string, phase) => {
    store.chat(id).phase = phase;
    store.save();
  },
  send: (chatId: string, text: string, files: string[] = []) => {
    const c = store.chat(chatId);
    if (c.name === "New chat") c.name = text.slice(0, 40);
    return agents.send(chatId, text, files);
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
  setChatKey: (id: string, keyId: string) => {
    store.chat(id).keyId = keyId;
    store.save();
  },
  switchAgent: (id: string, keyId: string, model: string) => agents.switchAgent(id, keyId, model),
  continueChat: (id: string) => agents.continueChat(id),
  setPhiMode: (id: string, on: boolean) => {
    agents.setPhiMode(store.chat(id), on, "manual");
    store.save();
  },
  setKeyPhi: (id: string, on: boolean) => {
    store.data.keys.find((k) => k.id === id)!.phiAllowed = on;
    store.save();
  },
  stop: (id: string) => agents.stop(id),
  addKey: (name: string, provider, key: string, phiAllowed: boolean) => {
    const id = randomUUID();
    store.data.keys.push({ id, name, provider, phiAllowed, auth: key ? "key" : "login" });
    if (key) store.setSecret(id, key);
    store.save();
  },
  removeKey: (id: string) => {
    if (id.startsWith("login-")) return;
    store.data.keys = store.data.keys.filter((k) => k.id !== id);
    delete store.data.secrets[id];
    store.save();
  },
  answerPermission: (id: string, allow: boolean) => agents.answerPermission(id, allow),
  skillPrompt: (name: string, worktreeId: string, args?: string) => {
    const dir = join(app.getAppPath(), "skills", name);
    const skill = readFileSync(join(dir, "SKILL.md"), "utf8").replace(/^---[\s\S]*?---\n/, "");
    return `Run the following skill${args ? ` with argument: ${args}` : " for the current branch"} in ${wt(worktreeId).path}. Its sibling files live in ${dir}.
The Artifact tool is not available here: write the finished HTML to .consort/pr-writeup.html in the worktree and tell me the path.

${skill}`;
  },
  runCommand: (worktreeId: string, cmd: string) => git.runCommand(wt(worktreeId).path, cmd),
  diff: (worktreeId: string) => git.diff(wt(worktreeId).path),
};

app.whenReady().then(() => {
  store.load();
  // first-run titles for worktrees imported before titles existed
  for (const w of store.data.worktrees)
    if (w.title === w.name) { w.title = humanize(w.branch); suggestTitle(w.path, w.branch).then((t) => { w.title = t; store.save(); }); }
  for (const [name, fn] of Object.entries(handlers)) ipcMain.handle(name, (_e, ...args) => fn!(...args));
  // the window can be gone while jobs/agents are still winding down
  const send = (ch: string, data: unknown) => { if (win && !win.isDestroyed()) win.webContents.send(ch, data); };
  store.onChange((s) => send("state", s));
  agents.onPermission((r) => send("permission", r));
  ptys.listen((id, data) => send("pty:data", { id, data }), (s) => send("ptys", s));
  process.on("uncaughtException", (e) => console.error("[main]", e));
  createWindow();
  // drop worktrees whose folders vanished since last run
  for (const p of store.data.projects) syncWorktrees(p.id).then(() => store.save()).catch(() => {});
});
app.on("before-quit", () => ptys.killAll());
app.on("window-all-closed", () => app.quit());
