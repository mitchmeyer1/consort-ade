import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, openSync, closeSync, unlinkSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import type { Provider } from "../shared/types";
import type { ReviewPick, SourceFilters, TaskCost } from "../shared/headless";
import type { ShipFeature, ShipTicket } from "../shared/ship";

/**
 * consort-cli's state: one JSON file under ~/.consort-cli (or $CONSORT_CLI_HOME), mode 0600
 * because it holds API keys. There is no keychain on a server. The daemon and each worker
 * process read and write it. A cross-process lock serializes mutations; stale snapshots
 * merge their changed fields into the latest file rather than replacing other workers' work.
 */

export const HOME = process.env.CONSORT_CLI_HOME ?? join(homedir(), ".consort-cli");
export const STATE_FILE = join(HOME, "state.json");
export const LOG_DIR = join(HOME, "logs");
export const LOGINS_DIR = join(HOME, "logins");
export const WORK_DIR = join(HOME, "worktrees");
/**
 * This install's name on tickets: the hostname plus a short random suffix minted once and kept in
 * the state file, so two laptops with the same hostname (or two installs on one box, with
 * CONSORT_CLI_HOME) never look like the same claimant. CONSORT_CLI_HOST overrides it.
 */
export const host = (): string => {
  if (process.env.CONSORT_CLI_HOST) return process.env.CONSORT_CLI_HOST;
  const known = loadState().hostId;
  if (known) return known;
  return mutateState(s => {
    if (!s.hostId) s.hostId = `${hostname().replace(/\.local$/, "").replace(/[^\w.-]+/g, "-")}-${randomBytes(2).toString("hex")}`;
    return s.hostId;
  });
};

export type Account = {
  id: string; name: string; provider: Provider; auth: "login" | "key"; configDir?: string; apiKey?: string; createdAt: number;
  /** Maximum simultaneous requests using this provider account; defaults to two. */
  maxActiveTurns?: number;
  /** set when the account hit a usage limit; the pool skips it until then (shared/headless.ts pickAccount) */
  blockedUntil?: number; blockedWhy?: string; lastUsedAt?: number;
};
export type SlackConfig = { botToken: string; userId: string; channel?: string };
export type StatusNames = { progress: string; review: string; done: string };
export type Job = {
  id: string; name: string;
  source: "clickup" | "github" | "sentry" | "review";
  /** review scanners: the GitHub login whose assigned or requested PRs get an automatic review (cli/reviewJob.ts) */
  reviewer?: string;
  sentry?: import("../shared/sentryScanner.ts").SentryScannerConfig;
  /** absolute path of the repository checkout on this machine (on its base branch) */
  repo: string;
  /** the branch features are cut from and PRs target, e.g. main */
  base: string;
  /** ClickUp list id (clickup source; the first cut only knew lists) */
  listId?: string;
  /** ClickUp scope: a list, a folder of lists, or a whole space; every list inside is scanned */
  scope?: { kind: "list" | "folder" | "space"; id: string };
  filters: SourceFilters;
  everyMinutes: number;
  /** the tracker's own status names the pipeline moves tickets through */
  statuses: StatusNames;
  reviewModels?: ReviewPick[];
  /** Active AI turns; waiting workers do not consume this limit. */
  maxParallel: number;
  maxOpenTasks?: number;
  maxEnvironments?: number;
  modelPolicy?: import("../shared/cliModels.ts").CliModelPolicy;
  effortPolicy?: import("../shared/cliTurnPolicy.ts").CliEffortPolicy;
  parallelResearch?: number;
  parallelImplementation?: number;
  maxModelAttempts?: number;
  enabled: boolean;
  lastScanAt?: number;
  scanStartedAt?: number;
  createdAt: number;
};
export type TaskStatus = "working" | "waiting" | "monitoring" | "ready" | "done" | "failed" | "released";
export type Task = {
  id: string; jobId: string;
  ticket: ShipTicket;
  worktree: string; branch: string;
  feature: ShipFeature;
  status: TaskStatus;
  lifecycle?: "running" | "monitoring" | "paused" | "stopped" | "completed";
  pauseReason?: string;
  notificationQueue?: { id: string; text: string }[];
  /** Persist unanswered questions across worker restarts. */
  pendingQuestion?: { questions: string[]; afterTs: string };
  reviewersRequested?: string[];
  reviewWaitSince?: number;
  reviewRequestedHead?: string;
  reviewRequestedAt?: number;
  /** Written only after evidence validation, independent inspection, and publication succeed. */
  evidenceValidatedAt?: number;
  recoveryGuidance?: string;
  /** set by `consort-cli reboot`: the next worker opens with a turn that works out where the last run got to */
  rebootedAt?: number;
  /** the Slack thread every message about this task goes to */
  slackThread?: string;
  slackIdentity?: import("../shared/headless.ts").SlackIdentity;
  /** what the thread's first post says now (headless.ts slackCard key); the daemon edits the post when it changes */
  slackCard?: string;
  /** Last thread message inspected by the daemon status responder. */
  slackStatusAfterTs?: string;
  /** owner messages from the Slack thread, waiting for the worker to apply (cli/ownerUpdates.ts) */
  ownerUpdates?: import("./ownerUpdates").OwnerUpdate[];
  /** Slack message ts values the daemon saw as answers to pending questions, so they are not queued as updates */
  answeredTs?: string[];
  /** agent session ids by provider, so a task keeps one conversation per provider */
  sessions: Partial<Record<Provider, string>>;
  accountIds: Partial<Record<Provider, string>>;
  /** provider executing the current turn, including a fallback from the builder's provider */
  turnHistory?: { at: number; stage: string; role: string; provider: Provider; model: string; effort?: import("../shared/cliTurnPolicy.ts").EffortLevel; durationMs: number; usage?: import("../shared/headless.ts").TurnUsage[]; error?: string; escalated?: boolean; escalationReason?: string }[];
  riskReason?: string;
  /** the turn in flight, or the last one: the view shows its model and effort beside the account */
  turn?: { role: string; provider: Provider; model: string; effort: import("../shared/cliTurnPolicy.ts").EffortLevel; startedAt: number };
  activeProvider?: Provider;
  activeTurns?: { id: string; pid: number; accountId: string; startedAt: number; units?: number }[];
  childEnvironments?: { id: string; portBase: number; runCode: string; pid: number }[];
  environmentReservation?: { pid: number; at: number };
  reviewsDone: number;
  /** a review task (from a review scanner) reviews someone else's PR instead of building a ticket */
  kind?: "build" | "review";
  review?: import("./reviewJob").ReviewTarget;
  /** which of headless.ts REVIEW_STEPS a review task is on, 1-based */
  reviewStep?: number;
  /** the build graph was re-split once for parallel work (cli/buildGraph.ts) */
  graphResplitAt?: number;
  /** `consort-cli tasks split`: re-split the unfinished build tickets on the next build step, chain or not */
  resplitRequested?: number;
  /** where the worker last moved each ClickUp subtask (cli/subtasks.ts) */
  subtaskSync?: Record<string, import("./subtasks").SubtaskState>;
  /** build tickets already reported on their ClickUp subtasks as landed */
  subtaskTicketsNoted?: string[];
  /** tries at linking the build tickets to the ClickUp subtasks (at most two) */
  subtaskLinkTries?: number;
  /** the ticket set the last "Build plan" Slack line described */
  buildPlanIds?: string;
  /** review thread ids already answered */
  threadsSeen: string[];
  reviewBatch?: { fingerprint: string; stableSince: number };
  pid?: number;
  workerStop?: { pid: number; command: string; requesterPid: number; at: number; holdUntil: number };
  /** worker crashes so far; the daemon restarts a crashed worker a few times before failing the task */
  restarts?: number;
  startedAt: number; updatedAt: number; lastPrCheckAt?: number; finishedAt?: number;
  note?: string;
  /** one line on what the worker is doing right now, for `consort-cli view` */
  activity?: string;
  /** the agent's last few progress lines from its current turn, for the stop report on Slack */
  recent?: string[];
  /** the task's own environment: Docker run code and the first port of its block (see cli/environment.ts) */
  runCode?: string; portBase?: number; envReadyAt?: number;
  /** tokens and estimated dollars over every agent turn so far (shared/headless.ts addTurnCost) */
  cost?: TaskCost;
};
export type CliState = { capacity?: { maxActiveTurns?: number; maxOpenTasks?: number; maxEnvironments?: number }; version: 1; accounts: Account[]; slack?: SlackConfig; clickupKey?: string; branchPrefix?: string; jobs: Job[]; tasks: Task[];
  /** set by `consort-cli setup` at the end of the walk-through; every other command checks it */
  setupCompletedAt?: number;
  /** this install's claim name: hostname plus a random suffix, minted on first use */
  hostId?: string;
};

const empty = (): CliState => ({ version: 1, accounts: [], jobs: [], tasks: [] });

const snapshots = new WeakMap<CliState, CliState>();
const copy = <T>(value: T): T => structuredClone(value);
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function readState(): CliState {
  if (!existsSync(STATE_FILE)) return empty();
  const raw = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Partial<CliState>;
  return { ...empty(), ...raw, accounts: raw.accounts ?? [], jobs: raw.jobs ?? [], tasks: raw.tasks ?? [] };
}
export function loadState(): CliState {
  const state = readState();
  snapshots.set(state, copy(state));
  return state;
}

/** Apply only a caller's edits, including nested edits to id-addressed records. */
function mergeEdits(before: any, edited: any, latest: any): any {
  if (equal(before, edited)) return latest;
  if (Array.isArray(before) && Array.isArray(edited) && [...before, ...edited].every(x => object(x) && typeof x.id === "string")) {
    const old = new Map(before.map(x => [x.id, x]));
    const next = new Map(edited.map(x => [x.id, x]));
    const result = (Array.isArray(latest) ? latest : []).filter(x => !old.has(x.id) || next.has(x.id)).map(x => {
      const changed = next.get(x.id);
      return old.has(x.id) && changed ? mergeEdits(old.get(x.id), changed, x) : x;
    });
    for (const entry of edited) if (!old.has(entry.id) && !result.some(x => x.id === entry.id)) result.push(copy(entry));
    return result;
  }
  if (object(before) && object(edited)) {
    const result = { ...(object(latest) ? latest : {}) };
    for (const key of new Set([...Object.keys(before), ...Object.keys(edited)])) {
      if (equal(before[key], edited[key])) continue;
      if (!(key in edited) || edited[key] === undefined) delete result[key];
      else result[key] = mergeEdits(before[key], edited[key], result[key]);
    }
    return result;
  }
  return copy(edited);
}

function writeState(s: CliState) {
  const tmp = `${STATE_FILE}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, STATE_FILE);
    try { chmodSync(STATE_FILE, 0o600); } catch {}
  } finally { try { unlinkSync(tmp); } catch {} }
}

export const processAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};

/** Synchronous critical sections contain no awaits and release the lock on every exit. */
function locked<T>(action: () => T): T {
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const lock = `${STATE_FILE}.lock`;
  const deadline = Date.now() + 15_000;
  let fd: number;
  for (;;) {
    try { fd = openSync(lock, "wx", 0o600); writeFileSync(fd, String(process.pid)); break; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        const pid = Number(readFileSync(lock, "utf8"));
        if ((pid > 0 && !processAlive(pid)) || (!pid && Date.now() - statSync(lock).mtimeMs > 30_000)) { unlinkSync(lock); continue; }
      } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; }
      if (Date.now() >= deadline) throw new Error(`Timed out locking ${STATE_FILE}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try { return action(); } finally { closeSync(fd); unlinkSync(lock); }
}

/** Atomic read/modify/write for counters, leases, and decisions using current state. */
export function mutateState<T>(action: (state: CliState) => T): T {
  return locked(() => { const state = readState(); const before = JSON.stringify(state); const result = action(state); if (JSON.stringify(state) !== before) writeState(state); return result; });
}
export function saveState(s: CliState) {
  locked(() => {
    const baseline = snapshots.get(s);
    const merged = baseline ? mergeEdits(baseline, s, readState()) as CliState : mergeEdits(empty(), s, readState()) as CliState;
    writeState(merged);
    // Keep the caller's snapshot: refreshing its baseline to unseen fields would make its
    // next save delete concurrent additions it never received.
    snapshots.set(s, copy(s));
  });
}

export function updateTask(id: string, patch: Partial<Task> | ((t: Task) => Partial<Task>), touch = true): Task {
  return mutateState(s => {
    const t = s.tasks.find(x => x.id === id);
    if (!t) throw new Error(`Task ${id} is not in the state file.`);
    Object.assign(t, typeof patch === "function" ? patch(t) : patch, touch ? { updatedAt: Date.now() } : {});
    return t;
  });
}

export const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const DEFAULT_STATUSES: StatusNames = { progress: "in progress", review: "in review", done: "complete" };

/** block an account after a usage limit; `until` from the provider when it said, else an hour */
export function blockAccount(id: string, until: number | undefined, why: string) {
  mutateState(s => {
    const a = s.accounts.find(x => x.id === id);
    if (!a) return;
    a.blockedUntil = until && until > Date.now() ? until : Date.now() + 60 * 60_000;
    a.blockedWhy = why.slice(0, 200);
  });
}
export function touchAccount(id: string) {
  mutateState(s => { const a = s.accounts.find(x => x.id === id); if (a) a.lastUsedAt = Date.now(); });
}
