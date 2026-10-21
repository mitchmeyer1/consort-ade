import { randomUUID } from "node:crypto";
import { loadState, mutateState, processAlive, type CliState, type Job, type Task } from "./state";

/** Separate task backlog, provider turns, and environments: polling consumes no AI slot. */
const open = (task: Task) => ["working", "waiting", "monitoring"].includes(task.status);
const positive = (value: number | undefined, fallback: number) => Number.isInteger(value) && value! > 0 ? value! : fallback;
export const openTaskLimit = (job: Job) => positive(job.maxOpenTasks, Math.max(8, job.maxParallel * 4));
export const environmentLimit = (job: Job) => positive(job.maxEnvironments, openTaskLimit(job));
export const availableTaskSlots = (state: CliState, job: Job) => Math.max(0, Math.min(openTaskLimit(job) - state.tasks.filter(t => t.jobId === job.id && open(t)).length, positive(state.capacity?.maxOpenTasks, 32) - state.tasks.filter(open).length));

export class AccountUnavailableError extends Error {
  constructor(public accountId: string) { super(`Account ${accountId} reached its usage limit while waiting for capacity.`); this.name = "AccountUnavailableError"; }
}

export const maxAgentTurnUnits = (taskId: string, accountId: string): number => {
  const state = loadState();
  const task = state.tasks.find(t => t.id === taskId);
  const job = state.jobs.find(j => j.id === task?.jobId);
  const account = state.accounts.find(a => a.id === accountId);
  if (!task || !job || !account) throw new Error(`Missing task, job or account for task ${taskId}.`);
  return Math.min(positive(job.maxParallel, 2), positive(account.maxActiveTurns, 2), positive(state.capacity?.maxActiveTurns, 4));
};

export function tryAcquireAgentTurn(taskId: string, accountId: string, units = 1): string | undefined {
  if (!Number.isInteger(units) || units < 1) throw new Error("Agent capacity units must be a positive integer.");
  return mutateState(state => {
    for (const t of state.tasks) t.activeTurns = t.activeTurns?.filter(turn => processAlive(turn.pid));
    const task = state.tasks.find(t => t.id === taskId);
    if (!task || !open(task)) throw new Error(`Task ${taskId} cannot start an agent turn.`);
    const job = state.jobs.find(j => j.id === task.jobId);
    const account = state.accounts.find(a => a.id === accountId);
    if (!job || !account) throw new Error(`Missing job or account for task ${taskId}.`);
    if (account.blockedUntil && account.blockedUntil > Date.now()) throw new AccountUnavailableError(accountId);
    const active = state.tasks.flatMap(t => (t.activeTurns ?? []).map(turn => ({ ...turn, jobId: t.jobId })));
    const total = (turns: typeof active) => turns.reduce((n, turn) => n + (turn.units ?? 1), 0);
    const globalLimit = positive(state.capacity?.maxActiveTurns, 4);
    const jobLimit = positive(job.maxParallel, 2);
    const accountLimit = positive(account.maxActiveTurns, 2);
    if (units > Math.min(globalLimit, jobLimit, accountLimit)) throw new Error(`Agent capacity request ${units} exceeds task ${taskId} limits.`);
    if (total(active) + units > globalLimit) return undefined;
    if (total(active.filter(t => t.jobId === job.id)) + units > jobLimit) return undefined;
    if (total(active.filter(t => t.accountId === accountId)) + units > accountLimit) return undefined;
    const id = randomUUID();
    (task.activeTurns ??= []).push({ id, pid: process.pid, accountId, startedAt: Date.now(), units });
    return id;
  });
}
export function releaseAgentTurn(taskId: string, lease: string) {
  mutateState(state => { const t = state.tasks.find(t => t.id === taskId); if (t) t.activeTurns = t.activeTurns?.filter(turn => turn.id !== lease); });
}
export async function withAgentTurn<T>(taskId: string, accountId: string, action: () => Promise<T>, units = 1): Promise<T> {
  let lease: string | undefined;
  while (!(lease = tryAcquireAgentTurn(taskId, accountId, units))) await new Promise(resolve => setTimeout(resolve, 250));
  try { return await action(); } finally { releaseAgentTurn(taskId, lease); }
}

export function tryAcquireEnvironment(taskId: string): boolean {
  return mutateState(state => {
    const task = state.tasks.find(t => t.id === taskId);
    if (!task || !open(task)) throw new Error(`Task ${taskId} cannot reserve an environment.`);
    if (task.portBase || task.envReadyAt) return true;
    const job = state.jobs.find(j => j.id === task.jobId);
    if (!job) throw new Error(`Missing job for task ${taskId}.`);
    for (const t of state.tasks) if (t.environmentReservation && !processAlive(t.environmentReservation.pid)) delete t.environmentReservation;
    const all = state.tasks.filter(t => t.portBase || t.envReadyAt || (open(t) && t.environmentReservation));
    const used = all.filter(t => t.jobId === job.id);
    if (used.some(t => t.id === taskId)) return true;
    if (used.length + state.tasks.filter(t => t.jobId === job.id).reduce((n,t) => n + (t.childEnvironments?.length ?? 0), 0) >= environmentLimit(job) || all.length + state.tasks.reduce((n,t) => n + (t.childEnvironments?.length ?? 0), 0) >= positive(state.capacity?.maxEnvironments, 16)) return false;
    task.environmentReservation = { pid: process.pid, at: Date.now() };
    return true;
  });
}
export function releaseEnvironmentReservation(taskId: string) {
  mutateState(state => { const task = state.tasks.find(t => t.id === taskId); if (task?.environmentReservation?.pid === process.pid) delete task.environmentReservation; });
}
/** Reservation covers allocation; portBase/envReadyAt retains capacity until cleanup. */
export async function withEnvironmentSlot<T>(taskId: string, action: () => Promise<T>): Promise<T> {
  while (!tryAcquireEnvironment(taskId)) await new Promise(resolve => setTimeout(resolve, 250));
  try { return await action(); } finally { releaseEnvironmentReservation(taskId); }
}
