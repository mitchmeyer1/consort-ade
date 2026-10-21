import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import type { Provider } from "../shared/types";
import type { ReviewPick, SourceFilters, TaskCost } from "../shared/headless";
import type { ShipFeature, ShipStage, ShipTicket } from "../shared/ship";

/**
 * consort-cli's state: one JSON file under ~/.consort-cli (or $CONSORT_CLI_HOME), mode 0600
 * because it holds API keys. There is no keychain on a server. The daemon and each worker
 * process read and write it; writes are whole-file and atomic (rename), and a worker only ever
 * patches its own task, so the race window is a scan loop and a worker saving in the same
 * instant, which loses nothing worse than one timestamp.
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
  const s = loadState();
  if (!s.hostId) { s.hostId = `${hostname().replace(/\.local$/, "").replace(/[^\w.-]+/g, "-")}-${randomBytes(2).toString("hex")}`; saveState(s); }
  return s.hostId;
};

export type Account = {
  id: string; name: string; provider: Provider; auth: "login" | "key"; configDir?: string; apiKey?: string; createdAt: number;
  /** set when the account hit a usage limit; the pool skips it until then (shared/headless.ts pickAccount) */
  blockedUntil?: number; blockedWhy?: string; lastUsedAt?: number;
};
export type SlackConfig = { botToken: string; userId: string; channel?: string };
export type StatusNames = { progress: string; review: string; done: string };
export type Job = {
  id: string; name: string;
  source: "clickup" | "github" | "sentry";
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
  maxParallel: number;
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
  /** Last thread message inspected by the daemon status responder. */
  slackStatusAfterTs?: string;
  /** agent session ids by provider, so a task keeps one conversation per provider */
  sessions: Partial<Record<Provider, string>>;
  /** the ship stage each session in `sessions` belongs to; a new stage starts a new session from a handoff. Absent on tasks from before this, which keep resuming */
  sessionStages?: Partial<Record<Provider, ShipStage>>;
  /** Claude Code's last per-model report for each session, a running total on newer releases (see turnSpend) */
  sessionReports?: Partial<Record<Provider, { session: string; usage: import("../shared/headless.ts").TurnUsage[] }>>;
  /** the builder's last reply, quoted to the next stage's fresh session */
  lastReply?: string;
  accountIds: Partial<Record<Provider, string>>;
  /** provider executing the current turn, including a fallback from the builder's provider */
  activeProvider?: Provider;
  reviewsDone: number;
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
export type CliState = { version: 1; accounts: Account[]; slack?: SlackConfig; clickupKey?: string; branchPrefix?: string; jobs: Job[]; tasks: Task[];
  /** set by `consort-cli setup` at the end of the walk-through; every other command checks it */
  setupCompletedAt?: number;
  /** this install's claim name: hostname plus a random suffix, minted on first use */
  hostId?: string;
};

const empty = (): CliState => ({ version: 1, accounts: [], jobs: [], tasks: [] });

export function loadState(): CliState {
  if (!existsSync(STATE_FILE)) return empty();
  const raw = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Partial<CliState>;
  return { ...empty(), ...raw, accounts: raw.accounts ?? [], jobs: raw.jobs ?? [], tasks: raw.tasks ?? [] };
}

export function saveState(s: CliState) {
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, STATE_FILE);
  try { chmodSync(STATE_FILE, 0o600); } catch {}
}

/** re-read, patch one task, write: the only way a worker touches the file */
export function updateTask(id: string, patch: Partial<Task> | ((t: Task) => Partial<Task>), touch = true): Task {
  const s = loadState();
  const t = s.tasks.find((x) => x.id === id);
  if (!t) throw new Error(`Task ${id} is not in the state file.`);
  Object.assign(t, typeof patch === "function" ? patch(t) : patch, touch ? { updatedAt: Date.now() } : {});
  saveState(s);
  return t;
}

export const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const DEFAULT_STATUSES: StatusNames = { progress: "in progress", review: "in review", done: "complete" };

/** block an account after a usage limit; `until` from the provider when it said, else an hour */
export function blockAccount(id: string, until: number | undefined, why: string) {
  const s = loadState();
  const a = s.accounts.find((x) => x.id === id);
  if (!a) return;
  a.blockedUntil = until && until > Date.now() ? until : Date.now() + 60 * 60_000;
  a.blockedWhy = why.slice(0, 200);
  saveState(s);
}
export function touchAccount(id: string) {
  const s = loadState();
  const a = s.accounts.find((x) => x.id === id);
  if (a) { a.lastUsedAt = Date.now(); saveState(s); }
}
