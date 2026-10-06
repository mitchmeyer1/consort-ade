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
import { editMenuTemplate } from "./editMenu";
import { deployPrompt, type DeployProfile } from "../shared/deployProfile.ts";
import { spellingSuggestions } from "./spelling";
import { homeScopes, homeWorktree, isHome, isScratch, scratchWorktree } from "../shared/scratch";
import { isWorkspace, repoDirs, reposForPr, slugify, workspaceForCheckout, workspaceSources } from "../shared/workspace";
import * as ws from "./workspaces";
import { discoverModels } from "./modelDiscovery";
import { allCliStatus, updateAllClis } from "./cliRuntime";
import { mirrorPin, readNotes, writeNotes } from "./notes";
import { forgetCodexModels } from "./codexModels";
import type { Chat, InstalledExtension, Project, RepoResult, RepoStatus, WorkspaceStatus, Worktree } from "../shared/types";
import { askOnce, humanize, suggestTitle } from "./namer";
import { parsePrSuggestion, prSuggestionPrompt } from "../shared/createPr";
import { commitFromChat } from "./commitChat";
import { authLoginCmd, authStatus, claudeBin, codexHome, loginEnv } from "./auth";
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
import { queueAllFindings, findReview, readReview, reinvestigate, reviewDrift, setFinding, setFixRequest, submitReview, ReviewWatchers } from "./prReview";
import { fixPrompt } from "../shared/review";
import { pickReviewChat } from "../shared/reviewRunner";
import { defaultConnector, selectedModel } from "../shared/defaultConnector";
import { modelTiers } from "../shared/modelTiers";
import { MODELS, type Api, type Appearance, type PrDraft } from "../shared/types";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { configureSeats, ensurePoolKeys, isPoolId } from "./seatPool";
import { poolUsage } from "../shared/seatPool";
import * as shipApi from "./ship";
import { buildDossier, writeDossier } from "./investigate";
import { normalizeScratchpad } from "../shared/scratchpad";
import { investigationChatName, investigatePrompt } from "../shared/investigate";
import { canRedoStage, newShipFeature, parseShipCommand, prNumberFromUrl, redoShipChange, shipActionOf, shipBranch, shipChatName, shipFolder, shipIdeaName, shipReviewRoundToStart, shipSlug, syncRetryDelay, ticketRef, type ShipFeature, type ShipForm, type ShipTicket } from "../shared/ship";
import { shipPrompt } from "../shared/shipPrompt";

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
    webPreferences: { preload: join(import.meta.dirname, "../preload/index.mjs"), sandbox: false, spellcheck: true },
  });
  // Chromium underlines the misspelling; the menu that corrects it is ours to draw
  win.webContents.on("context-menu", async (_event, params) => {
    const contents = win?.webContents;
    if (!contents) return;
    const suggestions = params.dictionarySuggestions?.length ? params.dictionarySuggestions : await spellingSuggestions(params.misspelledWord);
    if (contents.isDestroyed()) return;
    const template = editMenuTemplate(params, suggestions, {
      replace: (word) => contents.replaceMisspelling(word),
      addToDictionary: (word) => contents.session.addWordToSpellCheckerDictionary(word),
    });
    if (template.length) Menu.buildFromTemplate(template).popup({ window: win! });
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
/**
 * A review deduces what the project runs on once; every later review of that project is handed
 * the numbers instead of re-reading its infra. The newest profile wins — a PR that changes a
 * Lambda's memory reports the new ceiling.
 */
function cacheDeployProfile(worktreeId: string, deploy: DeployProfile | undefined) {
  if (!deploy?.platform) return;
  const project = store.data.projects.find((p) => p.id === wt(worktreeId)?.projectId);
  if (!project) return;
  if (project.deploy && Date.parse(project.deploy.at) > Date.parse(deploy.at)) return;
  project.deploy = deploy;
  store.save();
}
const project = (id: string) => store.data.projects.find((p) => p.id === id)!;

/**
 * Where Consort keeps what it checks out: single-project worktrees under worktrees/<repo>, and
 * multi-repo workspaces under workspaces/<name>, both inside the app's data directory rather
 * than the repo. That works the same on every machine and keeps checkouts out of the repo tree.
 */
const libraryDir = (...parts: string[]) => join(app.getPath("userData"), ...parts);
const worktreesRoot = (p: Project) => libraryDir("worktrees", basename(p.path));
const workspacesRoot = () => libraryDir("workspaces");

function nativeCommand(file: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<void>((done, fail) => execFile(file, args, { env, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (!error) return done();
    const detail = String(stderr || stdout || error.message).trim().split("\n").slice(-3).join(" ");
    fail(new Error(detail || `Command failed: ${file} ${args.join(" ")}`));
  }));
}

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
  if (!p || isWorkspace(p) || isHome(p)) return; // a workspace's checkouts belong to its source repos; a home has no git
  const live = await git.listWorktrees(p.path);
  // A workspace creates real Git worktrees in its source repos. They belong only to the workspace
  // scope, never to the individual source-project tree. Move old chat records onto that scope once.
  const grouped = new Map(live.flatMap((entry) => {
    const owner = workspaceForCheckout(store.data, projectId, entry.path);
    const scope = owner && store.data.worktrees.find((worktree) => worktree.projectId === owner.id && worktree.workspace);
    return owner && scope ? [[entry.path, scope.id] as const] : [];
  }));
  for (const old of store.data.worktrees.filter((worktree) => worktree.projectId === projectId && grouped.has(worktree.path))) {
    const workspaceId = grouped.get(old.path)!;
    for (const chat of store.data.chats) if (chat.worktreeId === old.id) chat.worktreeId = workspaceId;
  }
  const sourceLive = live.filter((entry) => !grouped.has(entry.path));
  ensureRootWorktree(store.data.worktrees, p, sourceLive.find((w) => w.path === p.path)?.branch ?? "(detached)");
  const mine = store.data.worktrees.filter((w) => w.projectId === projectId);
  for (const l of sourceLive) {
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
      sourceLive.filter((l) => l.path !== p.path).map((l) => prepareWorktree(p.path, l.path, { env, hooks })),
    );
  }
  store.data.worktrees = store.data.worktrees.filter(
    (w) => w.projectId !== projectId || w.root || sourceLive.some((l) => l.path === w.path),
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

// the seat meters: every login's plan usage, read every few minutes and on demand after a limit or a switch
const seats = configureSeats({
  keys: () => store.data.keys,
  read: (key, force) => usage.read(key, { force }),
  publish: (pool) => { store.data.seatPool = pool; store.save(); },
  last: () => store.data.seatPool,
});


const clickUpKey = () => { try { return store.getClickUpKey() || undefined; } catch { return undefined; } };
const shipKey = () => {
  const k = store.data.keys.find((k) => k.id === store.data.defaultKeyId && k.provider === "claude") ?? store.data.keys.find((k) => k.provider === "claude") ?? store.data.keys[0];
  if (!k) throw new Error("Add a connector first (Settings).");
  return k;
};
/** one /ship turn: the stage prompt for the feature, in a chat of its worktree, shown as the command typed */
async function runShipTurn(w: Worktree, form: ShipForm, typed: string, files: string[], keyId: string, reuse?: string): Promise<string> {
  const f = w.ship!;
  const p = project(w.projectId);
  // the review step with its review cut off: finish the review first; its end runs pr-loop by itself
  if (form.form === "pr-loop" && f.review && reviewStalled(w)) {
    const id = await startShipReview(w.id, f.review.round, reuse, true);
    if (id) return id;
  }
  const deps = { repoPath: p.path, clickupKey: clickUpKey() };
  // the ticket is written into the worktree every turn, so any message in the chat can read it; grilling also gets it inline
  const fetched = await shipApi.fetchTicket(f.ticket, deps);
  if (fetched) { f.snapshot = fetched.snapshot; store.save(); }
  const onDisk = shipApi.writeTicketFile(w.path, f.ticket, fetched);
  const ticketBody = f.stage === "Grilling" ? fetched?.body ?? onDisk : undefined;
  // "running": the review turn is going, or still queued, somewhere other than the chat this turn runs in
  const reviewChat = f.review && store.data.chats.find((c) => c.id === f.review!.chatId);
  const reviewQueued = !!reviewChat && !f.review!.doneAt && !!reviewChat.queuedMessages?.some((m) => m.display === reviewTurnLabel(f.review!.round, f.review!.pr));
  const review = f.review ? { running: !f.review.doneAt && !!reviewChat && (reviewQueued || (reviewChat.running && reviewChat.id !== reuse)), summary: (await findReview(w.path, f.review.pr))?.summary } : undefined;
  const prompt = shipPrompt({ feature: f, form, worktree: w.path, branch: w.branch, base: p.defaultBase, ticketBody, review });
  const action = shipActionOf(typed);
  const id: string = reuse ?? handlers.addChat!(w.id, keyId, { name: shipChatName(action, f.ticket), remember: false });
  const chat = store.chat(id);
  chat.ship = { action, stage: f.stage };
  // the pipeline runs long unattended stretches (builds, test sessions, PR loops); Settings › Ship turns this off
  if (!reuse) chat.autoApprove = store.data.shipAutoApprove ?? true;
  store.save();
  await agents.send(id, prompt, files, { display: typed, shipStage: f.stage });
  return id;
}
/**
 * The ticket follows the feature: a stage move writes the label or status and a comment; the spec rides on
 * Spec'd. A write that fails (gh not signed in, no ClickUp key yet, the network) is retried on a backoff
 * until it lands, and again the moment a ClickUp key is saved; nothing asks the user to reconnect.
 */
const syncRetry = new Map<string, NodeJS.Timeout>();
async function writeTicket(worktreeId: string, note: string | undefined, before?: ShipFeature, retry = false) {
  const w = store.data.worktrees.find((x) => x.id === worktreeId);
  const p = w && project(w.projectId);
  if (!w?.ship || !p) return;
  if (!retry && before && before.stage === w.ship.stage && (!w.ship.spec || before.spec === w.ship.spec)) return;
  clearTimeout(syncRetry.get(worktreeId)); syncRetry.delete(worktreeId);
  const sync = await shipApi.syncTicket(w.ship, note, { repoPath: p.path, clickupKey: clickUpKey() }, w.path);
  const tries = sync.ok ? 0 : (w.ship.sync?.ok === false ? w.ship.sync.tries ?? 1 : 0) + 1;
  w.ship.sync = { ...sync, ...(tries ? { tries } : {}) };
  // the write moved the status, so the TICKET panel re-reads it
  const fetched = await shipApi.fetchTicket(w.ship.ticket, { repoPath: p.path, clickupKey: clickUpKey() }).catch(() => undefined);
  if (fetched && w.ship) w.ship.snapshot = fetched.snapshot;
  store.save();
  if (!sync.ok) scheduleTicketRetry(worktreeId, tries);
}
function scheduleTicketRetry(worktreeId: string, tries: number) {
  clearTimeout(syncRetry.get(worktreeId));
  syncRetry.set(worktreeId, setTimeout(() => { void writeTicket(worktreeId, undefined, undefined, true); }, syncRetryDelay(tries)));
}
/** every feature whose last ticket write failed gets another go now: at start-up, and when a ClickUp key is saved */
function retryFailedTickets(source?: ShipTicket["source"]) {
  for (const w of store.data.worktrees)
    if (w.ship && w.ship.sync?.ok === false && (!source || w.ship.ticket.source === source)) void writeTicket(w.id, undefined, undefined, true);
}
agents.onShipChanged((worktreeId, before, after, note, chatId) => {
  void writeTicket(worktreeId, note, before);
  const round = shipReviewRoundToStart(before, after);
  if (round) void startShipReview(worktreeId, round, chatId).catch((e) => console.error("ship self-review failed to start", e));
});
/** the user-visible label of a self-review turn; also how a finished turn is recognised as the review (see onTurnDone) */
const reviewTurnLabel = (round: number, pr: number) => `Self-review round ${round} · PR #${pr}`;
/**
 * A self-review that was started but is neither running, queued nor finished: its chat was stopped,
 * killed with the app, or deleted before it wrote the review file. Consort restarts it rather than
 * leaving the feature waiting on a turn that will never end.
 */
function reviewStalled(w: Worktree): boolean {
  const r = w.ship?.review;
  if (!r || r.doneAt) return false;
  const chat = store.data.chats.find((c) => c.id === r.chatId);
  if (!chat) return true;
  const label = reviewTurnLabel(r.round, r.pr);
  return !chat.running && !chat.queuedMessages?.some((m) => m.display === label);
}
/** the worktree's most recent idle ship chat, where the pipeline's next step runs; undefined when every ship chat is busy */
const idleShipChat = (worktreeId: string) => store.data.chats.filter((c) => c.worktreeId === worktreeId && c.ship && !c.running).sort((a, b) => (b.lastChattedAt ?? 0) - (a.lastChattedAt ?? 0))[0];
/**
 * In Review runs Consort's own PR review (the pr-writeup skill) as the feature's reviewer, in the ship chat
 * that moved the feature there, so the review and the fixes share one transcript. The review is queued
 * behind that chat's current turn, writes .consort/pr-review/pr-<n>.review.json, the drawer shows it with
 * Comment / Ignore / Fix per finding, and when the review turn finishes the same chat gets /ship pr-loop.
 * A new chat is opened only when the moving chat is gone and no ship chat of the worktree is idle.
 */
async function startShipReview(worktreeId: string, round: number, fromChatId?: string, restart = false): Promise<string | undefined> {
  const w = store.data.worktrees.find((x) => x.id === worktreeId);
  if (!w?.ship) return;
  const pr = prNumberFromUrl(w.ship.prs.at(-1) ?? "");
  if (!pr) return;
  if (w.ship.review?.round === round && !w.ship.review.doneAt && !restart) return w.ship.review.chatId; // already started or queued
  const key = shipKey();
  const tiers = modelTiers(key.provider, store.public().models?.[key.provider]);
  const origin = store.data.chats.find((c) => c.id === fromChatId && c.worktreeId === w.id) ?? idleShipChat(w.id);
  const id: string = origin?.id ?? handlers.addChat!(w.id, key.id, { name: `Review PR #${pr} · ship round ${round}`, model: tiers.orchestrator, delegateModel: tiers.delegate, remember: false });
  const chat = store.chat(id);
  chat.autoApprove = store.data.shipAutoApprove ?? true;
  // the review's agents run a tier below the chat's own model, as a stand-alone review would
  chat.delegateModel ??= modelTiers(key.provider, store.public().models?.[key.provider]).delegate;
  w.ship.review = { chatId: id, pr, round, startedAt: Date.now() };
  w.ship.reviewRound = round;
  w.ship.history.push({ at: Date.now(), stage: w.ship.stage, note: restart ? `Review round ${round} restarted on PR #${pr} after an interruption.` : `Review round ${round} started on PR #${pr}.` });
  store.save();
  // the skill resumes from the agent reports already under .consort/pr-review/agents/, so a restart finishes rather than repeats
  const resume = restart ? "\n\nThis review was interrupted before it wrote its review file. Resume it: read .consort/pr-review/agents/ first, dispatch only the groups with no report, then verify and write the file." : "";
  await agents.send(id, handlers.skillPrompt!("pr-writeup", w.id, String(pr), chat.delegateModel) + resume, [], { display: reviewTurnLabel(round, pr) });
  return id;
}
/** every feature whose self-review stalled gets it restarted in its ship chat: at launch, and when the review step is asked for */
function restartStalledReviews() {
  for (const w of store.data.worktrees)
    if (w.ship?.review && reviewStalled(w)) void startShipReview(w.id, w.ship.review.round, undefined, true).catch((e) => console.error("ship self-review restart failed", e));
}
/** a finished self-review hands back to the pipeline: the same chat runs /ship pr-loop over the findings */
agents.onTurnDone((chatId) => {
  const w = store.data.worktrees.find((x) => x.ship?.review?.chatId === chatId && !x.ship.review.doneAt);
  if (!w?.ship?.review) return;
  // the review shares its chat with the turn that approved; only the turn that was the review counts as its end
  const chat = store.data.chats.find((c) => c.id === chatId);
  const label = reviewTurnLabel(w.ship.review.round, w.ship.review.pr);
  const lastUser = [...(chat?.messages ?? [])].reverse().find((m) => m.role === "user");
  const lastText = lastUser?.blocks.map((b) => (b.type === "text" ? b.text : "")).join("\n").trim();
  if (lastText !== label || chat?.queuedMessages?.some((m) => m.display === label)) return;
  w.ship.review.doneAt = Date.now();
  w.ship.next = "/ship pr-loop";
  store.save();
  void (async () => {
    const summary = (await findReview(w.path, w.ship!.review!.pr))?.summary;
    w.ship!.history.push({ at: Date.now(), stage: w.ship!.stage, note: summary ? `Review round ${w.ship!.review!.round}: ${summary.total} finding${summary.total === 1 ? "" : "s"}. Next: fix findings and CI.` : `Review round ${w.ship!.review!.round} stopped before finishing; it will restart.` });
    store.save();
    if (!summary || w.ship!.stage !== "In Review" || w.ship!.paused) return;
    await runShipTurn(w, { form: "pr-loop" }, "/ship pr-loop", [], shipKey().id, idleShipChat(w.id)?.id);
  })().catch((e) => console.error("ship pr-loop after self-review failed", e));
});

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
    if (store.data.projects.some((p) => p.path === path)) return;
    const id = randomUUID();
    if (!(await git.isRepo(path))) {
      // a plain folder is a home: one scratch scope at its path. A /ship scope may already sit on that
      // folder, so the home adopts it rather than opening a second scope on the same folder.
      const project: Project = { id, name: basename(path), path, defaultBase: "", kind: "home" };
      store.data.projects.push(project);
      const existing = store.data.worktrees.find((w) => isScratch(w) && !w.projectId && w.path === path);
      if (existing) Object.assign(existing, { projectId: id, name: project.name, title: project.name, root: true });
      else store.data.worktrees.push(homeWorktree(randomUUID(), project));
      store.save();
      return;
    }
    store.data.projects.push({ id, name: basename(path), path, defaultBase: "origin/main" });
    await syncWorktrees(id);
    store.save();
  },
  removeProject: async (id: string) => {
    const p = project(id);
    if (p && isHome(p)) {
      for (const w of homeScopes(store.data, id)) Object.assign(w, { projectId: "", root: false });
      store.data.projects = store.data.projects.filter((p) => p.id !== id);
      store.save();
      return;
    }
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
  readNotes: (id: string) => readNotes(wt(id)),
  writeNotes: (id: string, doc: import("../shared/notes").NotesDoc) => {
    const w = wt(id);
    const saved = writeNotes(w, doc);
    mirrorPin(w, saved);
    store.save();
    return saved;
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
  readReview: async (id: string, target: string) => {
    const read = await readReview(artifactPath(id, target));
    cacheDeployProfile(id, read.review.deploy);
    return read;
  },
  findReview: (id: string, pr?: number) => findReview(wt(id).path, pr),
  updateReviewFinding: (id: string, target: string, findingId: string, patch: { status?: import("../shared/review").FindingStatus; comment?: string }) => setFinding(artifactPath(id, target), findingId, patch),
  submitReview: (id: string, target: string, opts: { event: import("../shared/review").ReviewEvent; body: string; inline: boolean; draft: boolean }) => submitReview(artifactPath(id, target), opts, id),
  queueAllFindings: (id: string, target: string) => queueAllFindings(artifactPath(id, target)),
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
    let chat = store.data.worktrees.find((w) => w.id === id)?.ship ? idleShipChat(id) : undefined;
    chat ??= pickReviewChat(store.data.chats, id, review.pr);
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
  connectorUsage: async (keyId: string, force?: boolean) => {
    const k = store.data.keys.find((k) => k.id === keyId);
    if (!k) throw new Error("Connector not found");
    if (!k.pool) return usage.read(k, { force });
    if (force) await seats.refresh(true);
    return poolUsage(k.id, store.data.seatPool, k.provider);
  },
  switchSeat: (id: string, dir?: string) => agents.switchSeat(id, dir),
  refreshSeats: async () => { await seats.refresh(true); },
  setShipAutoApprove: (on: boolean) => { store.data.shipAutoApprove = on; store.save(); },
  setClickUpKey: (key: string) => { store.setClickUpKey(key); if (key.trim()) retryFailedTickets("clickup"); },
  setBranchPrefix: (prefix: string) => { store.data.branchPrefix = prefix.trim().replace(/^\/+|\/+$/g, ""); store.save(); },
  setScratchpad: (pad: import("../shared/scratchpad").Scratchpad) => { store.data.scratchpad = normalizeScratchpad(pad); store.save(); },
  prLookup: (projectId: string, number: number) => git.prDetail(project(projectId).path, number),
  // Investigate: read a ticket, its comments and what it links to into a dossier in the project's root
  // checkout, and open a chat there that reports the situation, progress, to-dos and open questions.
  // Read-only: no branch, nothing written to the tracker (shared/investigate.ts).
  investigateStart: async (projectId: string, from: { source: "github"; number: number } | { source: "clickup"; id: string }) => {
    const p = project(projectId);
    if (!p) throw new Error("Project no longer exists.");
    const root = store.data.worktrees.find((w) => w.projectId === projectId && w.root);
    if (!root) throw new Error("The project has no root checkout to investigate in.");
    const key = shipKey();
    const dossier = await buildDossier(from, { repoPath: p.path, clickupKey: clickUpKey() });
    const dossierPath = writeDossier(root.path, dossier);
    await shipApi.excludeConsortDir(root.path).catch(() => {});
    const id: string = handlers.addChat!(root.id, key.id, { name: investigationChatName(dossier.ticket), remember: false });
    const prompt = investigatePrompt({ ticket: dossier.ticket, dossierPath, projectName: p.name, worktreePath: root.path, unreadable: dossier.unreadable });
    await agents.send(id, prompt, [], { display: `Investigate ${ticketRef(dossier.ticket)} · ${dossier.ticket.title}` });
    return id;
  },
  // /ship: a feature is a worktree. Resolve the ticket (or open one from the idea), cut the branch from the
  // project's base like any new worktree, record the feature on it, and open its first chat at Grilling.
  shipStart: async (projectId: string, from: { source: "github"; number: number } | { source: "clickup"; id: string } | { idea: string }, files: string[] = []) => {
    const p = project(projectId);
    if (!p) throw new Error("Project no longer exists.");
    if (isWorkspace(p) || isHome(p)) throw new Error("/ship needs a git project; workspaces and home folders can't ship yet.");
    const key = shipKey();
    let ticket: ShipTicket;
    if ("idea" in from) {
      const idea = from.idea.trim();
      if (!idea) throw new Error("Describe the feature first.");
      ticket = await shipApi.createGithubIssue(p.path, shipIdeaName(idea, 8).replace(/…$/, ""), `${idea}\n\n_Opened by /ship in Consort._`);
    } else if (from.source === "github") ticket = await shipApi.githubTicket(p.path, from.number);
    else {
      const k = clickUpKey();
      if (!k) throw new Error("Add a ClickUp API key in Settings › Ship first.");
      ticket = await shipApi.clickupTicket(k, from.id);
    }
    const slug = shipSlug(ticket.title);
    const branch = shipBranch(store.data.branchPrefix, slug, ticket.id);
    let w = store.data.worktrees.find((x) => x.projectId === projectId && x.branch === branch);
    if (!w) {
      await handlers.addWorktree!(projectId, shipFolder(slug, ticket.id), branch, p.defaultBase);
      w = store.data.worktrees.find((x) => x.projectId === projectId && x.branch === branch);
    }
    if (!w) throw new Error("The worktree was not created.");
    if (!w.ship) { w.ship = newShipFeature(ticket, slug, Date.now()); w.title = ticket.title; }
    await shipApi.excludeConsortDir(w.path).catch(() => {});
    store.save();
    void writeTicket(w.id, "Started.");
    return runShipTurn(w, { form: "resume" }, "/ship", files, key.id);
  },
  // the stage bar's buttons: the pipeline keeps going in the chat you are in when it is idle, else in the
  // worktree's most recent idle ship chat; a new chat only when every one of them is busy or there is none
  shipRun: async (worktreeId: string, command: string, chatId?: string) => {
    const w = wt(worktreeId);
    if (!w?.ship) throw new Error("This worktree is not a /ship feature.");
    const form = parseShipCommand(command);
    if (!form || form.form === "new") throw new Error("Not a /ship command for this feature.");
    if (form.form === "list") form.form = "resume";
    const idle = (c: Chat | undefined) => !!c && c.worktreeId === w.id && !c.running;
    const current = store.data.chats.find((c) => c.id === chatId);
    const reuse = idle(current) ? current : store.data.chats.filter((c) => idle(c) && c.ship).sort((a, b) => (b.lastChattedAt ?? 0) - (a.lastChattedAt ?? 0))[0];
    // Redo: rewind the record to the stage (shared/ship.ts redoShipChange), tell the ticket, then run the stage again
    if (form.form === "redo") {
      if (!form.stage) throw new Error("Say which stage to redo: /ship redo <stage>.");
      if (!canRedoStage(w.ship, form.stage)) throw new Error(`${form.stage} is not a finished stage of this feature.`);
      const before = w.ship;
      w.ship = redoShipChange(w.ship, form.stage, Date.now());
      store.save();
      void writeTicket(w.id, `Redo requested: ${form.stage}.`, before);
      if (form.stage === "In Review") {
        const id = await startShipReview(w.id, Math.max(1, w.ship.reviewRound ?? 1), reuse?.id, true);
        if (id) return id;
      }
    }
    return runShipTurn(w, form, command, [], reuse?.keyId ?? shipKey().id, reuse?.id);
  },
  // typed in a chat: the stage runs there when the chat is idle, else in a fresh chat of the same worktree
  shipCommand: async (chatId: string, text: string, files: string[] = []) => {
    const chat = store.chat(chatId);
    const w = wt(chat.worktreeId);
    const form = parseShipCommand(text);
    if (!form) throw new Error("Not a /ship command.");
    if (!w.ship) {
      if (form.form !== "new" || !form.idea) throw new Error(w.projectId && !isScratch(w) ? "This worktree is not a /ship feature. Start one with /ship new <idea>, or from the project page." : "/ship runs in a project worktree; open a project and start it there.");
      return handlers.shipStart!(w.projectId, { idea: form.idea }, files);
    }
    if (form.form === "new") throw new Error("This worktree already ships a feature; start another from the project page.");
    if (form.form === "list") form.form = "resume";
    return runShipTurn(w, form, text, files, chat.keyId, chat.running ? undefined : chatId);
  },
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
  // Every connector is asked what it offers, from the provider's API and its CLI; the union per
  // provider is the picker's list, kept in state so the next launch starts from it. A provider
  // with no answer keeps its last list.
  refreshModels: async () => {
    forgetCodexModels();
    const found = await discoverModels(store.data.keys, (k) => store.getSecret(k.id));
    for (const provider of ["claude", "codex"] as const)
      if (found[provider]?.length) (store.data.modelCatalog ??= {})[provider] = { models: found[provider]!, at: Date.now() };
    store.save();
  },
  cliStatus: () => allCliStatus(),
  // fetch anything newer for either CLI; a new binary may carry models, so the pickers are re-asked
  updateClis: async () => {
    if (await updateAllClis()) handlers.refreshModels!().catch(() => {});
    return allCliStatus();
  },
  // standing instructions reach a chat on its next turn; running turns keep the prompt they started with
  setInstructions: (items: import("../shared/instructions").Instruction[]) => {
    store.data.instructions = items.map((i) => ({ id: i.id, text: i.text.trim(), enabled: !!i.enabled })).filter((i) => i.text);
    store.save();
  },
  installClaudePlugin: async (keyId: string, marketplace: string, plugin: string): Promise<InstalledExtension> => {
    const key = store.data.keys.find((k) => k.id === keyId);
    if (!key || key.provider !== "claude") throw new Error("Choose a Claude connector.");
    if (key.auth !== "login") throw new Error("Claude plugins need a Claude Code terminal-login connector.");
    const name = plugin.trim();
    if (!name) throw new Error("Enter a plugin name.");
    const env = { ...process.env, ...loginEnv(key) };
    const source = marketplace.trim();
    if (source) await nativeCommand(claudeBin(), ["plugin", "marketplace", "add", source], env);
    await nativeCommand(claudeBin(), ["plugin", "install", name], env);
    const installed: InstalledExtension = { id: randomUUID(), connectorId: key.id, provider: "claude", kind: "plugin", name, ...(source ? { source } : {}), installedAt: Date.now() };
    (store.data.extensions ??= []).push(installed);
    store.save();
    return installed;
  },
  installCodexSkill: (keyId: string, source: string): InstalledExtension => {
    const key = store.data.keys.find((k) => k.id === keyId);
    if (!key || key.provider !== "codex") throw new Error("Choose a Codex connector.");
    const root = resolve(source);
    if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error("Choose a skill folder.");
    if (!existsSync(join(root, "SKILL.md"))) throw new Error("That folder must contain SKILL.md.");
    const name = basename(root).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!name) throw new Error("Choose a folder with a valid name.");
    const destination = join(codexHome(key), "skills", name);
    if (existsSync(destination)) throw new Error(`A Codex skill named “${name}” is already installed for this connector.`);
    mkdirSync(join(codexHome(key), "skills"), { recursive: true });
    cpSync(root, destination, { recursive: true, force: false, errorOnExist: true });
    const installed: InstalledExtension = { id: randomUUID(), connectorId: key.id, provider: "codex", kind: "skill", name, source: root, installedAt: Date.now() };
    (store.data.extensions ??= []).push(installed);
    store.save();
    return installed;
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
  clearChat: (id: string) => agents.clearChat(id),
  setShowToolCalls: (on: boolean) => { store.data.showToolCalls = on; store.save(); },
  setChatToolCalls: (id: string, on: boolean | null) => { const chat = store.chat(id); chat.showToolCalls = on ?? undefined; store.save(); },
  listCommands: (id: string) => agents.listCommands(id),
  renameChat: (id: string, name: string) => {
    const chat = store.chat(id);
    chat.name = name;
    // a repoless chat's worktree is only its folder; its title follows the chat
    const w = store.data.worktrees.find((w) => w.id === chat.worktreeId);
    if (w && isScratch(w) && !w.ship && !w.projectId) w.title = name;
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
    if (w && isScratch(w) && !w.ship && !w.projectId && !store.data.chats.some((c) => c.worktreeId === w.id)) {
      store.data.worktrees = store.data.worktrees.filter((x) => x.id !== w.id);
      if (w.path.startsWith(scratchRoot())) rmSync(w.path, { recursive: true, force: true });
    }
    store.save();
  },
  setAutoApprove: (id: string, on: boolean) => agents.setAutoApprove(id, on),
  setAutopilot: (id: string, on: boolean) => {
    if (on && !store.getOpenRouterKey()) throw new Error("Autopilot needs an OpenRouter key: add one in Settings under OpenRouter navigator.");
    store.chat(id).autopilot = on;
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
  setDefaultKey: (id: string) => {
    if (!store.data.keys.some((key) => key.id === id)) throw new Error("Connector not found.");
    store.data.defaultKeyId = id;
    store.save();
  },
  stop: (id: string) => agents.stop(id),
  addKey: (name: string, provider, key: string, auth?: "login" | "key") => {
    const id = randomUUID();
    auth ??= key ? "key" : "login";
    if (auth === "key") {
      if (!key) throw new Error("Enter an API key.");
      store.data.keys.push({ id, name, provider, auth });
      store.setSecret(id, key);
    } else {
      // a second CLI login for the same provider: give it a private config dir so its credentials don't collide with the built-in one
      const configDir = join(app.getPath("userData"), "logins", id);
      mkdirSync(configDir, { recursive: true });
      store.data.keys.push({ id, name, provider, auth, configDir });
    }
    ensurePoolKeys(store.data);
    store.save();
    void seats.refresh(true);
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
    if (id.startsWith("login-") || isPoolId(id)) return;
    const key = store.data.keys.find((k) => k.id === id);
    if (key?.configDir && key.configDir.startsWith(join(app.getPath("userData"), "logins"))) rmSync(key.configDir, { recursive: true, force: true });
    store.data.keys = store.data.keys.filter((k) => k.id !== id);
    delete store.data.secrets[id];
    usage.forget(id);
    // a provider left with no logins loses its pool; its seats are re-read either way
    ensurePoolKeys(store.data);
    store.save();
    void seats.refresh(true);
  },
  setOpenRouterKey: (key: string) => store.setOpenRouterKey(key),
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
    let progress = "", rubric = "", deploy = "";
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
      // Phase 0.5 needs either the cached ceilings or the order to go and find them.
      const project = store.data.projects.find((p) => p.id === wt(worktreeId).projectId);
      deploy = `\n\n## Deployment profile for this project (Phase 0.5)\n\n${deployPrompt(project?.deploy)}`;
    }
    const tier = delegateModel ? `You are the orchestrator, running on this session's strongest model. Dispatch every delegated agent on \`${delegateModel}\` by passing that model on the agent call; the runtime already defaults delegated agents to it. Your tokens go to scope, grouping, short assignments, verification decisions and the final prose — not to reading the diff yourself. Escalate a single agent back to your own model only when a specific verification has already failed at the delegate tier, and say why in the summary.\n\n` : "";
    return `${progress}${tier}Run the following skill${args ? ` with argument: ${args}` : " for the current branch"} in ${worktreePath}. Its sibling files live in ${dir}.
The Artifact tool is not available here. The deliverable is the review file: write it to .consort/pr-review/pr-<n>.review.json in the worktree, in the schema the skill gives. Consort renders that file and lets the user approve or ignore each finding and post the approved ones to GitHub, so do not post comments yourself. Print the operational review summary in chat, then end with a clickable Markdown link to the saved review file using its absolute path.

${skill}${deploy}${rubric}`;
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
  retryFailedTickets();
  ensurePoolKeys(store.data);
  store.save();
  seats.start();
  // a self-review the last run never finished (the app quit, the chat was stopped or deleted) is picked up again
  setTimeout(restartStalledReviews, 5_000);
  // a pinned note lives in the worktree's own file; the sidebar reads the mirror on the record, so refresh it from disk once
  for (const w of store.data.worktrees) mirrorPin(w, readNotes(w));
  // the model pickers follow the providers, not a release of Consort: ask on every start
  handlers.refreshModels!().catch((error: unknown) => console.warn("model refresh failed", error));
  // so do the CLIs themselves: a release newer than the bundled one is fetched on start and daily (main/cliRuntime.ts)
  const sweepClis = () => handlers.updateClis!().catch((error: unknown) => console.warn("CLI update failed", error));
  setTimeout(sweepClis, 15_000);
  setInterval(sweepClis, 24 * 3_600_000);
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
    notifier.show({ title: `Permission needed: ${request.tool}`, body: `${chat.name} · click to allow or deny`, open: { chat: chat.id }, kind: "info" });
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
        title: c.error ? "Chat failed" : status === "attention" ? "Chat needs you" : status === "complete" ? "Chat finished" : "Chat running",
        body: `${c.name}${c.error ? ` · ${c.error.split("\n")[0]}` : status === "attention" ? " · waiting for your reply" : status === "complete" ? " · ready to read" : ""}`,
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
