import { selectedModel } from "../shared/defaultConnector";
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell, Notification, Menu } from "electron";
import { join, basename, resolve, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { store } from "./store";
import * as git from "./git";
import { ensureRootWorktree, isRootWorktree } from "./rootWorktree";
import * as agents from "./agents";
import { askOnce, humanize, suggestTitle } from "./namer";
import { commitFromChat } from "./commitChat";
import { authLoginCmd, authStatus } from "./auth";
import * as ptys from "./ptys";
import { chatStatus } from "../shared/chatStatus";
import { MODELS, type Api, type Appearance } from "../shared/types";
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
  store.data.worktrees = store.data.worktrees.filter(
    (w) => w.projectId !== projectId || w.root || live.some((l) => l.path === w.path),
  );
  const alive = new Set(store.data.worktrees.map((w) => w.id));
  store.data.chats = store.data.chats.filter((c) => alive.has(c.worktreeId));
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
    finally { statusCache.delete(id); repoCache.delete(w.projectId); store.save(); }
  },
  pushWorktree: async (id: string, branch: string) => {
    const w = wt(id);
    if (!w) throw new Error("Worktree no longer exists.");
    if (store.data.chats.some((c) => c.worktreeId === id && c.running)) throw new Error("Wait for this worktree's chats to finish before pushing.");
    try { return await git.pushWorktree(w.path, branch); }
    finally { statusCache.delete(id); }
  },
  commitAndPushRoot: async (id: string, branch: string, message: string) => {
    const w = wt(id);
    if (!w || !isRootWorktree(w, project(w.projectId))) throw new Error("Root worktree no longer exists.");
    if (store.data.chats.some((c) => c.worktreeId === id && c.running)) throw new Error("Wait for root chats to finish before committing and pushing.");
    try { return await git.commitAndPushRoot(w.path, branch, message); }
    finally { statusCache.delete(id); repoCache.delete(w.projectId); }
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
  authStatus: (keyId: string) => authStatus(keyId),
  commitInfo: (id: string) => git.commitInfo(wt(id).path),
  commit: async (id: string, message: string) => { const r = await git.commit(wt(id).path, message); statusCache.delete(id); return r; },
  suggestCommit: async (id: string) => {
    const diff = await git.diffForSummary(wt(id).path);
    if (!diff.trim()) return "";
    return askOnce(wt(id).path, `Write a git commit message for this diff.\nFormat: a short imperative subject line (max 60 chars), a blank line, then 1 to 5 bullets, each ONE sentence, each starting with "- ". No other text.\n\n${diff}`);
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
  addChat: (worktreeId: string, keyId: string, opts: { name?: string; model?: string } = {}) => {
    const id = randomUUID();
    const key = store.data.keys.find((k) => k.id === keyId);
    if (!key) throw new Error("Connector not found.");
    const provider = key.provider;
    const model = opts.model?.trim() || selectedModel(store.data, key, MODELS[provider][0]);
    key.defaultModel = model;
    store.data.chats.push({
      id, worktreeId, provider, keyId, model, name: opts.name || "New chat",
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
    store.save();
  },
  answerPermission: (id: string, allow: boolean) => agents.answerPermission(id, allow),
  skillPrompt: (name: string, worktreeId: string, args?: string) => {
    const dir = join(app.getAppPath(), "skills", name);
    const skill = readFileSync(join(dir, "SKILL.md"), "utf8").replace(/^---[\s\S]*?---\n/, "");
    const brief = name === "pr-writeup" ? `\n\n## Complete review agent brief — include in every delegated assignment\n\n${readFileSync(join(dir, "categories.md"), "utf8")}` : "";
    const progress = name === "pr-writeup" ? "Keep the user informed in chat: explain the review plan before tools, then give a brief plain-language update every 30–45 seconds or five tool calls, whichever comes first. Summarize what you learned and what you are checking next; tool output alone is not an update.\n\n" : "";
    return `${progress}Run the following skill${args ? ` with argument: ${args}` : " for the current branch"} in ${wt(worktreeId).path}. Its sibling files live in ${dir}.
The Artifact tool is not available here: write the finished HTML to .consort/pr-writeup.html in the worktree. Print the operational review summary in the terminal/chat, then end with a clickable Markdown link to the saved HTML using its absolute path.

${skill}${brief}`;
  },
  addQuickAction: (worktreeId: string, title: string, command: string) => {
    const worktree = wt(worktreeId);
    if (!title.trim() || !command.trim()) throw new Error("Enter a title and Bash command.");
    (worktree.quickActions ??= []).push({ id: randomUUID(), title: title.trim(), command });
    store.save();
  },
  setQuickActionPinned: (worktreeId: string, actionId: string, pinned: boolean) => {
    const action = wt(worktreeId).quickActions?.find((action) => action.id === actionId);
    if (!action) throw new Error("Quick action not found.");
    action.pinned = pinned;
    store.save();
  },
  deleteQuickAction: (worktreeId: string, actionId: string) => {
    const worktree = wt(worktreeId);
    worktree.quickActions = (worktree.quickActions ?? []).filter((action) => action.id !== actionId);
    store.save();
  },
  runCommand: (worktreeId: string, cmd: string) => git.runCommand(wt(worktreeId).path, cmd),
  diff: (worktreeId: string) => git.diff(wt(worktreeId).path),
};

app.whenReady().then(() => {
  store.load();
  store.save();
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
  ptys.listen((id, data) => send("pty:data", { id, data }), (s) => send("ptys", s));
  process.on("uncaughtException", (e) => console.error("[main]", e));
  createWindow();
  // drop worktrees whose folders vanished since last run
  for (const p of store.data.projects) syncWorktrees(p.id).then(() => store.save()).catch(() => {});
});
app.on("before-quit", () => ptys.killAll());
app.on("window-all-closed", () => app.quit());
