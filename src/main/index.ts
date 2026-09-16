import { app, BrowserWindow, dialog, ipcMain, shell, Notification, Menu } from "electron";
import { join, basename, resolve, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { store } from "./store";
import * as git from "./git";
import { ensureRootWorktree, isRootWorktree } from "./rootWorktree";
import * as agents from "./agents";
import { humanize, suggestTitle } from "./namer";
import { authStatus } from "./auth";
import * as jobs from "./jobs";
import { chatStatus } from "../shared/chatStatus";
import { MODELS, type Api, type Appearance } from "../shared/types";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { execFile } from "node:child_process";

// ADE_DATA_DIR isolates state for test instances
// GUI apps get a bare PATH; borrow the login shell's so git/gh/claude resolve like in a terminal
try {
  const shellPath = execFileSync(process.env.SHELL || "/bin/zsh", ["-ilc", "echo -n \"$PATH\""], { timeout: 5000, env: { ...process.env, DISABLE_AUTO_UPDATE: "true" } }).toString().trim();
  if (shellPath) process.env.PATH = shellPath;
} catch {}
for (const d of ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin", join(process.env.HOME ?? "", ".local/bin")])
  if (!process.env.PATH?.split(":").includes(d)) process.env.PATH = `${process.env.PATH}:${d}`;

// keep the pre-productName data dir ("ade") so existing keys/projects survive the rename
app.setPath("userData", process.env.ADE_DATA_DIR ?? join(app.getPath("appData"), "ade"));

let win: BrowserWindow;
let activeChat: string | null = null;
const isViewing = (id: string) => activeChat === id && !!win && !win.isDestroyed() && win.isFocused() && win.isVisible() && !win.isMinimized();
function acknowledgeChat() {
  const chat = store.data.chats.find((c) => c.id === activeChat);
  if (chat?.unreadCompletion && isViewing(chat.id)) {
    chat.unreadCompletion = false;
    store.save();
  }
}


// macOS vibrancy: the renderer paints translucent backgrounds when frosted
const VIBRANCY: Record<Appearance["background"], Parameters<BrowserWindow["setVibrancy"]>[0]> = { opaque: null, frost: "under-window", frost2: "hud" };
function applyAppearance() {
  const a = store.data.appearance;
  win.setVibrancy(VIBRANCY[a.background]);
  win.setBackgroundColor(a.background === "opaque" ? (a.theme === "light" ? "#f3ead6" : "#0a0a0a") : "#00000000");
}
function createWindow() {
  const a = store.data.appearance;
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    titleBarStyle: "hiddenInset",
    vibrancy: VIBRANCY[a.background] ?? undefined,
    backgroundColor: a.background === "opaque" ? (a.theme === "light" ? "#f3ead6" : "#0a0a0a") : "#00000000",
    webPreferences: { preload: join(import.meta.dirname, "../preload/index.mjs"), sandbox: false },
  });
  win.on("blur", () => { activeChat = null; });
  win.webContents.on("did-start-loading", () => { activeChat = null; });
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
}

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

async function syncWorktrees(projectId: string) {
  const p = project(projectId);
  const live = (await git.listWorktrees(p.path)).filter((l) => l.path !== p.path || store.data.worktrees.some((w) => w.projectId === projectId && w.root));
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
    (w) => w.projectId !== projectId || w.root || live.some((l) => l.path === w.path),
  );
  const alive = new Set(store.data.worktrees.map((w) => w.id));
  store.data.chats = store.data.chats.filter((c) => alive.has(c.worktreeId));
}

const handlers: { [K in keyof Api]?: (...a: any[]) => any } = {
  getState: () => store.public(),
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
  pushWorktree: async (id: string, branch: string) => {
    const w = wt(id);
    if (!w) throw new Error("Worktree no longer exists.");
    if (store.data.chats.some((c) => c.worktreeId === id && c.running)) throw new Error("Wait for this worktree's chats to finish before pushing.");
    try { return await git.pushWorktree(w.path, branch); }
    finally { statusCache.delete(id); }
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
  openRootWorktree: async (projectId: string) => {
    const p = project(projectId);
    if (!p) throw new Error("Project no longer exists.");
    const current = await git.rootStatus(p.path);
    const root = ensureRootWorktree(store.data.worktrees, p, current.branch ?? "(detached)");
    store.save();
    return root.id;
  },
  addWorktree: async (projectId: string, name: string, branch: string, base: string) => {
    await git.addWorktree(project(projectId).path, name, branch, base);
    await syncWorktrees(projectId);
    store.save();
  },
  removeWorktree: async (id: string) => {
    const w = store.data.worktrees.find((w) => w.id === id)!;
    if (isRootWorktree(w, project(w.projectId))) throw new Error("The project root cannot be deleted as a worktree. Archive it to hide it.");
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
  artifactMenu: (id: string, target: string) => new Promise<"open" | null>((done) => {
    const remote = /^https?:\/\//i.test(target);
    if (!remote && /^[a-z][a-z0-9+.-]*:/i.test(target.replace(/:\d+(?::\d+)?$/, "")) && !target.startsWith("file:")) throw new Error("Unsupported link");
    const path = remote ? undefined : artifactPath(id, target);
    const report = (error: unknown) => dialog.showErrorBox("Could not open artifact", String(error));
    const menu = Menu.buildFromTemplate([
      { label: "Open", click: () => done("open") },
      { label: "Show in Finder", enabled: !!path, click: () => { if (path) { try { statSync(path); shell.showItemInFolder(path); } catch (e) { report(e); } } } },
      { label: "Open in Browser", click: () => {
        if (remote) { shell.openExternal(target).catch(report); return; }
        try {
          statSync(path!);
          // Ask Launch Services for the default HTTPS browser, even for local files.
          const browser = shell.openExternal;
          if (process.platform === "darwin") execFile("/usr/bin/osascript", ["-e", 'POSIX path of (path to default application for URL "https://example.com")'], (err, stdout) => {
            if (err) return report(err);
            execFile("/usr/bin/open", ["-a", stdout.trim(), path!], (e) => { if (e) report(e); });
          });
          else browser(pathToFileURL(path!).href).catch(report);
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
  jobStart: (scopeId: string, cwd: string, cmd: string, termId: string) => jobs.start(scopeId, cwd, cmd, termId),
  jobStop: (id: string) => jobs.stop(id),
  jobWrite: (id: string, text: string) => jobs.write(id, text),
  jobRemove: (id: string) => jobs.remove(id),
  jobSeen: (id: string) => jobs.seen(id),
  jobs: () => jobs.list(),
  authStatus: (provider) => authStatus(provider),
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
  pickFiles: async () => {
    const r = await dialog.showOpenDialog(win, { properties: ["openFile", "multiSelections"] });
    return r.canceled ? [] : r.filePaths;
  },
  setChatKey: (id: string, keyId: string) => {
    store.chat(id).keyId = keyId;
    store.save();
  },
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
  const previous = new Map(store.data.chats.map((c) => [c.id, eventKey(c)]));
  function eventKey(c: (typeof store.data.chats)[number]) {
    const status = chatStatus(c);
    return c.permissions?.length ? `permission:${c.permissions.map((p) => p.id).join(",")}`
      : c.error ? `error:${c.error}` : status ?? "idle";
  }
  store.onChange((s) => {
    for (const c of s.chats) {
      const key = eventKey(c);
      const changed = previous.get(c.id) !== key;
      previous.set(c.id, key);
      if (!changed || key === "idle" || isViewing(c.id) || !Notification.isSupported()) continue;
      const status = chatStatus(c);
      const notification = new Notification({
        title: status === "attention" ? "Chat needs your attention" : status === "complete" ? "Chat complete" : "Chat started working",
        body: c.permissions?.length ? "A chat is waiting for permission." : c.error ? "A chat encountered an error." : status === "attention" ? "A chat is waiting for your response." : status === "complete" ? "Your chat is ready to review." : "Your chat is running.",
      });
      notification.on("click", () => {
        if (!store.data.chats.some((chat) => chat.id === c.id) || !win || win.isDestroyed()) return;
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        send("openChat", c.id);
      });
      notification.on("failed", (_event, error) => console.warn("Chat notification failed:", error));
      notification.show();
    }
    for (const id of previous.keys()) if (!s.chats.some((c) => c.id === id)) previous.delete(id);
    send("state", s);
    acknowledgeChat();
  });
  agents.onPermission((r) => send("permission", r));
  jobs.onJobs((j) => send("jobs", j));
  process.on("uncaughtException", (e) => console.error("[main]", e));
  createWindow();
  // drop worktrees whose folders vanished since last run
  for (const p of store.data.projects) syncWorktrees(p.id).then(() => store.save()).catch(() => {});
});
app.on("before-quit", () => jobs.stopAll());
app.on("window-all-closed", () => app.quit());
